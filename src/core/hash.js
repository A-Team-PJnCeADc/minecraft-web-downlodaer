// WASM 哈希引擎: CRC-32 增量计算、SHA-1 分块压缩; 另含 JS 侧 crc32 合并
// WASM 模块内存布局见 src/wasm/hash.wat: 0..1023 CRC 表, 2048..2367 SHA-1 扩展字,
// 2048..2067 SHA-1 状态, 8192 起为输入缓冲(按需增长)

const SCRATCH_BASE = 65536;
const STATE_BASE = 4096;
const STATE_STRIDE = 32;

export class HashEngine {
  static async load(input) {
    let bytes;
    if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
      bytes = input instanceof ArrayBuffer ? input : input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    } else {
      const res = await fetch(input);
      if (!res.ok) throw new Error('hash.wasm 加载失败: HTTP ' + res.status);
      bytes = await res.arrayBuffer();
    }
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new HashEngine(instance);
  }

  constructor(instance) {
    this.instance = instance;
    this.exports = instance.exports;
    this.memory = this.exports.memory;
    this.exports.crc32_init();
    this.crc32 = 0;
    this.nextState = STATE_BASE;
    this.freeStates = [];
    this._sync();
  }

  _sync() {
    this.u8 = new Uint8Array(this.memory.buffer);
  }

  _ensure(bytes) {
    const need = Math.max(SCRATCH_BASE + bytes, this.nextState);
    if (this.memory.buffer.byteLength >= need) return;
    let pages = Math.ceil((need - this.memory.buffer.byteLength) / 65536);
    this.memory.grow(pages);
    this._sync();
  }

  // 把一帧数据写入 WASM 内存, 返回从未对齐前的写入长度
  writeScratch(view, offset, length) {
    this._ensure(length);
    if (view.constructor === Uint8Array) {
      this.u8.set(view.subarray(offset, offset + length), SCRATCH_BASE);
    } else {
      this.u8.set(new Uint8Array(view.buffer, view.byteOffset + offset, length), SCRATCH_BASE);
    }
    return length;
  }

  scratch(size) {
    this._ensure(size);
    return this.u8.subarray(SCRATCH_BASE, SCRATCH_BASE + size);
  }

  // 两段 CRC 合并, 由 WASM 执行 GF(2) 矩阵运算
  combine(crc1, crc2, len2) {
    return this.exports.crc32_combine(crc1 >>> 0, crc2 >>> 0, len2 >>> 0) >>> 0;
  }

  crc32Of(view, offset = 0, length = view.byteLength - offset, seed = 0) {
    this.writeScratch(view, offset, length);
    return this.exports.crc32_update(seed, SCRATCH_BASE, length) >>> 0;
  }

  // 每个 Sha1 实例独占一段状态区, 支持多路并发哈希; digest 后回收复用
  allocState() {
    if (this.freeStates.length) return this.freeStates.pop();
    const ptr = this.nextState;
    this.nextState += STATE_STRIDE;
    if (this.nextState > SCRATCH_BASE) throw new Error('SHA-1 状态区耗尽');
    this._ensure(0);
    return ptr;
  }

  freeState(ptr) {
    if (ptr) this.freeStates.push(ptr);
  }

  stateWords(ptr) {
    return new Uint32Array(this.memory.buffer, ptr, 5);
  }

  sha1Blocks(ptr, byteOffset, blockCount) {
    this.exports.sha1_blocks(ptr, SCRATCH_BASE + byteOffset, blockCount);
  }

  sha1StateIn(ptr, values) {
    const w = this.stateWords(ptr);
    for (let i = 0; i < 5; i++) w[i] = values[i];
  }

  sha1StateOut(ptr) {
    return Array.from(this.stateWords(ptr));
  }
}

const SHA1_INIT = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];

export class Sha1 {
  constructor(engine) {
    this.engine = engine;
    this.pending = new Uint8Array(64);
    this.pendingLen = 0;
    this.total = 0;
    this.statePtr = engine.allocState();
    engine.sha1StateIn(this.statePtr, SHA1_INIT);
  }

  update(bytes) {
    if (!this.statePtr) throw new Error('SHA-1 实例已结束');
    let off = 0;
    const len = bytes.length;
    this.total += len;

    if (this.pendingLen > 0) {
      const need = Math.min(64 - this.pendingLen, len);
      this.pending.set(bytes.subarray(0, need), this.pendingLen);
      this.pendingLen += need;
      off = need;
      if (this.pendingLen === 64) {
        this.engine.writeScratch(this.pending, 0, 64);
        this.engine.sha1Blocks(this.statePtr, 0, 1);
        this.pendingLen = 0;
      }
    }

    const blocks = (len - off) >> 6;
    if (blocks > 0) {
      this.engine.writeScratch(bytes, off, blocks * 64);
      this.engine.sha1Blocks(this.statePtr, 0, blocks);
      off += blocks * 64;
    }

    if (off < len) {
      this.pending.set(bytes.subarray(off, len), 0);
      this.pendingLen = len - off;
    }
    return this;
  }

  // 放弃当前计算并归还状态区
  abort() {
    if (this.statePtr) {
      this.engine.freeState(this.statePtr);
      this.statePtr = 0;
    }
  }

  digest() {
    if (!this.statePtr) throw new Error('SHA-1 实例已结束');
    const bits = this.total * 8;
    const rest = new Uint8Array((this.pendingLen < 56 ? 64 : 128));
    rest.set(this.pending.subarray(0, this.pendingLen), 0);
    rest[this.pendingLen] = 0x80;
    const hi = Math.floor(bits / 0x100000000);
    const lo = bits >>> 0;
    const tail = rest.length - 8;
    rest[tail] = (hi >>> 24) & 255;
    rest[tail + 1] = (hi >>> 16) & 255;
    rest[tail + 2] = (hi >>> 8) & 255;
    rest[tail + 3] = hi & 255;
    rest[tail + 4] = (lo >>> 24) & 255;
    rest[tail + 5] = (lo >>> 16) & 255;
    rest[tail + 6] = (lo >>> 8) & 255;
    rest[tail + 7] = lo & 255;
    this.pendingLen = 0;
    this.engine.writeScratch(rest, 0, rest.length);
    this.engine.sha1Blocks(this.statePtr, 0, rest.length >> 6);
    const words = this.engine.sha1StateOut(this.statePtr);
    this.engine.freeState(this.statePtr);
    this.statePtr = 0;
    const out = new Uint8Array(20);
    for (let i = 0; i < 5; i++) {
      out[i * 4] = (words[i] >>> 24) & 255;
      out[i * 4 + 1] = (words[i] >>> 16) & 255;
      out[i * 4 + 2] = (words[i] >>> 8) & 255;
      out[i * 4 + 3] = words[i] & 255;
    }
    return out;
  }
}

export function hexOf(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

// zlib crc32_combine 等价实现: 把第二段 CRC 接到第一段之后
// 每次调用重建矩阵, 避免复用被平方运算覆盖的状态
function combineState() {
  const even = new Uint32Array(32);
  const odd = new Uint32Array(32);
  odd[0] = 0xEDB88320;
  let row = 1;
  for (let n = 1; n < 32; n++) {
    odd[n] = row;
    row = (row << 1) | 0;
  }
  return { even, odd };
}

function gf2Times(mat, vec) {
  let sum = 0;
  let v = vec >>> 0;
  for (let i = 0; i < 32; i++) {
    if (v & 1) sum ^= mat[i];
    v >>>= 1;
  }
  return sum >>> 0;
}

function gf2Square(square, mat) {
  for (let n = 0; n < 32; n++) square[n] = gf2Times(mat, mat[n]);
}

export function crc32Combine(crc1, crc2, len2) {
  if (len2 === 0) return crc1 >>> 0;
  const { even, odd } = combineState();
  gf2Square(even, odd);
  gf2Square(odd, even);
  let len = len2;
  let c1 = crc1 >>> 0;
  do {
    gf2Square(even, odd);
    if (len & 1) c1 = gf2Times(even, c1);
    len = Math.floor(len / 2);
    if (len === 0) break;
    gf2Square(odd, even);
    if (len & 1) c1 = gf2Times(odd, c1);
    len = Math.floor(len / 2);
  } while (len !== 0);
  return (c1 ^ (crc2 >>> 0)) >>> 0;
}

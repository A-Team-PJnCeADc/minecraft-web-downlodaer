// javapatch.wasm 的 JS 封装: 输入缓冲写入线性内存, 结果从模块内部缓冲读回
// 导出: lzma_decode / gdiff_apply / adler32; 失败返回负值, 错误文本通过 error_* 读取

export class PatchEngine {
  static async load(input) {
    let bytes;
    if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
      bytes = input instanceof ArrayBuffer ? input : input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    } else {
      const res = await fetch(input);
      if (!res.ok) throw new Error('javapatch.wasm 加载失败: HTTP ' + res.status);
      bytes = await res.arrayBuffer();
    }
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new PatchEngine(instance);
  }

  constructor(instance) {
    this.instance = instance;
    this.exports = instance.exports;
    this.memory = this.exports.memory;
    this.u8 = new Uint8Array(this.memory.buffer);
  }

  _sync() {
    this.u8 = new Uint8Array(this.memory.buffer);
  }

  _ensure(bytes) {
    if (this.memory.buffer.byteLength >= bytes) return;
    const pages = Math.ceil((bytes - this.memory.buffer.byteLength) / 65536);
    this.memory.grow(pages);
    this._sync();
  }

  // 把数据复制进模块内存, 返回指针; 调用方负责 free
  put(bytes) {
    if (!bytes.length) return 0;
    const ptr = this.exports.alloc(bytes.length);
    if (!ptr) throw new Error('WASM 内存分配失败: ' + bytes.length);
    // alloc 可能触发 memory.grow, 旧视图会失效
    if (this.u8.buffer !== this.memory.buffer) this._sync();
    this.u8.set(bytes, ptr);
    return ptr;
  }

  free(ptr, len) {
    if (ptr) this.exports.dealloc(ptr, len);
  }

  _error() {
    const ptr = this.exports.error_ptr();
    const len = this.exports.error_len();
    if (!len) return '未知错误';
    return new TextDecoder('utf-8').decode(new Uint8Array(this.memory.buffer, ptr, len));
  }

  _result(len) {
    if (len < 0) throw new Error(this._error());
    const ptr = this.exports.result_ptr();
    // 复制出来, 结果缓冲下一次调用会被覆盖
    return new Uint8Array(this.memory.buffer.slice(ptr, ptr + len));
  }

  lzmaDecode(bytes) {
    const ptr = this.put(bytes);
    try {
      return this._result(this.exports.lzma_decode(ptr, bytes.length));
    } finally {
      this.free(ptr, bytes.length);
    }
  }

  gdiffApply(base, delta) {
    const bp = this.put(base);
    const dp = this.put(delta);
    try {
      return this._result(this.exports.gdiff_apply(bp, base.length, dp, delta.length));
    } finally {
      this.free(bp, base.length);
      this.free(dp, delta.length);
    }
  }

  adler32(bytes) {
    const ptr = this.put(bytes);
    try {
      return this.exports.adler32(ptr, bytes.length) >>> 0;
    } finally {
      this.free(ptr, bytes.length);
    }
  }

  crc32(bytes, seed = 0) {
    const ptr = this.put(bytes);
    try {
      return this.exports.crc32(ptr, bytes.length, seed) >>> 0;
    } finally {
      this.free(ptr, bytes.length);
    }
  }
}

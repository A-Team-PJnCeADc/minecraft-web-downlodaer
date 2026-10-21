// ZIP 读取: 解析中央目录, 按需读取并解压单个条目
// 数据源通过 readAt(offset, length) 注入, 浏览器用 File.slice, Node 用 fs.read
// 解压函数通过 inflateRaw(bytes) 注入: 浏览器 DecompressionStream('deflate-raw'), Node zlib

const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOC_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const decoder = new TextDecoder('utf-8');

export class ZipReader {
  constructor({ size, readAt, inflateRaw }) {
    this.size = size;
    this.readAt = readAt;
    this.inflateRaw = inflateRaw;
    this.entries = new Map();
    this.order = [];
  }

  async open() {
    const tailLen = Math.min(this.size, 66000);
    const tail = await this.readAt(this.size - tailLen, tailLen);
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件: 未找到 EOCD');
    let count = dv.getUint16(eocd + 10, true);
    let cdSize = dv.getUint32(eocd + 12, true);
    let cdOffset = dv.getUint32(eocd + 16, true);

    if ((count === 0xffff || cdOffset === 0xffffffff) && eocd >= 20) {
      const locPos = eocd - 20;
      if (dv.getUint32(locPos, true) === EOCD64_LOC_SIG) {
        const eocd64Offset = Number(dv.getBigUint64(locPos + 8, true));
        const head = await this.readAt(eocd64Offset, 56);
        const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
        if (hv.getUint32(0, true) === EOCD64_SIG) {
          count = Number(hv.getBigUint64(32, true));
          cdSize = Number(hv.getBigUint64(40, true));
          cdOffset = Number(hv.getBigUint64(48, true));
        }
      }
    }

    const cd = await this.readAt(cdOffset, cdSize);
    const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cdSize; i++) {
      if (cv.getUint32(p, true) !== CENTRAL_SIG) break;
      const flags = cv.getUint16(p + 8, true);
      const method = cv.getUint16(p + 10, true);
      const crc = cv.getUint32(p + 16, true);
      let compSize = cv.getUint32(p + 20, true);
      let uncompSize = cv.getUint32(p + 24, true);
      const nameLen = cv.getUint16(p + 28, true);
      const extraLen = cv.getUint16(p + 30, true);
      const commentLen = cv.getUint16(p + 32, true);
      let localOffset = cv.getUint32(p + 42, true);
      const name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLen));
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
        let ep = 0;
        while (ep + 4 <= extra.length) {
          const tag = extra[ep] | (extra[ep + 1] << 8);
          const len = extra[ep + 2] | (extra[ep + 3] << 8);
          if (tag === 0x0001) {
            const ev = new DataView(extra.buffer, extra.byteOffset + ep + 4, len);
            let q = 0;
            if (uncompSize === 0xffffffff) { uncompSize = Number(ev.getBigUint64(q, true)); q += 8; }
            if (compSize === 0xffffffff) { compSize = Number(ev.getBigUint64(q, true)); q += 8; }
            if (localOffset === 0xffffffff) { localOffset = Number(ev.getBigUint64(q, true)); }
          }
          ep += 4 + len;
        }
      }
      this.entries.set(name, {
        name, flags, method, crc, compSize, uncompSize, localOffset,
        isDirectory: name.endsWith('/'),
      });
      this.order.push(name);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return this;
  }

  has(name) {
    return this.entries.has(name);
  }

  // 列出前缀下的文件
  list(prefix = '') {
    const out = [];
    for (const name of this.order) {
      const e = this.entries.get(name);
      if (e.isDirectory) continue;
      if (name.startsWith(prefix)) out.push(e);
    }
    return out;
  }

  async readEntry(name) {
    const entry = typeof name === 'string' ? this.entries.get(name) : name;
    if (!entry) throw new Error('ZIP 内不存在条目: ' + name);
    const head = await this.readAt(entry.localOffset, 30);
    const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (hv.getUint32(0, true) !== LOCAL_SIG) throw new Error('本地文件头损坏: ' + entry.name);
    const nameLen = hv.getUint16(26, true);
    const extraLen = hv.getUint16(28, true);
    const dataOffset = entry.localOffset + 30 + nameLen + extraLen;
    const raw = await this.readAt(dataOffset, entry.compSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return this.inflateRaw(raw);
    throw new Error('不支持的压缩方式 ' + entry.method + ': ' + entry.name);
  }

  async readText(name) {
    return decoder.decode(await this.readEntry(name));
  }
}

// 浏览器侧工厂: 传入 File/Blob
export async function openZipFromBlob(blob) {
  const reader = new ZipReader({
    size: blob.size,
    readAt: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
    inflateRaw: async (bytes) => {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    },
  });
  return reader.open();
}

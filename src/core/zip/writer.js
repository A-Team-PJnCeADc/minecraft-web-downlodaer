// 流式 ZIP 写入器: 先按已知大小预排布, 支持多连接并发写入不相交区间, 最后补写 CRC 与中央目录
// 结构: 本地文件头(已知大小, 无数据描述符) + 数据 + 中央目录 (+ ZIP64 记录)
import { crc32Combine } from '../hash.js';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOC_SIG = 0x07064b50;
const U32_MAX = 0xffffffff;

function dosTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const encoder = new TextEncoder();

export class ZipWriter {
  constructor(sink, options = {}) {
    this.sink = sink;
    this.entries = [];
    this.cursor = 0;
    this.appendCursor = 0;
    this.laid = false;
    this.finalized = false;
    const d = dosTime(options.time || new Date());
    this.dosTime = d.time;
    this.dosDate = d.date;
    this.zip64 = false;
    this.hashEngine = options.hashEngine || null;
    this.dir = new TextEncoder().encode('/');
  }

  // 登记一个大小已知的条目; 必须在 layout() 之前调用
  reserve(name, size, method = 0) {
    if (this.laid) throw new Error('layout 之后不能再登记条目');
    const entry = {
      name,
      nameBytes: encoder.encode(name),
      size,
      method,
      crc: 0,
      offset: 0,
      dataOffset: 0,
      zip64: size >= U32_MAX,
      written: 0,
      failed: false,
      chunks: 0,
      crcParts: new Map(),
    };
    this.entries.push(entry);
    return entry;
  }

  localHeaderSize(entry) {
    return 30 + entry.nameBytes.length + (entry.zip64 ? 20 : 0);
  }

  // 计算偏移并写出全部本地文件头; 之后数据区可被任意顺序写入
  async layout() {
    if (this.laid) return;
    let cursor = 0;
    for (const entry of this.entries) {
      entry.offset = cursor;
      if (entry.offset >= U32_MAX) entry.zip64 = true;
      const headerLen = this.localHeaderSize(entry);
      entry.dataOffset = cursor + headerLen;
      cursor = entry.dataOffset + entry.size;
      if (entry.zip64) this.zip64 = true;
    }
    this.cursor = cursor;
    this.appendCursor = cursor;
    this.laid = true;
    for (const entry of this.entries) {
      await this.sink.writeAt(entry.offset, this.buildLocalHeader(entry));
    }
  }

  buildLocalHeader(entry) {
    const extraLen = entry.zip64 ? 20 : 0;
    const buf = new Uint8Array(30 + entry.nameBytes.length + extraLen);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, LOCAL_SIG, true);
    dv.setUint16(4, entry.zip64 ? 45 : 20, true);
    dv.setUint16(6, 0x0800, true); // 文件名使用 UTF-8
    dv.setUint16(8, entry.method, true);
    dv.setUint16(10, this.dosTime, true);
    dv.setUint16(12, this.dosDate, true);
    dv.setUint32(14, entry.crc >>> 0, true);
    dv.setUint32(18, entry.zip64 ? U32_MAX : entry.size, true);
    dv.setUint32(22, entry.zip64 ? U32_MAX : entry.size, true);
    dv.setUint16(26, entry.nameBytes.length, true);
    dv.setUint16(28, extraLen, true);
    buf.set(entry.nameBytes, 30);
    if (entry.zip64) {
      const ev = new DataView(buf.buffer, 30 + entry.nameBytes.length);
      ev.setUint16(0, 0x0001, true);
      ev.setUint16(2, 16, true);
      ev.setBigUint64(4, BigInt(entry.size), true);
      ev.setBigUint64(12, BigInt(entry.size), true);
    }
    return buf;
  }

  // 数据按绝对位置写入; 记录每段 CRC 与长度供最终合并
  async writeChunk(entry, chunkOffset, bytes, crc32, chunkIndex) {
    if (entry.failed) return;
    await this.sink.writeAt(entry.dataOffset + chunkOffset, bytes);
    entry.crcParts.set(chunkIndex, { crc: crc32 >>> 0, len: bytes.length });
    entry.written += bytes.length;
  }

  // 顺序块写入时可直接累加 CRC
  setSequentialCrc(entry, crc) {
    entry.crc = crc >>> 0;
  }

  terminalCrc(entry) {
    if (!entry.crcParts || entry.crcParts.size === 0) return (entry.crc || 0) >>> 0;
    const keys = [...entry.crcParts.keys()].sort((a, b) => a - b);
    let crc = 0;
    let first = true;
    for (const k of keys) {
      const part = entry.crcParts.get(k);
      crc = first ? part.crc
        : (this.hashEngine ? this.hashEngine.combine(crc, part.crc, part.len) : crc32Combine(crc, part.crc, part.len));
      first = false;
    }
    return crc >>> 0;
  }

  // 未知大小的条目: 追加在预排布区之后, 由调用方提供完整字节
  async addStored(name, bytes, method = 0) {
    if (!this.laid) await this.layout();
    const entry = {
      name,
      nameBytes: encoder.encode(name),
      size: bytes.length,
      method,
      crc: 0,
      offset: this.appendCursor,
      dataOffset: this.appendCursor + 30 + encoder.encode(name).length,
      zip64: bytes.length >= U32_MAX || this.appendCursor >= U32_MAX,
      written: bytes.length,
      failed: false,
    };
    this.appendCursor = entry.dataOffset + bytes.length;
    if (entry.zip64) this.zip64 = true;
    await this.sink.writeAt(entry.offset, this.buildLocalHeader(entry));
    if (bytes.length) await this.sink.writeAt(entry.dataOffset, bytes);
    this.entries.push(entry);
    return entry;
  }

  // 补写条目 CRC(必须在全部数据写完后调用)
  async sealEntry(entry, crc32) {
    const crc = (crc32 ?? entry.crc) >>> 0;
    entry.crc = crc;
    entry.sealed = true;
    const patch = new Uint8Array(4);
    new DataView(patch.buffer).setUint32(0, crc, true);
    await this.sink.writeAt(entry.offset + 14, patch);
  }

  markFailed(entry) {
    entry.failed = true;
  }

  // 重试前清空条目状态, 数据区位置不变, 直接覆盖原占位
  resetEntry(entry) {
    entry.failed = false;
    entry.sealed = false;
    entry.written = 0;
    entry.crc = 0;
    if (entry.crcParts) entry.crcParts.clear();
  }

  buildCentralHeader(entry) {
    const nameLen = entry.nameBytes.length;
    const needZip64 = entry.zip64 || entry.offset >= U32_MAX || entry.size >= U32_MAX;
    const extraLen = needZip64 ? 28 : 0;
    const buf = new Uint8Array(46 + nameLen + extraLen);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, CENTRAL_SIG, true);
    dv.setUint16(4, 45, true);
    dv.setUint16(6, needZip64 ? 45 : 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, entry.method, true);
    dv.setUint16(12, this.dosTime, true);
    dv.setUint16(14, this.dosDate, true);
    dv.setUint32(16, entry.crc >>> 0, true);
    dv.setUint32(20, needZip64 ? U32_MAX : entry.size, true);
    dv.setUint32(24, needZip64 ? U32_MAX : entry.size, true);
    dv.setUint16(28, nameLen, true);
    dv.setUint16(30, extraLen, true);
    dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true);
    dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true);
    dv.setUint32(42, needZip64 ? U32_MAX : entry.offset, true);
    buf.set(entry.nameBytes, 46);
    if (needZip64) {
      const ev = new DataView(buf.buffer, 46 + nameLen, 28);
      ev.setUint16(0, 0x0001, true);
      ev.setUint16(2, 24, true);
      ev.setBigUint64(4, BigInt(entry.size), true);
      ev.setBigUint64(12, BigInt(entry.size), true);
      ev.setBigUint64(20, BigInt(entry.offset), true);
    }
    return buf;
  }

  // 可重复调用: 每次都按当前完成情况重写中央目录并截断, 支持"重试后再封包"
  async finalize() {
    if (!this.laid) await this.layout();
    const kept = this.entries.filter((e) => !e.failed);
    let offset = this.appendCursor;
    const headers = kept.map((e) => {
      const h = this.buildCentralHeader(e);
      return { h, entry: e };
    });
    const cdStart = offset;
    for (const { h, entry } of headers) {
      await this.sink.writeAt(offset, h);
      entry.centralOffset = offset;
      offset += h.length;
    }
    const cdSize = offset - cdStart;
    const needZip64 = this.zip64 || kept.length > 0xffff || cdStart >= U32_MAX || cdSize >= U32_MAX;
    if (needZip64) {
      const eocd64 = new Uint8Array(56);
      const dv = new DataView(eocd64.buffer);
      dv.setUint32(0, EOCD64_SIG, true);
      dv.setBigUint64(4, 44n, true);
      dv.setUint16(12, 45, true);
      dv.setUint16(14, 45, true);
      dv.setUint32(16, 0, true);
      dv.setUint32(20, 0, true);
      dv.setBigUint64(24, BigInt(kept.length), true);
      dv.setBigUint64(32, BigInt(kept.length), true);
      dv.setBigUint64(40, BigInt(cdSize), true);
      dv.setBigUint64(48, BigInt(cdStart), true);
      await this.sink.writeAt(offset, eocd64);
      const locator = new Uint8Array(20);
      const lv = new DataView(locator.buffer);
      lv.setUint32(0, EOCD64_LOC_SIG, true);
      lv.setUint32(4, 0, true);
      lv.setBigUint64(8, BigInt(offset), true);
      lv.setUint32(16, 1, true);
      await this.sink.writeAt(offset + 56, locator);
      offset += 76;
    }
    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, EOCD_SIG, true);
    edv.setUint16(4, 0, true);
    edv.setUint16(6, 0, true);
    edv.setUint16(8, needZip64 ? 0xffff : kept.length, true);
    edv.setUint16(10, needZip64 ? 0xffff : kept.length, true);
    edv.setUint32(12, needZip64 ? U32_MAX : cdSize, true);
    edv.setUint32(16, needZip64 ? U32_MAX : cdStart, true);
    edv.setUint16(20, 0, true);
    await this.sink.writeAt(offset, eocd);
    offset += 22;
    await this.sink.truncate(offset);
    this.finalized = true;
    this.totalSize = offset;
    return kept;
  }
}

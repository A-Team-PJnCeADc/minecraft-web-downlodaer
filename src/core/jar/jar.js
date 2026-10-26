// JAR 读写: 保持条目顺序, 固定 DOS 时间戳(与 Forge 安装器一致的 628041600000ms)
// 写入默认使用 deflate(浏览器 CompressionStream / Node zlib), 与 Java ZipOutputStream 输出等价
import { ZipReader } from '../zip/reader.js';

export const STABLE_TIME = 628041600000;

export function dosTimeOf(ms) {
  const d = new Date(ms);
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

async function inflateRawBytes(bytes) {
  if (globalThis.DecompressionStream) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { inflateRawSync } = await import('node:zlib');
  return new Uint8Array(inflateRawSync(bytes));
}

async function deflateRawBytes(bytes, level = 6) {
  if (globalThis.CompressionStream) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { deflateRawSync } = await import('node:zlib');
  return new Uint8Array(deflateRawSync(bytes, { level }));
}

// 读取 jar: 返回条目顺序与内容
export async function readJar(bytes, { cancel = null, signal = null } = {}) {
  const bus = cancel || (signal ? { get cancelled() { return signal.aborted; }, throwIfCancelled() { if (signal.aborted) { const e = new Error('已取消'); e.name = 'AbortError'; throw e; } } } : null);
  const zip = await new ZipReader({
    size: bytes.length,
    readAt: async (offset, length) => bytes.subarray(offset, offset + length),
    inflateRaw: inflateRawBytes,
  }).open();
  const order = [];
  const entries = new Map();
  let seen = 0;
  for (const entry of zip.list()) {
    // 大 jar 解包要几秒, 每 1024 条让出一次事件循环并检查取消
    bus?.throwIfCancelled?.();
    if ((seen++ & 1023) === 0) await Promise.resolve();
    const data = await zip.readEntry(entry);
    order.push(entry.name);
    entries.set(entry.name, data);
  }
  return { order, entries };
}

const encoder = new TextEncoder();

// 写 jar: items 为 Map<name, Uint8Array> 或 [{name, data}], order 可指定条目顺序
export async function writeJar(items, { order = null, engine = null, deflate = true } = {}) {
  const list = order
    ? order.filter((n) => items.has(n)).map((n) => [n, items.get(n)])
    : [...items.entries()];
  const parts = [];
  const central = [];
  let offset = 0;
  const { time: dosT, date: dosD } = dosTimeOf(STABLE_TIME);

  const crcOf = engine
    ? (data) => engine.crc32(data)
    : (data) => crc32Js(data);

  for (const [name, data] of list) {
    const nameBytes = encoder.encode(name);
    const crc = crcOf(data) >>> 0;
    let method = 0;
    let body = data;
    if (deflate && data.length > 32) {
      const packed = await deflateRawBytes(data);
      if (packed.length < data.length) {
        method = 8;
        body = packed;
      }
    }
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, dosT, true);
    lv.setUint16(12, dosD, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    parts.push(local, body);
    central.push({ name, nameBytes, crc, method, compSize: body.length, size: data.length, offset });
    offset += local.length + body.length;
  }

  const cdParts = [];
  let cdSize = 0;
  for (const e of central) {
    const buf = new Uint8Array(46 + e.nameBytes.length);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, e.method, true);
    dv.setUint16(12, dosT, true);
    dv.setUint16(14, dosD, true);
    dv.setUint32(16, e.crc, true);
    dv.setUint32(20, e.compSize, true);
    dv.setUint32(24, e.size, true);
    dv.setUint16(28, e.nameBytes.length, true);
    dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true);
    dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true);
    dv.setUint32(42, e.offset, true);
    buf.set(e.nameBytes, 46);
    cdParts.push(buf);
    cdSize += buf.length;
  }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const total = parts.reduce((s, p) => s + p.length, 0) + cdSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  for (const p of cdParts) {
    out.set(p, pos);
    pos += p.length;
  }
  out.set(eocd, pos);
  return out;
}

let crcTable = null;
export function crc32Js(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

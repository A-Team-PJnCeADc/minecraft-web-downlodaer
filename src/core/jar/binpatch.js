// Forge/NeoForge 二进制补丁: 容器解析与还原
// 经典格式(Forge 1.13 - 1.21.x): LZMA(旧式 .lzma 容器) -> ZIP -> 若干 *.binpatch
//   单条记录: u8 版本(1) + UTF 混淆名 + UTF 目标名 + bool 存在 + [i32 Adler32] + i32 长度 + GDIFF 数据
// NeoForge 新格式: LZMA -> "NFPATCHBUNDLE001" + i32 条目数 + u8 支持的类型位 + 逐条记录
// 还原计算(GDIFF 与 Adler32)在 wasm 内完成, 这里只做容器解析与调度
import { ZipReader } from '../zip/reader.js';

const BUNDLE_SIGNATURE = 'NFPATCHBUNDLE001';
const ENTRY_CREATE = 0;
const ENTRY_MODIFY = 1;
const ENTRY_REMOVE = 2;
export const BASE_CLIENT = 1;
export const BASE_SERVER = 2;
export const BASE_JOINED = 4;

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }

  u8() {
    if (this.pos + 1 > this.bytes.length) throw new Error('补丁数据提前结束');
    return this.bytes[this.pos++];
  }

  i32() {
    if (this.pos + 4 > this.bytes.length) throw new Error('补丁数据提前结束');
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  u16() {
    if (this.pos + 2 > this.bytes.length) throw new Error('补丁数据提前结束');
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  utf() {
    const len = this.u16();
    const raw = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return new TextDecoder('utf-8').decode(raw);
  }

  take(len) {
    const raw = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return raw;
  }
}

// 解析经典 .binpatch 记录; legacy 模式下没有版本字节, 名字用点分隔
export function parseBinpatch(bytes, legacy = false) {
  const r = new Reader(bytes);
  let obf;
  let srg;
  if (legacy) {
    obf = r.utf();
    r.utf();
    srg = r.utf().replace(/\./g, '/');
  } else {
    const version = r.u8();
    if (version !== 1) throw new Error('不支持的补丁格式: ' + version);
    obf = r.utf();
    srg = r.utf();
  }
  const exists = r.u8() !== 0;
  const checksum = exists ? r.i32() >>> 0 : 0;
  const length = r.i32();
  if (length < 0) throw new Error('补丁长度非法: ' + length);
  return { operation: length === 0 ? ENTRY_REMOVE : ENTRY_MODIFY, path: obf, target: srg, exists, checksum, data: r.take(length) };
}

// NeoForge 新格式补丁包
export function parsePatchBundle(bytes) {
  const sig = new TextDecoder('latin1').decode(bytes.subarray(0, BUNDLE_SIGNATURE.length));
  if (sig !== BUNDLE_SIGNATURE) throw new Error('补丁包签名不匹配: ' + sig);
  const r = new Reader(bytes);
  r.take(BUNDLE_SIGNATURE.length);
  const count = r.i32();
  const supported = r.u8();
  const patches = [];
  for (let i = 0; i < count; i++) {
    const flags = r.u8();
    const operation = (flags & 0x18) >> 3;
    const baseTypes = flags & 0x07;
    const path = r.utf();
    const checksum = operation === ENTRY_MODIFY ? r.i32() >>> 0 : 0;
    const length = r.i32();
    if (length < 0) throw new Error('补丁长度非法: ' + length);
    patches.push({ operation, baseTypes, path, checksum, data: r.take(length), format: 'bundle' });
  }
  return { supported, patches };
}

// 解压 .lzma 后按内容判断是 ZIP(经典) 还是新格式补丁包
export async function readPatchArchive(engine, compressedBytes, { legacy = false, prefix = null } = {}) {
  const raw = engine.lzmaDecode(compressedBytes);
  if (raw.length >= 4 && raw[0] === 0x50 && raw[1] === 0x4b) {
    const zip = await new ZipReader({
      size: raw.length,
      readAt: async (offset, length) => raw.subarray(offset, offset + length),
      inflateRaw: async (bytes) => inflateRawBytes(bytes),
    }).open();
    const patches = [];
    for (const entry of zip.list()) {
      if (!entry.name.endsWith('.binpatch')) continue;
      if (prefix && !entry.name.startsWith(prefix + '/')) continue;
      const data = await zip.readEntry(entry);
      const patch = parseBinpatch(data, legacy);
      patch.name = entry.name;
      patch.format = 'classic';
      patches.push(patch);
    }
    return { kind: 'classic', supported: BASE_CLIENT | BASE_SERVER, patches };
  }
  return { kind: 'bundle', ...parsePatchBundle(raw) };
}

// 未压缩的 deflate 解压: 浏览器用 DecompressionStream, Node 用 zlib
export async function inflateRawBytes(bytes) {
  if (globalThis.DecompressionStream) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { inflateRawSync } = await import('node:zlib');
  return new Uint8Array(inflateRawSync(bytes));
}

// 对 clean 条目表应用补丁; items 为 Map<name, Uint8Array>, 返回新的 Map
// 校验失败立即抛错(GDIFF 的复制指令依赖精确的基线字节)
export function applyPatches(engine, items, parsed, { baseType = BASE_CLIENT, strict = true, shouldAbort = null } = {}) {
  const out = new Map(items);
  const stats = { patched: 0, created: 0, removed: 0, copied: 0, failed: 0 };
  const failures = [];
  const patches = parsed.patches;
  let seen = 0;
  for (const patch of patches) {
    // 每 64 条检查一次取消, 让大批量补丁可以中途停下
    if (shouldAbort && (seen++ & 63) === 0) shouldAbort();
    if (patch.baseTypes !== undefined && (patch.baseTypes & baseType) === 0) continue;
    // 经典格式只装类, 名字是点号分隔的类名; 新格式带的是 jar 内真实路径(可能不是 class)
    const classic = patch.format === 'classic';
    const key = classic && !patch.path.includes('/') ? patch.path.replace(/\./g, '/') : patch.path;
    const name = classic && !key.endsWith('.class') ? key + '.class' : key;
    const existing = out.get(name);

    if (patch.operation === ENTRY_REMOVE) {
      if (existing) {
        out.delete(name);
        stats.removed++;
      } else if (strict) {
        failures.push(`${key}: 补丁要求删除, 但基线中不存在`);
      }
      continue;
    }

    if (patch.operation === ENTRY_CREATE) {
      out.set(name, patch.data);
      stats.created++;
      continue;
    }

    // 经典格式把"新建"编码为 exists=false 的修改记录, 数据是从空基线算出的增量
    if (patch.format === 'classic' && patch.exists === false) {
      const created = patch.data.length ? engine.gdiffApply(new Uint8Array(0), patch.data) : new Uint8Array(0);
      out.set(name, created);
      stats.created++;
      continue;
    }

    if (!existing) {
      if (strict) failures.push(`${key}: 补丁要求修改, 但基线中不存在`);
      else stats.failed++;
      continue;
    }
    if (patch.exists) {
      const actual = engine.adler32(existing);
      if (actual !== patch.checksum) {
        const msg = `${key}: 基线校验和不符 期望 ${patch.checksum.toString(16)} 实际 ${actual.toString(16)}`;
        if (strict) failures.push(msg);
        stats.failed++;
        continue;
      }
    }
    const patched = engine.gdiffApply(existing, patch.data);
    out.set(name, patched);
    stats.patched++;
  }
  if (failures.length) {
    const err = new Error(`补丁应用失败 ${failures.length} 项: ${failures.slice(0, 3).join('; ')}`);
    err.failures = failures;
    err.stats = stats;
    throw err;
  }
  return { items: out, stats };
}

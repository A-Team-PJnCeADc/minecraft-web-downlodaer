// 从 HMCL 发行版 jar 提取内置凭据与构建信息, 写入 config/keys.local.json
// 用法: node tools/extract-hmcl-key.mjs <HMCL.jar 路径>
// 只在本机落盘(已加入 .gitignore), 控制台只打印掩码
import { open, writeFile, mkdir, readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipReader } from '../src/core/zip/reader.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jarPath = process.argv[2];
if (!jarPath) {
  console.error('用法: node tools/extract-hmcl-key.mjs <HMCL.jar>');
  process.exit(1);
}

// 只提下载链路实际要用的凭据: CurseForge API Key
const FIELDS = [
  { prop: 'hmcl.curseforge.apikey', field: 'curseApiKey', label: 'CurseForge API Key', secret: true },
];

const handle = await open(jarPath, 'r');
const stat = await handle.stat();
const zip = new ZipReader({
  size: stat.size,
  readAt: async (offset, length) => {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    return new Uint8Array(buf.subarray(0, bytesRead));
  },
  inflateRaw: async (bytes) => new Uint8Array(inflateRawSync(bytes)),
});
await zip.open();

let props = {};
// 3.17 起属性文件在 assets/hmcl.properties, 旧版在根目录, 统一按后缀找
const propPath = zip.list().map((e) => e.name || e)
  .find((n) => /(^|\/)hmcl\.properties$/i.test(n));
if (propPath) {
  const text = await zip.readText(propPath);
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.\-]+)\s*=\s*(.*)$/);
    if (m) props[m[1]] = m[2].trim();
  }
  console.log('属性文件:', propPath);
}
if (zip.has('META-INF/MANIFEST.MF')) {
  const text = await zip.readText('META-INF/MANIFEST.MF');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([\w.\-]+):\s*(.*)$/);
    if (m && props[m[1]] === undefined) props[m[1]] = m[2].trim();
  }
}
await handle.close();

const mask = (value, secret) => {
  if (!value) return '(空)';
  if (!secret) return value;
  if (value.length <= 12) return '*'.repeat(value.length);
  return value.slice(0, 7) + '…' + value.slice(-4) + ` (长度 ${value.length})`;
};

const found = {};
const rows = [];
for (const f of FIELDS) {
  const value = props[f.prop] || '';
  if (value) found[f.field] = value;
  rows.push([f.label, mask(value, f.secret), f.secret ? '凭据' : '公开']);
}

if (!Object.keys(found).length) {
  console.error('该 jar 内没有 hmcl.curseforge.apikey（自行编译、未注入凭据的构建）');
  process.exit(2);
}
if (!found.curseApiKey) {
  console.warn('注意: 这个 jar 没有 hmcl.curseforge.apikey，官方发行版才会带');
}

const outDir = resolve(root, 'config');
await mkdir(outDir, { recursive: true });
const outFile = resolve(outDir, 'keys.local.json');
let existing = {};
try { existing = JSON.parse(await readFile(outFile, 'utf8')); } catch { }

const payload = {
  ...existing,
  ...found,
  extractedFrom: basename(jarPath),
  extractedAt: new Date().toISOString(),
};
await writeFile(outFile, JSON.stringify(payload, null, 2));

// 同步到 mc-gateway 三个入口的内置兜底常量(网关/Worker/EdgeOne 函数)
const gatewayFiles = [
  resolve(root, '../mc-gateway/server.js'),
  resolve(root, '../mc-gateway/worker.js'),
  resolve(root, '../mc-gateway/edge-functions/[[default]].js'),
  resolve(root, '../mc-gateway/edge-functions/api/[[default]].js'),
  resolve(root, '../mc-gateway/cloud-functions/api/gw.js'),
];
for (const file of gatewayFiles) {
  try {
    const text = await readFile(file, 'utf8');
    const next = text.replace(/const HMCL_FALLBACK_KEY = '[^']*';/, "const HMCL_FALLBACK_KEY = '" + key + "';");
    if (next !== text) {
      await writeFile(file, next);
      console.log('已同步内置 key →', file);
    }
  } catch {
    // 网关目录不存在时跳过
  }
}

const width = Math.max(...rows.map((r) => r[0].length)) + 2;
console.log('来源:', jarPath);
for (const [label, value, kind] of rows) {
  console.log(String(label).padEnd(width), String(value).padEnd(26), kind);
}
console.log('\n已写入', outFile, '(已加入 .gitignore)');

// 校验 hash.wasm: CRC-32 与 SHA-1 对照 Node 内置实现, 并覆盖分块合并
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HashEngine, Sha1, hexOf, crc32Combine } from '../src/core/hash.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engine = await HashEngine.load(readFileSync(resolve(root, 'src/wasm/hash.wasm')));

function crc32Ref(buf) {
  let c = ~0 >>> 0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
  }
  return (~c) >>> 0;
}

let failures = 0;
function check(name, got, want) {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ' != ' + want}`);
}

const sizes = [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 1000, 100000];
for (const n of sizes) {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = (i * 37 + 11) & 255;
  check(`crc32 n=${n}`, engine.crc32Of(buf) >>> 0, crc32Ref(buf) >>> 0);
  const sha = new Sha1(engine).update(buf).digest();
  check(`sha1 n=${n}`, hexOf(sha), createHash('sha1').update(buf).digest('hex'));
}

// 分块 SHA-1: 任意切分必须与整体一致
const big = new Uint8Array(300000);
for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 3) & 255;
const want = createHash('sha1').update(big).digest('hex');
for (const cut of [1, 13, 64, 65, 1023, 65536]) {
  const s = new Sha1(engine);
  for (let off = 0; off < big.length; off += cut) s.update(big.subarray(off, Math.min(off + cut, big.length)));
  check(`sha1 分块 cut=${cut}`, hexOf(s.digest()), want);
}

// 多实例交错更新必须互不影响
{
  const x = new Uint8Array(5000); const y = new Uint8Array(7000);
  for (let i = 0; i < x.length; i++) x[i] = (i * 3) & 255;
  for (let i = 0; i < y.length; i++) y[i] = (i * 11 + 5) & 255;
  const sx = new Sha1(engine); const sy = new Sha1(engine);
  const maxLen = Math.max(x.length, y.length);
  for (let off = 0; off < maxLen; off += 700) {
    if (off < x.length) sx.update(x.subarray(off, Math.min(off + 700, x.length)));
    if (off < y.length) sy.update(y.subarray(off, Math.min(off + 700, y.length)));
  }
  check('并发实例 x', hexOf(sx.digest()), createHash('sha1').update(x).digest('hex'));
  check('并发实例 y', hexOf(sy.digest()), createHash('sha1').update(y).digest('hex'));
}

// CRC 合并: 两段分别计算后合并等于整体计算
const a = big.subarray(0, 123456);
const b = big.subarray(123456);
const whole = engine.crc32Of(big);
const partA = engine.crc32Of(a);
const partB = engine.crc32Of(b);
check('crc32 combine', crc32Combine(partA, partB, b.length) >>> 0, whole >>> 0);

check('wasm crc32 combine', engine.combine(partA, partB, b.length) >>> 0, whole >>> 0);

// 多段随机合并
const pieces = [];
let off = 0;
const lens = [1, 4096, 999, 65536, 7, big.length - 1 - 4096 - 999 - 65536 - 7];
for (const L of lens) { pieces.push(big.subarray(off, off + L)); off += L; }
let acc = 0;
let accLen = 0;
for (const p of pieces) {
  const c = engine.crc32Of(p);
  acc = accLen === 0 ? c : crc32Combine(acc, c, p.length);
  accLen += p.length;
}
check('crc32 多段合并', acc >>> 0, whole >>> 0);

// 速度
const bench = new Uint8Array(64 * 1024 * 1024);
for (let i = 0; i < bench.length; i += 4096) bench[i] = i & 255;
let t = performance.now();
const c = engine.crc32Of(bench);
const crcMs = performance.now() - t;
t = performance.now();
const s = new Sha1(engine);
for (let off = 0; off < bench.length; off += 2 << 20) s.update(bench.subarray(off, off + (2 << 20)));
s.digest();
const shaMs = performance.now() - t;
console.log(`吞吐 crc32 ${(64 / (crcMs / 1000)).toFixed(1)} MB/s, sha1 ${(64 / (shaMs / 1000)).toFixed(1)} MB/s`);
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);

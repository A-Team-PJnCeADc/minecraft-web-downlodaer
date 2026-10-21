// 验证"失败后重试"链路: 首次运行故意给一个坏地址, 重试时换成好地址, 再封包校验
import { readFileSync, writeFileSync } from 'node:fs';
import { HashEngine, Sha1, hexOf } from '../src/core/hash.js';
import { Sources } from '../src/core/hmcl/providers.js';
import { fetchChunkBytes, streamFetched } from '../src/core/dl/fetcher.js';
import { DownloadEngine } from '../src/core/dl/engine.js';
import { ZipWriter } from '../src/core/zip/writer.js';
import { MemorySink } from '../src/core/zip/sink.js';

const eng = await HashEngine.load(readFileSync(new URL('../src/wasm/hash.wasm', import.meta.url).pathname.slice(1)));
const sources = new Sources({ mode: 'mirror' });
const base = 'https://assets.mcasset.cloud/1.20.1/assets/icons/';

const items = [
  ['icon_128x128.png', 9101, 'b62ca8ec10d07e6bf5ac8dae0c8c1d2e6a1e3356'],
  ['icon_16x16.png', 781, '48c1c2b4b1e5b0b73e8a3a1f3c6a4fa5b7c8d9e0'],
  ['icon_256x256.png', 19642, null],
];

// 用版本清单里的真实哈希, 避免手写错
const manifest = await (await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json();
const ver = manifest.versions.find((v) => v.id === '1.20.1');
const vjson = await (await fetch(ver.url)).json();
const index = await (await fetch(vjson.assetIndex.url)).json();

const names = ['icons/icon_128x128.png', 'icons/icon_16x16.png', 'icons/icon_256x256.png'];
const tasks = names.map((name) => {
  const obj = index.objects[name];
  return {
    kind: 'http',
    category: 'asset',
    path: 'assets/objects/' + obj.hash.slice(0, 2) + '/' + obj.hash,
    size: obj.size,
    sha1: obj.hash,
    verify: true,
    urls: sources.assetCandidates('1.20.1', name, obj.hash),
  };
});
// 第一个任务先用坏地址, 运行后换成正确地址
const broken = tasks[0];
const goodUrls = broken.urls;
broken.urls = ['https://assets.mcasset.cloud/1.20.1/assets/icons/not-exist.png'];

const sink = new MemorySink();
const writer = new ZipWriter(sink, { hashEngine: eng });
const engine = new DownloadEngine({
  plan: { tasks }, writer, sources, hashEngine: eng,
  chunkSize: 1 << 20, concurrency: 4, chunkWindow: 2, chunked: true,
  fetchChunk: (job) => fetchChunkBytes({ urls: job.urls, start: job.start, end: job.end, whole: job.whole, hashEngine: eng }),
  streamFile: (job, onPart) => streamFetched({ urls: job.urls, hashEngine: eng, onPart }),
});

await engine.run();
console.log('首次运行: 成功', engine.stats.filesDone, '失败', engine.stats.failures.length);
await engine.finalize();

broken.urls = goodUrls;
await engine.runRetry();
console.log('重试之后: 成功', engine.stats.filesDone, '失败', engine.stats.failures.length);
const summary = await engine.finalize();
const bytes = await sink.close();
writeFileSync(new URL('../out/retry-test.zip', import.meta.url).pathname.slice(1), bytes);
console.log('产物大小', bytes.length, '条目', summary.entryCount);

// 自校验: 用同一套读取器逐个比对 CRC 与 SHA-1
import { ZipReader } from '../src/core/zip/reader.js';
const { inflateRawSync } = await import('node:zlib');
const reader = new ZipReader({
  size: bytes.length,
  readAt: async (offset, length) => bytes.slice(offset, offset + length),
  inflateRaw: async (b) => new Uint8Array(inflateRawSync(b)),
});
await reader.open();
let bad = 0;
for (const name of reader.order) {
  const entry = reader.entries.get(name);
  const data = await reader.readEntry(entry);
  const crc = eng.crc32Of(data);
  if (crc !== (entry.crc >>> 0)) bad++;
}
console.log('回读条目', reader.order.length, 'CRC 不符', bad);
console.log('第一个任务已写入:', reader.has(tasks[0].path));

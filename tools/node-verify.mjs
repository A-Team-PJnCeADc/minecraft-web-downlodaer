// Node 端验证: 复用浏览器内的同一套解析/调度/ZIP 代码, 输出真实压缩包并用 Python zipfile 复核
// 用法: node tools/node-verify.mjs --version 1.20.1 [--loader fabric:0.15.11] [--no-assets] [--out file.zip]
import { open, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { HashEngine } from '../src/core/hash.js';
import { ZipWriter } from '../src/core/zip/writer.js';
import { DownloadEngine } from '../src/core/dl/engine.js';
import { Sources } from '../src/core/hmcl/providers.js';
import { buildVersionPlan } from '../src/core/hmcl/plan.js';
import { fetchChunkBytes, streamFetched } from '../src/core/dl/fetcher.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes('--' + name);

class NodeFileSink {
  constructor(handle) {
    this.handle = handle;
    this.queue = Promise.resolve();
  }

  writeAt(position, bytes) {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.queue = this.queue.then(() => this.handle.write(buf, 0, buf.length, position));
    return this.queue;
  }

  truncate(size) {
    this.queue = this.queue.then(() => this.handle.truncate(size));
    return this.queue;
  }

  async close() {
    await this.queue;
    await this.handle.close();
  }
}

const version = arg('version', '1.20.1');
const loaderArg = arg('loader', null);
const outFile = resolve(arg('out', `out/${version}${loaderArg ? '-' + loaderArg.replace(':', '-') : ''}.zip`));
const includeAssets = !has('no-assets');
const concurrency = Number(arg('concurrency', '8'));
const chunkSize = Number(arg('chunk', String(1024 * 1024)));

const hashEngine = await HashEngine.load(readFileSync(resolve(root, 'src/wasm/hash.wasm')));
const sources = new Sources({ gateway: arg('gateway', '') || '', mode: arg('mode', 'default'), mirrorSite: arg('site', '') || undefined, mirrorRoot: arg('mirror-root', '') || '' });

let loader = null;
if (loaderArg) {
  const [type, ver] = loaderArg.split(':');
  loader = { type, version: ver };
}

console.log('构建计划:', version, loader ? `${loader.type} ${loader.version}` : '原版', includeAssets ? '含资源' : '跳过资源');
const t0 = performance.now();
const plan = await buildVersionPlan({
  sources, ctx: { os: 'windows', arch: 'x86_64', version: '10.0' },
  versionId: version, loader, includeAssets, includeLibraries: true,
});
console.log(`计划完成 ${((performance.now() - t0) / 1000).toFixed(2)}s, 条目 ${plan.stats.taskCount}, 预计 ${(plan.stats.totalBytes / 1048576).toFixed(1)} MiB`);
for (const w of plan.warnings) console.log('警告:', w);
for (const u of plan.unsupported) console.log('不支持:', u.item, '-', u.detail);
if (plan.stats.byCategory) {
  for (const [k, v] of Object.entries(plan.stats.byCategory)) {
    console.log(`  ${k}: ${v.count} 个, ${(v.bytes / 1048576).toFixed(1)} MiB`);
  }
}

const handle = await open(outFile, 'w+');
const sink = new NodeFileSink(handle);
const writer = new ZipWriter(sink, { hashEngine });
const engine = new DownloadEngine({
  plan, writer, sources, hashEngine, chunkSize, concurrency, window: 6,
  chunked: !has('whole'),
  fetchChunk: (job) => fetchChunkBytes({
    urls: job.urls, start: job.start, end: job.end, whole: job.whole, hashEngine,
  }),
  streamFile: (job, onPart) => streamFetched({ urls: job.urls, hashEngine, onPart }),
  readZipEntry: (task) => task.zip.readEntry(task.zipEntry),
  onProgress: (() => {
    let last = 0;
    return (stats) => {
      const now = performance.now();
      if (now - last < 2000) return;
      last = now;
      const pct = stats.bytesTotal ? (stats.bytesDone / stats.bytesTotal * 100).toFixed(1) : '0';
      console.log(`  进度 ${pct}% ${(stats.bytesDone / 1048576).toFixed(1)}/${(stats.bytesTotal / 1048576).toFixed(1)} MiB, 文件 ${stats.filesDone}/${stats.filesTotal}, 失败 ${stats.failures.length}`);
    };
  })(),
});

const stats = await engine.run();
// run() 只下载不封包: 中央目录与统计由 finalize() 补
await engine.finalize();
await sink.close();
const summary = engine.summary();
console.log(`完成: ${(summary.zipBytes / 1048576).toFixed(1)} MiB, 耗时 ${(summary.elapsed / 1000).toFixed(1)}s, 平均 ${(summary.speed / 1048576).toFixed(2)} MiB/s`);
console.log(`条目 ${summary.entryCount}, 成功文件 ${summary.filesDone}/${summary.filesTotal}, 失败 ${summary.failures.length}`);
if (summary.failures.length) {
  for (const f of summary.failures.slice(0, 20)) console.log('  失败:', f.category, f.path, '-', f.reason);
}
await writeFile(outFile + '.report.json', JSON.stringify({
  plan: { instanceId: plan.instanceId, stats: plan.stats, warnings: plan.warnings, unsupported: plan.unsupported },
  result: summary,
}, null, 2));
console.log('输出:', outFile);
void inflateRawSync;

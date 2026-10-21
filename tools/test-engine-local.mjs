// 不联网的引擎回归: 只有 local 任务, 验证 executeAll/reserve/layout/finalize 链路
import { writeFile, readFile } from 'node:fs/promises';
import { HashEngine } from '../src/core/hash.js';
import { MemorySink } from '../src/core/zip/sink.js';
import { ZipWriter } from '../src/core/zip/writer.js';
import { ZipReader } from '../src/core/zip/reader.js';
import { DownloadEngine } from '../src/core/dl/engine.js';

const wasm = await HashEngine.load(await readFile(new URL('../src/wasm/hash.wasm', import.meta.url)));
const sink = new MemorySink();
const writer = new ZipWriter(sink, { hashEngine: wasm });

const files = [
  { path: 'versions/demo/demo.json', kind: 'local', category: 'manifest', bytes: new TextEncoder().encode('{"id":"demo"}') },
  { path: 'libraries/a/b.jar', kind: 'local', category: 'library', bytes: new Uint8Array(2048).fill(7) },
  { path: 'mods/c.jar', kind: 'local', category: 'modpack', bytes: new Uint8Array(300).fill(9) },
];

const engine = new DownloadEngine({
  writer,
  plan: { tasks: files },
  hashEngine: wasm,
  concurrency: 4,
  chunkBytes: 1 << 20,
  trace: false,
});
await engine.run();
const stats = await engine.finalize();
const bytes = await sink.close();
await writeFile('out/local-only.zip', bytes);

const reader = await new ZipReader({
  size: bytes.length,
  readAt: async (o, l) => bytes.subarray(o, o + l),
  inflateRaw: async (b) => {
    const stream = new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  },
}).open();
const names = reader.list().map((e) => e.name);
let bad = 0;
for (const name of names) {
  const data = await reader.readEntry(name);
  const want = files.find((f) => f.path === name).bytes;
  if (data.length !== want.length) bad++;
}
console.log(JSON.stringify({ entries: names.length, filesDone: stats.filesDone, failures: stats.failures.length, zipBytes: bytes.length, bad, names }, null, 2));

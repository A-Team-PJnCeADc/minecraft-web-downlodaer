// 下载 Worker: 独立 WASM 实例, 分片取回后在 Worker 内完成 CRC-32, 以 transferable 交回主线程
// 也支持整文件流式模式(源不支持 Range 时使用), 按到达顺序回传每一段
import { HashEngine } from '../core/hash.js';
import { fetchChunkBytes, streamFetched } from '../core/dl/fetcher.js';

let engine = null;
let ready = null;

function ensureEngine() {
  if (!ready) {
    ready = HashEngine.load(new URL('../wasm/hash.wasm', import.meta.url).href).then((e) => {
      engine = e;
      return e;
    });
  }
  return ready;
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === 'chunk') {
    try {
      await ensureEngine();
      const { bytes, crc, url } = await fetchChunkBytes({
        urls: msg.urls,
        start: msg.start,
        end: msg.end,
        whole: msg.whole,
        hashEngine: engine,
      });
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      self.postMessage({ type: 'chunk', id: msg.id, buffer, crc, url, length: bytes.length }, [buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, message: String(err?.message || err), name: err?.name });
    }
    return;
  }

  if (msg.type === 'stream') {
    try {
      await ensureEngine();
      let index = 0;
      const result = await streamFetched({
        urls: msg.urls,
        hashEngine: engine,
        onPart: async (bytes, crc) => {
          const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          self.postMessage({ type: 'part', id: msg.id, index: index++, buffer, crc, length: bytes.length }, [buffer]);
        },
      });
      self.postMessage({ type: 'stream-end', id: msg.id, url: result.url, total: result.total, parts: index });
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, message: String(err?.message || err), name: err?.name });
    }
  }
};

// 计算 Worker: 顺序接收分片, 在 WASM 内累计 SHA-1 与 CRC-32, 结束时回传文件级结果
// 主线程不再做任何逐字节计算
import { HashEngine, Sha1, hexOf } from '../core/hash.js';

let engine = null;
let ready = null;
const files = new Map();

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
  try {
    await ensureEngine();
    if (msg.type === 'init') {
      files.set(msg.id, { verify: msg.verify, crc: 0, bytes: 0, sha1: msg.verify ? new Sha1(engine) : null });
      return;
    }
    const state = files.get(msg.id);
    if (!state) return;

    if (msg.type === 'chunk') {
      const view = new Uint8Array(msg.buffer, msg.offset || 0, msg.length);
      if (state.sha1) state.sha1.update(view);
      state.crc = engine.crc32Of(view, 0, view.length, state.crc);
      state.bytes += view.length;
      return;
    }

    if (msg.type === 'end') {
      const sha1 = state.sha1 ? hexOf(state.sha1.digest()) : null;
      files.delete(msg.id);
      self.postMessage({ type: 'result', id: msg.id, crc: state.crc >>> 0, sha1, bytes: state.bytes });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err?.message || err) });
  }
};

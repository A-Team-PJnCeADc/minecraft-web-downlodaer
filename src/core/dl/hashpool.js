// 哈希 Worker 池: 每个文件绑定一个 Worker, 分片以 transferable 送入, 保持顺序
export class HashPool {
  constructor({ size = 2, workerUrl = new URL('../../workers/hash-worker.js', import.meta.url) } = {}) {
    this.size = Math.max(1, size);
    this.workerUrl = workerUrl;
    this.workers = [];
    this.busy = 0;
    this.seq = 0;
    this.files = new Map();
  }

  workerAt(index) {
    if (!this.workers[index]) {
      const worker = new Worker(this.workerUrl, { type: 'module' });
      worker.onmessage = (event) => {
        const msg = event.data;
        const file = this.files.get(msg.id);
        if (!file) return;
        if (msg.type === 'result') {
          this.files.delete(msg.id);
          this.busy--;
          file.resolve({ crc: msg.crc, sha1: msg.sha1, bytes: msg.bytes });
        } else if (msg.type === 'error') {
          this.files.delete(msg.id);
          this.busy--;
          file.reject(new Error(msg.message));
        }
      };
      this.workers[index] = worker;
    }
    return this.workers[index];
  }

  init(verify) {
    const id = ++this.seq;
    const index = this.busy % this.size;
    const worker = this.workerAt(index);
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.files.set(id, { resolve, reject, worker, verify, promise });
    this.busy++;
    worker.postMessage({ type: 'init', id, verify });
    return { id, promise };
  }

  push(id, bytes) {
    const file = this.files.get(id);
    if (!file) return;
    const buffer = bytes.buffer;
    file.worker.postMessage(
      { type: 'chunk', id, buffer, offset: bytes.byteOffset, length: bytes.byteLength },
      [buffer],
    );
  }

  finish(id) {
    const file = this.files.get(id);
    if (!file) return Promise.reject(new Error('哈希任务不存在'));
    file.worker.postMessage({ type: 'end', id });
    return file.promise;
  }

  terminate() {
    for (const w of this.workers) w?.terminate();
    this.workers = [];
    this.files.clear();
    this.busy = 0;
  }
}

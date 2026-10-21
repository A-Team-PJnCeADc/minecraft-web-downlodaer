// Worker 池: 每个 Worker 同时只处理一个任务, 池内排队
// chunk 模式返回单个分片; stream 模式按到达顺序回调每一段(源不支持 Range 时使用)
export class FetchPool {
  constructor({ size = 8, workerUrl = new URL('../../workers/fetch-worker.js', import.meta.url) } = {}) {
    this.size = size;
    this.workerUrl = workerUrl;
    this.workers = [];
    this.idle = [];
    this.waiters = [];
    this.seq = 0;
    this.pending = new Map();
    // 单任务看门狗: Worker 卡死(不返回也不报错)时兜底, 避免整条流水线停住
    this.jobTimeout = 45000;
    this.workerTimeouts = new Map();
  }

  spawn() {
    const worker = new Worker(this.workerUrl, { type: 'module' });
    worker.onmessage = (event) => {
      const msg = event.data;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      if (msg.type === 'part') {
        const view = new Uint8Array(msg.buffer);
        // 流式任务每收到一段就重置看门狗: 看门的是「多久没有新数据」, 不是整文件 45 秒
        if (entry.stream) this.armTimeout(msg.id, entry);
        entry.chain = entry.chain.then(() => entry.onPart(view, msg.crc, msg.length));
        return;
      }
      clearTimeout(entry.timer);
      this.workerTimeouts.delete(worker);
      this.pending.delete(msg.id);
      this.release(worker);
      if (msg.type === 'error') {
        entry.chain.then(() => entry.reject(new Error(msg.message))).catch(() => entry.reject(new Error(msg.message)));
      } else if (msg.type === 'stream-end') {
        entry.chain.then(() => entry.resolve({ url: msg.url, total: msg.total })).catch(entry.reject);
      } else {
        entry.chain.then(() => entry.resolve({ bytes: new Uint8Array(msg.buffer), crc: msg.crc, url: msg.url }));
      }
    };
    worker.onerror = (err) => {
      for (const [id, entry] of this.pending) {
        if (entry.worker === worker) {
          this.pending.delete(id);
          entry.reject(new Error('Worker 异常: ' + (err.message || 'unknown')));
        }
      }
    };
    this.workers.push(worker);
    this.idle.push(worker);
    return worker;
  }

  acquire() {
    if (this.idle.length) return Promise.resolve(this.idle.pop());
    if (this.workers.length < this.size) return Promise.resolve(this.spawn());
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(worker) {
    if (!this.workers.includes(worker)) return;
    if (this.idle.includes(worker) && this.waiters.length === 0) return; // 防止重复归还
    const waiter = this.waiters.shift();
    if (waiter) waiter(worker);
    else if (!this.idle.includes(worker)) this.idle.push(worker);
  }

  // 记录超时; 同一 Worker 连续两次超时则销毁并重建
  noteTimeout(worker) {
    const count = (this.workerTimeouts.get(worker) || 0) + 1;
    this.workerTimeouts.set(worker, count);
    if (count < 2) return;
    this.workerTimeouts.delete(worker);
    try { worker.terminate(); } catch { }
    this.workers = this.workers.filter((w) => w !== worker);
    this.idle = this.idle.filter((w) => w !== worker);
    for (const [id, entry] of [...this.pending]) {
      if (entry.worker === worker) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(new Error('Worker 已回收'));
      }
    }
  }

  armTimeout(id, entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (!this.pending.has(id)) return;
      this.pending.delete(id);
      this.noteTimeout(entry.worker);
      entry.reject(new Error(`下载通道超时 ${Math.round(this.jobTimeout / 1000)}s 未返回`));
    }, this.jobTimeout);
  }

  async fetchChunk(job) {
    const worker = await this.acquire();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, worker, chain: Promise.resolve(), onPart: null };
      this.pending.set(id, entry);
      this.armTimeout(id, entry);
      worker.postMessage({
        type: 'chunk', id, urls: job.urls, start: job.start, end: job.end, whole: Boolean(job.whole),
      });
    });
  }

  async streamFile(job, onPart) {
    const worker = await this.acquire();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, worker, chain: Promise.resolve(), onPart, stream: true };
      this.pending.set(id, entry);
      this.armTimeout(id, entry);
      worker.postMessage({ type: 'stream', id, urls: job.urls });
    });
  }

  terminate() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
  }
}

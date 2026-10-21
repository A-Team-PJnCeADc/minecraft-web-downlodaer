// 下载引擎: 文件级并发 + 文件内分片顺序落地
// - 每个文件由一条协程顺序取回分片, 直接写入预排布好的 ZIP 偏移
// - 分片 CRC 在取回 Worker 的 WASM 内计算; SHA-1 与文件级 CRC 由哈希 Worker 池按序累计
// - 源不支持 Range 时退回单连接流式取回, 边到边写
import { Sha1, hexOf } from '../hash.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 单主机并发闸门
// 默认按 HTTP/2 多路复用处理: 同一连接上开多条流, 上限用 h2Limit; 浏览器不能指定 HTTP 版本,
// 也读不到协商结果(跨域 Resource Timing 会把 nextHopProtocol/transferSize 置空), 所以采用
// 「乐观按 HTTP/2 放开 + 运行期回退」: 同一主机连续失败 2 次就降到 HTTP/1.1 的连接上限(6)
// 网关包装的地址按内层主机计数(所有经网关的请求不该挤在同一个槽里)
class HostLimiter {
  constructor(limit = 6, h2Limit = 32, optimisticH2 = true) {
    this.limit = limit;
    this.h2Limit = h2Limit;
    this.optimisticH2 = optimisticH2;
    this.state = new Map();
  }

  slotOf(key) {
    const host = key || 'unknown';
    let slot = this.state.get(host);
    if (!slot) {
      slot = { active: 0, queue: [], limit: this.optimisticH2 ? this.h2Limit : this.limit, fails: 0 };
      this.state.set(host, slot);
    }
    return slot;
  }

  currentLimit(key) {
    return this.slotOf(key).limit;
  }

  // 失败累计到 2 次: 从多路复用的高上限回退到 HTTP/1.1 的 6(每主机只回退一次)
  noteFailure(key) {
    const slot = this.slotOf(key);
    slot.fails++;
    if (slot.fails >= 2 && slot.limit > this.limit) {
      slot.limit = this.limit;
      return true;
    }
    return false;
  }

  async run(key, fn) {
    const slot = this.slotOf(key);
    if (slot.active >= slot.limit) {
      await new Promise((resolve) => slot.queue.push(resolve));
    }
    slot.active++;
    try {
      return await fn();
    } finally {
      slot.active--;
      const next = slot.queue.shift();
      if (next) next();
    }
  }
}

export class DownloadEngine {
  constructor(options) {
    this.plan = options.plan;
    this.writer = options.writer;
    this.sources = options.sources;
    this.hashEngine = options.hashEngine;
    this.hashPool = options.hashPool || null;
    this.chunkSize = options.chunkSize || (1 << 20);
    this.concurrency = options.concurrency || 8;
    // 单文件内部同时在飞的请求数: 分片模式下总并发 = 文件数 × 该值
    this.chunkWindow = Math.max(1, options.chunkWindow || 4);
    // 分片下载(同一文件发多个 Range): 部分站点会把它当异常流量, 默认关闭, 整文件单请求
    this.chunked = options.chunked === true;
    this.hostLimiter = new HostLimiter(options.hostConcurrency || 6, options.h2HostConcurrency || 32, options.optimisticH2 !== false);
    this.onInfo = options.onInfo || (() => { });
    this.fetchChunk = options.fetchChunk;
    this.streamFile = options.streamFile || null;
    this.readZipEntry = options.readZipEntry || (async (task) => task.zip.readEntry(task.zipEntry));
    this.onProgress = options.onProgress || (() => { });
    this.signal = options.signal || null;
    this.verifyHashes = options.verifyHashes !== false;
    this.stats = {
      bytesTotal: 0, bytesDone: 0, filesTotal: 0, filesDone: 0,
      startedAt: 0, perCategory: {}, failures: [], singleStream: 0, hashWorker: 0,
    };
    this.tasks = this.plan.tasks;
  }

  get stopped() {
    return Boolean(this.signal?.aborted);
  }

  category(task) {
    const name = task.category || 'other';
    return this.stats.perCategory[name] ||
      (this.stats.perCategory[name] = { count: 0, bytes: 0, done: 0, bytesDone: 0, failed: 0 });
  }

  // 预排布: 只做一次
  async prepare() {
    if (this.prepared) return;
    const { writer, tasks } = this;
    writer.hashEngine = this.hashEngine;
    this.stats.startedAt = performance.now();

    for (const task of tasks) {
      const size = task.kind === 'local' ? task.bytes.length : task.size;
      const cat = this.category(task);
      cat.count++;
      this.stats.filesTotal++;
      if (task.kind === 'local' || size > 0) {
        cat.bytes += size;
        this.stats.bytesTotal += size;
        task.entry = writer.reserve(task.path, size, 0);
      } else {
        task.unknownSize = true;
      }
    }
    await writer.layout();
    this.prepared = true;
  }

  async run() {
    await this.prepare();
    await this.executeAll();
    return this.stats;
  }

  // 只重跑失败条目: 数据区位置不变, 覆盖原占位后重新封包
  async runRetry() {
    await this.prepare();
    const retryable = this.tasks.filter((t) => t.failed && t.kind !== 'local');
    if (!retryable.length) return this.stats;
    for (const task of retryable) {
      task.failed = false;
      task.done = false;
      task.bytesDone = 0;
      task.singleStream = false;
      task.finished = false;
      if (task.handle?.hasher) task.handle.hasher.abort();
      task.handle = null;
      if (task.entry) this.writer.resetEntry(task.entry);
      const cat = this.category(task);
      cat.failed = Math.max(0, cat.failed - 1);
    }
    const paths = new Set(retryable.map((t) => t.path));
    this.stats.failures = this.stats.failures.filter((f) => !paths.has(f.path));
    await this.executeAll();
    return this.stats;
  }

  async finalize() {
    const kept = await this.writer.finalize();
    this.stats.elapsed = performance.now() - this.stats.startedAt;
    this.stats.zipBytes = this.writer.totalSize;
    this.stats.entryCount = kept.length;
    return this.stats;
  }

  async executeAll() {
    const { writer, tasks } = this;
    for (const task of tasks) {
      if (task.kind !== 'local' || task.done || task.failed || this.stopped) continue;
      const crc = this.hashEngine.crc32Of(task.bytes);
      await writer.writeChunk(task.entry, 0, task.bytes, crc, 0);
      await writer.sealEntry(task.entry, crc);
      this.complete(task, task.bytes.length);
    }

    for (const task of tasks) {
      if (task.kind !== 'zip' || task.done || task.failed || this.stopped) continue;
      try {
        const bytes = await this.readZipEntry(task);
        const crc = this.hashEngine.crc32Of(bytes);
        if (task.crc32 !== undefined && crc !== (task.crc32 >>> 0)) {
          throw new Error(`CRC32 不匹配 期望 ${task.crc32.toString(16)} 实际 ${crc.toString(16)}`);
        }
        await writer.writeChunk(task.entry, 0, bytes, crc, 0);
        await writer.sealEntry(task.entry, crc);
        this.complete(task, bytes.length);
      } catch (err) {
        await this.fail(task, err);
      }
    }

    await this.runHttpTasks();

    for (const task of tasks) {
      if (task.kind !== 'http' || !task.unknownSize || task.done || task.failed || this.stopped) continue;
      await this.downloadUnknownSize(task);
    }
  }

  // 哈希句柄
  beginHash(task, verify) {
    const needSha1 = Boolean(verify && task.sha1 && this.verifyHashes);
    if (this.hashPool) {
      const { id, promise } = this.hashPool.init(needSha1);
      this.stats.hashWorker++;
      return { kind: 'pool', id, promise, needSha1 };
    }
    return { kind: 'local', hasher: needSha1 ? new Sha1(this.hashEngine) : null };
  }

  pushHash(task, handle, bytes, crc) {
    if (handle.kind === 'pool') {
      if (handle.needSha1) this.hashPool.push(handle.id, bytes);
      return;
    }
    if (handle.hasher) handle.hasher.update(bytes);
  }

  async endHash(task, handle) {
    if (handle.kind === 'pool') {
      if (!handle.needSha1) {
        this.hashPool.finish(handle.id).catch(() => { });
        return { crc: this.writer.terminalCrc(task.entry), sha1: null };
      }
      const result = await handle.promise;
      return { crc: result.crc, sha1: result.sha1 };
    }
    return {
      crc: this.writer.terminalCrc(task.entry),
      sha1: handle.hasher ? hexOf(handle.hasher.digest()) : null,
    };
  }

  dropHash(task, handle) {
    if (!handle) return;
    if (handle.kind === 'pool' && handle.needSha1) this.hashPool.finish(handle.id).catch(() => { });
    if (handle.kind === 'local' && handle.hasher) handle.hasher.abort();
  }

  async verifyAndSeal(task, handle) {
    const result = await this.endHash(task, handle);
    if (task.sha1 && this.verifyHashes) {
      if (!result.sha1 || result.sha1.toLowerCase() !== task.sha1.toLowerCase()) {
        await this.fail(task, new Error(`SHA-1 不匹配 期望 ${task.sha1} 实际 ${result.sha1 || '缺失'}`));
        return false;
      }
      task.verified = true;
    }
    await this.writer.sealEntry(task.entry, result.crc);
    this.complete(task, 0);
    return true;
  }

  // 远端条目
  async runHttpTasks() {
    const pending = this.tasks.filter((t) => t.kind === 'http' && !t.unknownSize && !t.done && !t.failed);
    let cursor = 0;
    const runners = [];
    // 分片模式: 每个文件内 chunkWindow 个请求在飞, 文件级协程数 = 并发 / chunkWindow
    // 整文件模式: 一个文件一条连接, 文件级协程数直接等于并发
    const width = this.chunked
      ? Math.max(1, Math.min(Math.ceil(this.concurrency / this.chunkWindow), pending.length))
      : Math.max(1, Math.min(this.concurrency, pending.length));
    for (let i = 0; i < width; i++) {
      runners.push((async () => {
        for (;;) {
          if (this.stopped) return;
          const task = pending[cursor++];
          if (!task) return;
          if (this.chunked) await this.downloadRanged(task);
          else await this.downloadStreamed(task);
        }
      })());
    }
    await Promise.all(runners);
  }

  // 分片流水线: 单文件内保持 chunkWindow 个请求在飞, 按序落盘与喂哈希
  async downloadRanged(task) {
    task.phase = 'start';
    const handle = this.beginHash(task, true);
    const numChunks = Math.max(1, Math.ceil(task.size / this.chunkSize));
    const inflight = [];
    let launched = 0;
    let failure = null;

    const launch = () => {
      if (launched >= numChunks || failure) return;
      const idx = launched++;
      const start = idx * this.chunkSize;
      const end = Math.min(start + this.chunkSize, task.size) - 1;
      const promise = this.fetchChunkWithRetry({ task, start, end, index: idx, urls: this.rankUrls(task) })
        .catch((err) => { if (!failure) failure = err; return null; });
      inflight.push({ idx, start, end, promise });
    };

    try {
      for (let i = 0; i < this.chunkWindow; i++) launch();
      while (inflight.length) {
        const slot = inflight.shift();
        const chunk = await slot.promise;
        if (!chunk) {
          await Promise.allSettled(inflight.map((s) => s.promise));
          inflight.length = 0;
          if (failure?.name === 'RangeUnsupportedError') {
            this.dropHash(task, handle);
            await this.downloadStreamed(task, { fallback: true });
            return;
          }
          throw failure;
        }
        if (this.sources && chunk.url) {
          try { this.sources.markHost(this.sources.hostKey(chunk.url), true); } catch { }
        }
        const length = chunk.bytes.length;
        if (length !== slot.end - slot.start + 1) {
          throw new Error(`分片长度不符 期望 ${slot.end - slot.start + 1} 实际 ${length}`);
        }
        task.phase = 'write#' + slot.idx;
        await this.writer.writeChunk(task.entry, slot.start, chunk.bytes, chunk.crc, slot.idx);
        task.phase = 'hash#' + slot.idx;
        this.pushHash(task, handle, chunk.bytes, chunk.crc);
        this.bump(task, length);
        launch();
        if (this.stopped) throw new Error('已取消');
      }
      task.phase = 'seal';
      await this.verifyAndSeal(task, handle);
      task.phase = 'done';
    } catch (err) {
      this.dropHash(task, handle);
      await this.fail(task, err);
    }
  }

  // 整文件一次性取回(不设 Range), 分片大小为个位数时使用
  async downloadWhole(task) {
    const handle = this.beginHash(task, true);
    try {
      const chunk = await this.fetchChunkWithRetry({ task, start: null, end: null, index: 0, urls: this.rankUrls(task), whole: true });
      const length = chunk.bytes.length;
      if (length !== task.size) throw new Error(`长度不符 期望 ${task.size} 实际 ${length}`);
      const crc = chunk.crc >>> 0;
      await this.writer.writeChunk(task.entry, 0, chunk.bytes, crc, 0);
      this.pushHash(task, handle, chunk.bytes, crc);
      this.bump(task, length);
      await this.verifyAndSeal(task, handle);
    } catch (err) {
      this.dropHash(task, handle);
      await this.fail(task, err);
    }
  }

  // 单连接流式: 默认模式(整文件一条请求), 以及源忽略 Range 时的回退
  async downloadStreamed(task, { fallback = false } = {}) {
    if (!this.streamFile) {
      await this.fail(task, new Error('源不支持 Range 且未提供流式通道'));
      return;
    }
    if (fallback) this.stats.singleStream++;
    const handle = this.beginHash(task, true);
    let offset = 0;
    let partIndex = 0;
    try {
      const urls = this.rankUrls(task);
      // 整文件模式同样走单主机闸门: 否则 16 个 runner 会对同一源同时开 16 条流
      const key = this.sources
        ? this.sources.hostKey(urls[0] || '')
        : (() => { try { return new URL(urls[0]).host; } catch { return ''; } })();
      const result = await this.hostLimiter.run(key, () => this.streamFile({ task, urls }, async (bytes, crc) => {
        const length = bytes.length;
        if (offset + length > task.size) return;
        await this.writer.writeChunk(task.entry, offset, bytes, crc, partIndex++);
        this.pushHash(task, handle, bytes, crc);
        offset += length;
        this.bump(task, length);
      }));
      if (offset !== task.size) throw new Error(`长度不符 期望 ${task.size} 实际 ${offset}`);
      if (this.sources && result?.url) {
        try { this.sources.markHost(this.sources.hostKey(result.url), true); } catch { }
      }
      await this.verifyAndSeal(task, handle);
    } catch (err) {
      this.noteHostFailure(err, task);
      this.dropHash(task, handle);
      await this.fail(task, err);
    }
  }

  // 大小未知: 单连接取回后追加; CRC 来自取回 Worker, SHA-1 走同一套句柄
  async downloadUnknownSize(task) {
    const handle = this.beginHash(task, true);
    try {
      const chunk = await this.fetchChunkWithRetry({ task, start: null, end: null, index: 0, urls: this.rankUrls(task), whole: true });
      const length = chunk.bytes.length;
      const crc = chunk.crc >>> 0;
      task.entry = await this.writer.addStored(task.path, chunk.bytes, 0);
      task.entry.crcParts = new Map([[0, { crc, len: length }]]);
      this.pushHash(task, handle, chunk.bytes, crc);
      task.size = length;
      this.category(task).bytes += length;
      this.stats.bytesTotal += length;
      this.bump(task, length);
      await this.verifyAndSeal(task, handle);
    } catch (err) {
      this.dropHash(task, handle);
      await this.fail(task, err);
    }
  }

  snapshot() {
    return this.tasks
      .filter((t) => t.kind === 'http' && (t.phase || t.done || t.failed))
      .map((t) => `${t.path.split('/').pop()}:${t.phase || (t.done ? 'done' : 'queued')}:${t.bytesDone || 0}/${t.size}`)
      .slice(0, 20);
  }

  rankUrls(task) {
    return this.sources ? this.sources.rank(task.urls) : task.urls;
  }

  // 失败记账: 主机熔断(镜像不可达时落到库代理/源站)与 HTTP/2 上限回退共用
  noteHostFailure(err, task) {
    if (!err || err.name === 'RangeUnsupportedError') return;
    const first = err?.url || (task?.urls && task.urls[0]) || '';
    const host = this.sources
      ? this.sources.hostKey(first)
      : (() => { try { return new URL(first).host; } catch { return first; } })();
    if (!host) return;
    if (this.sources && err?.url) {
      try { this.sources.markHost(host, false); } catch { }
    }
    if (this.hostLimiter.noteFailure(host)) {
      this.onInfo(`主机 ${host} 连续失败，回退到每主机 ${this.hostLimiter.limit} 条连接`);
    }
  }

  async fetchChunkWithRetry(job, attempts = 3) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.stopped) throw new Error('已取消');
      try {
        const first = (job.urls && job.urls[0]) || '';
        const key = this.sources ? this.sources.hostKey(first) : first;
        return await this.hostLimiter.run(key, () => this.fetchChunk(job));
      } catch (err) {
        lastError = err;
        if (err?.name === 'RangeUnsupportedError') break;
        this.noteHostFailure(err, job.task);
        await sleep(200 * Math.pow(2, attempt) + Math.random() * 200);
      }
    }
    throw lastError;
  }

  complete(task, bytes) {
    task.done = true;
    this.stats.filesDone++;
    this.category(task).done++;
    if (bytes) this.bump(task, bytes);
  }

  bump(task, bytes) {
    task.bytesDone = (task.bytesDone || 0) + bytes;
    this.stats.bytesDone += bytes;
    this.category(task).bytesDone += bytes;
    this.onProgress(this.stats);
  }

  async fail(task, err) {
    if (!task) return;
    if (task.failed) return;
    task.failed = true;
    this.writer.markFailed(task.entry);
    const cat = this.category(task);
    cat.failed++;
    this.stats.failures.push({ path: task.path, category: task.category, reason: err?.message || String(err) });
    this.onProgress(this.stats);
  }

  summary() {
    const { stats } = this;
    const secs = (stats.elapsed || (performance.now() - stats.startedAt)) / 1000;
    return { ...stats, speed: secs > 0 ? stats.bytesDone / secs : 0, ok: stats.failures.length === 0 };
  }
}

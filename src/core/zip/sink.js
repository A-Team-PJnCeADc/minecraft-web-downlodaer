// 输出目标: 支持随机定位写入的 sink
// 浏览器: File System Access(用户选定路径) 或 OPFS 暂存; Node 测试: 内存 sink
// 统一接口: writeAt(position, bytes) / truncate(size) / close()

export class MemorySink {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  async writeAt(position, bytes) {
    const end = position + bytes.length;
    if (end > this.length) {
      if (this.length === 0) {
        this.buffer = new Uint8Array(Math.max(end, 1 << 20));
      } else if (end > this.buffer.length) {
        const next = new Uint8Array(Math.max(end, this.buffer.length * 2));
        next.set(this.buffer.subarray(0, this.length));
        this.buffer = next;
      }
      this.length = end;
    }
    this.buffer.set(bytes, position);
  }

  async truncate(size) {
    if (size < this.length) this.length = size;
  }

  async close() {
    return this.buffer ? this.buffer.slice(0, this.length) : new Uint8Array(0);
  }
}

export class StreamSink {
  // writable: FileSystemWritableFileStream
  constructor(writable) {
    this.writable = writable;
    this.pending = Promise.resolve();
  }

  writeAt(position, bytes) {
    const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.pending = this.pending.then(() =>
      this.writable.write({ type: 'write', position, data }));
    return this.pending;
  }

  truncate(size) {
    this.pending = this.pending.then(() => this.writable.truncate(size));
    return this.pending;
  }

  async close() {
    await this.pending;
    await this.writable.close();
  }
}

export const STORAGE_NAME = 'mcweb-export.tmp';

// OPFS 暂存: 写入完成后取回 File 交给下载流程
export async function openOpfsSink(name = STORAGE_NAME) {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  return {
    sink: new StreamSink(writable),
    async finalize() {
      const file = await handle.getFile();
      return file;
    },
    async cleanup() {
      try { await root.removeEntry(name); } catch { }
    },
  };
}

// 直接写入用户选择的文件, 适用于超过 2GB 的压缩包
export async function openFileSink(suggestedName) {
  const handle = await window.showSaveFilePicker({
    suggestedName,
    types: [{ description: 'ZIP 压缩包', accept: { 'application/zip': ['.zip'] } }],
  });
  const writable = await handle.createWritable({ keepExistingData: false });
  return { sink: new StreamSink(writable), handle };
}

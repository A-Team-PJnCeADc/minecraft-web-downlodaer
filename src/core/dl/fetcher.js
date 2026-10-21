// 单个分片的取回: Range 请求 + 流式读取 + WASM CRC-32 增量计算
// 浏览器与 Node 共用; Worker 内使用独立 WASM 实例

export class RangeUnsupportedError extends Error { }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 流式读取的空转保护: 超过 stallMs 没有新数据就中止本次请求, 交给重试/换源
async function readWithStall(reader, controller, stallMs) {
  let timer = 0;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { controller.abort(); } catch { }
      reject(new Error(`读取超时 ${Math.round(stallMs / 1000)}s 无数据`));
    }, stallMs);
  });
  try {
    return await Promise.race([reader.read(), guard]);
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeStatusOk(status) {
  return status >= 200 && status < 300;
}

// 整文件流式取回: 不支持 Range 的源使用单连接, 按到达顺序回调每一段
export async function streamFetched(options) {
  const {
    urls, hashEngine, onPart, signal, timeout = 180000, retries = 1, stallMs = 12000, headMs = 15000,
  } = options;
  let lastError = null;
  for (const url of urls) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeout);
      let headTimer = 0;
      try {
        // 响应头也要有超时: 只等 body 的话, 连接被挂起时只能靠上层看门狗发现
        const res = await Promise.race([
          fetch(url, { signal: controller.signal, credentials: 'omit', mode: 'cors' }),
          new Promise((_, reject) => {
            headTimer = setTimeout(() => {
              try { controller.abort(); } catch { }
              reject(new Error(`连接 ${Math.round(headMs / 1000)}s 未建立 @ ${new URL(url).host}`));
            }, headMs);
          }),
        ]);
        clearTimeout(headTimer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        let offset = 0;
        for (;;) {
          const { done, value } = await readWithStall(reader, controller, stallMs);
          if (done) break;
          const crc = hashEngine.crc32Of(value, 0, value.length);
          await onPart(value, crc, offset);
          offset += value.length;
        }
        return { url, total: offset };
      } catch (err) {
        lastError = err;
        if (!err.url) err.url = url;
        if (attempt < retries) await sleep(300 * Math.pow(2, attempt));
      } finally {
        clearTimeout(headTimer);
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }
  }
  if (lastError && urls.length) lastError.attemptedUrls = urls;
  throw lastError || new Error('没有可用的下载地址');
}

export async function fetchChunkBytes(options) {
  const {
    urls, start, end, whole = false, signal, hashEngine,
    timeout = 15000, retries = 1, attemptOffset = 0, stallMs = 12000,
  } = options;

  let lastError = null;
  for (let u = attemptOffset; u < urls.length; u++) {
    const url = urls[u];
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const headers = {};
        if (!whole && start !== null) headers.Range = `bytes=${start}-${end}`;
        const res = await fetch(url, { headers, signal: controller.signal, credentials: 'omit', mode: 'cors' });
        if (res.status === 416) {
          // 该源手里的文件长度与索引不一致(偏短), 直接换源; 由上层退回整文件流式并靠 SHA-1 判定
          const err = new Error(`HTTP 416 范围不可满足 @ ${new URL(url).host}`);
          err.code = 'RANGE_UNSATISFIABLE';
          err.host = new URL(url).host;
          throw err;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} @ ${new URL(url).host}`);
        const expected = whole || start === null ? null : end - start + 1;
        if (expected !== null && res.status === 200) {
          // 服务器忽略 Range 直接回 200 全量: 交给整文件流式通道处理
          const declared = Number(res.headers.get('content-length') || 0);
          if (declared && declared !== expected) {
            throw new RangeUnsupportedError(`源忽略 Range（返回 ${declared}B, 期望分片 ${expected}B）`);
          }
        }
        const reader = res.body.getReader();
        let buffer = expected !== null ? new Uint8Array(expected) : null;
        const parts = buffer ? null : [];
        let received = 0;
        let crc = 0;
        for (;;) {
          const { done, value } = await readWithStall(reader, controller, stallMs);
          if (done) break;
          if (buffer) {
            if (received + value.length > buffer.length) {
              const grown = new Uint8Array(received + value.length);
              grown.set(buffer.subarray(0, received));
              buffer = grown;
            }
            buffer.set(value, received);
          } else {
            parts.push(value);
          }
          crc = hashEngine.crc32Of(value, 0, value.length, crc);
          received += value.length;
        }
        let bytes;
        if (buffer) {
          if (received !== buffer.length) {
            // 分片超长说明服务器回的是整个文件, 转单连接流式
            if (received > buffer.length) {
              throw new RangeUnsupportedError(`源忽略 Range（收到 ${received}B, 期望 ${buffer.length}B）`);
            }
            throw new Error(`分片长度不足 期望 ${buffer.length} 实际 ${received} @ ${new URL(url).host}`);
          }
          bytes = buffer;
        } else {
          bytes = new Uint8Array(received);
          let off = 0;
          for (const p of parts) { bytes.set(p, off); off += p.length; }
        }
        return { bytes, crc: crc >>> 0, url };
      } catch (err) {
        lastError = err;
        if (!err.url) err.url = url;
        if (err instanceof RangeUnsupportedError) break;
        if (err.code === 'RANGE_UNSATISFIABLE') break; // 同一源重试无意义, 换下一个候选
        if (attempt < retries) await sleep(300 * Math.pow(2, attempt));
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }
  }
  if (lastError && urls.length) lastError.attemptedUrls = urls.slice(attemptOffset);
  throw lastError || new Error('没有可用的下载地址');
}

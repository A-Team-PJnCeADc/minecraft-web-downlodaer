// 取回字节: 流式读 + 进度回调 + 停滞换源 + 取消
// 候选源按顺序试, 单个源 20s 没有新数据就判定停滞并换下一个
export async function fetchBytesWithProgress(urls, options = {}) {
  const {
    meta = null,
    label = '文件',
    cancel = null,
    log = () => {},
    onProgress = () => {},
    stallMs = 20000,
    fetchImpl = (...args) => fetch(...args),
  } = options;

  let lastErr = null;
  for (const url of urls) {
    cancel?.throwIfCancelled?.();
    const attempt = new AbortController();
    const unlink = cancel?.subscribe ? cancel.subscribe((type) => { if (type === 'cancel') attempt.abort(); }) : () => {};
    let stallTimer = null;
    const bump = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => attempt.abort(), stallMs);
    };
    try {
      bump();
      const res = await fetchImpl(url, { mode: 'cors', credentials: 'omit', signal: attempt.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const total = Number(res.headers.get('content-length')) || meta?.size || 0;
      let bytes;
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        let lastLog = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          bump();
          if (performance.now() - lastLog > 700) {
            lastLog = performance.now();
            log(`取回${label} ${mib(got)}${total ? ' / ' + mib(total) : ''}`);
          }
          onProgress(got, total);
          cancel?.throwIfCancelled?.();
        }
        bytes = new Uint8Array(got);
        let at = 0;
        for (const c of chunks) {
          bytes.set(c, at);
          at += c.length;
        }
      } else {
        bytes = new Uint8Array(await res.arrayBuffer());
      }
      if (meta?.size && bytes.length !== meta.size) {
        throw new Error(`大小不符 ${bytes.length} != ${meta.size}`);
      }
      log(`取回${label} 完成 ${mib(bytes.length)}`);
      onProgress(bytes.length, bytes.length);
      return bytes;
    } catch (err) {
      if (cancel?.cancelled) {
        const abort = new Error('已取消');
        abort.name = 'AbortError';
        throw abort;
      }
      lastErr = err?.name === 'AbortError' ? new Error('连接停滞') : err;
      log(`取回${label} 中断: ${lastErr.message}, 换下一个源`);
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      unlink();
    }
  }
  throw new Error(`${urls[0]}: ${lastErr?.message || '取回失败'}`);
}

function mib(n) {
  return `${(n / 1048576).toFixed(1)} MiB`;
}

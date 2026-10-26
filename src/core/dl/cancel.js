// 取消总线: 一次取消既发消息给订阅者(释放资源/更新界面), 也桥接 AbortSignal 给 fetch 与下载引擎
// 用法:
//   const bus = new CancelBus()
//   const un = bus.subscribe((type, payload) => { ... })   // 订阅
//   fetch(url, { signal: bus.toSignal() })                  // 桥接
//   bus.cancel('用户取消')                                  // 发布
export class CancelBus {
  constructor(label = '') {
    this.label = label;
    this.reason = null;
    this.subs = new Set();
    this.controller = null;
  }

  get cancelled() {
    return this.reason !== null;
  }

  // 订阅: 已取消时立即回调一次, 返回退订函数
  subscribe(fn) {
    this.subs.add(fn);
    if (this.cancelled) fn('cancel', this.reason);
    return () => this.subs.delete(fn);
  }

  publish(type, payload) {
    for (const fn of [...this.subs]) {
      try {
        fn(type, payload);
      } catch {
        // 订阅者异常不影响其它订阅者
      }
    }
  }

  cancel(reason = '已取消') {
    if (this.cancelled) return false;
    this.reason = reason;
    this.publish('cancel', reason);
    this.controller?.abort();
    return true;
  }

  // fetch / 下载引擎要 AbortSignal
  toSignal() {
    if (!this.controller) this.controller = new AbortController();
    if (this.cancelled && !this.controller.signal.aborted) this.controller.abort();
    return this.controller.signal;
  }

  throwIfCancelled() {
    if (!this.cancelled) return;
    const err = new Error(this.reason);
    err.name = 'AbortError';
    throw err;
  }
}

// 兼容: 传 AbortSignal 或 CancelBus 都行
export function asCancel(cancel) {
  if (!cancel) return null;
  if (cancel instanceof CancelBus) return cancel;
  if (typeof cancel.cancelled === 'boolean') return cancel;
  if (typeof cancel.aborted === 'boolean') {
    return {
      get cancelled() {
        return cancel.aborted;
      },
      throwIfCancelled() {
        if (!cancel.aborted) return;
        const err = new Error('已取消');
        err.name = 'AbortError';
        throw err;
      },
    };
  }
  return null;
}

export function isAbort(err) {
  return err?.name === 'AbortError';
}

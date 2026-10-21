// 通过 CDP 驱动本机 Chrome: 打开页面、执行脚本、截图, 用于界面与导出流程验证
// 用法: node tools/cdp.mjs <脚本.json>   脚本: [{goto}|{wait}|{eval}|{shot}|{click}|{sleep}]
import { writeFile, readFile } from 'node:fs/promises';

const DEVTOOLS = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
const scriptPath = process.argv[2];

async function targets() {
  const res = await fetch(DEVTOOLS + '/json/list');
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const msgId = ++id;
          pending.set(msgId, { res, rej });
          ws.send(JSON.stringify({ id: msgId, method, params }));
        });
      },
      events,
      close: () => ws.close(),
    });
    ws.onerror = (e) => reject(new Error('CDP 连接失败: ' + (e.message || 'unknown')));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await targets();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('没有可用的页面目标');
const cdp = await connect(page.webSocketDebuggerUrl);

await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');

const steps = JSON.parse(await readFile(scriptPath, 'utf8'));
for (const step of steps) {
  if (step.goto) {
    await cdp.send('Page.navigate', { url: step.goto });
    await sleep(step.wait ?? 2500);
  } else if (step.eval) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: step.eval, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) console.log('EVAL ERROR:', JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    else console.log('EVAL:', JSON.stringify(r.result?.value));
    await sleep(step.wait ?? 200);
  } else if (step.shot) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(step.shot, Buffer.from(r.data, 'base64'));
    console.log('SHOT:', step.shot);
  } else if (step.sleep) {
    await sleep(step.sleep);
  }
}

const errors = cdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error');
if (errors.length) {
  console.log('页面错误:');
  for (const e of errors) console.log('  ', e.params.entry.text, e.params.entry.url || '');
}
cdp.close();

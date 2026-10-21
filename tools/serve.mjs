// 静态文件服务器: 仅用于本地调试, 提供正确的 MIME 与禁用缓存
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';
    const file = join(root, normalize(path).replace(/^([/\\])+/, ''));
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(file);
    if (info.isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      // 开发期禁用缓存: 改完 JS 直接刷新就能生效, 避免旧脚本继续跑
      'Cache-Control': 'no-store',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

// 端口占用时自动顺延, 避免直接抛 EADDRINUSE
function listen(candidate) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && candidate < port + 20) {
      console.log(`端口 ${candidate} 被占用, 尝试 ${candidate + 1}`);
      listen(candidate + 1);
    } else {
      console.error('启动失败:', err.message);
      process.exit(1);
    }
  });
  // 默认只监听本机: config/keys.local.json 会被静态托管, 不能暴露到局域网
  server.listen(candidate, process.env.HOST || '127.0.0.1', () => {
    console.log(`http://127.0.0.1:${candidate}/`);
  });
}

listen(port);

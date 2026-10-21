// 构建静态站点: 只把浏览器要用的文件拷进 dist/, 供 Cloudflare Workers 静态资源部署
// 运行时读取的东西会一起带上: index.html、assets/、src/ (模块与 wasm)、config/*.example.json
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await cp(join(root, 'index.html'), join(dist, 'index.html'));
await cp(join(root, 'assets'), join(dist, 'assets'), { recursive: true });
await cp(join(root, 'src'), join(dist, 'src'), { recursive: true });

// config 只带示例文件: keys.local.json 是本机凭据, 不能随站点发布
await mkdir(join(dist, 'config'), { recursive: true });
for (const name of await readdir(join(root, 'config'))) {
  if (name.endsWith('.example.json')) {
    await cp(join(root, 'config', name), join(dist, 'config', name));
  }
}

let files = 0;
let bytes = 0;
const walk = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else {
      files++;
      bytes += (await stat(full)).size;
    }
  }
};
await walk(dist);
console.log(`dist/ 就绪: ${files} 个文件, ${(bytes / 1048576).toFixed(2)} MiB (${relative(root, dist)})`);

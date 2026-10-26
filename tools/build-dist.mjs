// 构建静态站点: 只把浏览器要用的文件拷进 dist/, 供 Cloudflare Workers 静态资源部署
// 运行时读取的东西会一起带上: index.html、assets/、src/ (模块与 wasm)、config/*.example.json
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await cp(join(root, 'index.html'), join(dist, 'index.html'));
await cp(join(root, 'assets'), join(dist, 'assets'), { recursive: true });
// jar 与 wasm 产物要随站点发布; Rust 源码目录(含 target/)只在开发期使用
const crateDir = join(root, 'src', 'wasm', 'javapatch');
await cp(join(root, 'src'), join(dist, 'src'), {
  recursive: true,
  filter: (source) => source !== crateDir && !source.startsWith(crateDir + sep),
});

// config 只带示例文件: keys.local.json 是本机凭据, 不能随站点发布
await mkdir(join(dist, 'config'), { recursive: true });
for (const name of await readdir(join(root, 'config'))) {
  if (name.endsWith('.example.json')) {
    await cp(join(root, 'config', name), join(dist, 'config', name));
  }
}

// 语法门禁: 浏览器模块一旦有解析错误, 整个页面连事件都绑不上, 所以构建时就拦下来
const scratch = join(tmpdir(), 'mcweb-syntax-check');
await mkdir(scratch, { recursive: true });
const syntaxErrors = [];
const checkSyntax = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { await checkSyntax(full); continue; }
    if (!entry.name.endsWith('.js')) continue;
    const temp = join(scratch, entry.name.replace(/\.js$/, '.mjs'));
    await cp(full, temp);
    try {
      execFileSync(process.execPath, ['--check', temp], { stdio: 'pipe' });
    } catch (err) {
      const out = String(err.stderr || err.message).split('\n').filter(Boolean).slice(0, 4).join(' | ');
      syntaxErrors.push(`${relative(dist, full)}: ${out}`);
    }
  }
};
await checkSyntax(join(dist, 'src'));
await rm(scratch, { recursive: true, force: true });
if (syntaxErrors.length) {
  console.error('构建中止: 模块语法错误');
  for (const line of syntaxErrors) console.error('  ' + line);
  process.exit(1);
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

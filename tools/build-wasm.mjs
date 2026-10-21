// 用 wabt 把 src/wasm/hash.wat 汇编为 src/wasm/hash.wasm
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wabtInit = (await import('wabt')).default;
const wabt = await wabtInit();

const wat = await readFile(resolve(root, 'src/wasm/hash.wat'), 'utf8');
const mod = wabt.parseWat('hash.wat', wat, { mutable_globals: true });
const { buffer } = mod.toBinary({ log: false, write_debug_names: true });
await writeFile(resolve(root, 'src/wasm/hash.wasm'), Buffer.from(buffer));
console.log('hash.wasm', buffer.byteLength, 'bytes');

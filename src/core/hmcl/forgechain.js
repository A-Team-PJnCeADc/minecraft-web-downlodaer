// Forge/NeoForge 补丁链: 原版 client.jar -> 改名 -> 打 binpatch, 全部在浏览器内完成
// 语义按安装器实际使用的工具区分:
//   SpecialSource 1.8.5 = 读入 ClassNode 再写回, 新建常量池, ASM 6 的引导方法顺序
//   ForgeAutoRenamingTool 0.1.x / ART 2.x = 流式改名 + 新建常量池
//   ART 0.1.2x(1.19/1.20) = 流式改名 + 复制常量池
import { readJar, writeJar } from '../jar/jar.js';
import { readPatchArchive, applyPatches } from '../jar/binpatch.js';
import { ZipReader } from '../zip/reader.js';

// 各版本家族对应的重写器参数(实测逐类字节一致时使用的取值)
export function chainSpecFor(gameVersion) {
  const v = String(gameVersion || '');
  const m = v.match(/^(\d+)\.(\d+)/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major >= 26) return { flags: 8, invert: false, kind: 'binpatch-only', mappings: 'none' };
  if (major !== 1) return null;
  if (minor <= 12) return null; // 1.7.10 / 1.12.2 只有 universal jar, 没有处理器
  // 1.13-1.16: MCP_DATA 直接给 SpecialSource, 类名用 srg
  if (minor <= 16) return { flags: 40, invert: false, kind: 'specialsource', mappings: 'joined' };
  // 1.17-1.18: ART 新建池, MERGED_MAPPINGS(类名换成官方)
  if (minor <= 18) return { flags: 254, invert: false, kind: 'art-fresh', mappings: 'merged' };
  // 1.19-1.20: ART 复制池, MERGED_MAPPINGS
  if (minor <= 20) return { flags: 38, invert: false, kind: 'art-copy', mappings: 'merged' };
  // 1.21.x: ART --names {MOJMAPS} --reverse --strip-sigs, mojmaps 需先做 sanitize
  if (minor === 21) return { flags: 126, invert: true, kind: 'installertools', mappings: 'mojmap' };
  return null;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function u16(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, false);
  return b;
}

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

function str(s) {
  const body = enc.encode(s ?? '');
  return concat([u16(body.length), body]);
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// MCPConfig / TSRG2 文本映射: 返回 混淆名 -> 目标名 的表
export function parseMappings(text, { invert = false } = {}) {
  const classes = new Map();
  const fields = new Map();
  const methods = new Map();
  const params = [];
  const lines = text.split(/\r?\n/);

  if (invert) {
    // 1.21.x: 行为"官方名 混淆名", 描述符里的类名也是官方名
    const rev = new Map();
    for (const line of lines) {
      if (!line || line.startsWith('\t') || line.startsWith('tsrg2')) continue;
      const [official, obf] = line.split(' ');
      if (!official || !obf) continue;
      classes.set(obf, official);
      rev.set(official, obf);
    }
    const obfDesc = (d) => d.replace(/L([^;]+);/g, (m, p1) => `L${rev.get(p1) || p1};`);
    let owner = null;
    let lastMethod = null;
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('\t\t')) {
        const sub = line.slice(2).split(' ');
        if (lastMethod && sub.length >= 2 && /^\d+$/.test(sub[0])) {
          params.push([lastMethod[0], lastMethod[1], lastMethod[2], Number(sub[0]), sub[sub.length - 2]]);
        }
        continue;
      }
      if (!line.startsWith('\t')) {
        owner = line.split(' ')[1];
        lastMethod = null;
        continue;
      }
      const parts = line.slice(1).split(' ');
      if (parts.length === 2) {
        fields.set(`${owner}\u0000${parts[1]}`, parts[0]);
        lastMethod = null;
      } else if (parts.length >= 3) {
        const desc = obfDesc(parts[1]);
        methods.set(`${owner}\u0000${parts[2]}\u0000${desc}`, parts[0]);
        lastMethod = [owner, parts[2], desc];
      }
    }
    return { classes, fields, methods, params };
  }

  let owner = null;
  let lastMethod = null;
  for (const line of lines) {
    if (!line || line.startsWith('tsrg2')) continue;
    if (!line.startsWith('\t')) {
      const parts = line.split(' ');
      if (parts.length >= 2) {
        classes.set(parts[0], parts[1]);
        owner = parts[0];
        lastMethod = null;
      }
      continue;
    }
    if (line.startsWith('\t\t')) {
      const sub = line.slice(2).split(' ');
      if (lastMethod && sub.length >= 2 && /^\d+$/.test(sub[0])) {
        params.push([lastMethod[0], lastMethod[1], lastMethod[2], Number(sub[0]), sub[sub.length - 1]]);
      }
      continue;
    }
    const parts = line.slice(1).split(' ');
    if (parts.length === 2) {
      fields.set(`${owner}\u0000${parts[0]}`, parts[1]);
      lastMethod = null;
    } else if (parts.length >= 3) {
      methods.set(`${owner}\u0000${parts[0]}\u0000${parts[1]}`, parts[2]);
      lastMethod = [owner, parts[0], parts[1]];
    }
  }
  return { classes, fields, methods, params };
}

// 读 class 的父类/接口/字段描述符; 字段映射要带描述符才能和引用对上
function classInfo(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, false) !== 0xcafebabe) return null;
  const count = dv.getUint16(8, false);
  const utf8 = new Array(count);
  const classRef = new Array(count);
  let p = 10;
  for (let i = 1; i < count; i++) {
    const tag = bytes[p];
    if (tag === 1) {
      const len = dv.getUint16(p + 1, false);
      utf8[i] = dec.decode(bytes.subarray(p + 3, p + 3 + len));
      p += 3 + len;
    } else if (tag === 7) {
      classRef[i] = dv.getUint16(p + 1, false);
      p += 3;
    } else if (tag === 8 || tag === 16 || tag === 19 || tag === 20) {
      p += 3;
    } else if (tag === 15) {
      p += 4;
    } else if (tag === 3 || tag === 4 || tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 17 || tag === 18) {
      p += 5;
    } else if (tag === 5 || tag === 6) {
      p += 9;
      i++;
    } else {
      return null;
    }
  }
  const superIndex = dv.getUint16(p + 4, false);
  p += 6;
  const ifaceCount = dv.getUint16(p, false);
  p += 2;
  const interfaces = [];
  for (let i = 0; i < ifaceCount; i++) {
    const idx = dv.getUint16(p, false);
    interfaces.push(utf8[classRef[idx]] ?? '');
    p += 2;
  }
  const fieldCount = dv.getUint16(p, false);
  p += 2;
  const fields = [];
  for (let i = 0; i < fieldCount; i++) {
    fields.push([utf8[dv.getUint16(p + 2, false)] ?? '', utf8[dv.getUint16(p + 4, false)] ?? '']);
    const attrCount = dv.getUint16(p + 6, false);
    p += 8;
    for (let k = 0; k < attrCount; k++) {
      p += 6 + dv.getUint32(p + 2, false);
    }
  }
  const methodCount = dv.getUint16(p, false);
  p += 2;
  const methods = [];
  for (let i = 0; i < methodCount; i++) {
    methods.push([utf8[dv.getUint16(p + 2, false)] ?? '', utf8[dv.getUint16(p + 4, false)] ?? '']);
    const attrCount = dv.getUint16(p + 6, false);
    p += 8;
    for (let k = 0; k < attrCount; k++) {
      p += 6 + dv.getUint32(p + 2, false);
    }
  }
  return { superName: superNameOf(utf8, classRef, superIndex), interfaces, fields, methods };
}

function superNameOf(utf8, classRef, index) {
  if (!index) return '';
  return utf8[classRef[index]] ?? '';
}


// 合并映射: joined.tsrg + 官方映射 -> tsrg2(混淆 -> 官方类名, 成员保留 srg 名)
// 与 installertools MergeMappings --classes --reverse-right 的产物逐行一致
export function mergeMappings(joinedText, mojmapText) {
  const officialOf = new Map();
  for (const line of mojmapText.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith(' ')) continue;
    const m = line.match(/^(\S+) -> (\S+):$/);
    if (m) officialOf.set(m[2].replace(/\./g, '/'), m[1].replace(/\./g, '/'));
  }
  const out = ['tsrg2 left right'];
  for (const raw of joinedText.split(/\r?\n/)) {
    if (!raw || raw.startsWith('tsrg2')) continue;
    const parts = raw.split(' ');
    if (!raw.startsWith('\t')) {
      out.push(`${parts[0]} ${officialOf.get(parts[0]) ?? parts[1]}`);
      continue;
    }
    // 末列是数字 id, 合并产物里不保留
    if (/^\d+$/.test(parts[parts.length - 1])) parts.pop();
    out.push(parts.join(' '));
  }
  return out.join('\n') + '\n';
}


// 官方映射(proguard 文本): 混淆名 -> 官方名, 成员按 混淆类+混淆名 索引
export function parseProguardMappings(text) {
  const classes = new Map();
  const members = new Map();
  let owner = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.startsWith('#')) continue;
    if (!raw.startsWith(' ')) {
      const m = raw.match(/^(\S+) -> (\S+):$/);
      if (!m) continue;
      owner = m[2].replace(/\./g, '/');
      classes.set(owner, m[1].replace(/\./g, '/'));
      continue;
    }
    if (!owner) continue;
    const m = raw.trim().match(/^(?:\d+:\d+:)?(\S+ )?(.+?) -> (\S+)$/);
    if (!m) continue;
    members.set(`${owner}\u0000${m[3]}`, m[2]);
  }
  return { classes, members };
}

// 用 proguard 表 + 输入类结构直接组表
export function buildMapsFromProguard(tables, entries) {
  const { classes, members } = tables;
  const fieldEntries = [];
  const methodEntries = [];
  const hierarchy = [];
  for (const [name, data] of entries) {
    if (!name.endsWith('.class')) continue;
    const owner = name.slice(0, -6);
    if (!classes.has(owner)) continue;
    let info;
    try {
      info = classInfo(data);
    } catch {
      info = null;
    }
    if (!info) continue;
    hierarchy.push([owner, info.superName, info.interfaces]);
    for (const [fname, fdesc] of info.fields) {
      const target = members.get(`${owner}\u0000${fname}`);
      if (target) fieldEntries.push([owner, fname, fdesc, target]);
    }
    for (const [mname, mdesc] of info.methods) {
      const target = members.get(`${owner}\u0000${mname}`);
      if (target) methodEntries.push([owner, mname, mdesc, target]);
    }
  }
  return packBlob([...classes.entries()], fieldEntries, methodEntries, [], hierarchy);
}


// mojmap(proguard 文本) -> 官方 tsrg(官方名在前, 描述符用 JVM 形式)
// 与 installertools DownloadMojmaps --sanitize 的输出同形
const PRIM = { void: 'V', boolean: 'Z', byte: 'B', char: 'C', short: 'S', int: 'I', long: 'J', float: 'F', double: 'D' };

function javaTypeToDesc(type) {
  const dims = [];
  let t = type.trim();
  while (t.endsWith('[]')) {
    dims.push('[');
    t = t.slice(0, -2).trim();
  }
  const prim = PRIM[t];
  const base = prim ? prim : `L${t.replace(/\./g, '/').replace(/\$/g, '$')};`;
  return dims.join('') + base;
}

function javaMethodToDesc(sig) {
  const open = sig.indexOf('(');
  const ret = javaTypeToDesc(sig.slice(0, open));
  const params = sig.slice(open + 1, sig.lastIndexOf(')'));
  const parts = params ? params.split(',').map((x) => javaTypeToDesc(x)) : [];
  return `(${parts.join('')})${ret}`;
}

export function sanitizeMojmap(text) {
  const out = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.startsWith('#')) continue;
    if (!raw.startsWith(' ')) {
      const m = raw.match(/^(\S+) -> (\S+):$/);
      if (!m) continue;
      current = [];
      out.push([m[1].replace(/\./g, '/'), m[2].replace(/\./g, '/'), current]);
      continue;
    }
    if (!current) continue;
    const m = raw.trim().match(/^(?:\d+:\d+:)?(\S+(?:\s+\S+)?)\s+([^\s(]+)\((.*)\) -> (\S+)$/);
    if (m) {
      const desc = `(${m[3] ? m[3].split(',').map((x) => javaTypeToDesc(x)).join('') : ''})${javaTypeToDesc(m[1])}`;
      current.push(`\t${m[2]} ${desc} ${m[4]}`);
      continue;
    }
    const f = raw.trim().match(/^(\S+(?:\s+\S+)?)\s+(\S+) -> (\S+)$/);
    if (f) current.push(`\t${f[2]} ${f[3]}`);
  }
  const lines = [];
  for (const [official, obf, members] of out) {
    lines.push(`${official} ${obf}`);
    lines.push(...members);
  }
  return lines.join('\n') + '\n';
}

// RMAP1 映射表: 类、字段、方法、参数名、继承关系
export function buildMapsBlob(parsed, entries) {
  const { classes, fields, methods, params } = parsed;
  const fieldEntries = [];
  const hierarchy = [];
  for (const [name, data] of entries) {
    if (!name.endsWith('.class')) continue;
    const owner = name.slice(0, -6);
    let info;
    try {
      info = classInfo(data);
    } catch {
      info = null;
    }
    if (!info) continue;
    hierarchy.push([owner, info.superName, info.interfaces]);
    for (const [fname, fdesc] of info.fields) {
      const target = fields.get(`${owner}\u0000${fname}`);
      if (target) fieldEntries.push([owner, fname, fdesc, target]);
    }
  }
  const classEntries = [...classes.entries()];
  const methodEntries = [...methods.entries()].map(([k, v]) => k.split('\u0000').concat(v));
  return packBlob(classEntries, fieldEntries, methodEntries, params, hierarchy);
}

function packBlob(classEntries, fieldEntries, methodEntries, params, hierarchy) {
  return concat([
    enc.encode('RMAP1'),
    u32(classEntries.length),
    ...classEntries.flatMap(([a, b]) => [str(a), str(b)]),
    u32(fieldEntries.length),
    ...fieldEntries.flatMap((e) => e.map(str)),
    u32(methodEntries.length),
    ...methodEntries.flatMap((e) => e.map(str)),
    u32(params.length),
    ...params.flatMap(([o, n, d, i, name]) => [str(o), str(n), str(d), new Uint8Array([i]), str(name)]),
    u32(hierarchy.length),
    ...hierarchy.flatMap(([n, sup, ifaces]) => [str(n), str(sup), u16(ifaces.length), ...ifaces.map((x) => str(x))]),
  ]);
}

// 逐类改名; 失败时抛错并带类名
export function remapEntries(engine, entries, blob, flags, onProgress, classMap = null) {
  const ex = engine.exports;
  const mem = () => new Uint8Array(engine.memory.buffer);
  const put = (bytes) => engine.put(bytes);
  const mapsPtr = put(blob);
  const rc = ex.maps_init(mapsPtr, blob.length);
  if (rc !== 0) {
    const msg = dec.decode(mem().subarray(ex.error_ptr(), ex.error_ptr() + ex.error_len()));
    throw new Error(`映射表载入失败: ${msg}`);
  }
  const out = new Map();
  let done = 0;
  for (const [name, data] of entries) {
    if (!name.endsWith('.class')) {
      out.set(name, data);
      continue;
    }
    const n = ex.remap_class(put(data), data.length, flags);
    if (n < 0) {
      const msg = dec.decode(mem().subarray(ex.error_ptr(), ex.error_ptr() + ex.error_len()));
      throw new Error(`${name}: ${msg}`);
    }
    let entryName = name;
    if (classMap) {
      const target = classMap.get(name.slice(0, -6));
      if (target) entryName = target + '.class';
    }
    out.set(entryName, mem().slice(ex.result_ptr(), ex.result_ptr() + n));
    done++;
    if (onProgress && done % 200 === 0) onProgress(done, entries.size);
  }
  return out;
}

// 完整链路: 原版 jar + 映射 + binpatch -> 打过补丁的 jar
export async function applyForgeChain(options) {
  const { engine, clientJar, mappingsText = null, mojmapText = null, patchBytes, spec, onStatus = null } = options;
  const mode = spec.mappings || (mojmapText ? 'merged' : 'joined');
  onStatus?.('解析映射表');
  const client = await readJar(clientJar);
  let blob;
  let classMap = null;
  if (mode === 'mojmap') {
    if (!mojmapText) throw new Error('该版本需要官方映射');
    onStatus?.('转换官方映射');
    const parsed = parseMappings(sanitizeMojmap(mojmapText), { invert: true });
    onStatus?.('构建映射');
    blob = buildMapsBlob(parsed, client.entries);
    classMap = parsed.classes;
  } else {
    const text = mode === 'merged'
      ? mergeMappings(mappingsText, mojmapText ?? (() => { throw new Error('映射合并需要官方映射'); })())
      : mappingsText;
    const parsed = parseMappings(text, { invert: spec.invert });
    onStatus?.('构建映射');
    blob = buildMapsBlob(parsed, client.entries);
    classMap = parsed.classes;
  }
  onStatus?.('改名字节码');
  const remapped = remapEntries(engine, client.entries, blob, spec.flags, (done, total) => {
    onStatus?.(`改名 ${done}/${total}`);
  }, classMap);
  if (!patchBytes) return { jar: await writeJar(remapped), remapped };
  onStatus?.('应用补丁');
  const archive = await readPatchArchive(engine, patchBytes);
  const result = applyPatches(engine, remapped, archive, { strict: true });
  if (result.stats.failed?.length) {
    throw new Error(`补丁基线校验失败 ${result.stats.failed.length} 项: ${result.stats.failed[0]}`);
  }
  onStatus?.('写出 jar');
  return { jar: await writeJar(result.items), remapped, stats: result.stats };
}

// 按计划执行: 取回客户端 jar、MCP 配置、官方映射与补丁, 产出打过补丁的 jar
export async function runPlannedChain(plan, { engine, onStatus = null, fetchBytes }) {
  const chain = plan.forgeChain;
  if (!chain) throw new Error('计划里没有补丁链');
  const zip = plan.forgeInfo?.zip;
  if (!zip) throw new Error('缺少安装器 zip');
  const mode = chain.spec.mappings || 'merged';
  if (!chain.client?.urls?.length) throw new Error('缺少客户端 jar 地址');

  onStatus?.('取回客户端 jar');
  const clientBytes = await fetchBytes(chain.client.urls, chain.client);

  let mojmapText = null;
  if (mode !== 'joined') {
    if (!chain.mojmap?.urls?.length) throw new Error('缺少官方映射地址');
    onStatus?.('取回官方映射');
    mojmapText = new TextDecoder().decode(await fetchBytes(chain.mojmap.urls, chain.mojmap));
  }

  let joinedText = null;
  if (mode !== 'mojmap') {
    if (!chain.mcpConfig?.urls?.length) throw new Error('缺少 MCP 配置地址');
    onStatus?.('取回 MCP 配置');
    const mcpBytes = await fetchBytes(chain.mcpConfig.urls, chain.mcpConfig);
    const mcpZip = await new ZipReader({
      size: mcpBytes.length,
      readAt: async (offset, length) => mcpBytes.subarray(offset, offset + length),
      inflateRaw: async (bytes) => {
        if (globalThis.DecompressionStream) {
          const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
          return new Uint8Array(await new Response(stream).arrayBuffer());
        }
        throw new Error('缺少 deflate-raw 解压能力');
      },
    }).open();
    joinedText = new TextDecoder().decode(await mcpZip.readEntry(chain.mcpConfig.entry || 'config/joined.tsrg'));
  }

  onStatus?.('读取补丁');
  const patchBytes = await zip.readEntry(chain.patchEntry || 'data/client.lzma');

  return applyForgeChain({
    engine,
    clientJar: clientBytes,
    mappingsText: joinedText,
    mojmapText,
    patchBytes,
    spec: chain.spec,
    onStatus,
  });
}

// 安装计划构建: 对齐 HMCL 的 GameBuilder 流程
// 顺序: 原版版本 JSON -> 加载器补丁 -> 库 -> 客户端 jar -> 资源索引/对象 -> 日志配置 -> 整合包文件与覆盖
import { chainSpecFor } from './forgechain.js';
import {
  collectLibraries, mergeVersionJson, assetObjectPath, sanitizeId,
} from './version.js';
import {
  loadVersionManifest, loadVersionJson, loadFabricProfile, forgeInstallerCandidates,
  fetchWithRetry, fetchJson, loadModrinthVersionFor, API_PROJECTS,
} from './providers.js';
import { ZipReader } from '../zip/reader.js';

const LOADER_NAMES = {
  fabric: 'fabric-loader',
  quilt: 'quilt-loader',
  legacyfabric: 'legacy-fabric',
  forge: 'forge',
  neoforge: 'neoforge',
};

export function instanceIdFor(gameVersion, loader) {
  if (!loader || !loader.type) return gameVersion;
  if (loader.type === 'fabric') return `fabric-loader-${loader.version}-${gameVersion}`;
  if (loader.type === 'quilt') return `quilt-loader-${loader.version}-${gameVersion}`;
  if (loader.type === 'legacyfabric') return `legacy-fabric-loader-${loader.version}-${gameVersion}`;
  return `${gameVersion}-${LOADER_NAMES[loader.type] || loader.type}-${loader.version}`;
}

const LOADER_CACHE_TTL = 30 * 24 * 3600 * 1000;
const LOADER_CACHE_KEY = 'mcweb.loaderPatchCache.v1';

function readLoaderCache(key) {
  try {
    const all = JSON.parse(globalThis.localStorage?.getItem(LOADER_CACHE_KEY) || '{}');
    const hit = all[key];
    if (hit && Date.now() - hit.at < LOADER_CACHE_TTL) return hit.value;
  } catch { }
  return null;
}

function writeLoaderCache(key, value) {
  try {
    const all = JSON.parse(globalThis.localStorage?.getItem(LOADER_CACHE_KEY) || '{}');
    all[key] = { at: Date.now(), value };
    const keys = Object.keys(all);
    if (keys.length > 40) {
      keys.sort((a, b) => all[a].at - all[b].at);
      for (const k of keys.slice(0, keys.length - 40)) delete all[k];
    }
    globalThis.localStorage?.setItem(LOADER_CACHE_KEY, JSON.stringify(all));
  } catch { }
}

const inflateRaw = async (bytes) => {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

// 远程 zip: 只按需读 EOCD 与目标条目, 不整包下载(安装器 7MB -> 约百 KB)
async function openZipFromUrl(url, { timeout = 25000, retries = 0 } = {}) {
  const head = await fetchWithRetry(url, { timeout, retries, headers: { Range: 'bytes=0-1' } });
  if (head.status === 200) {
    // 服务器忽略 Range: 退回整包读
    const buf = new Uint8Array(await head.arrayBuffer());
    return new ZipReader({
      size: buf.length,
      readAt: async (offset, length) => buf.subarray(offset, offset + length),
      inflateRaw,
    }).open();
  }
  const total = Number((head.headers.get('content-range') || '').split('/')[1]) || 0;
  if (!total) {
    // 206 但 content-range 读不到(跨域响应未 expose 该头, 例如 Cloudflare 后面的 forge maven): 退回整包读
    const full = await fetchWithRetry(url, { timeout: Math.max(timeout, 60000), retries: 1 });
    const buf = new Uint8Array(await full.arrayBuffer());
    return new ZipReader({
      size: buf.length,
      readAt: async (offset, length) => buf.subarray(offset, offset + length),
      inflateRaw,
    }).open();
  }
  const reader = new ZipReader({
    size: total,
    readAt: async (offset, length) => {
      const res = await fetchWithRetry(url, { timeout, retries: 1, headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
      const buf = new Uint8Array(await res.arrayBuffer());
      // 206 返回的就是请求区间, 200 则是整包
      return res.status === 200 ? buf.subarray(offset, offset + length) : buf;
    },
    inflateRaw,
  });
  return reader.open();
}

// Forge/NeoForge: 安装器内含 install_profile.json 与版本补丁
export async function resolveForgePatch(sources, gameVersion, loader, onStatus) {
  const cacheKey = `${loader.type}.${gameVersion}.${loader.version}`;
  const cached = readLoaderCache(cacheKey);
  if (cached) {
    onStatus?.(`加载器描述来自本地缓存（${loader.type} ${loader.version}）`);
    return { ...cached, zip: null, fromCache: true };
  }

  const candidates = [];
  const push = (url) => { if (!candidates.includes(url)) candidates.push(url); };
  for (const url of forgeInstallerCandidates(sources, gameVersion, loader.version, loader.type)) {
    for (const candidate of sources.dataUrlCandidates(url)) push(candidate);
  }
  // 同一构件在所有镜像站上的地址一并探测: 某个站在建计划时段挂掉(连接挂起/429)不影响结果
  for (const url of [...candidates]) {
    for (const candidate of sources.altMavenCandidates(url)) push(candidate);
  }
  if (!candidates.length) throw new Error('没有可用的安装器地址');

  const errors = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 两轮: 第一轮全部并行探测(谁快用谁), 全挂时等一会再试一次(应对 429 限流)
  for (let round = 1; round <= 2; round++) {
    onStatus?.(`探测 ${candidates.length} 个安装器源（第 ${round} 轮）`);
    const opened = [];
    const first = await new Promise((resolve) => {
      let settled = false;
      let failed = 0;
      for (const url of candidates) {
        openZipFromUrl(url, { timeout: 8000 }).then((zip) => {
          opened.push({ url, zip });
          if (!settled) { settled = true; resolve({ url, zip }); }
        }).catch((err) => {
          errors.push(`${hostOf(url)}: ${err.message}`);
          failed++;
          if (!settled && failed === candidates.length) { settled = true; resolve(null); }
        });
      }
    });

    const attempts = first ? [first, ...opened.filter((o) => o !== first)] : [];
    for (const { url, zip } of attempts) {
      try {
        onStatus?.(`解析安装器 ${hostOf(url)}`);
        let profile = null;
        let versionJson = null;
        let pendingProcessors = [];
        if (zip.has('install_profile.json')) {
          profile = JSON.parse(await zip.readText('install_profile.json'));
          // 1.12 及更早: versionInfo 内嵌; 1.13+: 安装器根目录的 version.json
          if (profile.versionInfo) versionJson = profile.versionInfo;
          else if (profile.install?.filePath && zip.has(profile.install.filePath)) {
            versionJson = JSON.parse(await zip.readText(profile.install.filePath));
          } else if (typeof profile.json === 'string' && zip.has(profile.json.replace(/^\//, ''))) {
            versionJson = JSON.parse(await zip.readText(profile.json.replace(/^\//, '')));
          } else if (zip.has('version.json')) {
            versionJson = JSON.parse(await zip.readText('version.json'));
          }
          pendingProcessors = (profile.processors || []).map((p) => p.jar);
        } else if (zip.has('version.json')) {
          versionJson = JSON.parse(await zip.readText('version.json'));
        }
        if (!versionJson) throw new Error('安装器内未找到版本描述');

        const result = {
          versionJson,
          installerUrl: url,
          installerProfile: profile,
          pendingProcessors,
          installerMaven: zip.list().map((e) => e.name || e).filter((n) => n.startsWith('maven/') && n.endsWith('.jar')),
          zip,
        };
        writeLoaderCache(cacheKey, {
          versionJson: result.versionJson,
          installerUrl: result.installerUrl,
          installerProfile: result.installerProfile,
          pendingProcessors: result.pendingProcessors,
          installerMaven: result.installerMaven,
        });
        onStatus?.(`安装器已解析: ${hostOf(url)}`);
        return result;
      } catch (err) {
        errors.push(`${hostOf(url)}: ${err.message}`);
      }
    }
    if (round < 2) await sleep(2500);
  }
  throw new Error(`无法获取安装器（${candidates.length} 个候选源）：${errors.slice(0, 3).join('；')}`);
}

async function sha1Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 每个候选源取一次最小对象并校验 SHA-1, 内容正确才视为该版本的资源可下载
export async function probeAssetSources(objectTasks, sources) {
  // 取最小、中位、最大各一个, 兼顾"是否覆盖该版本"与"大文件是否完整"
  const sorted = [...objectTasks].sort((a, b) => (a.size || 1e9) - (b.size || 1e9));
  const sample = sorted.length > 4
    ? [sorted[0], sorted[Math.floor(sorted.length / 2)], sorted[sorted.length - 1]]
    : sorted.slice(0, 3);
  if (!sample.length) return { ok: true, usable: [], message: '' };
  const hosts = [];
  for (const task of sample) {
    for (const url of task.urls) {
      try {
        const host = new URL(url).host;
        if (hosts.some((h) => h.host === host && h.tested)) continue;
        const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
        let ok = res.ok;
        if (ok && task.sha1) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          ok = await sha1Hex(bytes) === task.sha1.toLowerCase() && bytes.length === task.size;
        }
        hosts.push({ host, tested: true, status: res.status, ok });
      } catch (err) {
        hosts.push({ host: (() => { try { return new URL(url).host; } catch { return url; } })(), tested: true, ok: false, error: err.message });
      }
      if (hosts.filter((h) => h.ok).length) break;
    }
    if (hosts.filter((h) => h.ok).length) break;
  }
  const usable = hosts.filter((h) => h.ok).map((h) => h.host);
  if (usable.length) return { ok: true, usable, message: '' };
  const detail = hosts.map((h) => `${h.host}${h.status ? ' HTTP ' + h.status : h.error ? ' ' + h.error : ''}`).join(', ');
  return {
    ok: false,
    usable: [],
    message: `资源镜像没有该版本的资源文件（预检: ${detail}）。解决办法: 在设置里填一个 CORS 网关以便回落到官方 resources.download.minecraft.net，或在下载页取消勾选“包含资源文件”。`,
  };
}

function assetTasks(indexJson, versionId, sources, taskPathPrefix) {
  const tasks = [];
  for (const [name, obj] of Object.entries(indexJson.objects || {})) {
    tasks.push({
      kind: 'http',
      category: 'asset',
      path: taskPathPrefix + assetObjectPath(obj.hash),
      size: obj.size || 0,
      sha1: obj.hash,
      urls: sources.assetCandidates(versionId, name, obj.hash),
      verify: true,
      assetName: name,
    });
  }
  return tasks;
}

export async function planAssets(sources, versionJson, options = {}) {
  // 资源镜像按“游戏版本号”寻址, 不能用 assetIndex.id (如 5、34)
  const gameVersion = options.gameVersion || versionJson.id;
  const tasks = [];
  const warnings = [];
  const assetIndex = versionJson.assetIndex;
  if (!assetIndex?.url) {
    warnings.push('版本未声明 assetIndex, 跳过资源文件');
    return { tasks, warnings };
  }
  const indexUrl = assetIndex.url;
  const indexTask = {
    kind: 'http',
    category: 'assetIndex',
    path: 'assets/indexes/' + assetIndex.id + '.json',
    size: assetIndex.size || 0,
    sha1: assetIndex.sha1 || null,
    urls: sources.dataUrlCandidates(indexUrl),
    verify: true,
    indexOf: assetIndex.id,
  };
  tasks.push(indexTask);

  let indexJson = null;
  let indexError = null;
  for (const candidate of sources.dataUrlCandidates(indexUrl)) {
    try {
      indexJson = await fetchJson(candidate, { timeout: 60000 });
      break;
    } catch (err) {
      indexError = err;
    }
  }
  if (!indexJson) {
    warnings.push('资源索引获取失败: ' + (indexError?.message || '未知错误'));
    return { tasks, warnings };
  }
  const objectTasks = assetTasks(indexJson, gameVersion, sources, '');
  if (options.includeAssets === false) {
    return { tasks, warnings, assetCount: objectTasks.length, assetSkipped: true };
  }

  // 资源镜像预检: 用最小的对象试每个候选源, 该版本不在镜像上时直接给出结论, 避免上千次 404
  const probe = await probeAssetSources(objectTasks, sources);
  if (!probe.ok) {
    warnings.push(probe.message);
    return {
      tasks, warnings, assetCount: objectTasks.length, assetBlocked: true,
      assetProbe: probe,
    };
  }
  tasks.push(...objectTasks);

  return {
    tasks, warnings, assetCount: objectTasks.length,
    assetBytes: objectTasks.reduce((s, t) => s + t.size, 0),
    assetProbe: probe,
  };
}

export function planLogging(versionJson, sources) {
  const tasks = [];
  const file = versionJson.logging?.client?.file;
  if (file?.url && file?.id) {
    tasks.push({
      kind: 'http',
      category: 'logConfig',
      path: 'assets/log_configs/' + file.id,
      size: file.size || 0,
      sha1: file.sha1 || null,
      urls: sources.dataUrlCandidates(file.url),
      verify: Boolean(file.sha1),
    });
  }
  return tasks;
}

export function planLibraries(libraries, sources) {
  return libraries.map((lib) => ({
    kind: 'http',
    category: 'library',
    path: lib.path,
    size: lib.size || 0,
    sha1: lib.sha1 || null,
    urls: sources.libraryCandidates(lib),
    verify: Boolean(lib.sha1),
    library: lib,
  }));
}

function clientJarTask(versionJson, sources) {
  const client = versionJson.downloads?.client;
  if (!client?.url) return null;
  return {
    kind: 'http',
    category: 'jar',
    path: null,
    size: client.size || 0,
    sha1: client.sha1 || null,
    urls: sources.dataUrlCandidates(client.url),
    verify: Boolean(client.sha1),
  };
}

// 加载器配套 API: 落到实例 mods/ 目录, 与 HMCL 的 FABRIC_API / QUILT_API 组件等价
async function planApiExtras(sources, extras, gameVersion, root, tasks, warnings) {
  for (const key of extras || []) {
    if (!API_PROJECTS[key]) continue;
    try {
      const resolved = await loadModrinthVersionFor(sources, key, gameVersion);
      if (!resolved) {
        warnings.push(`${API_PROJECTS[key].label} 在 ${gameVersion} 下没有可用版本`);
        continue;
      }
      tasks.push({
        kind: 'http',
        category: 'api',
        path: root + 'mods/' + resolved.file.filename,
        size: resolved.file.size,
        sha1: resolved.file.sha1,
        urls: sources.dataUrlCandidates(resolved.file.url),
        verify: Boolean(resolved.file.sha1),
        apiLabel: `${resolved.label} ${resolved.versionNumber}`,
      });
    } catch (err) {
      warnings.push(`${API_PROJECTS[key].label} 解析失败: ${err.message}`);
    }
  }
}

export async function buildVersionPlan(options) {
  const {
    sources, ctx, versionId, loader = null, includeAssets = true, includeLibraries = true,
    instanceId = null, features = {}, warnings = [], extras = [], onStatus = null,
  } = options;

  const manifest = await loadVersionManifest(sources);
  const entry = (manifest.versions || []).find((v) => v.id === versionId);
  if (!entry) throw new Error('版本清单中不存在: ' + versionId);

  const baseJson = await loadVersionJson(sources, entry);
  let merged = baseJson;
  const unsupported = [];
  let forgeInfo = null;
  let forgeChain = null;

  if (loader && loader.type) {
    if (['fabric', 'quilt', 'legacyfabric'].includes(loader.type)) {
      const profile = await loadFabricProfile(sources, loader.type, versionId, loader.version);
      merged = mergeVersionJson(baseJson, profile, instanceIdFor(versionId, loader));
    } else if (['forge', 'neoforge'].includes(loader.type)) {
      try {
        forgeInfo = await resolveForgePatch(sources, versionId, loader, onStatus);
        merged = mergeVersionJson(baseJson, forgeInfo.versionJson, instanceIdFor(versionId, loader));
        if (forgeInfo.pendingProcessors.length) {
          const spec = chainSpecFor(versionId);
          if (spec?.pending) {
            unsupported.push({
              item: '补丁链',
              detail: `${versionId} 的映射需要先做 DOWNLOAD_MOJMAPS 的 sanitize 转换(proguard 文本 -> tsrg), 尚未实现`,
            });
          } else if (spec) {
            forgeChain = {
              spec,
              patchEntry: 'data/client.lzma',
              client: baseJson.downloads?.client
                ? {
                  size: baseJson.downloads.client.size || 0,
                  sha1: baseJson.downloads.client.sha1 || null,
                  urls: sources.dataUrlCandidates(baseJson.downloads.client.url),
                }
                : null,
              mojmap: baseJson.downloads?.client_mappings
                ? {
                  size: baseJson.downloads.client_mappings.size || 0,
                  sha1: baseJson.downloads.client_mappings.sha1 || null,
                  urls: sources.dataUrlCandidates(baseJson.downloads.client_mappings.url),
                }
                : null,
              mcpConfig: null,
              steps: [
                { name: '取回输入', status: 'local' },
                { name: '映射合并', status: 'local' },
                { name: '类重写', status: 'local', flags: spec.flags },
                { name: 'binpatch', status: 'local' },
              ],
              output: null,
            };
          } else {
            unsupported.push({
              item: '安装处理器',
              detail: `安装器声明 ${forgeInfo.pendingProcessors.length} 个 processor, 需要 JVM 运行, 浏览器无法执行`,
              jars: forgeInfo.pendingProcessors,
            });
          }
        }
      } catch (err) {
        // 安装器取不到时不放弃整个计划: 仍然导出原版 + 整合包文件, 只是缺少加载器补丁
        warnings.push(`${loader.type} 安装器解析失败（${err.message}）：本次只导出原版与整合包文件，加载器补丁需要 HMCL 侧补装`);
        unsupported.push({
          item: `${loader.type} 加载器补丁`,
          detail: '缺少安装器内的版本描述与库列表',
        });
      }
    } else {
      throw new Error('不支持的加载器: ' + loader.type);
    }
  }

  const id = sanitizeId(instanceId || merged.id);
  const root = `versions/${id}/`;

  const libraries = includeLibraries ? collectLibraries(merged, ctx, features) : [];
  const libTasks = planLibraries(libraries, sources);

  const jarTask = clientJarTask(merged, sources);
  if (jarTask) jarTask.path = root + id + '.jar';
  if (forgeChain) {
    forgeChain.output = root + id + '.jar';
    // mcp_config / neoform 只在安装器的 libraries 里声明, 版本 json 的库列表里没有
    const zipLib = (forgeInfo?.installerProfile?.libraries || [])
      .find((l) => /(mcp_config|neoform)/.test(l.name || '') && /@zip$/.test(l.name || ''));
    const art = zipLib?.downloads?.artifact;
    if (art?.path) {
      forgeChain.mcpConfig = {
        size: art.size || 0,
        sha1: art.sha1 || null,
        urls: sources.libraryCandidates({ name: zipLib.name, mavenPath: art.path, explicitUrl: art.url }),
        entry: 'config/joined.tsrg',
      };
    }
    const mode = forgeChain.spec.mappings || 'merged';
    const missing = [];
    if (!forgeChain.client) missing.push('客户端 jar');
    if (mode !== 'joined' && !forgeChain.mojmap) missing.push('官方映射');
    if (mode !== 'mojmap' && !forgeChain.mcpConfig) missing.push('MCP 配置');
    if (missing.length) {
      unsupported.push({
        item: '补丁链输入',
        detail: `缺少 ${missing.join(' / ')}, 无法在浏览器内改名`,
      });
    }
  }

  const assetPlan = await planAssets(sources, merged, { includeAssets, gameVersion: versionId });
  warnings.push(...assetPlan.warnings);

  const logTasks = planLogging(merged, sources);

  const instanceJsonBytes = new TextEncoder().encode(JSON.stringify(merged, null, 2));
  const localTasks = [{
    kind: 'local',
    category: 'meta',
    path: root + id + '.json',
    bytes: instanceJsonBytes,
  }];

  const tasks = [...localTasks, ...libTasks];
  if (jarTask) tasks.push(jarTask);
  tasks.push(...assetPlan.tasks, ...logTasks);
  if (extras.length) await planApiExtras(sources, extras, versionId, root, tasks, warnings);
  if (assetPlan.assetBlocked) warnings.push(assetPlan.warnings[assetPlan.warnings.length - 1]);

  return {
    instanceId: id,
    root,
    gameVersion: versionId,
    loader,
    versionJson: merged,
    baseVersionJson: baseJson,
    libraries,
    tasks,
    warnings,
    unsupported,
    forgeInfo,
    forgeChain,
    assetBlocked: Boolean(assetPlan.assetBlocked),
    assetProbe: assetPlan.assetProbe || null,
    stats: summarize(tasks, assetPlan),
  };
}

export function summarize(tasks, assetPlan = {}) {
  const byCategory = {};
  let totalBytes = 0;
  let known = 0;
  for (const t of tasks) {
    const size = t.size || (t.bytes ? t.bytes.length : 0);
    byCategory[t.category] = byCategory[t.category] || { count: 0, bytes: 0 };
    byCategory[t.category].count++;
    byCategory[t.category].bytes += size;
    totalBytes += size;
    if (size > 0) known++;
  }
  return {
    taskCount: tasks.length,
    totalBytes,
    knownSizes: known,
    byCategory,
    assetCount: assetPlan.assetCount || 0,
    assetBytes: assetPlan.assetBytes || 0,
  };
}

// 整合包: 版本计划 + 清单文件 + 覆盖文件
export async function buildModpackPlan(options) {
  const { sources, ctx, modpack, zip, instanceName } = options;
  const warnings = [...(modpack.warnings || [])];
  const id = sanitizeId(instanceName || `${modpack.name}-${modpack.packVersion}`);
  const root = `versions/${id}/`;

  const versionPlan = await buildVersionPlan({
    ...options,
    versionId: modpack.gameVersion,
    loader: modpack.loader,
    instanceId: id,
    warnings,
    extras: modpack.extras || [],
  });

  const tasks = [...versionPlan.tasks];
  for (const f of modpack.files || []) {
    tasks.push({
      kind: 'http',
      category: 'modpack',
      path: root + f.path,
      size: f.size || 0,
      sha1: f.sha1 || null,
      urls: sources.rank(f.urls),
      verify: Boolean(f.sha1),
      optional: f.required === false,
    });
  }

  for (const [rel, entry] of modpack.overrides || new Map()) {
    tasks.push({
      kind: 'zip',
      category: 'override',
      path: root + rel,
      size: entry.uncompSize,
      zipEntry: entry.name,
      crc32: entry.crc,
      zip,
      verify: false,
    });
  }

  for (const extra of modpack.extraLocalFiles || []) {
    tasks.push({
      kind: 'local',
      category: 'meta',
      path: root + extra.path,
      bytes: new TextEncoder().encode(JSON.stringify(extra.json, null, 2)),
    });
  }

  const stats = summarize(tasks);
  stats.modsCount = tasks.filter((t) => (t.category === 'modpack' || t.category === 'api') && /(^|\/)mods\//.test(t.path || '')).length;
  stats.overrideCount = tasks.filter((t) => t.kind === 'zip').length;
  return {
    ...versionPlan,
    instanceId: id,
    root,
    tasks,
    warnings: [...new Set([...warnings, ...versionPlan.warnings])],
    stats,
    modpackType: modpack.type,
  };
}

// 整合包清单解析: Modrinth / CurseForge / MCBBS / MultiMC(Prism)
// 文件落位遵循版本隔离: 全部内容进入 versions/<实例ID>/

export const OVERRIDE_DIRS = ['client-overrides', 'overrides'];

// 顺序执行带并发上限的异步映射
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = [];
  for (let i = 0; i < Math.max(1, Math.min(limit, items.length)); i++) {
    runners.push((async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        out[index] = await fn(items[index], index);
      }
    })());
  }
  await Promise.all(runners);
  return out;
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

export async function detectModpack(zip) {
  if (zip.has('modrinth.index.json')) return { type: 'modrinth', manifest: JSON.parse(await zip.readText('modrinth.index.json')) };
  // mcbbs 的专用标记优先; 只按 manifestType 判断会把 CurseForge 包误判成 mcbbs
  if (zip.has('mcbbs.packmeta')) return { type: 'mcbbs', manifest: JSON.parse(await zip.readText('mcbbs.packmeta')) };
  if (zip.has('manifest.json')) {
    const manifest = JSON.parse(await zip.readText('manifest.json'));
    if (manifest.minecraft && manifest.minecraft.version) return { type: 'curse', manifest };
    if (Array.isArray(manifest.addons) || manifest.fileApi || manifest.manifestType) {
      return { type: 'mcbbs', manifest };
    }
    return { type: 'curse', manifest };
  }
  if (zip.has('mmc-pack.json')) return { type: 'multimc', manifest: JSON.parse(await zip.readText('mmc-pack.json')) };
  return null;
}

function defaultLoader() {
  return { type: null, version: null };
}

export function parseLoaderFromCurse(manifest) {
  const loaders = manifest?.minecraft?.modLoaders || [];
  const primary = loaders.find((l) => l.primary) || loaders[0];
  if (!primary) return defaultLoader();
  const id = primary.id || '';
  if (id.startsWith('forge-')) return { type: 'forge', version: id.slice(6) };
  if (id.startsWith('neoforge-')) return { type: 'neoforge', version: id.slice(9) };
  if (id.startsWith('fabric-')) return { type: 'fabric', version: id.slice(7) };
  if (id.startsWith('quilt-')) return { type: 'quilt', version: id.slice(6) };
  return defaultLoader();
}

export function parseLoaderFromModrinth(deps) {
  if (!deps) return defaultLoader();
  if (deps['fabric-loader']) return { type: 'fabric', version: deps['fabric-loader'] };
  if (deps['quilt-loader']) return { type: 'quilt', version: deps['quilt-loader'] };
  if (deps['neoforge']) return { type: 'neoforge', version: deps['neoforge'] };
  if (deps['neo-forge']) return { type: 'neoforge', version: deps['neo-forge'] };
  if (deps['forge']) return { type: 'forge', version: deps['forge'] };
  return defaultLoader();
}

export function parseLoaderFromMultiMC(components) {
  for (const c of components || []) {
    const uid = c.uid || '';
    if (uid === 'net.fabricmc.fabric-loader') return { type: 'fabric', version: c.version };
    if (uid === 'org.quiltmc.quilt-loader') return { type: 'quilt', version: c.version };
    if (uid === 'net.minecraftforge') return { type: 'forge', version: c.version };
    if (uid === 'net.neoforged') return { type: 'neoforge', version: c.version };
  }
  return defaultLoader();
}

function overrideEntries(zip, dirs) {
  const seen = new Map();
  for (const dir of dirs) {
    for (const entry of zip.list(dir + '/')) {
      const rel = entry.name.slice(dir.length + 1);
      if (!rel || rel.endsWith('/')) continue;
      if (seen.has(rel)) continue;
      seen.set(rel, entry);
    }
  }
  return seen;
}

// Modrinth: files[].downloads 为多镜像; env.client=unsupported 的条目跳过
export function modrinthPlan(manifest, zip) {
  const warnings = [];
  const files = [];
  for (const f of manifest.files || []) {
    if (f.env && f.env.client === 'unsupported') continue;
    if (!f.downloads || f.downloads.length === 0) {
      warnings.push(`缺少下载地址: ${f.path}`);
      continue;
    }
    files.push({
      path: f.path,
      size: f.fileSize || 0,
      sha1: f.hashes?.sha1 || null,
      sha512: f.hashes?.sha512 || null,
      urls: f.downloads,
      required: true,
    });
  }
  const overrides = overrideEntries(zip, OVERRIDE_DIRS);
  const modsCount = files.filter((f) => String(f.path).startsWith('mods/')).length;
  return {
    name: manifest.name || 'modrinth-pack',
    modsCount,
    packVersion: manifest.versionId || '1.0',
    gameVersion: manifest.dependencies?.minecraft,
    loader: parseLoaderFromModrinth(manifest.dependencies),
    files,
    overrides,
    warnings,
    extraLocalFiles: [{ path: 'modrinth.index.json', json: manifest }],
  };
}

// CurseForge: 清单通常只有 projectID/fileID, 需要换出 fileName 才能拼 CDN 地址
// 解析顺序: 清单自带 fileName/url -> CurseForge API(需 API Key) -> 下载跳转端点(经网关)
export async function cursePlan(manifest, zip, sources) {
  const warnings = [];
  const entries = Array.isArray(manifest.files) ? manifest.files : [];
  const forgeCdn = (fileID, fileName) =>
    `https://edge.forgecdn.net/files/${Math.floor(fileID / 1000)}/${fileID % 1000}/${encodeURIComponent(fileName)}`;

  const files = [];
  const needResolve = [];
  for (const f of entries) {
    if (f.fileName) {
      files.push({
        path: 'mods/' + f.fileName,
        size: 0,
        sha1: f.hashes?.sha1 || null,
        urls: sources ? sources.dataUrlCandidates(f.url || forgeCdn(f.fileID, f.fileName)) : [f.url || forgeCdn(f.fileID, f.fileName)],
        required: f.required !== false,
      });
    } else if (f.url) {
      const name = String(f.url).split('/').pop().split('?')[0] || `${f.projectID}-${f.fileID}.jar`;
      files.push({
        path: 'mods/' + name,
        size: 0,
        sha1: f.hashes?.sha1 || null,
        urls: sources ? sources.dataUrlCandidates(f.url) : [f.url],
        required: f.required !== false,
      });
    } else {
      needResolve.push(f);
    }
  }

  let resolvedByApi = 0;
  const unreachable = [];
  // 没有 API Key 时不发请求: CurseForge 对未带 x-api-key 的调用一律 403, 每个 mod 打一次纯属浪费
  if (needResolve.length && !sources?.curseApiKey) {
    for (const f of needResolve) unreachable.push({ f, error: '未配置 CurseForge API Key' });
  } else if (needResolve.length) {
    const results = await mapLimit(needResolve, 6, async (f) => {
      try {
        const { resolveCurseFile } = await import('./providers.js');
        return { f, info: await resolveCurseFile(sources, f.projectID, f.fileID) };
      } catch (err) {
        return { f, error: err.message };
      }
    });
    for (const r of results) {
      const { f } = r;
      if (r.info) {
        const fileName = r.info.fileName || `${f.projectID}-${f.fileID}.jar`;
        const url = r.info.downloadUrl || forgeCdn(f.fileID, fileName);
        files.push({
          path: 'mods/' + fileName,
          size: r.info.size || 0,
          sha1: r.info.hashes?.find?.((h) => h.algo === 1)?.value || f.hashes?.sha1 || null,
          urls: sources ? sources.dataUrlCandidates(url) : [url],
          required: f.required !== false,
        });
        resolvedByApi++;
        continue;
      }
      unreachable.push({ f, error: r.error });
    }
  }

  if (resolvedByApi) warnings.push(`${resolvedByApi} 个条目缺少 fileName，已通过 CurseForge API 补齐`);
  if (unreachable.length) {
    // 拿不到名字时仍可用下载跳转端点(网关内跟随 302), 文件名退化为 projectID-fileID
    const sample = unreachable.slice(0, 3).map((u) => `${u.f.projectID}/${u.f.fileID}(${u.error})`).join(', ');
    warnings.push(`${unreachable.length} 个条目无法解析文件名（${sample}…）：需要在设置里填 CurseForge API Key，或配置 CORS 网关后由下载跳转端点取回`);
    if (sources?.gateway) {
      for (const { f } of unreachable) {
        const target = `https://www.curseforge.com/api/v1/mods/${f.projectID}/files/${f.fileID}/download`;
        files.push({
          path: `mods/${f.projectID}-${f.fileID}.jar`,
          size: 0,
          sha1: f.hashes?.sha1 || null,
          urls: [sources.gateway.replace('{url}', encodeURIComponent(target))],
          required: f.required !== false,
        });
      }
    }
  }

  const overrideDir = manifest.overrides || 'overrides';
  const overrides = overrideEntries(zip, [overrideDir]);
  const modsInOverrides = [...overrides.keys()].filter((k) => k.startsWith('mods/')).length;
  const modsCount = files.length + modsInOverrides;
  return {
    name: manifest.name || manifest.manifest?.name || 'curse-pack',
    packVersion: manifest.version || manifest.manifest?.version || '1.0',
    gameVersion: manifest.minecraft?.version,
    loader: parseLoaderFromCurse(manifest),
    files,
    overrides,
    modsCount,
    warnings,
    extraLocalFiles: [],
  };
}

// MCBBS: addons 里同时声明游戏版本与加载器, files 按 type 分 addon/curse
// 对应 HMCL McbbsModpackManifest: { addons:[{id,version}], files:[{type,path,hash}|{type,projectID,fileID,fileName,url}], fileApi, settings }
const MCBBS_COMPONENT_TO_LOADER = {
  fabric: 'fabric',
  quilt: 'quilt',
  legacyfabric: 'legacyfabric',
  forge: 'forge',
  neoforge: 'neoforge',
};

export function mcbbsPlan(manifest, zip) {
  const warnings = [];
  const addons = Array.isArray(manifest.addons) ? manifest.addons : [];
  const component = (id) => addons.find((a) => String(a.id).toLowerCase() === id);

  // 游戏版本与加载器都来自 addons, 与 HMCL toModpack() 取 game 组件一致
  const gameAddon = component('game') || component('minecraft');
  const gameVersion = gameAddon?.version || manifest.minecraftVersion || null;
  if (!gameVersion) warnings.push('MCBBS 清单的 addons 中没有 game 组件，无法确定游戏版本');

  let loader = defaultLoader();
  for (const [id, type] of Object.entries(MCBBS_COMPONENT_TO_LOADER)) {
    const found = component(id);
    if (found?.version) { loader = { type, version: found.version }; break; }
  }
  const extras = [];
  if (component('fabric-api')) extras.push('fabric-api');
  if (component('quilt-api')) extras.push('quilt-api');
  if (component('legacy-fabric-api')) extras.push('legacy-fabric-api');

  const fileApi = String(manifest.fileApi || manifest.url || '').replace(/\/$/, '');
  const settings = manifest.settings || {};
  const installMods = settings.install_mods !== false;

  const files = [];
  let modsCount = 0;
  for (const f of manifest.files || []) {
    const type = String(f.type || '').toLowerCase();
    const isMod = String(f.path || '').startsWith('mods/');

    if (type === 'curse') {
      const fileName = f.fileName || null;
      if (!fileName) {
        warnings.push(`MCBBS curse 条目缺少 fileName（projectID=${f.projectID}, fileID=${f.fileID}）`);
        continue;
      }
      if (isMod && !installMods) continue;
      files.push({
        path: 'mods/' + fileName,
        size: 0,
        sha1: null,
        urls: [f.url || `https://edge.forgecdn.net/files/${Math.floor(f.fileID / 1000)}/${f.fileID % 1000}/${encodeURIComponent(fileName)}`],
        required: f.force !== false,
      });
      modsCount++;
      continue;
    }

    // 其余按 addon 文件处理: path 为实例内相对路径, 内容来自 fileApi/overrides/<path>
    if (!f.path) continue;
    if (isMod && !installMods) continue;
    const urls = fileApi ? [`${fileApi}/overrides/${f.path}`] : [];
    if (!urls.length) warnings.push(`MCBBS 条目缺少 fileApi，无法下载 ${f.path}`);
    files.push({
      path: f.path,
      size: 0,
      sha1: f.hash || null,
      urls,
      required: f.force !== false,
    });
    if (isMod) modsCount++;
  }

  // 旧版 MCBBS 包把文件放在打包 zip 的 overrides/ 里
  const overrides = overrideEntries(zip, OVERRIDE_DIRS);
  return {
    name: manifest.name || 'mcbbs-pack',
    packVersion: manifest.version || '1.0',
    gameVersion,
    loader,
    extras,
    files,
    overrides,
    modsCount,
    warnings,
    extraLocalFiles: [],
    launchInfo: manifest.launchInfo || null,
  };
}

// MultiMC/Prism: .minecraft/ 下的文件即实例内容
export async function multimcPlan(manifest, zip, zipName) {
  const mcComponent = (manifest.components || []).find((c) => c.uid === 'net.minecraft');
  const overrides = new Map();
  for (const entry of zip.list('.minecraft/')) {
    const rel = entry.name.slice('.minecraft/'.length);
    if (rel) overrides.set(rel, entry);
  }
  let instanceName = zipName || 'multimc-pack';
  if (zip.has('instance.cfg')) {
    const cfg = await zip.readText('instance.cfg');
    const m = cfg.match(/^name=(.*)$/m);
    if (m) instanceName = m[1].trim();
  }
  return {
    name: instanceName,
    packVersion: manifest.formatVersion ? String(manifest.formatVersion) : '1.0',
    gameVersion: mcComponent?.version,
    loader: parseLoaderFromMultiMC(manifest.components),
    files: [],
    overrides,
    warnings: [],
    extraLocalFiles: [],
  };
}

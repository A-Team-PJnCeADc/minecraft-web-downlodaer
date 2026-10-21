// 版本 JSON 解析: 规则判定、Maven 坐标、库/资源定位、版本合并
// 逻辑对应 HMCL: CompatibilityRule/OSRestriction/Library/AssetIndex/DefaultGameRepositoryLayout

export const TARGET_OS = { WINDOWS: 'windows', OSX: 'osx', LINUX: 'linux' };

export function detectTarget() {
  const ua = navigator.userAgent;
  let os = TARGET_OS.WINDOWS;
  if (/Mac OS X|Macintosh/.test(ua)) os = TARGET_OS.OSX;
  else if (/Linux/.test(ua) && !/Android/.test(ua)) os = TARGET_OS.LINUX;
  const arch = /arm64|aarch64/i.test(ua) ? 'arm64' : 'x86_64';
  return { os, arch, version: os === TARGET_OS.WINDOWS ? '10.0' : '0' };
}

const OS_ALIASES = {
  windows: ['windows', 'win'],
  osx: ['osx', 'macos', 'mac'],
  linux: ['linux', 'unix'],
};

export function parseOsName(name) {
  if (!name) return null;
  for (const [key, aliases] of Object.entries(OS_ALIASES)) {
    if (aliases.includes(name.toLowerCase())) return key;
  }
  return null;
}

function archMatches(pattern, arch) {
  if (!pattern) return true;
  let re;
  try { re = new RegExp(pattern); } catch { return true; }
  return re.test(arch);
}

// HMCL OSRestriction.allow(): 支持 name 形如 "win-x86" 的写法
export function osRestrictionAllows(rule, ctx) {
  if (!rule) return true;
  const { name, version, arch } = rule;
  if (name) {
    const parts = String(name).split('-');
    if (parts.length === 2) {
      const os = parseOsName(parts[0]);
      const archName = parts[1];
      if (os && ['x86', 'x86_64', 'arm64', 'arm32'].includes(archName)) {
        if (os !== ctx.os) return false;
        return archName === ctx.arch;
      }
    }
    const os = parseOsName(name);
    if (os && os !== ctx.os) return false;
  }
  if (version) {
    let re;
    try { re = new RegExp(version); } catch { re = null; }
    if (re && !re.test(ctx.version)) return false;
  }
  if (arch && !archMatches(arch, ctx.arch)) return false;
  return true;
}

// 规则为 allow/disallow 序列, 默认 disallow; features 必须全部匹配
export function ruleAllows(rules, ctx, features = {}) {
  if (!rules || rules.length === 0) return true;
  let action = 'disallow';
  for (const rule of rules) {
    if (!osRestrictionAllows(rule.os, ctx)) continue;
    if (rule.features) {
      let ok = true;
      for (const [k, v] of Object.entries(rule.features)) {
        if ((features[k] ?? false) !== v) { ok = false; break; }
      }
      if (!ok) continue;
    }
    action = rule.action || 'allow';
  }
  return action === 'allow';
}

export function parseCoords(name) {
  const [coords, ext] = String(name).split('@');
  const parts = coords.split(':');
  if (parts.length < 3) throw new Error('无法解析 Maven 坐标: ' + name);
  return {
    group: parts[0],
    artifact: parts[1],
    version: parts[2],
    classifier: parts[3] || null,
    extension: ext || 'jar',
    full: coords,
  };
}

export function mavenPath(c) {
  const file = `${c.artifact}-${c.version}${c.classifier ? '-' + c.classifier : ''}.${c.extension}`;
  return `${c.group.replace(/\./g, '/')}/${c.artifact}/${c.version}/${file}`;
}

function nativeDescriptors(ctx) {
  const bits = ctx.arch === 'x86_64' || ctx.arch === 'arm64' ? '64' : '32';
  const keys = ['', ctx.arch, bits];
  const variants = ['', 'native-', 'natives-'];
  const out = [];
  for (const key of keys) {
    for (const variant of variants) {
      out.push(variant + ctx.os + (key ? '-' + key : ''));
    }
  }
  return out;
}

// 库: 返回可直接下载的资源描述, 与 HMCL Library 的 classifier 解析顺序一致
export function resolveLibrary(lib, ctx, features = {}) {
  if (!ruleAllows(lib.rules, ctx, features)) return null;
  const coords = parseCoords(lib.name);
  const descriptors = nativeDescriptors(ctx);
  const bits = ctx.arch === 'x86_64' || ctx.arch === 'arm64' ? '64' : '32';

  let classifier = coords.classifier;
  let download = null;

  if (!classifier && lib.natives) {
    let resolved = null;
    for (const d of descriptors) {
      if (lib.natives[d]) { resolved = lib.natives[d]; break; }
    }
    if (!resolved) return null; // 该平台没有对应 natives
    classifier = resolved.replace('${arch}', bits);
  }

  if (classifier) {
    download = lib.downloads?.classifiers?.[classifier] || null;
    if (!download && lib.downloads?.artifact?.path?.includes(classifier)) download = lib.downloads.artifact;
  } else if (lib.downloads?.classifiers && !lib.downloads?.artifact) {
    // 仅声明 classifiers 的老式 natives
    for (const d of descriptors) {
      if (lib.downloads.classifiers[d]) { classifier = d; download = lib.downloads.classifiers[d]; break; }
    }
    if (!download) return null;
  } else {
    download = lib.downloads?.artifact || null;
  }

  const effective = classifier && !coords.classifier
    ? parseCoords(coords.full + ':' + classifier)
    : coords;
  const path = download?.path || mavenPath(effective);
  const baseUrl = lib.url && !lib.url.endsWith('/') ? lib.url + '/' : lib.url;

  return {
    kind: 'library',
    name: lib.name,
    group: effective.group,
    artifact: effective.artifact,
    version: effective.version,
    classifier,
    path: 'libraries/' + path,
    size: download?.size || 0,
    sha1: download?.sha1 || null,
    explicitUrl: download?.url || null,
    mavenPath: path,
    fallbackBase: baseUrl || 'https://libraries.minecraft.net/',
    isNative: Boolean(classifier && (lib.natives || !lib.downloads?.artifact)),
    checksums: lib.checksums || null,
    hasUrl: Boolean(download?.url || lib.url),
  };
}

// 允许库文件缺失校验信息, 由下载器在拿到 Content-Length 后补齐大小
export function collectLibraries(versionJson, ctx, features = {}) {
  const out = [];
  const seen = new Set();
  for (const lib of versionJson.libraries || []) {
    const resolved = resolveLibrary(lib, ctx, features);
    if (!resolved) continue;
    const key = resolved.group + ':' + resolved.artifact + (resolved.classifier ? ':' + resolved.classifier : '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

// 合并版本 JSON: 库去重(后者覆盖), 参数拼接, mainClass 覆盖
export function mergeVersionJson(base, patch, id) {
  const merged = JSON.parse(JSON.stringify(base));
  merged.id = id || patch.id || base.id;
  delete merged.inheritsFrom;
  if (patch.mainClass) merged.mainClass = patch.mainClass;
  if (patch.assets) merged.assets = patch.assets;
  if (patch.assetIndex) merged.assetIndex = patch.assetIndex;
  if (patch.javaVersion) merged.javaVersion = patch.javaVersion;
  if (patch.type) merged.type = patch.type;
  if (patch.logging) merged.logging = patch.logging;

  const seen = new Map();
  for (const lib of base.libraries || []) {
    try { seen.set(parseCoords(lib.name).group + ':' + parseCoords(lib.name).artifact, lib); } catch { }
  }
  for (const lib of patch.libraries || []) {
    try {
      const c = parseCoords(lib.name);
      seen.set(c.group + ':' + c.artifact + (c.classifier || ''), lib);
    } catch { }
  }
  merged.libraries = [...seen.values()];

  const baseArgs = base.arguments || {};
  const patchArgs = patch.arguments || {};
  if (patchArgs.game || patchArgs.jvm || baseArgs.game || baseArgs.jvm) {
    merged.arguments = {
      game: [...(baseArgs.game || []), ...(patchArgs.game || [])],
      jvm: [...(baseArgs.jvm || []), ...(patchArgs.jvm || [])],
    };
    if (base.minecraftArguments && !patchArgs.game) merged.minecraftArguments = base.minecraftArguments;
  }
  return merged;
}

export function assetObjectPath(hash) {
  return 'assets/objects/' + hash.substring(0, 2) + '/' + hash;
}

export function sanitizeId(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 64) || 'minecraft';
}

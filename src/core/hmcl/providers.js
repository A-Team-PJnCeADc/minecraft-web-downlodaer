// 下载源与远端元数据: 版本清单、加载器元数据、库/资源 URL 候选、带重试的 HTTP 封装
// 候选生成对齐 HMCL 的 HMCLDownloadProvider: 官方前缀经 MIRROR_RULES 展开为"镜像/官方"候选链
// 浏览器额外限制: 官方 libraries/assets 与 BMCLAPI 重定向目标不返回 Access-Control-Allow-Origin

export const DOWNLOAD_SOURCE = {
  DEFAULT: 'default',
  OFFICIAL: 'official',
  MIRROR: 'mirror',
  CUSTOM: 'custom',
};

export const SOURCE_MODES = {
  default: {
    label: '自动（DEFAULT，按地区选主源）',
    allowOfficialFallback: true,
  },
  official: {
    label: '官方源（OFFICIAL，镜像仅兜底）',
    allowOfficialFallback: true,
  },
  mirror: {
    label: '镜像源（MIRROR，镜像优先）',
    allowOfficialFallback: false,
  },
  custom: {
    label: '自定义（自填库代理与网关）',
    allowOfficialFallback: true,
  },
};

// 旧设置值到新枚举的映射
const MODE_ALIAS = { auto: 'default', bmclapi: 'mirror' };

export const BMCLAPI_ROOT = 'https://bmclapi2.bangbang93.com';

// 官方前缀 → 镜像路径, 与 HMCLDownloadProvider 的规则表一致; {root} 由当前镜像站的根替换, fallback 表示官方优先
export const MIRROR_RULES = [
  { source: 'https://bmclapi2.bangbang93.com', target: '{root}' },
  { source: 'https://launchermeta.mojang.com', target: '{root}' },
  { source: 'https://piston-meta.mojang.com', target: '{root}' },
  { source: 'https://piston-data.mojang.com', target: '{root}' },
  { source: 'https://launcher.mojang.com', target: '{root}' },
  { source: 'https://libraries.minecraft.net', target: '{root}/libraries' },
  { source: 'https://resources.download.minecraft.net', target: '{root}/assets' },
  { source: 'http://files.minecraftforge.net/maven', target: '{root}/maven' },
  { source: 'https://files.minecraftforge.net/maven', target: '{root}/maven' },
  { source: 'https://maven.minecraftforge.net', target: '{root}/maven' },
  { source: 'https://maven.neoforged.net/releases/', target: '{root}/maven/' },
  { source: 'http://dl.liteloader.com/versions', target: '{root}/maven' },
  { source: 'https://dl.liteloader.com/versions', target: '{root}/maven' },
  { source: 'https://meta.fabricmc.net', target: '{root}/fabric-meta' },
  { source: 'https://maven.fabricmc.net', target: '{root}/maven' },
  { source: 'https://authlib-injector.yushi.moe', target: '{root}/mirrors/authlib-injector' },
  { source: 'https://repo1.maven.org/maven2', target: 'https://mirrors.cloud.tencent.com/nexus/repository/maven-public' },
  { source: 'https://repo.maven.apache.org/maven2', target: 'https://mirrors.cloud.tencent.com/nexus/repository/maven-public' },
  { source: 'https://api.modrinth.com', target: 'https://mod.mcimirror.top/modrinth', fallback: true },
  { source: 'https://cdn.modrinth.com', target: 'https://mod.mcimirror.top', fallback: true },
  { source: 'https://api.curseforge.com', target: 'https://mod.mcimirror.top/curseforge', fallback: true },
  { source: 'https://edge.forgecdn.net', target: 'https://mod.mcimirror.top', fallback: true },
];

// 高校镜像站只镜像 BMCLAPI 的 maven 子树: 元数据、版本 json、资源索引/对象、客户端 jar 都不在其中
// 实测(SJTU/NJU/USTC/ZJU/CERNET 的 /bmclapi): forge/neoforge/fabric/intermediary/中央库都在, quilt-loader 与 com/mojang 库不在
export const CAMPUS_MIRROR_ROOTS = [
  'https://mirrors.sjtug.sjtu.edu.cn/bmclapi',
  'https://mirror.nju.edu.cn/bmclapi',
  'https://mirrors.zju.edu.cn/bmclapi',
  'https://mirrors.cernet.edu.cn/bmclapi',
  'https://mirrors.ustc.edu.cn/bmclapi',
];

export const CAMPUS_RULES = [
  { source: 'https://maven.minecraftforge.net', target: '{root}' },
  { source: 'https://files.minecraftforge.net/maven', target: '{root}' },
  { source: 'http://files.minecraftforge.net/maven', target: '{root}' },
  { source: 'https://maven.neoforged.net/releases', target: '{root}' },
  { source: 'https://maven.fabricmc.net', target: '{root}' },
  { source: 'http://dl.liteloader.com/versions', target: '{root}' },
  { source: 'https://dl.liteloader.com/versions', target: '{root}' },
  { source: 'https://repo1.maven.org/maven2', target: '{root}' },
  { source: 'https://repo.maven.apache.org/maven2', target: '{root}' },
];

// 镜像站点: 同一套官方前缀规则, 换成不同运营方提供的镜像根
// bmclapi 是全结构镜像(元数据/版本 json/资源/库/加载器 maven), 但不返回 ACAO 且会 302 到同样不带 ACAO 的下载节点
// campus 只覆盖 maven(库与加载器), 同样不带 ACAO(SJTUG 是 302->307->S3, 浏览器在 302 就判失败)
// custom 由用户填任意与 BMCLAPI 同结构的根
export const MIRROR_SITES = {
  bmclapi: {
    id: 'bmclapi',
    label: 'BMCLAPI（bmclapi2.bangbang93.com）',
    short: 'BMCLAPI',
    note: '全结构镜像；上游不返回 ACAO，浏览器内经网关访问',
    rules: MIRROR_RULES,
    roots: ['{bmcl}'],
    needsGateway: true,
  },
  campus: {
    id: 'campus',
    label: '高校镜像（SJTU / NJU / USTC / ZJU / CERNET 的 bmclapi 目录）',
    short: '高校镜像',
    note: '只镜像 BMCLAPI 的 maven 子树；各站都不返回 ACAO，浏览器内经网关访问',
    rules: CAMPUS_RULES,
    roots: CAMPUS_MIRROR_ROOTS,
    needsGateway: true,
  },
  custom: {
    id: 'custom',
    label: '自定义镜像根（按 BMCLAPI 结构改写）',
    short: '自定义',
    note: '填任意与 BMCLAPI 同结构的镜像根；只有带 ACAO 的根能在浏览器内生效',
    rules: MIRROR_RULES,
    roots: [],
    needsGateway: null,
  },
};

export const DEFAULT_MIRROR_SITE = 'bmclapi';

// 探测当前浏览器是否已关闭同源策略(本机 Chrome 以 --disable-web-security --user-data-dir=... 启动)
// 对不返回 ACAO 的官方库发一个 2 字节 Range 请求: 能读到状态码说明跨域限制没生效
export async function probeCorsDisabled() {
  const url = 'https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-1' }, credentials: 'omit', signal: controller.signal });
    return { ok: res.status === 200 || res.status === 206, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// 浏览器内可用的镜像: 官方库走 Sponge 的 maven 聚合代理, 资源走按版本名寻址的静态镜像
export const BROWSER_LIBRARY_PROXY = 'https://repo.spongepowered.org/repository/maven-public/';
export const BROWSER_ASSET_MIRRORS = [
  'https://assets.mcasset.cloud/{version}/assets/{name}',
  'https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@{version}/assets/{name}',
  'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/{version}/assets/{name}',
];

// 实测返回 ACAO 的主机
const CORS_HOSTS = [
  'maven.fabricmc.net', 'maven.minecraftforge.net', 'maven.neoforged.net',
  'maven.quiltmc.org', 'repo.spongepowered.org', 'maven.izzel.io',
  'maven.terraformersmc.com', 'repo.sleeping.town', 'api.modrinth.com',
  'cdn.modrinth.com', 'edge.forgecdn.net', 'mediafilez.forgecdn.net',
  'assets.mcasset.cloud', 'cdn.jsdelivr.net', 'piston-meta.mojang.com',
  'piston-data.mojang.com', 'mod.mcimirror.top', 'meta.fabricmc.net',
  'meta.quiltmc.org', 'meta.legacyfabric.net', 'mirrors.cloud.tencent.com',
];

// 实测不返回 ACAO 的主机(无网关时不可用于浏览器)
// SJTUG 是 302->307->S3 三跳, 只有最后一跳带 ACAO, 浏览器在 302 就判 CORS 失败, 因此按无 CORS 处理
const NO_CORS_HOSTS = [
  'libraries.minecraft.net', 'resources.download.minecraft.net',
  'bmclapi2.bangbang93.com', 'mirror.nju.edu.cn', 'mirrors.cernet.edu.cn',
  'bmclapi.hurtmc.com', 'launcher.mojang.com', 'launchermeta.mojang.com',
  'mirrors.zju.edu.cn', 'mirrors.ustc.edu.cn', 'mirrors.sjtug.sjtu.edu.cn',
];

// 网关代理由两类主机使用: 官方不带 ACAO 的 CDN(恒用), 以及当前选中镜像站的根(镜像站在浏览器内都不带 ACAO)
// 自带 CORS 的主机(piston、Sponge、各 maven、mcasset、Modrinth/CurseForge)一律直连, 不经网关
export const GATEWAY_HOSTS = [
  'libraries.minecraft.net', 'resources.download.minecraft.net',
  'launcher.mojang.com', 'launchermeta.mojang.com',
];

// 默认 CORS 网关(公开部署的 EdgeOne Makers 实例): 用户可在设置里换成自己的
export const DEFAULT_GATEWAY = 'https://mc-gateway.noon.pw/api/gw?url={url}';

// GitHub 在国内多数线路被重置: 默认套 gh-proxy 前缀, 用户可换自己的
export const DEFAULT_GH_PROXY = 'https://gh-proxy.org/';

export const DEFAULT_SOURCES = {
  versionManifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  fabricMeta: 'https://meta.fabricmc.net',
  quiltMeta: 'https://meta.quiltmc.org',
  legacyFabricMeta: 'https://meta.legacyfabric.net',
  forgeMaven: 'https://maven.minecraftforge.net',
  neoforgeMaven: 'https://maven.neoforged.net/releases',
  modrinthApi: 'https://api.modrinth.com/v2',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(message, status, url) {
    super(message);
    this.status = status;
    this.url = url;
  }
}

// gateway: 形如 https://example.com/?url={url} 的用户自建 CORS 网关
export function viaGateway(url, gateway) {
  if (!gateway) return null;
  if (gateway.includes('{url}')) return gateway.replace('{url}', encodeURIComponent(url));
  return gateway.replace(/\/$/, '') + '/' + url;
}

export async function fetchWithRetry(url, options = {}) {
  const { retries = 3, timeout = 30000, ...init } = options;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal, mode: 'cors', credentials: 'omit' });
      clearTimeout(timer);
      if (!res.ok) throw new HttpError('HTTP ' + res.status + ' ' + url, res.status, url);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) break;
      if (attempt < retries) await sleep(400 * Math.pow(2, attempt));
    }
  }
  throw lastError;
}

export async function fetchJson(url, options) {
  const res = await fetchWithRetry(url, options);
  return res.json();
}

// 大陆机器判定: 时区或语言命中即视为大陆(与 HMCL RegionUtils 的时区白名单同思路)
export function detectMainland() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Harbin', 'Asia/Urumqi', 'PRC'].includes(tz)) return true;
    const lang = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    return /^zh(-CN|-Hans)?$/i.test(lang) && tz.startsWith('Asia/');
  } catch {
    return false;
  }
}

export class Sources {
  constructor(config = {}) {
    this.mode = MODE_ALIAS[config.mode] || config.mode || 'default';
    if (!SOURCE_MODES[this.mode]) this.mode = 'default';
    this.config = { ...DEFAULT_SOURCES, ...config };
    this.bmclRoot = config.bmclRoot || BMCLAPI_ROOT;
    this.mirrorSite = MIRROR_SITES[config.mirrorSite] ? config.mirrorSite : DEFAULT_MIRROR_SITE;
    this.mirrorRoot = config.mirrorRoot || '';
    // 本机 Chrome 用 --disable-web-security 启动时关闭同源策略: 不再需要网关, 也不剔除无 ACAO 的主机
    this.noCors = Boolean(config.noCors);
    this.ghProxy = config.ghProxy === undefined ? DEFAULT_GH_PROXY : config.ghProxy;
    this.gateway = config.gateway === undefined ? DEFAULT_GATEWAY : config.gateway;
    this.libraryProxy = config.libraryProxy ?? BROWSER_LIBRARY_PROXY;
    this.assetMirrors = config.assetMirrors ?? BROWSER_ASSET_MIRRORS;
    this.mainland = config.mainland ?? detectMainland();
    this.curseApiKey = config.curseApiKey || '';
    this.isBrowser = config.isBrowser ?? (typeof window !== 'undefined');
    this.goodHosts = new Map();
    this.deadHosts = new Set();
  }

  // 文件候选: 大陆的 DEFAULT 与 MIRROR 镜像优先, OFFICIAL 官方优先; 非大陆 DEFAULT 不用镜像
  get preferMirror() {
    if (this.mode === 'mirror') return true;
    if (this.mode === 'official') return false;
    return this.mainland;
  }

  get allowOfficial() {
    return SOURCE_MODES[this.mode].allowOfficialFallback;
  }

  hostHasCors(url) {
    try {
      const host = new URL(url).host;
      return CORS_HOSTS.some((h) => host === h || host.endsWith('.' + h));
    } catch { return false; }
  }

  hostNeedsGateway(url) {
    try {
      const host = new URL(url).host;
      if (GATEWAY_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return true;
      return this.mirrorHosts.has(host);
    } catch { return false; }
  }

  hostLacksCors(url) {
    try {
      const host = new URL(url).host;
      return NO_CORS_HOSTS.some((h) => host === h || host.endsWith('.' + h));
    } catch { return false; }
  }

  // 当前镜像站点: 规则表与镜像根由站点决定
  get site() {
    return MIRROR_SITES[this.mirrorSite];
  }

  siteRoot(root) {
    return root === '{bmcl}' ? this.bmclRoot : root;
  }

  // 当前站点实际使用的镜像根(自定义站点取用户填写的根, 未填时退回 BMCLAPI)
  get siteRoots() {
    const site = this.site;
    if (site.id === 'custom') {
      const root = (this.mirrorRoot || '').replace(/\/$/, '');
      return [root || this.bmclRoot];
    }
    return site.roots.map((root) => this.siteRoot(root));
  }

  // 当前镜像站根的主机: 这些主机在浏览器内也经网关(镜像站均不返回 ACAO)
  get mirrorHosts() {
    const hosts = new Set();
    for (const root of this.siteRoots) {
      try { hosts.add(new URL(root).host); } catch { }
    }
    return hosts;
  }

  // 最长前缀匹配, 返回该站上的镜像地址列表(高校镜像有多所)与 fallback 标记
  applyRule(url) {
    const site = this.site;
    let best = null;
    for (const rule of site.rules) {
      if (!url.startsWith(rule.source)) continue;
      if (!best || rule.source.length > best.source.length) best = rule;
    }
    if (!best) return null;
    const rest = url.slice(best.source.length);
    const mirrors = [];
    for (const root of this.siteRoots) {
      const target = best.target.replace('{root}', root);
      const mirror = target + rest;
      if (!mirrors.includes(mirror)) mirrors.push(mirror);
    }
    return { mirrors, fallback: Boolean(best.fallback) };
  }

  // 把一组官方地址展开成候选链; kind: 'file' | 'meta'
  expand(urls, kind = 'file') {
    const out = [];
    for (const url of urls) {
      const rule = this.applyRule(url);
      if (!rule) {
        out.push(url);
        continue;
      }
      const mirrorFirst = kind === 'meta'
        ? (this.mode === 'mirror' || (this.mode === 'default' && this.mainland))
        : (rule.fallback ? false : this.preferMirror);
      if (mirrorFirst) out.push(...rule.mirrors, url);
      else out.push(url, ...rule.mirrors);
    }
    return this.normalize(out);
  }

  // raw.githubusercontent.com 直连在多数线路被重置: 返回 gh-proxy 前缀地址(可换成用户自己的代理)
  ghProxyOf(url) {
    if (!this.ghProxy) return null;
    try {
      if (new URL(url).host !== 'raw.githubusercontent.com') return null;
    } catch { return null; }
    const base = this.ghProxy.endsWith('/') ? this.ghProxy : this.ghProxy + '/';
    return base + url;
  }

  // 去重、按 CORS 能力过滤或加网关、按历史成功率排序
  normalize(urls) {
    const list = [];
    for (const url of urls) {
      if (!url) continue;
      if (this.isBrowser && !this.noCors) {
        // 官方两个 CDN 无 ACAO: 有网关才包一层, 没网关就直接剔除
        if (this.hostNeedsGateway(url)) {
          if (this.gateway) {
            const wrapped = viaGateway(url, this.gateway);
            if (wrapped) list.push(wrapped);
          }
          continue;
        }
        // 其余无 ACAO 的主机(镜像站、launchermeta 等)不经网关: 直连必失败, 剔除
        if (this.hostLacksCors(url)) continue;
      }
      const proxied = this.ghProxyOf(url);
      if (proxied) {
        if (this.preferMirror) list.push(proxied, url);
        else list.push(url, proxied);
        continue;
      }
      list.push(url);
    }
    return this.rank(list);
  }

  markHost(host, ok) {
    const stat = this.goodHosts.get(host) || { ok: 0, fail: 0 };
    if (ok) stat.ok++; else stat.fail++;
    this.goodHosts.set(host, stat);
    // 连续失败且从未成功: 直接进 deadHosts, 之后的候选链不再排它
    if (!ok && stat.ok === 0 && stat.fail >= 3) this.deadHosts.add(host);
  }

  checkHostHealth(host) {
    const stat = this.goodHosts.get(host);
    if (stat && stat.ok === 0 && stat.fail >= 3) {
      if (!this.deadHosts.has(host)) {
        this.deadHosts.add(host);
        return true;
      }
    }
    return false;
  }

  // 统计与熔断用的主机键: 网关包装后的地址按内层主机算, 否则所有经网关的请求会共用一个"主机", 一挂全挂
  hostKey(url) {
    let target = url;
    try {
      const inner = new URL(url).searchParams.get('url');
      if (inner) target = inner;
    } catch { return url; }
    try { return new URL(target).host; } catch { return url; }
  }

  rank(urls) {
    const alive = urls.filter((u) => !this.deadHosts.has(this.hostKey(u)));
    const list = alive.length ? alive : urls;
    const score = (u) => {
      const s = this.goodHosts.get(this.hostKey(u));
      if (!s) return 0;
      if (s.fail >= 3 && s.ok === 0) return -100;
      return (s.ok - s.fail) / Math.max(1, s.ok + s.fail);
    };
    return [...new Set(list)].map((u, i) => ({ u, i, s: score(u) }))
      .sort((a, b) => (b.s - a.s) || (a.i - b.i))
      .map((x) => x.u);
  }

  // 各类资源的候选链
  libraryCandidates(lib) {
    // 与 HMCL Library.computePath 一致: 显式 url > 库声明的仓库 > 官方默认库地址
    const official = lib.explicitUrl
      || (lib.fallbackBase ? lib.fallbackBase.replace(/\/?$/, '/') + lib.mavenPath : null)
      || ('https://libraries.minecraft.net/' + lib.mavenPath);
    const officialIsCors = this.hostHasCors(official);
    const head = [];
    if (officialIsCors) head.push(official);
    // 官方库主机无 CORS: 镜像优先, 或浏览器里没有网关时只能走代理
    const wantProxy = Boolean(this.libraryProxy)
      && (this.preferMirror || (!officialIsCors && this.isBrowser && !this.gateway));
    if (wantProxy) head.push(this.libraryProxy + lib.mavenPath);
    const list = this.normalize([...head, ...this.expandRaw(official)]);
    if (list.length) return list;
    return this.normalize(wantProxy ? [this.libraryProxy + lib.mavenPath] : [official]);
  }

  // 不做 CORS 过滤的原始展开, 供 libraryCandidates 组合
  // meta=true 时按 HMCL 的版本清单语义: 只有 MIRROR 模式才镜像优先
  expandRaw(url, meta = false) {
    const rule = this.applyRule(url);
    if (!rule) return [url];
    const mirrorFirst = meta ? this.mode === 'mirror' : (rule.fallback ? false : this.preferMirror);
    return mirrorFirst ? [...rule.mirrors, url] : [url, ...rule.mirrors];
  }

  // 取 maven 相对路径: 用于在其它镜像站上构造同一构件的地址
  mavenPathOf(url) {
    let target = url;
    if (this.gateway) {
      try { target = new URL(url).searchParams.get('url') || url; } catch { }
    }
    const prefixes = [
      'https://maven.minecraftforge.net/',
      'https://files.minecraftforge.net/maven/',
      'https://maven.neoforged.net/releases/',
      'https://maven.fabricmc.net/',
      'https://libraries.minecraft.net/',
      'https://repo1.maven.org/maven2/',
      `${this.bmclRoot}/maven/`,
      ...CAMPUS_MIRROR_ROOTS.map((root) => root + '/'),
      ...(this.mirrorRoot ? [this.mirrorRoot.replace(/\/$/, '') + '/maven/'] : []),
    ];
    for (const prefix of prefixes) {
      if (target.startsWith(prefix)) return target.slice(prefix.length);
    }
    return null;
  }

  // 单文件(安装器等): 同一构件在当前镜像站各根上的地址一起交给并行探测, 不依赖某一个站可用
  altMavenCandidates(url) {
    const path = this.mavenPathOf(url);
    if (!path) return [];
    const out = [];
    for (const target of this.mavenMirrorTargets(path)) {
      for (const candidate of this.dataUrlCandidates(target)) {
        if (!out.includes(candidate)) out.push(candidate);
      }
    }
    return out;
  }

  // 当前镜像站上某个 maven 相对路径的地址(按站点规则表拼, bmclapi 是 <root>/maven/, 高校镜像是 <root>/)
  mavenMirrorTargets(path) {
    const rule = this.site.rules.find((r) => r.source === 'https://maven.minecraftforge.net')
      || this.site.rules.find((r) => r.source.startsWith('https://maven.'));
    if (!rule) return [];
    return this.siteRoots.map((root) => rule.target.replace('{root}', root) + '/' + path);
  }

  assetCandidates(versionId, name, hash) {
    const official = `https://resources.download.minecraft.net/${hash.substring(0, 2)}/${hash}`;
    const head = (this.assetMirrors || []).map((pattern) => pattern
      .replace('{version}', encodeURIComponent(versionId))
      .replace('{name}', name)
      .replace('{hash2}', hash.substring(0, 2))
      .replace('{hash}', hash));
    const chain = this.mode === 'official' ? [] : head;
    const list = this.normalize([...chain, ...this.expandRaw(official)]);
    if (list.length) return list;
    // 官方模式在浏览器内无网关时, 官方与镜像都不可用, 退回按名寻址的静态镜像
    return this.normalize([...head, official]);
  }

  // 单地址(客户端 jar / 资源索引 / 日志配置 / 整合包文件)的降级链
  // 本身带 CORS 的主机(官方元数据、Modrinth CDN)直接用官方地址, 镜像只作兜底
  dataUrlCandidates(url) {
    const chain = this.expandRaw(url);
    const ordered = this.hostHasCors(url) ? [url, ...chain.filter((u) => u !== url)] : chain;
    return this.normalize(ordered);
  }

  metaCandidates(url) {
    return this.normalize(this.expandRaw(url, true));
  }

  versionJsonCandidates(entry) {
    return this.metaCandidates(entry.url);
  }
}

export async function loadVersionManifest(sources) {
  const candidates = sources.metaCandidates(sources.config.versionManifest);
  let lastError;
  for (const url of candidates) {
    try {
      return await fetchJson(url);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export async function loadVersionJson(sources, entry) {
  let lastError;
  for (const url of sources.versionJsonCandidates(entry)) {
    try {
      return await fetchJson(url);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// 加载器元数据接口版本: Quilt 用 v3, Fabric/Legacy Fabric 用 v2
export const META_API_VERSION = { fabric: 'v2', legacyfabric: 'v2', quilt: 'v3' };

export async function loadFabricProfile(sources, type, gameVersion, loaderVersion) {
  const bases = {
    fabric: sources.config.fabricMeta,
    quilt: sources.config.quiltMeta,
    legacyfabric: sources.config.legacyFabricMeta,
  };
  const api = META_API_VERSION[type] || 'v2';
  const url = `${bases[type]}/${api}/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`;
  let lastError;
  for (const candidate of sources.metaCandidates(url)) {
    try {
      return await fetchJson(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export async function loadFabricLoaderVersions(sources, type, gameVersion) {
  const bases = {
    fabric: sources.config.fabricMeta,
    quilt: sources.config.quiltMeta,
    legacyfabric: sources.config.legacyFabricMeta,
  };
  const api = META_API_VERSION[type] || 'v2';
  const url = `${bases[type]}/${api}/versions/loader/${encodeURIComponent(gameVersion)}`;
  let lastError;
  for (const candidate of sources.metaCandidates(url)) {
    try {
      const list = await fetchJson(candidate);
      // 稳定版优先, 版本号按数字段倒序
      const cmp = (a, b) => {
        const pa = a.version.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
        const pb = b.version.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const d = (pb[i] || 0) - (pa[i] || 0);
          if (d) return d;
        }
        return 0;
      };
      return list
        .map((it) => ({ version: it.loader.version, stable: Boolean(it.loader.stable) }))
        .sort((a, b) => (Number(b.stable) - Number(a.stable)) || cmp(a, b));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export async function loadMavenVersions(url) {
  const res = await fetchWithRetry(url);
  const xml = await res.text();
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
}

export async function loadForgeVersions(sources, gameVersion) {
  const all = await loadMavenVersions(sources.config.forgeMaven + '/net/minecraftforge/forge/maven-metadata.xml');
  return all
    .filter((v) => v.startsWith(gameVersion + '-'))
    .map((v) => v.slice(gameVersion.length + 1))
    .reverse();
}

export async function loadNeoForgeVersions(sources, gameVersion) {
  const all = await loadMavenVersions(sources.config.neoforgeMaven + '/net/neoforged/neoforge/maven-metadata.xml');
  const [major, minor] = gameVersion.split('.');
  const prefix = `${major}.${minor}.`;
  return all.filter((v) => v.startsWith(prefix)).reverse();
}

// CurseForge 文件名解析: 清单里只有 projectID/fileID 时用官方 API 换出 fileName 与真实下载地址
// api.curseforge.com 对 Origin 回 Access-Control-Allow-Origin, 且预检允许 x-api-key
const curseFileCache = new Map();

const CURSE_CACHE_KEY = 'mcweb.curseFileCache.v1';
const CURSE_CACHE_TTL = 7 * 24 * 3600 * 1000;

function curseCacheGet(key) {
  try {
    const all = JSON.parse(globalThis.localStorage?.getItem(CURSE_CACHE_KEY) || '{}');
    const hit = all[key];
    if (hit && Date.now() - hit.at < CURSE_CACHE_TTL) return hit.value;
  } catch { }
  return null;
}

function curseCachePut(key, value) {
  try {
    const all = JSON.parse(globalThis.localStorage?.getItem(CURSE_CACHE_KEY) || '{}');
    all[key] = { at: Date.now(), value };
    // 只保留最近 3000 条, 防止无限增长
    const keys = Object.keys(all);
    if (keys.length > 3000) {
      keys.sort((a, b) => all[a].at - all[b].at);
      for (const k of keys.slice(0, keys.length - 3000)) delete all[k];
    }
    globalThis.localStorage?.setItem(CURSE_CACHE_KEY, JSON.stringify(all));
  } catch { }
}

export async function resolveCurseFile(sources, projectID, fileID) {
  const persistKey = projectID + ':' + fileID;
  const persisted = curseCacheGet(persistKey);
  if (persisted) return persisted;
  const cacheKey = projectID + ':' + fileID;
  if (curseFileCache.has(cacheKey)) return curseFileCache.get(cacheKey);
  const url = `https://api.curseforge.com/v1/mods/${projectID}/files/${fileID}`;
  const headers = sources.curseApiKey ? { 'x-api-key': sources.curseApiKey } : {};
  // api.curseforge.com 自带 ACAO 且预检允许 x-api-key: 本机有 key 就直连, 没 key 而有网关时才让网关代持
  const useGateway = !sources.curseApiKey && Boolean(sources.gateway);
  const res = useGateway
    ? await fetch(viaGateway(url, sources.gateway), { mode: 'cors', credentials: 'omit' })
    : await fetch(url, { headers, mode: 'cors', credentials: 'omit' });
  if (res.status === 403) throw new Error('CurseForge API 403：缺少或无效的 API Key');
  if (res.status === 429) throw new Error('CurseForge API 429：请求过于频繁');
  if (!res.ok) throw new Error('CurseForge API HTTP ' + res.status);
  const json = await res.json();
  const data = json && json.data;
  if (!data) throw new Error('CurseForge API 响应缺少 data');
  const result = {
    fileName: data.fileName || null,
    downloadUrl: data.downloadUrl || null,
    size: data.fileLength || 0,
    hashes: data.hashes || null,
  };
  curseFileCache.set(cacheKey, result);
  curseCachePut(persistKey, result);
  return result;
}

// 加载器配套 API/标准库: 从 Modrinth 取该游戏版本下最新的主文件
export const API_PROJECTS = {
  'fabric-api': { projectId: 'fabric-api', loaders: ['fabric'], label: 'Fabric API' },
  'quilt-api': { projectId: 'qsl', loaders: ['quilt'], label: 'Quilt 标准库 (QSL)' },
  'legacy-fabric-api': { projectId: 'legacy-fabric-api', loaders: ['fabric'], label: 'Legacy Fabric API' },
};

export async function loadModrinthVersionFor(sources, key, gameVersion) {
  const meta = API_PROJECTS[key];
  if (!meta) return null;
  const query = `game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}`
    + `&loaders=${encodeURIComponent(JSON.stringify(meta.loaders))}`;
  const url = `${sources.config.modrinthApi}/project/${meta.projectId}/version?${query}`;
  let list = null;
  let lastError = null;
  for (const candidate of sources.dataUrlCandidates(url)) {
    try {
      list = await fetchJson(candidate, { timeout: 20000 });
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!list) {
    if (lastError) throw lastError;
    return null;
  }
  if (!Array.isArray(list) || list.length === 0) return null;
  const version = list[0];
  const file = (version.files || []).find((f) => f.primary) || (version.files || [])[0];
  if (!file) return null;
  return {
    key,
    label: meta.label,
    versionNumber: version.version_number,
    name: version.name,
    file: {
      url: file.url,
      filename: file.filename,
      size: file.size || 0,
      sha1: file.hashes?.sha1 || null,
    },
  };
}

export function forgeInstallerCandidates(sources, gameVersion, forgeVersion, type) {
  if (type === 'neoforge') {
    const base = `${sources.config.neoforgeMaven}/net/neoforged/neoforge/${forgeVersion}`;
    return [`${base}/neoforge-${forgeVersion}-installer.jar`];
  }
  const base = `${sources.config.forgeMaven}/net/minecraftforge/forge/${gameVersion}-${forgeVersion}`;
  return [`${base}/forge-${gameVersion}-${forgeVersion}-installer.jar`];
}

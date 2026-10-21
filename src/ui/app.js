// 界面控制器: 版本/加载器/整合包解析, 计划生成, 导出执行与进度渲染
// UI 优化: 版本列表虚拟滚动, 进度渲染节流(120ms)并复用 DOM, 速度曲线用 Canvas, 日志批量插入
import { HashEngine } from '../core/hash.js';
import { Sources, SOURCE_MODES, MIRROR_SITES, DEFAULT_MIRROR_SITE, DEFAULT_GATEWAY, DEFAULT_GH_PROXY, probeCorsDisabled, loadVersionManifest, loadFabricLoaderVersions, loadForgeVersions, loadNeoForgeVersions } from '../core/hmcl/providers.js';
import { buildVersionPlan, buildModpackPlan, instanceIdFor } from '../core/hmcl/plan.js';
import { officialUrlsFor } from '../core/hmcl/official.js';
import { detectModpack, modrinthPlan, cursePlan, mcbbsPlan, multimcPlan } from '../core/hmcl/modpack.js';
import { ZipWriter } from '../core/zip/writer.js';
import { openZipFromBlob } from '../core/zip/reader.js';
import { DownloadEngine } from '../core/dl/engine.js';
import { FetchPool } from '../core/dl/pool.js';
import { HashPool } from '../core/dl/hashpool.js';
import { openOpfsSink, openFileSink } from '../core/zip/sink.js';
import { detectTarget } from '../core/hmcl/version.js';

const $ = (id) => document.getElementById(id);
const fmtBytes = (n) => {
  if (!n) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
};
const fmtTime = (s) => {
  if (!Number.isFinite(s) || s <= 0) return '--';
  if (s < 60) return `${Math.ceil(s)} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${Math.ceil(s % 60)} 秒`;
  return `${Math.floor(s / 3600)} 时 ${Math.floor((s % 3600) / 60)} 分`;
};

const CATEGORY_LABELS = {
  meta: '版本/清单', library: '运行库', jar: '客户端 jar', assetIndex: '资源索引',
  asset: '资源对象', logConfig: '日志配置', modpack: '整合包文件', override: '覆盖文件', api: 'API 模组', other: '其他',
};

const DEFAULT_SETTINGS = {
  concurrency: 16,
  chunkMB: 1,
  window: 6,
  verify: true,
  sink: 'auto',
  chunked: false,
  hostConcurrency: 16,
  h2HostConcurrency: 32,
  sourceMode: 'default',
  mirrorSite: DEFAULT_MIRROR_SITE,
  mirrorRoot: '',
  gateway: DEFAULT_GATEWAY,
  ghProxy: DEFAULT_GH_PROXY,
  noCors: false,
  curseApiKey: '',
  proxy: 'https://repo.spongepowered.org/repository/maven-public/',
  os: detectTarget().os,
  arch: detectTarget().arch,
  theme: 'light',
  includeAssets: true,
  includeLibraries: true,
};

// 设置版本: 2 起默认填好公开网关, 3 起补默认 GitHub 代理, 4 起并发默认 16 / 每主机 16
// 必须声明在 state 之前: state.settings 初始化时就要读它, 否则 TDZ 抛错会让设置全部退回默认值
const SETTINGS_VERSION = 4;

const state = {
  settings: loadSettings(),
  hashEngine: null,
  sources: null,
  builtinCurseKey: '',
  manifest: null,
  selectedVersion: null,
  selectedLoader: null,
  versionFilter: { search: '', type: 'release' },
  plan: null,
  modpack: null,
  engine: null,
  controller: null,
  pool: null,
  hashPool: null,
  running: false,
  stats: null,
  sinkInfo: null,
  zipWriter: null,
  ui: { lastRender: 0, cats: new Map(), samples: [], hist: [], logQueue: [], logScheduled: false, last: {} },
};

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem('mcweb.settings') || '{}');
    delete stored.hashWorkers; // 旧版的实验字段, 不再使用
    if (!stored.settingsVersion) {
      if (!stored.gateway) stored.gateway = DEFAULT_GATEWAY;
      if (!stored.ghProxy) stored.ghProxy = DEFAULT_GH_PROXY;
    } else if (stored.settingsVersion < 3 && !stored.ghProxy) {
      stored.ghProxy = DEFAULT_GH_PROXY;
    }
    if (!stored.settingsVersion || stored.settingsVersion < 4) {
      // 只升级仍是旧默认值的项, 用户自改过的数值保留
      if (stored.concurrency === 24) stored.concurrency = 16;
      if (stored.hostConcurrency === 6) stored.hostConcurrency = 16;
    }
    stored.settingsVersion = SETTINGS_VERSION;
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem('mcweb.settings', JSON.stringify(state.settings));
}

// 日志批量插入
function log(text, isError = false) {
  state.ui.logQueue.push({ text: `${new Date().toLocaleTimeString()}  ${text}`, isError });
  if (state.ui.logScheduled) return;
  state.ui.logScheduled = true;
  setTimeout(() => {
    state.ui.logScheduled = false;
    const box = $('logBox');
    if (!box) return;
    const frag = document.createDocumentFragment();
    for (const item of state.ui.logQueue.splice(0)) {
      const line = document.createElement('div');
      if (item.isError) line.className = 'err';
      line.textContent = item.text;
      frag.appendChild(line);
    }
    box.appendChild(frag);
    while (box.childElementCount > 300) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }, 60);
}

// 下载进行中禁止更换目标: 统一入口, 返回 true 表示已拦截
function guardRunning(action = '更换下载目标') {
  if (!state.running) return false;
  log(`正在下载中，不能${action}。先点“取消”结束当前导出再切换。`, true);
  return true;
}

function applyRunningLock(on) {
  document.body.classList.toggle('running', on);
  for (const id of ['sourceMode', 'setSourceMode', 'mirrorSite', 'setMirrorSite', 'setMirrorRoot', 'setGhProxy', 'setNoCors', 'setSink', 'setConcurrency', 'setChunk', 'setChunked', 'setHostConcurrency', 'setH2Concurrency', 'btnPlanVanilla', 'btnPlanLoader', 'btnLoaderList', 'setGateway', 'setProxy']) {
    const el = $(id);
    if (el) el.disabled = on;
  }
  const pick = $('pickModpack');
  if (pick) pick.style.pointerEvents = on ? 'none' : '';
  const drop = $('dropZone');
  if (drop) drop.style.pointerEvents = on ? 'none' : '';
}

function setNet(ok, text) {
  $('netDot').className = 'dot ' + (ok ? 'ok' : 'bad');
  $('netText').textContent = text;
}

// 虚拟列表
function virtualList(container, { rowHeight = 56, overscan = 6, renderRow }) {
  const inner = document.createElement('div');
  inner.className = 'vlist-inner';
  container.textContent = '';
  container.appendChild(inner);
  let items = [];
  const nodes = new Map();
  let raf = 0;

  const draw = () => {
    raf = 0;
    const top = container.scrollTop;
    const height = container.clientHeight || 400;
    const start = Math.max(0, Math.floor(top / rowHeight) - overscan);
    const end = Math.min(items.length, Math.ceil((top + height) / rowHeight) + overscan);
    for (const [index, node] of nodes) {
      if (index < start || index >= end) {
        node.remove();
        nodes.delete(index);
      }
    }
    for (let i = start; i < end; i++) {
      let node = nodes.get(i);
      if (!node) {
        node = renderRow(items[i], i);
        node.classList.add('vrow');
        node.style.height = rowHeight - 4 + 'px';
        node.style.top = i * rowHeight + 'px';
        inner.appendChild(node);
        nodes.set(i, node);
      }
    }
    inner.style.height = items.length * rowHeight + 'px';
  };

  const request = () => {
    if (raf) return;
    raf = requestAnimationFrame(draw);
  };

  container.addEventListener('scroll', request, { passive: true });
  window.addEventListener('resize', request);

  return {
    setItems(next) {
      items = next;
      for (const node of nodes.values()) node.remove();
      nodes.clear();
      draw();
    },
    refresh: request,
    rowHeight,
  };
}

// 视图切换
const VIEW_META = {
  home: ['主页', '纯前端解析与下载，导出启动器可直接使用的 .minecraft 压缩包'],
  download: ['下载', '原版版本、加载器与整合包清单解析'],
  instance: ['实例与导出', '计划摘要、并发参数与导出进度'],
  settings: ['设置', '目标平台、下载源与缓存'],
  about: ['说明', '能力边界与文件排列'],
};

function switchView(view) {
  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.classList.toggle('active', btn.dataset.view === view);
  }
  for (const el of document.querySelectorAll('.view')) {
    el.classList.toggle('active', el.id === 'view-' + view);
  }
  const meta = VIEW_META[view] || VIEW_META.home;
  $('viewTitle').textContent = meta[0];
  $('viewSubtitle').textContent = meta[1];
  if (view === 'settings') refreshStorageInfo();
  if (view === 'download') versionListView?.refresh();
}

// 设置
function applySettingsToForm() {
  const s = state.settings;
  $('setConcurrency').value = s.concurrency;
  $('setChunk').value = s.chunkMB;
  $('setChunked').checked = Boolean(s.chunked);
  $('setHostConcurrency').value = s.hostConcurrency;
  $('setH2Concurrency').value = s.h2HostConcurrency;
  $('setVerify').checked = s.verify;
  $('setSink').value = s.sink;
  $('setGateway').value = s.gateway;
  $('setGateway').placeholder = DEFAULT_GATEWAY;
  $('setGhProxy').value = s.ghProxy;
  $('setGhProxy').placeholder = DEFAULT_GH_PROXY;
  $('setNoCors').checked = Boolean(s.noCors);
  $('setCurseKey').value = s.curseApiKey;
  $('setCurseKey').placeholder = state.builtinCurseKey
    ? '已使用内置凭据（不显示）；填写可覆盖'
    : '可选，用于解析清单里缺 fileName 的 mod';
  $('setProxy').value = s.proxy;
  $('setSourceMode').value = s.sourceMode;
  $('sourceMode').value = s.sourceMode;
  $('setMirrorSite').value = s.mirrorSite;
  $('mirrorSite').value = s.mirrorSite;
  $('setMirrorRoot').value = s.mirrorRoot;
  $('setOs').value = s.os;
  $('setArch').value = s.arch;
  $('optAssets').checked = s.includeAssets;
  $('optLibs').checked = s.includeLibraries;
  document.documentElement.dataset.theme = s.theme;
}

function bindSettings() {
  const bindNumber = (id, key, min, max) => {
    $(id).addEventListener('change', () => {
      const v = Number($(id).value);
      state.settings[key] = Math.min(max, Math.max(min, v));
      $(id).value = state.settings[key];
      saveSettings();
    });
  };
  bindNumber('setConcurrency', 'concurrency', 1, 64);
  bindNumber('setChunk', 'chunkMB', 1, 16);
  bindNumber('setHostConcurrency', 'hostConcurrency', 1, 16);
  bindNumber('setH2Concurrency', 'h2HostConcurrency', 1, 64);
  $('setChunked').addEventListener('change', () => {
    state.settings.chunked = $('setChunked').checked;
    saveSettings();
    log(state.settings.chunked ? '分片下载已开启（同一文件多 Range）' : '分片下载已关闭（每文件一条连接）');
  });
  $('setVerify').addEventListener('change', () => { state.settings.verify = $('setVerify').checked; saveSettings(); });
  $('setSink').addEventListener('change', () => { state.settings.sink = $('setSink').value; saveSettings(); });
  $('setGateway').addEventListener('change', () => { state.settings.gateway = $('setGateway').value.trim(); saveSettings(); rebuildSources(); });
  $('setGhProxy').addEventListener('change', () => {
    state.settings.ghProxy = $('setGhProxy').value.trim();
    saveSettings();
    rebuildSources();
    renderCapabilities();
    log(state.settings.ghProxy ? `GitHub 代理已保存: ${state.settings.ghProxy}` : '已清空 GitHub 代理（raw.githubusercontent.com 直连）');
  });
  $('btnTestGateway').addEventListener('click', testGateway);
  $('setNoCors').addEventListener('change', () => {
    state.settings.noCors = $('setNoCors').checked;
    saveSettings();
    rebuildSources();
    renderCapabilities();
    log(state.settings.noCors
      ? '无 CORS 限制已开启：所有上游直连，不经网关（需要本机 Chrome 以 --disable-web-security 启动）'
      : '无 CORS 限制已关闭：恢复同源策略下的候选过滤与网关');
  });
  $('btnTestNoCors').addEventListener('click', async () => {
    log('检测同源策略是否已关闭…');
    const result = await probeCorsDisabled();
    if (result.ok) {
      log(`跨域限制已关闭（官方 libraries 返回 ${result.status}）`);
      if (!state.settings.noCors) log('可以把「无 CORS 限制」打开，省掉网关这一层');
    } else {
      log(`跨域限制仍在生效（${result.error || 'status ' + result.status}）：需要用 --disable-web-security --user-data-dir=<独立目录> 启动的 Chrome`, true);
    }
  });
  $('setCurseKey').addEventListener('change', () => {
    state.settings.curseApiKey = $('setCurseKey').value.trim();
    saveSettings();
    rebuildSources();
    log(state.settings.curseApiKey ? 'CurseForge API Key 已保存' : '已清空 CurseForge API Key');
  });
  $('setProxy').addEventListener('change', () => {
    state.settings.proxy = $('setProxy').value.trim();
    state.settings.sourceMode = 'custom';
    $('setSourceMode').value = 'custom';
    $('sourceMode').value = 'custom';
    saveSettings();
    rebuildSources();
  });
  const applySourceMode = (value) => {
    if (state.running) {
      guardRunning('切换下载源');
      $('setSourceMode').value = state.settings.sourceMode;
      $('sourceMode').value = state.settings.sourceMode;
      return;
    }
    state.settings.sourceMode = value;
    saveSettings();
    rebuildSources();
    $('setSourceMode').value = value;
    $('sourceMode').value = value;
    $('setProxy').value = state.settings.proxy;
    renderCapabilities();
    log(`下载源切换为 ${SOURCE_MODES[value]?.label || value}`);
  };
  $('setSourceMode').addEventListener('change', () => applySourceMode($('setSourceMode').value));
  $('sourceMode').addEventListener('change', () => applySourceMode($('sourceMode').value));
  const applyMirrorSite = (value) => {
    if (state.running) {
      guardRunning('切换镜像站点');
      $('setMirrorSite').value = state.settings.mirrorSite;
      $('mirrorSite').value = state.settings.mirrorSite;
      return;
    }
    state.settings.mirrorSite = MIRROR_SITES[value] ? value : DEFAULT_MIRROR_SITE;
    saveSettings();
    rebuildSources();
    $('setMirrorSite').value = state.settings.mirrorSite;
    $('mirrorSite').value = state.settings.mirrorSite;
    renderCapabilities();
    log(`镜像站点切换为 ${MIRROR_SITES[state.settings.mirrorSite].label}`);
  };
  $('setMirrorSite').addEventListener('change', () => applyMirrorSite($('setMirrorSite').value));
  $('mirrorSite').addEventListener('change', () => applyMirrorSite($('mirrorSite').value));
  $('setMirrorRoot').addEventListener('change', () => {
    state.settings.mirrorRoot = $('setMirrorRoot').value.trim();
    saveSettings();
    rebuildSources();
    renderCapabilities();
    log(state.settings.mirrorRoot ? `自定义镜像根已保存: ${state.settings.mirrorRoot}` : '已清空自定义镜像根');
  });
  $('setOs').addEventListener('change', () => { state.settings.os = $('setOs').value; saveSettings(); });
  $('setArch').addEventListener('change', () => { state.settings.arch = $('setArch').value; saveSettings(); });
  $('optAssets').addEventListener('change', () => { state.settings.includeAssets = $('optAssets').checked; saveSettings(); });
  $('optLibs').addEventListener('change', () => { state.settings.includeLibraries = $('optLibs').checked; saveSettings(); });
  $('btnClearOpfs').addEventListener('click', async () => {
    try {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
      refreshStorageInfo();
      log('OPFS 暂存已清理');
    } catch (err) {
      log('清理失败: ' + err.message, true);
    }
  });
}

// 只用于请求, 不写入界面, 也不回填到设置项
async function loadBuiltinCredentials() {
  try {
    const res = await fetch('config/keys.local.json', { cache: 'no-store' });
    if (!res.ok) return;
    const json = await res.json();
    if (json && typeof json.curseApiKey === 'string' && json.curseApiKey.trim()) {
      state.builtinCurseKey = json.curseApiKey.trim();
      const field = $('setCurseKey');
      if (field) field.placeholder = '已使用HMCL凭据（不显示）；填写可覆盖';
    }
  } catch {
    // 没有该文件属于正常情况
  }
}

function activeCurseKey() {
  return state.settings.curseApiKey || state.builtinCurseKey || '';
}

function rebuildSources() {
  state.sources = new Sources({
    mode: state.settings.sourceMode,
    mirrorSite: state.settings.mirrorSite,
    mirrorRoot: state.settings.mirrorRoot,
    ghProxy: state.settings.ghProxy,
    noCors: state.settings.noCors,
    gateway: state.settings.gateway,
    curseApiKey: activeCurseKey(),
    libraryProxy: state.settings.sourceMode === 'custom' ? state.settings.proxy : undefined,
  });
  if (state.settings.sourceMode === 'custom') state.sources.libraryProxy = state.settings.proxy;
  else state.settings.proxy = state.sources.libraryProxy;
}

async function refreshStorageInfo() {
  const el = $('opfsInfo');
  if (!el) return;
  if (!navigator.storage?.estimate) { el.textContent = '当前浏览器不提供用量估算'; return; }
  const est = await navigator.storage.estimate();
  el.textContent = `已用 ${fmtBytes(est.usage || 0)} / 配额 ${fmtBytes(est.quota || 0)}`;
}

// 能力检测
function mirrorSiteText() {
  const site = MIRROR_SITES[state.settings.mirrorSite] || MIRROR_SITES[DEFAULT_MIRROR_SITE];
  if (site.id === 'custom') {
    return state.settings.mirrorRoot
      ? `自定义：${state.settings.mirrorRoot}（需带 ACAO）`
      : '自定义（未填写镜像根，退回 BMCLAPI）';
  }
  return site.id === 'bmclapi'
    ? 'BMCLAPI'
    : '高校镜像';
}

function renderCapabilities() {
  const rows = [
    ['WebAssembly', typeof WebAssembly === 'object'],
    ['Web Worker (module)', typeof Worker !== 'undefined'],
    ['SharedArrayBuffer', typeof SharedArrayBuffer !== 'undefined'],
    ['File System Access', typeof window.showSaveFilePicker === 'function'],
    ['OPFS 暂存', Boolean(navigator.storage?.getDirectory)],
    ['Streams 解压(deflate-raw)', typeof DecompressionStream === 'function'],
  ];
  $('capList').innerHTML = rows.map(([name, ok]) =>
    `<li>${name}：<b style="color:${ok ? 'var(--success)' : 'var(--error)'}">${ok ? '可用' : '不可用'}</b></li>`).join('');
  $('engineFacts').innerHTML = [
    ['校验算法', 'CRC-32 / SHA-1（WASM，含分片 CRC 合并）'],
    ['计算分布', '取回 Worker 并行算分片 CRC；SHA-1 与文件级 CRC 由 WASM 按序累计'],
    ['内存上限', `并发 ${state.settings.concurrency} × 分片 ${state.settings.chunkMB} MiB × 窗口 ${state.settings.window}`],
    ['目标平台', `${state.settings.os} / ${state.settings.arch}`],
    ['下载源', SOURCE_MODES[state.settings.sourceMode]?.label || state.settings.sourceMode],
    ['镜像站点', mirrorSiteText()],
    ['地区判定', state.sources?.mainland ? '大陆（镜像优先）' : '非大陆（官方优先）'],
    ['库代理', state.settings.proxy || '（空）'],
    ['CORS 网关', state.settings.gateway === DEFAULT_GATEWAY
      ? `${DEFAULT_GATEWAY}（默认）`
      : (state.settings.gateway || '（未配置，libraries/assets 会被剔除）')],
    ['CORS 限制', state.settings.noCors
      ? '已关闭（本机 Chrome --disable-web-security，全部直连）'
      : '同源策略生效（按网关与候选过滤）'],
    ['GitHub 代理', state.settings.ghProxy === DEFAULT_GH_PROXY
      ? `${DEFAULT_GH_PROXY}（默认）`
      : (state.settings.ghProxy || '（未配置，raw.githubusercontent 直连）')],
    ['CurseForge Key', state.settings.curseApiKey ? '用户填写' : (state.builtinCurseKey ? '复用HMCL' : '（未配置）')],
  ].map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join('');
}

// 版本列表
let versionListView = null;

async function ensureManifest() {
  if (state.manifest) return state.manifest;
  setNet(false, '正在获取版本清单');
  try {
    state.manifest = await loadVersionManifest(state.sources);
    setNet(true, `清单 ${state.manifest.versions.length} 个版本`);
    if (!state.selectedVersion) {
      const latest = state.manifest.latest?.release;
      state.selectedVersion = state.manifest.versions.find((v) => v.id === latest)?.id || null;
    }
    fillLoaderGameVersions();
    renderVersionList();
    return state.manifest;
  } catch (err) {
    setNet(false, '清单获取失败');
    log('版本清单获取失败: ' + err.message, true);
    throw err;
  }
}

function versionRows() {
  if (!state.manifest) return [];
  const { search, type } = state.versionFilter;
  return state.manifest.versions.filter((v) => {
    if (type === 'release' && v.type !== 'release') return false;
    if (type === 'snapshot' && v.type !== 'snapshot') return false;
    if (type === 'old' && !String(v.type).startsWith('old')) return false;
    if (search && !v.id.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
}

// 加载器页的游戏版本下拉, 与“原版游戏”页共用同一个选择
function fillLoaderGameVersions() {
  const select = $('loaderGameVersion');
  if (!select || !state.manifest) return;
  const releases = state.manifest.versions.filter((v) => v.type === 'release').slice(0, 200);
  select.innerHTML = releases.map((v) =>
    `<option value="${v.id}">${v.id}</option>`).join('');
  if (state.selectedVersion && releases.some((v) => v.id === state.selectedVersion)) {
    select.value = state.selectedVersion;
  } else if (releases.length) {
    state.selectedVersion = releases[0].id;
    select.value = state.selectedVersion;
  }
}

function renderVersionList() {
  const container = $('versionList');
  if (!versionListView) {
    versionListView = virtualList(container, {
      rowHeight: 56,
      renderRow: (item) => {
        const el = document.createElement('div');
        el.className = 'list-item' + (item.id === state.selectedVersion ? ' active' : '');
        el.dataset.version = item.id;
        const left = document.createElement('div');
        const id = document.createElement('div');
        id.className = 'id';
        id.textContent = item.id;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = new Date(item.releaseTime || item.time).toLocaleDateString();
        left.append(id, meta);
        const badge = document.createElement('span');
        badge.className = 'badge ' + (item.type === 'release' ? 'release' : item.type === 'snapshot' ? 'snapshot' : 'old');
        badge.textContent = item.type === 'release' ? '正式版' : item.type === 'snapshot' ? '快照' : '旧版本';
        el.append(left, badge);
        el.addEventListener('click', () => {
          if (guardRunning('切换要导出的版本')) return;
          state.selectedVersion = item.id;
          for (const node of container.querySelectorAll('.list-item.active')) node.classList.remove('active');
          el.classList.add('active');
          const select = $('loaderGameVersion');
          if (select && [...select.options].some((o) => o.value === item.id)) select.value = item.id;
          renderVersionDetail();
        });
        return el;
      },
    });
  }
  versionListView.setItems(versionRows());
  renderVersionDetail();
}

function renderVersionDetail() {
  const id = state.selectedVersion;
  $('detailTitle').textContent = id ? `版本 ${id}` : '选择一个版本';
  const entry = state.manifest?.versions.find((v) => v.id === id);
  if (!entry) { $('detailInfo').innerHTML = '<p class="muted">选择左侧列表中的版本</p>'; return; }
  $('detailInfo').innerHTML = [
    ['版本号', entry.id],
    ['类型', entry.type],
    ['发布时间', new Date(entry.releaseTime || entry.time).toLocaleString()],
    ['清单 SHA-1', entry.sha1 || '—'],
    ['实例目录', `versions/${instanceIdFor(entry.id, state.selectedLoader)}/`],
  ].map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join('');
  $('instanceName').placeholder = instanceIdFor(entry.id, state.selectedLoader);
}

// 计划
function renderPlanSummary() {
  const plan = state.plan;
  const box = $('planSummary');
  if (!plan) {
    box.innerHTML = '<p class="muted">尚未生成计划。在“下载”页选择版本或整合包后生成。</p>';
    $('btnStart').disabled = true;
    return;
  }
  const rows = Object.entries(plan.stats.byCategory || {}).map(([k, v]) =>
    `<div class="row"><span>${CATEGORY_LABELS[k] || k}</span><span>${v.count} 个 · ${fmtBytes(v.bytes)}</span></div>`).join('');
  const blocked = plan.assetBlocked
    ? `<div class="hint error"><b>资源对象不可下载</b>：${plan.warnings.find((w) => w.includes('资源镜像')) || '资源镜像缺少该版本'}</div>`
    : '';
  const warn = (plan.warnings || []).map((w) => `<div class="hint warn">${w}</div>`).join('');
  const unsupported = (plan.unsupported || []).map((u) =>
    `<div class="hint error"><b>${u.item}</b>：${u.detail}</div>`).join('');
  box.innerHTML = `
    <div class="kv">
      <div class="row"><span>实例 ID</span><span>${plan.instanceId}</span></div>
      <div class="row"><span>游戏版本</span><span>${plan.gameVersion}</span></div>
      <div class="row"><span>加载器</span><span>${plan.loader?.type ? `${plan.loader.type} ${plan.loader.version}` : '原版'}</span></div>
      <div class="row"><span>条目总数</span><span>${plan.stats.taskCount}</span></div>
      <div class="row"><span>需下载 mod</span><span>${plan.stats.modsCount ?? 0} 个</span></div>
      <div class="row"><span>覆盖文件</span><span>${plan.stats.overrideCount ?? 0} 个</span></div>
      <div class="row"><span>预计体积</span><span>${fmtBytes(plan.stats.totalBytes)}</span></div>
      ${rows}
    </div>${blocked}${warn}${unsupported}`;
  $('btnStart').disabled = state.running;
}

async function planVanilla() {
  if (!state.selectedVersion) return;
  await withBusy($('btnPlanVanilla'), '解析中…', async () => {
    log(`解析原版 ${state.selectedVersion}`);
    state.plan = await buildVersionPlan({
      sources: state.sources,
      ctx: { os: state.settings.os, arch: state.settings.arch, version: state.settings.os === 'windows' ? '10.0' : '0' },
      versionId: state.selectedVersion,
      loader: state.selectedLoader,
      includeAssets: state.settings.includeAssets,
      includeLibraries: state.settings.includeLibraries,
      instanceId: $('instanceName').value.trim() || null,
    });
    afterPlan();
  });
}

async function planLoader() {
  if (!state.selectedLoader) { log('先选择加载器版本', true); return; }
  const game = $('loaderGameVersion').value.trim() || state.selectedVersion;
  if (!game) { log('需要游戏版本', true); return; }
  await withBusy($('btnPlanLoader'), '解析中…', async () => {
    $('logBox').textContent = '';
    log(`解析 ${state.selectedLoader.type} ${state.selectedLoader.version} / ${game}`);
    state.plan = await buildVersionPlan({
      sources: state.sources,
      ctx: { os: state.settings.os, arch: state.settings.arch, version: state.settings.os === 'windows' ? '10.0' : '0' },
      versionId: game,
      loader: state.selectedLoader,
      includeAssets: state.settings.includeAssets,
      includeLibraries: state.settings.includeLibraries,
      extras: selectedLoaderExtras(),
      onStatus: (msg) => log(msg),
    });
    afterPlan();
  });
}

async function planModpack() {
  if (!state.modpack) return;
  const mp = state.modpack;
  await withBusy($('btnPlanModpack'), '解析中…', async () => {
    $('logBox').textContent = '';
    log(`解析整合包 ${mp.plan.name} (${mp.type})`);
    state.plan = await buildModpackPlan({
      sources: state.sources,
      ctx: { os: state.settings.os, arch: state.settings.arch, version: state.settings.os === 'windows' ? '10.0' : '0' },
      modpack: { ...mp.plan, type: mp.type },
      zip: mp.zip,
      instanceName: mp.plan.name,
      includeAssets: state.settings.includeAssets,
      includeLibraries: state.settings.includeLibraries,
      onStatus: (msg) => log(msg),
    });
    afterPlan();
  });
}


// 网关连通性自检: 用 CurseForge 一个真实文件元数据同时验证代理与 key 代持
// 用 XHR + 硬超时, 避免个别环境下 fetch 长期挂起不给反馈
function gatewayProbe(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = timeoutMs;
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => reject(new Error('连接失败（CORS 或被拦截）'));
    xhr.ontimeout = () => reject(new Error(`无响应，已等待 ${Math.round(timeoutMs / 1000)} 秒`));
    xhr.send();
  });
}

async function testGateway() {
  const gateway = $('setGateway').value.trim() || DEFAULT_GATEWAY;
  const target = 'https://api.curseforge.com/v1/mods/237664/files/7034259';
  const url = gateway.includes('{url}') ? gateway.replace('{url}', encodeURIComponent(target)) : gateway;
  const started = performance.now();
  $('btnTestGateway').disabled = true;
  log('测试网关: ' + gateway.replace('{url}', '…'));
  try {
    const res = await gatewayProbe(url);
    const ms = Math.round(performance.now() - started);
    let name = null;
    try {
      name = JSON.parse(res.text)?.data?.fileName || null;
    } catch { }
    if (res.status >= 200 && res.status < 300 && name) {
      log(`网关正常（${ms}ms）：能取到 CurseForge 元数据，fileName=${name}`);
    } else if (res.status >= 200 && res.status < 300) {
      log(`网关可访问（${ms}ms），但响应里没有 data.fileName：${res.text.slice(0, 120)}`, true);
    } else {
      log(`网关返回 HTTP ${res.status}（${ms}ms）：${res.text.slice(0, 120)}`, true);
    }
  } catch (err) {
    log(`网关不可用（${Math.round(performance.now() - started)}ms）：${err.message}`, true);
  } finally {
    $('btnTestGateway').disabled = false;
  }
}

function afterPlan() {
  const p = state.plan;
  log(`计划就绪: ${p.stats.taskCount} 条目, ${fmtBytes(p.stats.totalBytes)}`);
  for (const w of p.warnings || []) log('警告: ' + w, true);
  for (const u of p.unsupported || []) log('未支持: ' + u.item + ' - ' + u.detail, true);
  if (p.assetBlocked) log('资源对象已跳过: 镜像缺少该版本资源, 需要 CORS 网关或取消勾选“包含资源文件”', true);
  // 新计划覆盖旧的导出状态, 避免把上一次的结果/失败当成这一次的
  $('progressCard').hidden = true;
  $('resultCard').hidden = true;
  $('failCard').hidden = true;
  $('pgBar').style.width = '0%';
  $('pgPercent').textContent = '0%';
  $('pgBytes').textContent = '0 B / 0 B';
  $('pgSpeed').textContent = '0.00 MiB/s';
  $('pgEta').textContent = '--';
  state.stats = null;
  state.sinkInfo = null;
  renderPlanSummary();
  resetProgressView();
  switchView('instance');
}

async function withBusy(btn, busyText, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  try {
    await fn();
  } catch (err) {
    log(err.message || String(err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// 加载器
async function listLoaders() {
  const type = $('loaderType').value;
  const game = $('loaderGameVersion').value.trim() || state.selectedVersion;
  if (!game) { log('需要游戏版本', true); return; }
  $('loaderList').innerHTML = '<p class="muted">查询中…</p>';
  try {
    let items = [];
    if (['fabric', 'quilt', 'legacyfabric'].includes(type)) {
      items = await loadFabricLoaderVersions(state.sources, type, game);
    } else if (type === 'forge') {
      items = (await loadForgeVersions(state.sources, game)).map((v) => ({ version: v, stable: true }));
    } else if (type === 'neoforge') {
      items = (await loadNeoForgeVersions(state.sources, game)).map((v) => ({ version: v, stable: true }));
    }
    if (!items.length) {
      $('loaderList').innerHTML = `<p class="muted">${game} 没有可用的 ${type} 版本</p>`;
      return;
    }
    $('loaderList').innerHTML = items.map((it) => `
      <div class="list-item" data-loader-version="${it.version}">
        <div><div class="id">${it.version}</div><div class="meta">${it.stable ? '稳定版' : '预览版'}</div></div>
        <span class="badge">${type}</span>
      </div>`).join('');
    for (const el of $('loaderList').querySelectorAll('.list-item')) {
      el.addEventListener('click', () => {
        for (const other of $('loaderList').querySelectorAll('.list-item')) other.classList.remove('active');
        el.classList.add('active');
        state.selectedLoader = { type, version: el.dataset.loaderVersion };
        renderLoaderExtras(type);
        $('loaderTitle').textContent = `${type} ${state.selectedLoader.version}`;
        $('loaderInfo').innerHTML = [
          ['加载器', type],
          ['版本', state.selectedLoader.version],
          ['游戏版本', game],
          ['实例 ID', instanceIdFor(game, state.selectedLoader)],
        ].map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join('');
        renderVersionDetail();
      });
    }
    log(`${type} 列出 ${items.length} 个版本 (${game})`);
  } catch (err) {
    const unsupported = /HTTP (400|404)/.test(err.message || '');
    $('loaderList').innerHTML = unsupported
      ? `<p class="muted">${type} 没有游戏版本 ${game} 的构建（上游元数据返回 400/404）</p>`
      : `<p class="muted">查询失败: ${err.message}</p>`;
    log('加载器列表失败: ' + err.message, true);
  }
}

// 加载器配套 API 勾选, 对应 HMCL 的 FABRIC_API / QUILT_API / LEGACY_FABRIC_API 组件
const LOADER_API_OPTION = {
  fabric: { key: 'fabric-api', label: 'Fabric API', hint: '绝大多数 Fabric 模组依赖' },
  quilt: { key: 'quilt-api', label: 'Quilt 标准库 (QSL)', hint: 'Quilt 模组的公共库' },
  legacyfabric: { key: 'legacy-fabric-api', label: 'Legacy Fabric API', hint: '旧版本 Fabric 模组依赖' },
};

function renderLoaderExtras(type) {
  const box = $('loaderExtras');
  const option = LOADER_API_OPTION[type];
  if (!option) {
    box.innerHTML = `<p class="muted">${type} 没有配套 API 组件，库与主类由安装器补丁提供</p>`;
    return;
  }
  box.innerHTML = `
    <div class="field-row">
      <label>${option.label}</label>
      <label class="switch"><input type="checkbox" id="optLoaderApi" checked /><span></span></label>
    </div>
    <p class="muted">${option.hint}；选中后从 Modrinth 取该游戏版本下的最新主文件，落到 versions/&lt;实例ID&gt;/mods/</p>`;
}

function selectedLoaderExtras() {
  const type = state.selectedLoader?.type;
  const option = LOADER_API_OPTION[type];
  if (!option) return [];
  const box = $('optLoaderApi');
  return box && box.checked ? [option.key] : [];
}

// 整合包
async function loadModpackFile(file) {
  if (!file) return;
  $('modpackInfo').innerHTML = '<p class="muted">读取中…</p>';
  try {
    const zip = await openZipFromBlob(file);
    const detected = await detectModpack(zip);
    if (!detected) throw new Error('未识别的整合包清单（modrinth.index.json / manifest.json / mcbbs.packmeta / mmc-pack.json）');
    let plan;
    if (detected.type === 'modrinth') plan = modrinthPlan(detected.manifest, zip);
    else if (detected.type === 'curse') plan = await cursePlan(detected.manifest, zip, state.sources);
    else if (detected.type === 'mcbbs') plan = mcbbsPlan(detected.manifest, zip);
    else plan = await multimcPlan(detected.manifest, zip, file.name.replace(/\.zip$/i, ''));

    state.modpack = { file, zip, type: detected.type, plan };
    if (detected.type === 'curse') {
      const src = state.settings.curseApiKey ? '设置页填写的 key'
        : state.builtinCurseKey ? '内置凭据（config/keys.local.json）'
          : state.sources?.gateway ? '未配置 key，走网关'
            : '未配置 key';
      log(`CurseForge 查询身份: ${src}`);
    }
    $('modpackInfo').innerHTML = `
      <div class="kv">
        <div class="row"><span>文件</span><span>${file.name} (${fmtBytes(file.size)})</span></div>
        <div class="row"><span>清单类型</span><span>${detected.type}</span></div>
        <div class="row"><span>整合包名称</span><span>${plan.name}</span></div>
        <div class="row"><span>整合包版本</span><span>${plan.packVersion}</span></div>
        <div class="row"><span>游戏版本</span><span>${plan.gameVersion || '未声明'}</span></div>
        <div class="row"><span>加载器</span><span>${plan.loader?.type ? `${plan.loader.type} ${plan.loader.version}` : '未声明'}</span></div>
        <div class="row"><span>远端文件</span><span>${plan.files.length}</span></div>
        <div class="row"><span>其中 mod</span><span>${plan.modsCount ?? '—'}</span></div>
        <div class="row"><span>覆盖文件</span><span>${plan.overrides?.size || 0}</span></div>
      </div>
      ${(plan.warnings || []).map((w) => `<div class="hint warn">${w}</div>`).join('')}`;
    $('btnPlanModpack').disabled = false;
    log(`整合包已解析: ${plan.name} (${detected.type})`);
  } catch (err) {
    state.modpack = null;
    $('btnPlanModpack').disabled = true;
    $('modpackInfo').innerHTML = `<div class="hint error">解析失败: ${err.message}</div>`;
    log('整合包解析失败: ' + err.message, true);
  }
}

// 导出
async function chooseSink(zipName) {
  const mode = state.settings.sink;
  if (mode !== 'opfs' && typeof window.showSaveFilePicker === 'function') {
    try {
      const { sink, handle } = await openFileSink(zipName);
      state.sinkInfo = { kind: 'file', handle, name: handle.name };
      return sink;
    } catch (err) {
      log('未选择保存位置，改用 OPFS 暂存: ' + err.message);
    }
  }
  const opfs = await openOpfsSink('mcweb-export.zip');
  state.sinkInfo = { kind: 'opfs', opfs };
  return opfs.sink;
}

async function startExport() {
  if (!state.plan || state.running) return;
  const plan = state.plan;
  state.running = true;
  applyRunningLock(true);
  $('btnStart').disabled = true;
  $('btnCancel').disabled = false;
  $('resultCard').hidden = true;
  $('failCard').hidden = true;
  $('btnRetry').disabled = true;
  $('btnRetryGateway').disabled = true;
  $('btnSavePartial').disabled = true;
  $('progressCard').hidden = false;
  $('logBox').textContent = '';
  state.stats = null;
  resetProgressView();
  startTicker();

  const zipName = `${plan.instanceId}.zip`;
  const controller = new AbortController();
  state.controller = controller;

  try {
    const sink = await chooseSink(zipName);
    state.zipWriter = new ZipWriter(sink, { hashEngine: state.hashEngine });
    const poolSize = Math.max(2, Math.min(state.settings.concurrency, 24));
    state.pool = new FetchPool({ size: poolSize });
    state.hashPool = state.settings.hashWorkers > 0
      ? new HashPool({ size: Math.max(1, Math.min(4, state.settings.hashWorkers)) })
      : null;

    state.engine = new DownloadEngine({
      plan,
      writer: state.zipWriter,
      sources: state.sources,
      hashEngine: state.hashEngine,
      hashPool: state.hashPool,
      chunkSize: state.settings.chunkMB * 1024 * 1024,
      concurrency: poolSize,
      chunkWindow: 4,
      chunked: state.settings.chunked,
      hostConcurrency: state.settings.hostConcurrency,
      h2HostConcurrency: state.settings.h2HostConcurrency,
      onInfo: (msg) => log(msg),
      window: state.settings.window,
      verifyHashes: state.settings.verify,
      fetchChunk: (job) => state.pool.fetchChunk(job),
      streamFile: (job, onPart) => state.pool.streamFile(job, onPart),
      readZipEntry: (task) => task.zip.readEntry(task.zipEntry),
      signal: controller.signal,
      onProgress: (stats) => { state.stats = stats; },
    });

    log(`开始导出 ${zipName}，并发 ${poolSize}，${state.settings.chunked ? `分片 ${state.settings.chunkMB} MiB` : '整文件单请求'}，HTTP/2 多路复用上限 ${state.settings.h2HostConcurrency} 条/主机（HTTP/1.1 回退 ${state.settings.hostConcurrency} 条），哈希 ${state.hashPool ? 'Worker ' + state.hashPool.size : '主线程 WASM'}`);
    state.sink = sink;
    await state.engine.run();
    await afterEngineRun();
  } catch (err) {
    log('导出失败: ' + (err.message || String(err)), true);
  } finally {
    state.running = false;
    applyRunningLock(false);
    stopTicker();
    state.controller = null;
    $('btnCancel').disabled = true;
    $('btnStart').disabled = !state.plan;
    if (state.stats) renderProgress(state.stats, true);
  }
}

// 一次运行结束后: 有失败就给重试入口(只补失败项, 完成后重新封包), 无失败直接封包保存
// 取消也要给重试: 已写入的数据区不变, 重试只补未完成的条目, 再封包
async function afterEngineRun() {
  const summary = state.engine.summary();
  if (summary.failures.length || !summary.filesDone) {
    showRetryOffer(summary);
    return;
  }
  await finalizeAndSave();
}

function showRetryOffer(summary) {
  $('failCard').hidden = false;
  $('resultCard').hidden = true;
  const assetFails = summary.failures.filter((f) => f.category === 'asset').length;
  const hint = assetFails
    ? `<div class="hint warn">资源对象失败 ${assetFails} 个：按名字寻址的镜像覆盖不到这些对象（旧版 lang、被截断的传输等）。点「从网关重试」会用官方哈希地址 resources.download.minecraft.net/&lt;2位&gt;/&lt;hash&gt; 经 CORS 网关重新下载；普通重试仍按原候选链。</div>`
    : '';
  $('failList').innerHTML = `<div class="hint warn">共 ${summary.failures.length} 个条目未完成，已写入的 ${summary.filesDone} 个文件仍然有效。重试只下载失败的部分，不会重下已完成的内容。</div>`
    + hint
    + summary.failures.slice(0, 200).map((f) =>
      `<div class="row"><span>${f.category}</span><span>${f.path}<br><small>${f.reason}</small></span></div>`).join('');
  $('btnRetry').disabled = false;
  $('btnRetryGateway').disabled = false;
  $('btnSavePartial').disabled = false;
  $('btnRetry').textContent = `重试失败条目 (${summary.failures.length})`;
  log(`有 ${summary.failures.length} 个条目失败，可点“重试失败条目”只补下这些文件`);
}

async function finalizeAndSave() {
  const engine = state.engine;
  if (!engine) return;
  try {
    await engine.finalize();
    if (state.sink) {
      await state.sink.close();
      state.sink = null;
    }
    if (state.sinkInfo?.kind === 'opfs' && state.sinkInfo.opfs) {
      state.sinkInfo.file = await state.sinkInfo.opfs.finalize();
    }
    const summary = engine.summary();
    state.plan.result = summary;
    if (!summary.failures.length) {
      $('failCard').hidden = true;
      $('failList').innerHTML = '';
    }
    renderResult(summary, engine.stats);
    $('btnRetry').disabled = true;
    $('btnRetryGateway').disabled = true;
    $('btnSavePartial').disabled = true;
    log(`导出完成: ${fmtBytes(summary.zipBytes)}, 耗时 ${(summary.elapsed / 1000).toFixed(1)}s, 完成 ${summary.filesDone}/${summary.filesTotal}`);
  } catch (err) {
    log('封包失败: ' + (err.message || String(err)), true);
  } finally {
    state.pool?.terminate();
    state.hashPool?.terminate();
    state.pool = null;
    state.hashPool = null;
  }
}

// 从任务本身推导官方（无 ACAO）地址: 供「从网关重试」把这些地址套上网关重新下载

// 失败条目改用官方哈希地址 + 当前网关重试: 计划阶段没配网关时官方候选被剔除, 这条路径补上
async function retryFailedViaGateway() {
  if (!state.engine || state.running) return;
  const gateway = state.settings.gateway || DEFAULT_GATEWAY;
  if (!gateway) {
    log('先在设置里填写 CORS 网关：官方 libraries / resources 不返回 ACAO，必须经网关才能取', true);
    return;
  }
  const wrap = (url) => {
    if (state.settings.noCors) return url;   // 已关闭同源策略: 官方地址直接取, 不必过网关
    return gateway.includes('{url}')
      ? gateway.replace('{url}', encodeURIComponent(url))
      : gateway.replace(/\/$/, '') + '/' + url;
  };
  const failed = state.engine.tasks.filter((t) => t.failed && t.kind === 'http');
  let patched = 0;
  let skipped = 0;
  for (const task of failed) {
    const official = officialUrlsFor(task);
    if (!official.length) { skipped++; continue; }
    const keep = (task.urls || []).filter((u) => !u.startsWith(gateway.split('?')[0]));
    task.urls = [...official.map(wrap), ...keep];
    patched++;
  }
  log(`从网关重试：重建 ${patched} 个失败条目的官方地址${skipped ? `，${skipped} 个无法推导官方地址按原候选链` : ''}`);
  if (!patched) return;
  await retryFailed();
}

async function retryFailed() {
  if (!state.engine || state.running) return;
  state.running = true;
  applyRunningLock(true);
  $('btnRetry').disabled = true;
  $('btnRetryGateway').disabled = true;
  $('btnSavePartial').disabled = true;
  $('btnCancel').disabled = false;
  // 取消或上一轮结束后重试: 换一个新的 AbortController, 否则引擎会立刻被判为已取消
  const controller = new AbortController();
  state.controller = controller;
  state.engine.signal = controller.signal;
  startTicker();
  log('重试失败条目…');
  try {
    await state.engine.runRetry();
  } catch (err) {
    log('重试失败: ' + (err.message || String(err)), true);
  } finally {
    state.running = false;
    applyRunningLock(false);
    stopTicker();
    $('btnCancel').disabled = true;
  }
  await afterEngineRun();
}

function renderResult(summary, stats) {
  $('resultCard').hidden = false;
  const unsupported = (state.plan.unsupported || []).map((u) => `<div class="hint error">${u.item}：${u.detail}</div>`).join('');
  $('resultInfo').innerHTML = `
    <div class="kv">
      <div class="row"><span>压缩包大小</span><span>${fmtBytes(summary.zipBytes)}</span></div>
      <div class="row"><span>写入条目</span><span>${summary.entryCount}</span></div>
      <div class="row"><span>完成文件</span><span>${summary.filesDone} / ${summary.filesTotal}</span></div>
      <div class="row"><span>耗时</span><span>${(summary.elapsed / 1000).toFixed(1)} s</span></div>
      <div class="row"><span>平均速度</span><span>${(summary.speed / 1048576).toFixed(2)} MiB/s</span></div>
      <div class="row"><span>单连接回退</span><span>${summary.singleStream || 0} 个文件</span></div>
      <div class="row"><span>保存方式</span><span>${state.sinkInfo.kind === 'file' ? '已直接写入 ' + state.sinkInfo.name : 'OPFS 暂存'}</span></div>
    </div>${unsupported}`;
  $('btnSave').textContent = state.sinkInfo.kind === 'file' ? '再次下载副本' : '保存压缩包';
  $('btnSave').disabled = false;

  const fails = summary.failures || [];
  if (fails.length) {
    const assetFails = fails.filter((f) => f.category === 'asset').length;
    const hint = assetFails
      ? `<div class="hint warn">资源对象失败 ${assetFails} 个：按名字寻址的镜像无法覆盖这些对象（旧版 lang、被截断的传输等）。在设置里填 CORS 网关后会回落到官方哈希地址 resources.download.minecraft.net/&lt;2位&gt;/&lt;hash&gt;。</div>`
      : '';
    $('failCard').hidden = false;
    $('failList').innerHTML = hint + fails.slice(0, 200).map((f) =>
      `<div class="row"><span>${f.category}</span><span>${f.path}<br><small>${f.reason}</small></span></div>`).join('');
  }
  void stats;
}

function saveZip() {
  const info = state.sinkInfo;
  if (!info) return;
  const file = info.kind === 'file' ? null : info.file;
  if (!file) {
    log('文件已由浏览器写入所选路径，可在该路径查看');
    return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.plan.instanceId}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// 进度渲染(节流 + DOM 复用 + Canvas 曲线)
function resetProgressView() {
  state.ui.lastRender = 0;
  state.ui.cats.clear();
  state.ui.samples.length = 0;
  state.ui.hist.length = 0;
  state.ui.last = {};
  $('catList').textContent = '';
  if (versionListView) versionListView.refresh();
}

function setText(id, value) {
  if (state.ui.last[id] === value) return;
  state.ui.last[id] = value;
  $(id).textContent = value;
}

function drawSpeedChart() {
  const canvas = $('speedChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const samples = state.ui.samples;
  const style = getComputedStyle(document.documentElement);
  const grid = style.getPropertyValue('--outline-variant').trim() || '#C6C5D3';
  const accent = style.getPropertyValue('--primary').trim() || '#4352A5';
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
  if (samples.length < 2) return;
  const max = Math.max(...samples.map((s) => s.v), 1);
  ctx.beginPath();
  samples.forEach((s, i) => {
    const x = (i / (samples.length - 1)) * w;
    const y = h - (s.v / max) * (h - 6) - 3;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = accent + '22';
  ctx.fill();
}

function renderProgress(stats, finished = false) {
  const now = performance.now();
  if (!finished && now - state.ui.lastRender < 120) return;
  state.ui.lastRender = now;
  const hist = state.ui.hist;
  hist.push({ t: now, b: stats.bytesDone });
  while (hist.length > 2 && now - hist[0].t > 2000) hist.shift();
  const speed = hist.length > 1 && now > hist[0].t
    ? ((hist[hist.length - 1].b - hist[0].b) / ((now - hist[0].t) / 1000))
    : 0;

  const pct = stats.bytesTotal ? Math.min(100, (stats.bytesDone / stats.bytesTotal) * 100) : 0;
  setText('pgPercent', pct.toFixed(1) + '%');
  setText('pgBytes', `${fmtBytes(stats.bytesDone)} / ${fmtBytes(stats.bytesTotal)}`);
  // 速度取 2 秒滑窗, 避免分片成批到达时读数在 0 与峰值之间跳
  setText('pgSpeed', `${Math.max(0, speed / 1048576).toFixed(2)} MiB/s`);
  const remain = speed > 0 ? (stats.bytesTotal - stats.bytesDone) / speed : Infinity;
  setText('pgEta', finished ? '已完成' : `剩余 ${fmtTime(remain)}`);
  const bar = $('pgBar');
  bar.style.width = pct.toFixed(2) + '%';
  bar.classList.toggle('done', finished && stats.failures.length === 0);

  if (speed > 0 || finished) {
    state.ui.samples.push({ v: speed });
    if (state.ui.samples.length > 120) state.ui.samples.shift();
    drawSpeedChart();
  }

  for (const [key, value] of Object.entries(stats.perCategory)) {
    let row = state.ui.cats.get(key);
    if (!row) {
      const wrap = document.createElement('div');
      wrap.className = 'cat';
      const head = document.createElement('div');
      head.className = 'cat-head';
      const name = document.createElement('span');
      name.textContent = CATEGORY_LABELS[key] || key;
      const count = document.createElement('span');
      const barWrap = document.createElement('div');
      barWrap.className = 'bar';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      barWrap.appendChild(fill);
      head.append(name, count);
      wrap.append(head, barWrap);
      $('catList').appendChild(wrap);
      row = { count, fill };
      state.ui.cats.set(key, row);
    }
    const p = value.bytes ? (value.bytesDone / value.bytes) * 100 : (value.done / Math.max(1, value.count)) * 100;
    row.count.textContent = `${value.done}/${value.count}${value.failed ? ` · 失败 ${value.failed}` : ''}`;
    row.fill.style.width = Math.min(100, p).toFixed(1) + '%';
  }
}

// 进度刷新链: 仅在导出期间运行, 每 120ms 最多一次
let tickerTimer = 0;
function startTicker() {
  stopTicker();
  let lastBytes = -1;
  let lastChange = performance.now();
  let warned = false;
  const loop = () => {
    if (!state.running) return;
    if (state.stats) {
      renderProgress(state.stats);
      if (state.stats.bytesDone !== lastBytes) {
        lastBytes = state.stats.bytesDone;
        lastChange = performance.now();
        warned = false;
      } else if (!warned && performance.now() - lastChange > 12000) {
        warned = true;
        log('已 12 秒没有数据到达：浏览器代理若指向已关闭的端口会一直挂起，检查系统代理或把 127.0.0.1 设为直连', true);
      }
    }
    const wait = Math.max(30, 120 - (performance.now() - state.ui.lastRender));
    tickerTimer = setTimeout(loop, wait);
  };
  tickerTimer = setTimeout(loop, 120);
}

function stopTicker() {
  clearTimeout(tickerTimer);
  tickerTimer = 0;
}

// 启动
async function boot() {
  applySettingsToForm();
  await loadBuiltinCredentials();
  applySettingsToForm(); // 内置凭据加载后再刷新占位提示
  rebuildSources();
  bindSettings();
  renderCapabilities();

  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  }
  $('btnTheme').addEventListener('click', () => {
    state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = state.settings.theme;
    saveSettings();
    drawSpeedChart();
  });
  for (const tab of document.querySelectorAll('#downloadTabs .tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('#downloadTabs .tab')) t.classList.toggle('active', t === tab);
      for (const p of document.querySelectorAll('.tab-panel')) p.classList.toggle('active', p.id === 'panel-' + tab.dataset.tab);
    });
  }
  let searchTimer = 0;
  $('versionSearch').addEventListener('input', () => {
    const value = $('versionSearch').value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.versionFilter.search = value;
      versionListView?.setItems(versionRows());
    }, 160);
  });
  $('versionType').addEventListener('change', () => {
    state.versionFilter.type = $('versionType').value;
    versionListView?.setItems(versionRows());
  });
  $('btnPlanVanilla').addEventListener('click', planVanilla);
  $('btnLoaderList').addEventListener('click', listLoaders);
  $('loaderGameVersion').addEventListener('change', () => {
    state.selectedVersion = $('loaderGameVersion').value;
    versionListView?.setItems(versionRows());
    renderVersionDetail();
    log('游戏版本切换为 ' + state.selectedVersion + '，需要重新列出加载器');
  });
  $('btnPlanLoader').addEventListener('click', planLoader);
  $('btnPlanModpack').addEventListener('click', planModpack);
  $('btnStart').addEventListener('click', startExport);
  $('btnSave').addEventListener('click', saveZip);
  $('btnRetry').addEventListener('click', retryFailed);
  $('btnRetryGateway').addEventListener('click', retryFailedViaGateway);
  $('btnSavePartial').addEventListener('click', async () => {
    $('btnRetry').disabled = true;
    $('btnRetryGateway').disabled = true;
    $('btnSavePartial').disabled = true;
    await finalizeAndSave();
  });
  $('btnCancel').addEventListener('click', () => {
    log('已请求取消');
    state.controller?.abort();
  });
  $('pickModpack').addEventListener('click', (e) => { e.preventDefault(); $('modpackFile').click(); });
  $('modpackFile').addEventListener('change', (e) => loadModpackFile(e.target.files?.[0]));
  const zone = $('dropZone');
  for (const evt of ['dragenter', 'dragover']) {
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.add('over'); });
  }
  for (const evt of ['dragleave', 'drop']) {
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.remove('over'); });
  }
  zone.addEventListener('drop', (e) => loadModpackFile(e.dataTransfer?.files?.[0]));

  try {
    state.hashEngine = await HashEngine.load(new URL('../wasm/hash.wasm', import.meta.url).href);
    log('WASM 哈希引擎已就绪 (CRC-32 / SHA-1 / CRC 合并)');
  } catch (err) {
    log('WASM 加载失败: ' + err.message, true);
  }

  try {
    await ensureManifest();
  } catch {
    setNet(false, '清单不可用');
  }
}

window.__mcweb = state;
boot();

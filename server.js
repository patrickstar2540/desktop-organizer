'use strict';
/**
 * 桌面整理器 - 本地服务
 * 纯 Node 内置模块，零依赖。启动后以无边框应用窗口（Edge/Chrome --app）呈现。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');

const org = require('./organizer');
const win = require('./winutil');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const INSTANCE_PATH = path.join(DATA_DIR, 'instance.json');
const NO_OPEN = process.env.WB_NO_OPEN === '1';

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- 配置 ----------
const DEFAULT_CONFIG = { targetRoot: '', backupRoot: '', shortcutName: '已整理的文件', selected: ['office', 'image', 'note', 'folder', 'archive', 'unknown'] };

function loadConfig() {
  let cfg;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    cfg = { ...DEFAULT_CONFIG, ...raw };
  } catch {
    cfg = { ...DEFAULT_CONFIG };
  }
  return migrateOrder(cfg);
}

/**
 * 老版本的排序含义：序号 ① 最靠桌面外沿，所以右侧的两个组会「反着排」。
 * 新版本改成「面板从左到右 = 桌面从左到右」，右侧组的相对顺序要反过来一次，
 * 否则老用户升级后原来的布局会整个调个方向。只迁移一次。
 */
function migrateOrder(cfg) {
  if (Number(cfg.orderVersion) >= 2) return cfg;
  const order = Array.isArray(cfg.shortcutOrder) ? cfg.shortcutOrder.slice() : [];
  const sides = cfg.shortcutSides || {};
  const rightIdx = order.map((k, i) => ({ k, i })).filter(x => sides[x.k] === 'right');
  if (rightIdx.length > 1) {
    const vals = rightIdx.map(x => x.k).slice().reverse();
    rightIdx.forEach((x, n) => { order[x.i] = vals[n]; });
    cfg.shortcutOrder = order;
  }
  cfg.orderVersion = 2;
  saveConfig(cfg);
  return cfg;
}

function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8'); } catch { /* ignore */ }
}

// ---------- 桌面路径与隐藏文件缓存 ----------
let desktopPath = process.env.WB_DESKTOP && fs.existsSync(process.env.WB_DESKTOP)
  ? process.env.WB_DESKTOP
  : win.getDesktopPath();

/**
 * 桌面图标来自两个目录：当前用户桌面 + 公共桌面。
 * 只扫用户桌面会把「所有用户」的快捷方式（Steam/微信/Chrome 等）漏掉，
 * 它们就会留在桌面中间不动。
 */
function desktopDirs() {
  const dirs = [desktopPath];
  const pub = process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : 'C:\\Users\\Public\\Desktop';
  try {
    if (fs.statSync(pub).isDirectory() && path.resolve(pub).toLowerCase() !== path.resolve(desktopPath).toLowerCase()) {
      dirs.push(pub);
    }
  } catch { /* 没有公共桌面就算了 */ }
  return dirs;
}

let hiddenCache = { at: 0, set: new Set() };
function hiddenNames(dir) {
  if (Date.now() - hiddenCache.at > 60000) {
    hiddenCache = { at: Date.now(), set: win.getHiddenNames(dir) };
  }
  return hiddenCache.set;
}

function defaultTarget() {
  return path.join(os.homedir(), '桌面归档');
}

/**
 * 备份根目录：用户自己选的文件夹；没选过就跟整理用的存放位置一致
 * （这样第一次用只要选一次，两边都定下来了）。
 */
function backupRootOf(cfg) {
  const c = cfg || loadConfig();
  if (c.backupRoot) return c.backupRoot;
  return c.targetRoot || defaultTarget();
}

/** 存档实际落在 <备份根>\桌面备份 里，和整理出来的分类文件夹分开 */
function backupBaseOf(cfg) {
  return bk.defaultBase(backupRootOf(cfg));
}

function driveWritable(root) {
  try {
    if (!fs.existsSync(root)) return false;
    fs.accessSync(root, fs.constants.W_OK);
    return true;
  } catch { return false; }
}

function suggestionList() {
  const out = [defaultTarget()];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  for (const letter of ['D:', 'E:', 'F:', 'G:']) {
    if (driveWritable(letter + '\\')) add(path.join(letter + '\\', '桌面归档'));
  }
  return out.slice(0, 3);
}

// ---------- 业务 ----------
function currentScan() {
  const scan = org.scanDesktop(desktopPath, hiddenNames(desktopPath));
  return scan;
}

function publicScan(scan, cfg) {
  const isInsideDesktop = (p) => {
    const rel = path.relative(desktopPath, path.resolve(p));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  return {
    desktopPath,
    total: scan.total,
    skipped: scan.skipped,
    categories: scan.categories.map(c => ({
      key: c.key, name: c.name, folder: c.folder, hint: c.hint,
      subHint: c.subHint, subMode: c.subMode, count: c.count, size: c.size,
      items: c.items.slice(0, 200).map(i => ({
        name: i.name, size: i.size, mtime: i.mtime, isDir: i.isDir, subFolder: i.subFolder
      }))
    })),
    defaults: {
      targetRoot: cfg.targetRoot || defaultTarget(),
      backupRoot: backupRootOf(cfg),
      backupBase: backupBaseOf(cfg),
      shortcutName: cfg.shortcutName || DEFAULT_CONFIG.shortcutName,
      selected: cfg.selected || DEFAULT_CONFIG.selected
    },
    suggestions: suggestionList(),
    targetInvalid: cfg.targetRoot ? isInsideDesktop(cfg.targetRoot) : false,
    backup: backupSummary()
  };
}

function validateTarget(targetRoot) {
  const t = String(targetRoot || '').trim();
  if (!t) return '请先选择存放位置';
  const abs = path.resolve(t);
  const rel = path.relative(desktopPath, abs);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return '存放位置不能选在桌面里面，否则整理完会再次出现在桌面上';
  }
  if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) {
    return '存放位置是一个文件，请选择文件夹';
  }
  return '';
}

// ---------- 错误日志 ----------
const ERROR_LOG = path.join(DATA_DIR, 'error.log');
function writeErrorLog(e, tag) {
  try {
    const line = `[${new Date().toISOString()}] ${tag || ''} ${e && e.stack ? e.stack : e}\n`;
    fs.appendFileSync(ERROR_LOG, line, 'utf8');
  } catch { /* ignore */ }
}

process.on('uncaughtException', (e) => writeErrorLog(e, 'uncaughtException'));
process.on('unhandledRejection', (e) => writeErrorLog(e, 'unhandledRejection'));

// ---------- 整理任务 ----------
let job = null; // { id, state, done, total, current, result, error, startedAt, finishedAt }

function planTotal(plan) {
  let n = 0;
  for (const g of plan.groups) for (const s of g.subs) n += s.items.length;
  return n;
}

function startJob(plan, body, desktopForShortcut) {
  job = {
    id: Date.now().toString(36),
    state: 'running',
    done: 0,
    total: planTotal(plan),
    current: '',
    startedAt: Date.now(),
    result: null,
    error: null
  };
  const current = job;

  (async () => {
    try {
      const log = await org.executePlan(plan, DATA_DIR, {
        onProgress: (p) => {
          current.done = p.done;
          current.total = p.total;
          current.current = p.name;
        }
      });

      current.current = '正在刷新桌面…';

      let shortcut = null;
      if (body.makeShortcut) {
        const name = String(body.shortcutName || '已整理的文件').replace(/[\\/:*?"<>|]/g, '').trim() || '已整理的文件';
        const lnk = path.join(desktopForShortcut, name + '.lnk');
        try {
          const kind = win.createFolderShortcut(lnk, plan.targetRoot, '打开整理后的文件夹');
          const realPath = kind === 'url' ? lnk.replace(/\.lnk$/i, '.url') : lnk;
          shortcut = { ok: true, path: realPath, kind };
          log.shortcut = { path: realPath, kind };
          org.saveLog(DATA_DIR, log);
        } catch (e) {
          shortcut = { ok: false, error: e.message };
        }
      }

      // 桌面原件已被删除，必须主动通知 Explorer 重绘，否则会留下打不开的图标残影
      const deleted = log.moved.map(m => ({ path: m.from, isDir: !!m.isDir }));
      const refresh = win.refreshShell({ deleted, dirs: [desktopForShortcut] });

      current.result = {
        ok: true,
        movedCount: log.moved.length,
        skipped: log.skipped,
        failed: log.failed,
        targetRoot: plan.targetRoot,
        logId: log.id,
        shortcut,
        desktopRefreshed: !!refresh.ok
      };
      current.state = 'done';
      current.finishedAt = Date.now();
    } catch (e) {
      current.state = 'error';
      current.error = e.message || String(e);
      current.finishedAt = Date.now();
      writeErrorLog(e, 'execute');
    }
  })();

  return current;
}

// ---------- HTTP 工具 ----------
// ---------- 桌面快捷方式重排 ----------
const dti = require('./desktopicons');
const shorts = require('./shortcuts');
const cls = require('./classify');
const icons = require('./icons');
const dsk = require('./deskfiles');
const cln = require('./cleanup');
const uni = require('./uninstall');

const SHORTCUT_MAP_PATH = path.join(DATA_DIR, 'shortcut-map.json');
const ICON_LOG_DIR = path.join(DATA_DIR, 'icon-logs');
const ICON_CACHE_DIR = path.join(DATA_DIR, 'icon-cache');
const ICON_GROUPS = ['tool', 'niche', 'game', 'file'];
const SHORTCUT_GROUPS = ['tool', 'niche', 'game'];

function loadShortcutMap() {
  try { return JSON.parse(fs.readFileSync(SHORTCUT_MAP_PATH, 'utf8')) || {}; } catch { return {}; }
}
function saveShortcutMap(map) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SHORTCUT_MAP_PATH, JSON.stringify(map, null, 2), 'utf8');
  } catch { /* ignore */ }
}

/** 读取桌面全部图标 + 全部快捷方式，并完成分类 */
function collectShortcutData() {
  const readRes = dti.read();
  if (!readRes.ok) return { ok: false, error: readRes.error };

  const files = shorts.listShortcutFiles(desktopDirs());
  shorts.scanMeta(files);

  const memory = loadShortcutMap();
  const occByIndex = dti.occMap(readRes.icons);
  const byName = new Map();
  for (const ic of readRes.icons) {
    if (!byName.has(ic.name)) byName.set(ic.name, []);
    byName.get(ic.name).push({ i: ic.i, occ: occByIndex.get(ic.i), x: ic.x, y: ic.y });
  }

  const used = new Map();
  const buckets = { tool: [], niche: [], game: [], file: [], other: [] };
  const unmatched = [];

  for (const f of files) {
    const slots = byName.get(f.name) || [];
    const n = used.get(f.name) || 0;
    if (n >= slots.length) { unmatched.push(f.name); continue; }
    used.set(f.name, n + 1);
    const slot = slots[n];
    const r = cls.classifyShortcut(f, memory);
    // 纯规则结果（不看记忆）：用来判断"这条记忆是不是多余的"，否则会把自己的记忆当成规则结论删掉
    const ruleOnly = cls.classifyShortcut(f, null);
    const cat = ICON_GROUPS.includes(r.category) && r.category !== 'file' ? r.category : 'other';
    const iconKey = icons.keyFor(f.file);
    buckets[cat].push({
      name: f.name, occ: slot.occ, i: slot.i, x: slot.x, y: slot.y,
      category: cat, ruleCategory: ICON_GROUPS.includes(ruleOnly.category) ? ruleOnly.category : 'other',
      reason: r.reason, source: r.source, key: r.key,
      target: f.target || f.url || '',
      isUrl: !!f.url,
      file: f.file,
      iconKey,
      iconUrl: icons.isCached(ICON_CACHE_DIR, iconKey, f.file) ? '/icons/' + iconKey + '.png?v=' + icons.CACHE_VER : ''
    });
  }

  /* ---- 桌面文件（非快捷方式）：同样参与重排，但不取图标（类型差异已经足够明显） ---- */
  let fileItems = [];
  try {
    const desk = dsk.list(desktopDirs(), hiddenNames(desktopPath));
    const attached = dsk.attachIcons(desk, readRes.icons, used);
    fileItems = attached.map(it => ({
      name: it.iconName, occ: it.occ, i: it.i, x: it.x, y: it.y,
      category: 'file', sub: it.cat, file: it.file, isDir: it.isDir,
      size: it.size, mtime: it.mtime, label: it.name
    }));
    buckets.file = fileItems;
  } catch { /* 读不到就当作没有文件 */ }

  const cfg = loadConfig();
  const order = Array.isArray(cfg.shortcutOrder) && cfg.shortcutOrder.length
    ? cfg.shortcutOrder.filter(k => ICON_GROUPS.includes(k))
    : ['game', 'niche', 'tool'];
  for (const k of ICON_GROUPS) if (!order.includes(k)) order.push(k);

  const fileOrder = Array.isArray(cfg.fileOrder)
    ? cfg.fileOrder.filter(k => dsk.FILE_KEYS.includes(k))
    : [];
  for (const k of dsk.FILE_KEYS) if (!fileOrder.includes(k)) fileOrder.push(k);

  const fileCounts = {};
  for (const k of dsk.FILE_KEYS) {
    fileCounts[k] = fileItems.filter(it => it.sub === k).length;
  }

  const matched = buckets.tool.length + buckets.niche.length + buckets.game.length +
    buckets.file.length + buckets.other.length;

  return {
    ok: true,
    desktopPath,
    metrics: readRes.metrics,
    icons: readRes.icons,
    ghosts: readRes.icons.map(i => ({ x: i.x, y: i.y })),
    iconTotal: readRes.icons.length,
    nonShortcut: Math.max(0, readRes.icons.length - matched),
    groups: buckets,
    order,
    sides: { tool: 'right', niche: 'right', game: 'right', file: 'right', ...(cfg.shortcutSides || {}) },
    enabled: { tool: true, niche: true, game: true, file: true, ...(cfg.shortcutEnabled || {}) },
    gap: cfg.shortcutGap === 'fill' ? 'fill' : 'keep',
    memoryCount: Object.keys(memory).length,
    unmatched,
    // ---- 桌面文件 ----
    fileKeys: dsk.FILE_KEYS,
    fileMeta: dsk.FILE_KEYS.map(k => ({ key: k, ...dsk.META.get(k) })),
    fileOrder,
    fileCounts,
    fileTotal: fileItems.length,
    fileMode: cfg.fileMode === 'folder' ? 'folder' : 'arrange'
  };
}

/** 把前端传来的分组整理成标准 plan */
function normalizeIconPlan(data, body) {
  const index = new Map();
  for (const k of ['tool', 'niche', 'game', 'file', 'other']) {
    for (const it of data.groups[k] || []) index.set(it.name + '#' + it.occ, it);
  }

  const order = (Array.isArray(body.order) ? body.order : data.order)
    .filter(k => ICON_GROUPS.includes(k));
  for (const k of ICON_GROUPS) if (!order.includes(k)) order.push(k);

  const gap = body.gap === 'fill' ? 'fill' : 'keep';
  const fileMode = body.fileMode === 'folder' ? 'folder' : 'arrange';

  const fileOrder = (Array.isArray(body.fileOrder) ? body.fileOrder : (data.fileOrder || []))
    .filter(k => dsk.FILE_KEYS.includes(k));
  for (const k of dsk.FILE_KEYS) if (!fileOrder.includes(k)) fileOrder.push(k);

  const groups = {};
  const moving = new Set();
  let archived = [];

  for (const k of ICON_GROUPS) {
    const src = (body.groups && body.groups[k]) || {};
    let enabled = src.enabled !== false;
    const side = src.side === 'right' ? 'right' : 'left';
    let items = [];
    for (const raw of (Array.isArray(src.items) ? src.items : [])) {
      const found = index.get(raw.name + '#' + raw.occ);
      if (!found) continue;
      items.push(found);
    }

    if (k === 'file') {
      // 同类聚块：先按用户拖出来的类型顺序把同类文件拢在一起，再逐块摆开
      const rank = new Map(fileOrder.map((v, i) => [v, i]));
      items.sort((a, b) => (rank.get(a.sub) ?? 99) - (rank.get(b.sub) ?? 99));

      // 快照是缓存复用的，上一趟打的 brk 会留在同一批对象上，先清掉再按这一趟的排法重打
      for (const it of items) delete it.brk;

      if (enabled && gap === 'keep') {
        const seen = new Set();
        for (const it of items) {
          if (seen.has(it.sub)) continue;
          seen.add(it.sub);
          it.brk = true;
        }
        if (items.length) delete items[0].brk;
      }

      // 归档模式：建文件夹并移动文件，文件本身不再占桌面位置
      // 注意不要动 enabled —— 它表示「这一组要不要参与」，会被存进配置；
      // 归档只影响这一趟怎么排，不该把用户的选择改掉。
      if (fileMode === 'folder' && enabled) {
        // 排除「归档目标文件夹」自己：六个分类文件夹都是 folder 类，
        // 不排除的话第二次归档会把「办公文档」塞进「文件夹」里，越滚越深
        const archNames = new Set(dsk.FILE_KEYS.map(k => (dsk.META.get(k) || {}).folder));
        const selfTarget = it => it.isDir
          && path.dirname(it.file) === desktopPath
          && archNames.has(path.basename(it.file));
        archived = items.filter(it => !selfTarget(it));
        items = [];
      }
    }

    groups[k] = { key: k, enabled, side, items };
    if (enabled) for (const it of items) moving.add(it.name + '#' + it.occ);
  }

  const plan = { order, groups, gap, fileMode, fileOrder, archived };
  return { plan, moving };
}

/**
 * 桌面快照。
 *
 * 面板一打开就把桌面读一遍（这一步约 2 秒：读图标坐标、扫两个桌面目录、解析每个快捷方式）。
 * 之后用户每动一下（拖图标、改左右、切排法）只需要在这份快照上重算布局，几毫秒就够。
 * 如果每动一下都重新扫桌面，那就是「拖完等两秒才看到效果」——所以必须缓存。
 * 缓存只在面板打开、执行、撤销、恢复这些时刻刷新，面板开着的时候桌面不会自己变。
 */
let scSnap = { at: 0, data: null };
const SC_SNAP_TTL = 10 * 60 * 1000;

function shortcutSnapshot(fresh) {
  if (!fresh && scSnap.data && Date.now() - scSnap.at < SC_SNAP_TTL) return scSnap.data;
  const d = collectShortcutData();
  if (d.ok) { scSnap.data = d; scSnap.at = Date.now(); }
  else scSnap.data = null;
  return d;
}

function dropShortcutSnapshot() {
  scSnap.data = null;
  scSnap.at = 0;
}

/** 把前端传来的方案算成一组落点；预览和执行共用，保证「看到的」就是「会做的」 */
function layoutFromPlan(data, body) {
  const { plan, moving } = normalizeIconPlan(data, body);
  const anyEnabled = ICON_GROUPS.some(k => plan.groups[k].enabled && plan.groups[k].items.length)
    || (plan.fileMode === 'folder' && plan.archived.length > 0);
  if (!anyEnabled) return { error: '没有任何一组被勾选，或者勾选的组里没有图标' };
  const layout = dti.computeLayout(data.icons || [], data.metrics, plan, moving);
  return { plan, layout };
}

function shortcutLayoutPayload(data, plan, layout) {
  return {
    ok: true,
    metrics: data.metrics,
    order: plan.order,
    gap: plan.gap,
    total: layout.positions.length,
    overflow: layout.overflow,
    summary: layout.summary,
    positions: layout.positions,
    autoArrange: data.metrics.autoArrange,
    nonShortcut: data.nonShortcut,
    fileMode: plan.fileMode,
    fileOrder: plan.fileOrder,
    fileCounts: data.fileCounts,
    archivedCount: plan.fileMode === 'folder' ? plan.archived.length : 0,
    at: Date.now()
  };
}

function saveIconLog(entry) {
  try {
    fs.mkdirSync(ICON_LOG_DIR, { recursive: true });
    fs.writeFileSync(path.join(ICON_LOG_DIR, entry.id + '.json'), JSON.stringify(entry, null, 2), 'utf8');
    const all = fs.readdirSync(ICON_LOG_DIR).filter(f => f.endsWith('.json')).sort();
    while (all.length > 30) fs.unlinkSync(path.join(ICON_LOG_DIR, all.shift()));
  } catch { /* ignore */ }
}

function listIconLogs() {
  try {
    return fs.readdirSync(ICON_LOG_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(ICON_LOG_DIR, f), 'utf8'));
          return { id: j.id, at: j.at, movedCount: (j.moves || []).length, order: j.order, gap: j.gap };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
      .slice(0, 10);
  } catch { return []; }
}

/**
 * 「用这个软件之前」的图标位置。
 *
 * 每次重排都会把「挪之前的坐标」写进日志，所以把日志按时间从旧到新过一遍，
 * 每个图标取它第一次出现时的 from 坐标 —— 拼起来就是第一次整理之前的样子。
 * 这样即使当时还没做备份，也能回到最初的状态。
 */
function originPositions() {
  let files = [];
  try { files = fs.readdirSync(ICON_LOG_DIR).filter(f => f.endsWith('.json')); } catch { return []; }
  const logs = [];
  for (const f of files) {
    try { logs.push(JSON.parse(fs.readFileSync(path.join(ICON_LOG_DIR, f), 'utf8'))); } catch { /* 跳过坏文件 */ }
  }
  logs.sort((a, b) => (a.at || 0) - (b.at || 0));

  const seen = new Set();
  const out = [];
  for (const log of logs) {
    for (const mv of log.moves || []) {
      const key = mv.name + '#' + mv.occ;
      if (seen.has(key)) continue;
      if (typeof mv.fromX !== 'number' || typeof mv.fromY !== 'number') continue;
      seen.add(key);
      out.push({ name: mv.name, occ: mv.occ, x: mv.fromX, y: mv.fromY });
    }
  }
  return out;
}

function originInfo() {
  const pos = originPositions();
  return { count: pos.length };
}

/* ---------------- 桌面备份 ---------------- */
const bk = require('./backup');
let bjob = null; // 备份 / 恢复任务（和文件整理任务分开，互不干扰）

function briefBackup(m) {
  return {
    id: m.id,
    at: m.at,
    itemCount: (m.items || []).length,
    fileCount: m.fileCount || 0,
    totalBytes: m.totalBytes || 0,
    copiedBytes: m.copiedBytes || 0,
    newCount: m.newCount || 0,
    reusedCount: m.reusedCount || 0,
    iconCount: m.iconCount || 0,
    skipped: (m.skipped || []).length,
    restoredAt: m.restoredAt || 0
  };
}

function backupSummary() {
  const cfg = loadConfig();
  const base = backupBaseOf(cfg);
  const list = bk.listBackups(base);
  return {
    hasBackup: list.length > 0,
    count: list.length,
    last: list.length ? briefBackup(list[0]) : null,
    backups: list.map(briefBackup),
    root: base,
    backupRoot: backupRootOf(cfg),
    targetRoot: cfg.targetRoot || defaultTarget(),
    freeSpace: bk.freeSpace(base),
    keep: bk.KEEP
  };
}

function startBJob(fn) {
  bjob = {
    id: Date.now().toString(36),
    state: 'running',
    phase: 'start',
    done: 0,
    total: 0,
    current: '',
    result: null,
    error: null,
    startedAt: Date.now()
  };
  const cur = bjob;
  (async () => {
    try {
      cur.result = await fn(cur);
      cur.state = 'done';
      cur.finishedAt = Date.now();
    } catch (e) {
      cur.state = 'error';
      cur.error = e.message || String(e);
      cur.finishedAt = Date.now();
      writeErrorLog(e, 'backup');
    }
  })();
  return cur;
}

/** 记下每个图标现在的名字与坐标（同名图标用 occ 区分） */
function snapshotIcons(baseDir) {
  const r = dti.read();
  if (!r.ok) return { ok: false, error: r.error };
  const occ = dti.occMap(r.icons);
  const icons = r.icons.map(ic => ({ name: ic.name, occ: occ.get(ic.i), x: ic.x, y: ic.y }));
  try {
    fs.writeFileSync(
      path.join(baseDir, 'icons.json'),
      JSON.stringify({ at: Date.now(), metrics: r.metrics, icons }, null, 2),
      'utf8'
    );
  } catch (e) {
    return { ok: false, error: '写入图标位置失败：' + e.message };
  }
  return { ok: true, count: icons.length };
}

/** 把图标全部挪回备份时记录的坐标 */
function restoreIcons(baseDir) {
  const p = path.join(baseDir, 'icons.json');
  if (!fs.existsSync(p)) return { ok: false, error: '这份备份里没有图标位置记录' };
  let snap;
  try { snap = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { ok: false, error: '图标位置记录已损坏' }; }

  const cur = dti.read();
  if (!cur.ok) return { ok: false, error: cur.error };
  if (cur.metrics.autoArrange) {
    return { ok: false, error: '桌面现在开着「自动排列图标」，Windows 会立刻把图标排回去。请先在桌面右键 → 查看 → 取消「自动排列图标」，再点一次恢复。' };
  }

  const curOcc = dti.occMap(cur.icons);
  const have = new Set(cur.icons.map(ic => ic.name + '#' + curOcc.get(ic.i)));
  const positions = [];
  let missing = 0;
  for (const rec of snap.icons || []) {
    const key = rec.name + '#' + rec.occ;
    if (!have.has(key)) { missing++; continue; }
    positions.push({ name: rec.name, occ: rec.occ, x: rec.x, y: rec.y });
  }
  const total = (snap.icons || []).length;
  if (!positions.length) return { ok: true, applied: 0, missing, total };
  const r = dti.applyStaged(positions, cur.icons, cur.metrics);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, applied: r.applied, missing, total };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png'
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('请求格式错误')); }
    });
    req.on('error', reject);
  });
}

let lastActivity = Date.now();

// ---------- 服务 ----------
function createServer() {
  return http.createServer(async (req, res) => {
    lastActivity = Date.now();
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;

    try {
      // ---- API ----
      if (p === '/api/ping') return sendJSON(res, 200, { ok: true });

      if (p === '/api/state' && req.method === 'GET') {
        const cfg = loadConfig();
        const scan = currentScan();
        if (!cfg.targetRoot) { cfg.targetRoot = defaultTarget(); saveConfig(cfg); }
        return sendJSON(res, 200, publicScan(scan, cfg));
      }

      if (p === '/api/rescan' && req.method === 'POST') {
        const cfg = loadConfig();
        desktopPath = process.env.WB_DESKTOP && fs.existsSync(process.env.WB_DESKTOP) ? process.env.WB_DESKTOP : win.getDesktopPath();
        hiddenCache = { at: 0, set: new Set() };
        return sendJSON(res, 200, publicScan(currentScan(), cfg));
      }

      if (p === '/api/plan' && req.method === 'POST') {
        const body = await readBody(req);
        const err = validateTarget(body.targetRoot);
        if (err) return sendJSON(res, 400, { error: err });
        const selected = Array.isArray(body.selected) ? body.selected : [];
        if (!selected.length) return sendJSON(res, 400, { error: '请至少选择一种要整理的类别' });
        const scan = currentScan();
        const plan = org.buildPlan(scan, { selected, targetRoot: body.targetRoot });
        if (!plan.total) return sendJSON(res, 400, { error: '选中的类别里没有可整理的文件' });
        const cfg = loadConfig();
        cfg.targetRoot = path.resolve(body.targetRoot);
        if (body.shortcutName != null) cfg.shortcutName = String(body.shortcutName).slice(0, 40);
        cfg.selected = selected;
        cfg.makeShortcut = !!body.makeShortcut;
        saveConfig(cfg);
        return sendJSON(res, 200, plan);
      }

      if (p === '/api/execute' && req.method === 'POST') {
        const body = await readBody(req);
        if (job && job.state === 'running') {
          return sendJSON(res, 409, { error: '正在整理中，请等这一次完成' });
        }
        const err = validateTarget(body.targetRoot);
        if (err) return sendJSON(res, 400, { error: err });
        const selected = Array.isArray(body.selected) ? body.selected : [];
        if (!selected.length) return sendJSON(res, 400, { error: '请至少选择一种要整理的类别' });

        const scan = currentScan();
        const plan = org.buildPlan(scan, { selected, targetRoot: body.targetRoot });
        if (!plan.total) return sendJSON(res, 400, { error: '选中的类别里没有可整理的文件' });

        const cfg = loadConfig();
        cfg.targetRoot = path.resolve(body.targetRoot);
        if (body.shortcutName != null) cfg.shortcutName = String(body.shortcutName).slice(0, 40);
        cfg.selected = selected;
        cfg.makeShortcut = !!body.makeShortcut;
        saveConfig(cfg);

        const j = startJob(plan, body, desktopPath);
        return sendJSON(res, 200, { jobId: j.id, total: j.total, started: true });
      }

      if (p === '/api/job' && req.method === 'GET') {
        if (!job) return sendJSON(res, 200, { state: 'idle' });
        return sendJSON(res, 200, {
          id: job.id,
          state: job.state,
          done: job.done,
          total: job.total,
          current: job.current,
          result: job.result,
          error: job.error
        });
      }

      if (p === '/api/job/ack' && req.method === 'POST') {
        job = null;
        return sendJSON(res, 200, { ok: true });
      }

      if (p === '/api/settings' && req.method === 'POST') {
        const body = await readBody(req);
        const cfg = loadConfig();
        const out = { ok: true, synced: false };

        // 换了备份位置：如果整理用的存放位置还是「跟备份同一个文件夹」，就跟着一起改
        if (typeof body.backupRoot === 'string' && body.backupRoot.trim()) {
          const nb = path.resolve(body.backupRoot.trim());
          const err = validateTarget(nb);
          if (err) return sendJSON(res, 400, { error: err });
          const prev = path.resolve(backupRootOf(cfg));
          cfg.backupRoot = nb;
          const curT = path.resolve(cfg.targetRoot || defaultTarget());
          if (curT === prev) { cfg.targetRoot = nb; out.synced = true; }
        }

        // 单独改整理位置（不动备份位置）
        if (typeof body.targetRoot === 'string' && body.targetRoot.trim()) {
          const nt = path.resolve(body.targetRoot.trim());
          const err = validateTarget(nt);
          if (err) return sendJSON(res, 400, { error: err });
          cfg.targetRoot = nt;
        }

        saveConfig(cfg);
        out.backupRoot = backupRootOf(cfg);
        out.targetRoot = cfg.targetRoot || defaultTarget();
        out.backupBase = backupBaseOf(cfg);
        return sendJSON(res, 200, out);
      }

      if (p === '/api/pick-folder' && req.method === 'POST') {
        const body = await readBody(req);
        const cfg = loadConfig();
        try {
          const picked = win.pickFolder(
            String(body.current || '').trim() || body.fallback || cfg.targetRoot || desktopPath,
            body.title || '请选择文件夹'
          );
          return sendJSON(res, 200, { path: picked || '' });
        } catch (e) {
          return sendJSON(res, 500, { error: '无法打开系统文件夹选择框，请直接在输入框里粘贴路径', detail: e.message });
        }
      }

      if (p === '/api/logs' && req.method === 'GET') {
        return sendJSON(res, 200, { logs: org.listLogs(DATA_DIR, 20) });
      }

      if (p === '/api/undo' && req.method === 'POST') {
        const body = await readBody(req);
        if (job && job.state === 'running') return sendJSON(res, 409, { error: '正在整理中，等这一次完成后再撤销' });
        const log = org.readLog(DATA_DIR, body.id);
        if (!log) return sendJSON(res, 404, { error: '找不到这次整理记录' });
        const result = await org.undoLog(log, DATA_DIR);
        // 文件回到桌面后同样需要刷新，否则图标要等下次登录才出现
        result.desktopRefreshed = !!win.refreshShell({ dirs: [desktopPath] }).ok;
        return sendJSON(res, 200, result);
      }

      if (p === '/api/refresh-shell' && req.method === 'POST') {
        const r = win.refreshShell({ dirs: [desktopPath] });
        return sendJSON(res, 200, { ok: !!r.ok, detail: r.raw || r.error || '' });
      }

      // ---- 桌面快捷方式重排（只改图标坐标，不碰文件） ----
      if (p === '/api/shortcuts' && req.method === 'GET') {
        // 面板打开：强制重扫一次，顺手把快照换成新的
        const data = shortcutSnapshot(true);
        if (!data.ok) return sendJSON(res, 500, { error: data.error });
        const { icons, ...rest } = data;   // icons 很大，前端用不上（快照里还得留着算布局）
        return sendJSON(res, 200, rest);
      }

      // 实时预览：只在这份快照上算布局，不重扫桌面（几十毫秒，够「拖完立刻看到」）
      if ((p === '/api/shortcuts/layout' || p === '/api/shortcuts/preview') && req.method === 'POST') {
        const body = await readBody(req);
        const data = shortcutSnapshot(p === '/api/shortcuts/preview');
        if (!data.ok) return sendJSON(res, 500, { error: data.error });
        const r = layoutFromPlan(data, body);
        if (r.error) return sendJSON(res, 400, { error: r.error });
        return sendJSON(res, 200, shortcutLayoutPayload(data, r.plan, r.layout));
      }

      if (p === '/api/shortcuts/apply' && req.method === 'POST') {
        const body = await readBody(req);
        // 执行前必须重扫：不能拿几分钟前的坐标去摆图标
        let data = shortcutSnapshot(true);
        if (!data.ok) return sendJSON(res, 500, { error: data.error });
        if (data.metrics.autoArrange) {
          return sendJSON(res, 409, { error: '桌面的「自动排列图标」是开着的，Windows 会立刻把图标重新排回去。请先在桌面空白处右键 → 查看 → 取消「自动排列图标」，再试一次。' });
        }
        let { plan, moving } = normalizeIconPlan(data, body);
        const anyEnabled = ICON_GROUPS.some(k => plan.groups[k].enabled && plan.groups[k].items.length)
          || (plan.fileMode === 'folder' && plan.archived.length > 0);
        if (!anyEnabled) return sendJSON(res, 400, { error: '没有任何一组被勾选，或者勾选的组里没有图标' });

        /* ---- 归档模式：先在桌面建好分类文件夹，把文件移进去 ---- */
        let archive = null;
        if (plan.fileMode === 'folder' && plan.archived.length) {
          const groups = [];
          for (const k of dsk.FILE_KEYS) {
            const list = plan.archived.filter(it => it.sub === k);
            if (!list.length) continue;
            const meta = dsk.META.get(k);
            const dir = path.join(desktopPath, meta.folder);
            groups.push({
              key: k, name: meta.name, folder: meta.folder, dir, count: list.length,
              subs: [{
                dir, sub: null,
                items: list.map(it => ({
                  from: it.file,
                  name: it.label || path.basename(it.file),
                  isDir: it.isDir, size: it.size, mtime: it.mtime
                }))
              }]
            });
          }
          if (groups.length) {
            try {
              const log = await org.executePlan({ targetRoot: desktopPath, groups }, DATA_DIR, {});
              archive = { id: log.id, moved: log.movedCount || 0, failed: (log.failed || []).length };
            } catch (e) {
              return sendJSON(res, 500, { error: '归档失败：' + e.message });
            }
            win.refreshShell({ dirs: [desktopPath] });
            await new Promise(r => setTimeout(r, 600));
            // 文件图标已经消失，重新读一遍桌面再算落点
            const again = collectShortcutData();
            if (again.ok) {
              data = again;
              const n2 = normalizeIconPlan(again, body);
              plan = n2.plan;
              moving = n2.moving;
            }
          }
        }

        const layout = dti.computeLayout(data.icons || [], data.metrics, plan, moving);

        const prev = new Map();
        for (const k of ['tool', 'niche', 'game', 'file', 'other']) {
          for (const it of data.groups[k] || []) prev.set(it.name + '#' + it.occ, it);
        }

        let applied = 0;
        let missing = 0;
        let adjusted = 0;
        let res2 = { ok: true, applied: 0, missing: 0 };

        if (layout.positions.length) {
          res2 = dti.applyStaged(layout.positions, data.icons || [], data.metrics);
          if (!res2.ok) return sendJSON(res, 500, { error: res2.error });
          applied = res2.applied || 0;
          missing = res2.missing || 0;

          /* 校正：万一还有图标被系统挤开，读回来对一遍再补发，最多补两轮 */
          for (let pass = 0; pass < 2; pass++) {
            try {
              const re = dti.read();
              if (!re.ok) break;
              const occ2 = dti.occMap(re.icons);
              const nowAt = new Map();
              for (const ic of re.icons) nowAt.set(ic.name + '#' + occ2.get(ic.i), { x: ic.x, y: ic.y });
              const fix = [];
              for (const p of layout.positions) {
                const cur = nowAt.get(p.name + '#' + p.occ);
                if (cur && Math.abs(cur.x - p.x) <= 2 && Math.abs(cur.y - p.y) <= 2) continue;
                fix.push({ name: p.name, occ: p.occ, x: p.x, y: p.y });
              }
              if (!fix.length) break;
              adjusted += fix.length;
              dti.applyPositions(fix);
            } catch { break; }
          }
        }

        const id = new Date().toISOString().replace(/[:.]/g, '-');
        const moves = layout.positions.map(p => {
          const before = prev.get(p.name + '#' + p.occ) || {};
          return {
            name: p.name, occ: p.occ, group: p.group,
            fromX: before.x, fromY: before.y, toX: p.x, toY: p.y
          };
        });
        if (moves.length) {
          saveIconLog({
            id, at: Date.now(), order: plan.order, gap: plan.gap,
            sides: Object.fromEntries(ICON_GROUPS.map(k => [k, plan.groups[k].side])),
            moves
          });
        }

        // 用户改过的分类写进记忆表，下次直接沿用（桌面文件不参与记忆）
        const memory = loadShortcutMap();
        let remembered = 0;
        for (const k of SHORTCUT_GROUPS) {
          if (!plan.groups[k].enabled) continue;
          for (const it of plan.groups[k].items) {
            // 注意要用「纯规则结果」比较：it.category 本身可能是记忆值，
            // 拿它比会把所有记忆项当成"多余"清掉（曾经真的清空过一次）。
            const rule = it.ruleCategory || it.category;
            if (rule !== k) {
              if (memory[it.key] !== k) { memory[it.key] = k; remembered++; }
            } else if (memory[it.key]) {
              delete memory[it.key];
              remembered++;
            }
          }
        }
        if (remembered) saveShortcutMap(memory);

        const cfg = loadConfig();
        cfg.shortcutOrder = plan.order;
        cfg.shortcutSides = Object.fromEntries(ICON_GROUPS.map(k => [k, plan.groups[k].side]));
        cfg.shortcutEnabled = Object.fromEntries(ICON_GROUPS.map(k => [k, plan.groups[k].enabled]));
        cfg.shortcutGap = plan.gap;
        cfg.fileOrder = plan.fileOrder;
        cfg.fileMode = plan.fileMode;
        saveConfig(cfg);

        win.refreshShell({ dirs: [desktopPath] });
        dropShortcutSnapshot();   // 图标已经挪过，快照作废

        return sendJSON(res, 200, {
          ok: true,
          moved: applied,
          missing,
          adjusted,
          overflow: layout.overflow,
          total: layout.positions.length,
          summary: layout.summary,
          logId: moves.length ? id : '',
          remembered,
          archive,
          fileMode: plan.fileMode
        });
      }

      if (p === '/api/shortcuts/undo' && req.method === 'POST') {
        const body = await readBody(req);
        const file = path.join(ICON_LOG_DIR, String(body.id || '') + '.json');
        if (!file.startsWith(ICON_LOG_DIR) || !fs.existsSync(file)) {
          return sendJSON(res, 404, { error: '找不到这次位置记录' });
        }
        let log;
        try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return sendJSON(res, 500, { error: '记录文件已损坏' }); }

        const readRes = dti.read();
        if (!readRes.ok) return sendJSON(res, 500, { error: readRes.error });
        const occByIndex = dti.occMap(readRes.icons);
        const byName = new Map();
        for (const ic of readRes.icons) {
          const k = ic.name;
          if (!byName.has(k)) byName.set(k, []);
          byName.get(k).push({ occ: occByIndex.get(ic.i), x: ic.x, y: ic.y });
        }
        const restore = [];
        let skipped = 0;
        for (const mv of (log.moves || [])) {
          const slots = byName.get(mv.name) || [];
          const slot = slots[mv.occ];
          if (!slot) { skipped++; continue; }
          // 只还原"还停在原位"的图标，用户后来手动挪过的不动
          if (slot.x !== mv.toX || slot.y !== mv.toY) { skipped++; continue; }
          restore.push({ name: mv.name, occ: mv.occ, x: mv.fromX, y: mv.fromY });
        }
        const r = dti.applyPositions(restore);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        try { fs.unlinkSync(file); } catch { /* ignore */ }
        win.refreshShell({ dirs: [desktopPath] });
        return sendJSON(res, 200, { ok: true, restored: r.applied, skipped });
      }

      if (p === '/api/shortcuts/logs' && req.method === 'GET') {
        return sendJSON(res, 200, { logs: listIconLogs() });
      }

      // ---- 清理桌面 ----
      // 扫描只读；真正清理前必须确认「有备份」或「用户自己勾了风险」
      if (p === '/api/cleanup/scan' && req.method === 'POST') {
        const r = await cln.scan(desktopDirs(), { cacheDir: ICON_CACHE_DIR });
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        return sendJSON(res, 200, { ...r, hasBackup: backupSummary().hasBackup });
      }

      if (p === '/api/cleanup/delete' && req.method === 'POST') {
        const body = await readBody(req);
        const sum = backupSummary();
        if (!sum.hasBackup && body.ackNoBackup !== true) {
          return sendJSON(res, 409, {
            error: '还没有备份过桌面。可以先在「桌面备份」存一份，或者在清理页勾选「知道未备份的风险」再清理。',
            needBackup: true
          });
        }
        const files = Array.isArray(body.files) ? body.files : [];
        if (!files.length) return sendJSON(res, 400, { error: '没有选中任何要清理的图标' });
        if (files.length > 300) return sendJSON(res, 400, { error: '一次最多清理 300 个' });
        const dirs = desktopDirs();
        const r = cln.remove(files, dirs, DATA_DIR);
        if (!r.ok) return sendJSON(res, 400, { error: r.error });
        win.refreshShell({ deleted: (r.files || []).map(p => ({ path: p })), dirs });
        return sendJSON(res, 200, { ...r, hasBackup: sum.hasBackup });
      }

      if (p === '/api/cleanup/restore' && req.method === 'POST') {
        const body = await readBody(req);
        const dirs = desktopDirs();
        const r = cln.restore(body.id, DATA_DIR, dirs);
        if (!r.ok) return sendJSON(res, 400, { error: r.error });
        if (r.restored) win.refreshShell({ dirs });
        return sendJSON(res, 200, r);
      }

      if (p === '/api/cleanup/logs' && req.method === 'GET') {
        return sendJSON(res, 200, { logs: cln.listLogs(DATA_DIR), hasBackup: backupSummary().hasBackup });
      }

      // ---- 按图标卸载 ----
      // 扫描只读；卸载要用户明确点；清残留只能清这个任务自己算出来的路径
      // 「所有已安装软件」里有些条目注册表没写占用（Steam 游戏基本都没写）。
      // 这里按安装目录现算，异步跑，前端分批来问，不挡住列表显示
      if (p === '/api/uninstall/sizes' && req.method === 'POST') {
        const body = await readBody(req);
        const paths = (Array.isArray(body.paths) ? body.paths : [])
          .slice(0, 12)
          .map(x => String(x || '').trim())
          .filter(x => /^[a-z]:[\\/]/i.test(x));
        if (!paths.length) return sendJSON(res, 200, { sizes: {} });
        const map = await uni.dirSizesAsync(paths);
        const out = {};
        for (const raw of paths) {
          const hit = map.get(path.resolve(raw).toLowerCase());
          if (hit) out[raw.toLowerCase()] = hit;
        }
        return sendJSON(res, 200, { sizes: out });
      }

      // ---- 所有已安装软件（含桌面没有图标的）----
      // 只读清单：分类、体积、风险等级都在这里算好，前端只负责画
      if (p === '/api/uninstall/all' && req.method === 'POST') {
        const body = await readBody(req);
        const items = uni.listAll(body.fresh);
        const counts = {};
        const bytes = {};
        for (const it of items) {
          counts[it.cat] = (counts[it.cat] || 0) + 1;
          bytes[it.cat] = (bytes[it.cat] || 0) + (it.size || 0);
        }
        return sendJSON(res, 200, {
          items,
          counts,
          bytes,
          total: items.length,
          uninstallable: items.filter(i => i.canUninstall).length,
          hasBackup: backupSummary().hasBackup,
          at: Date.now()
        });
      }

      if (p === '/api/uninstall/apps' && req.method === 'POST') {
        const body = await readBody(req);
        return sendJSON(res, 200, uni.scanDesktop(desktopDirs(), { cacheDir: ICON_CACHE_DIR, fresh: body.fresh }));
      }

      if (p === '/api/uninstall/plan' && req.method === 'POST') {
        const body = await readBody(req);
        const sum = backupSummary();
        if (!sum.hasBackup && body.ackNoBackup !== true) {
          return sendJSON(res, 409, {
            error: '还没有备份过桌面操作记录。卸载会改动桌面和安装目录，建议先在「桌面备份」存一份。',
            needBackup: true
          });
        }
        const r = uni.makePlan({ ...body, desktops: desktopDirs() });
        if (r.error) return sendJSON(res, 400, { error: r.error, needBackup: false });
        return sendJSON(res, 200, { ...r, hasBackup: sum.hasBackup });
      }

      if (p === '/api/uninstall/run' && req.method === 'POST') {
        const body = await readBody(req);
        const sum = backupSummary();
        if (!sum.hasBackup && body.ackNoBackup !== true) {
          return sendJSON(res, 409, { error: '还没有备份，先确认风险再卸载', needBackup: true });
        }
        const r = uni.runPlan(body.planId);
        if (r.error) return sendJSON(res, 400, r);
        return sendJSON(res, 200, r);
      }

      if (p === '/api/uninstall/status' && req.method === 'GET') {
        const planId = new URL(req.url, 'http://x').searchParams.get('planId') || '';
        const r = uni.getStatus(planId);
        if (r.error) return sendJSON(res, 404, r);
        return sendJSON(res, 200, r);
      }

      // 卸载面板用：批量取真实图标（只读，走磁盘缓存）
      // scope=desktop → 只认桌面根目录下的快捷方式
      // scope=apps    → 只认「已安装软件清单」里出现过的图标路径（注册表白名单）
      if (p === '/api/uninstall/icons' && req.method === 'POST') {
        const body = await readBody(req);
        const scope = body.scope === 'apps' ? 'apps' : 'desktop';
        const safe = [];
        const raw = (Array.isArray(body.items) ? body.items : []).slice(0, 40);

        if (scope === 'apps') {
          const allow = new Set();
          for (const a of uni.listAll()) {
            const ic = String(a.icon || '').replace(/,\s*-?\d+\s*$/, '').trim();
            if (ic) allow.add(path.resolve(ic).toLowerCase());
          }
          for (const it of raw) {
            const f = String(it && it.file || '').replace(/,\s*-?\d+\s*$/, '').trim();
            if (!f) continue;
            const abs = path.resolve(f);
            if (!allow.has(abs.toLowerCase())) continue;
            safe.push({ file: abs, key: it.key ? String(it.key) : undefined });
          }
        } else {
          const allow = desktopDirs().map(d => path.resolve(d).toLowerCase());
          for (const it of raw) {
            const f = String(it && it.file || '');
            if (!f) continue;
            const abs = path.resolve(f);
            if (!allow.includes(path.dirname(abs).toLowerCase())) continue;
            safe.push({ file: abs, key: it.key ? String(it.key) : undefined });
          }
        }

        if (!safe.length) return sendJSON(res, 200, { ok: true, icons: {} });
        const r = await icons.ensureIcons(safe, ICON_CACHE_DIR);
        return sendJSON(res, 200, r);
      }

      // ---- 批量卸载：建清单 / 查进度 / 开始 / 停止 ----
      if (p === '/api/uninstall/batch' && req.method === 'POST') {
        const body = await readBody(req);
        const items = Array.isArray(body.items) ? body.items : [];
        if (items.length > 80) return sendJSON(res, 400, { error: '一次最多 80 个，分两批来吧' });
        const r = uni.batchCreate({ items, desktops: desktopDirs() });
        if (r.error) return sendJSON(res, 400, r);
        return sendJSON(res, 200, { ...r, hasBackup: backupSummary().hasBackup });
      }

      if (p === '/api/uninstall/batch' && req.method === 'GET') {
        const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
        const r = uni.batchSnapshot(id);
        if (r.error) return sendJSON(res, 404, r);
        return sendJSON(res, 200, r);
      }

      if (p === '/api/uninstall/batch/start' && req.method === 'POST') {
        const body = await readBody(req);
        const sum = backupSummary();
        if (!sum.hasBackup && body.ackNoBackup !== true) {
          return sendJSON(res, 409, {
            error: '还没有备份过桌面。卸载会改动桌面、安装目录和软件配置，建议先花十几秒备份一次。',
            needBackup: true
          });
        }
        const r = uni.batchStart(body.id);
        if (r.error) return sendJSON(res, 400, r);
        return sendJSON(res, 200, r);
      }

      if (p === '/api/uninstall/batch/stop' && req.method === 'POST') {
        const body = await readBody(req);
        const r = uni.batchStop(body.id);
        if (r.error) return sendJSON(res, 400, r);
        return sendJSON(res, 200, r);
      }

      if (p === '/api/uninstall/residual' && req.method === 'POST') {
        const body = await readBody(req);
        const r = uni.cleanResidual(body.planId, body.ids);
        if (r.error) return sendJSON(res, 400, r);
        win.refreshShell({ dirs: desktopDirs() });
        return sendJSON(res, 200, r);
      }

      if (p === '/api/uninstall/reveal' && req.method === 'POST') {
        const body = await readBody(req);
        const r = body.reg ? uni.revealReg(body.reg) : uni.revealPath(body.path);
        if (r.error) return sendJSON(res, 400, r);
        return sendJSON(res, 200, r);
      }

      // ---- 桌面备份 ----
      if (p === '/api/backup/list' && req.method === 'GET') {
        const scan = await bk.scanDesktop(desktopDirs());
        return sendJSON(res, 200, {
          ...backupSummary(),
          origin: originInfo(),
          current: {
            itemCount: scan.itemCount,
            totalBytes: scan.totalBytes,
            totalFiles: scan.totalFiles
          }
        });
      }

      // 回到「用这个软件之前」：用最早一次重排日志里的原坐标把图标摆回去
      if (p === '/api/backup/restore-origin' && req.method === 'POST') {
        if (job && job.state === 'running') return sendJSON(res, 409, { error: '正在整理文件，等这次完成后再恢复' });
        if (bjob && bjob.state === 'running') return sendJSON(res, 409, { error: '上一个备份任务还没结束' });
        const pos = originPositions();
        if (!pos.length) return sendJSON(res, 400, { error: '没有找到整理前的坐标记录（可能还没做过图标重排）' });
        const cur = dti.read();
        if (!cur.ok) return sendJSON(res, 500, { error: cur.error });
        if (cur.metrics.autoArrange) {
          return sendJSON(res, 409, { error: '桌面现在开着「自动排列图标」，请先右键桌面 → 查看 → 取消「自动排列图标」' });
        }
        const curOcc = dti.occMap(cur.icons);
        const have = new Set(cur.icons.map(ic => ic.name + '#' + curOcc.get(ic.i)));
        const use = pos.filter(v => have.has(v.name + '#' + v.occ));
        const r = dti.applyStaged(use, cur.icons, cur.metrics);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        win.refreshShell({ dirs: [desktopPath] });
        return sendJSON(res, 200, { ok: true, applied: r.applied, missing: pos.length - use.length, total: pos.length });
      }

      if (p === '/api/backup/create' && req.method === 'POST') {
        if (bjob && bjob.state === 'running') {
          return sendJSON(res, 409, { error: '正在处理上一个备份任务，稍等一下' });
        }
        const cfg = loadConfig();
        const base = backupBaseOf(cfg);
        const rootErr = validateTarget(backupRootOf(cfg));
        if (rootErr) return sendJSON(res, 400, { error: '备份位置不可用：' + rootErr });
        const dirs = desktopDirs();
        const j = startBJob(async (cur) => {
          cur.phase = 'files';
          cur.current = '正在统计桌面上的项目…';
          try { fs.mkdirSync(base, { recursive: true }); } catch (e) {
            throw new Error('创建备份文件夹失败：' + e.message);
          }
          const meta = await bk.createBackup(base, dirs, {
            onProgress: (q) => {
              cur.done = q.done;
              cur.total = q.total;
              cur.current = '正在备份 ' + q.name;
            }
          });

          cur.phase = 'icons';
          cur.current = '正在记录图标位置…';
          const baseDir = path.join(base, meta.id);
          const snap = snapshotIcons(baseDir);
          if (snap.ok) {
            meta.iconCount = snap.count;
            try {
              fs.writeFileSync(path.join(baseDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
            } catch { /* ignore */ }
          }

          return {
            id: meta.id,
            itemCount: (meta.items || []).length,
            fileCount: meta.fileCount || 0,
            totalBytes: meta.totalBytes || 0,
            copiedBytes: meta.copiedBytes || 0,
            newCount: meta.newCount || 0,
            reusedCount: meta.reusedCount || 0,
            iconCount: meta.iconCount || 0,
            skipped: (meta.skipped || []).length,
            root: base,
            iconError: snap.ok ? '' : snap.error
          };
        });
        return sendJSON(res, 200, { jobId: j.id, started: true });
      }

      if (p === '/api/backup/job' && req.method === 'GET') {
        if (!bjob) return sendJSON(res, 200, { state: 'idle' });
        return sendJSON(res, 200, {
          id: bjob.id,
          state: bjob.state,
          phase: bjob.phase,
          done: bjob.done,
          total: bjob.total,
          current: bjob.current,
          result: bjob.result,
          error: bjob.error
        });
      }

      if (p === '/api/backup/ack' && req.method === 'POST') {
        if (bjob && bjob.state === 'running') return sendJSON(res, 409, { error: '任务还在进行中' });
        bjob = null;
        return sendJSON(res, 200, { ok: true });
      }

      if (p === '/api/backup/restore' && req.method === 'POST') {
        const body = await readBody(req);
        if (job && job.state === 'running') return sendJSON(res, 409, { error: '正在整理文件，等这一次整理完成后再恢复' });
        if (bjob && bjob.state === 'running') return sendJSON(res, 409, { error: '上一个备份任务还没结束，稍等一下' });
        const base = backupBaseOf(loadConfig());
        const meta = bk.getBackup(base, body.id);
        if (!meta) return sendJSON(res, 404, { error: '找不到这份备份' });
        const wantFiles = body.files !== false;
        const wantIcons = body.icons !== false;
        const baseDir = path.join(base, meta.id);

        const j = startBJob(async (cur) => {
          const out = { id: meta.id, files: null, icons: null };
          if (wantFiles) {
            cur.phase = 'restore-files';
            cur.current = '正在把文件放回桌面…';
            out.files = await bk.restoreFiles(base, meta, {
              onProgress: (q) => {
                cur.done = q.done;
                cur.total = q.total;
                cur.current = '正在恢复 ' + q.name;
              }
            });
          }
          if (wantIcons) {
            cur.phase = 'restore-icons';
            cur.current = '正在还原图标位置…';
            out.icons = restoreIcons(baseDir);
          }
          try { win.refreshShell({ dirs: [desktopPath] }); } catch { /* ignore */ }
          try {
            const mp = path.join(baseDir, 'meta.json');
            const m2 = JSON.parse(fs.readFileSync(mp, 'utf8'));
            m2.restoredAt = Date.now();
            fs.writeFileSync(mp, JSON.stringify(m2, null, 2), 'utf8');
          } catch { /* ignore */ }
          return out;
        });
        return sendJSON(res, 200, { jobId: j.id, started: true });
      }

      if (p === '/api/backup/delete' && req.method === 'POST') {
        const body = await readBody(req);
        if (bjob && bjob.state === 'running') return sendJSON(res, 409, { error: '正在备份，等这次备份结束后再删' });
        const r = bk.deleteBackup(backupBaseOf(loadConfig()), body.id);
        if (!r.ok && r.missing) return sendJSON(res, 404, { error: '找不到这份备份（可能已经删掉了）' });
        if (!r.ok) {
          const raw = String(r.error || '');
          const code = /^(E[A-Z]+)$/.test(raw) ? raw : '';
          return sendJSON(res, 500, {
            error: `有 ${r.left || 1} 个文件删不掉${code ? '（' + code + '）' : ''}，多半是被别的程序占用了。关掉正在用它预览/播放的窗口，再点一次删除。`
          });
        }
        return sendJSON(res, 200, { ok: true, ...backupSummary() });
      }

      // 图标模式用：批量取桌面快捷方式的真实图标（只读，带磁盘缓存）
      if (p === '/api/shortcuts/icons' && req.method === 'POST') {
        const body = await readBody(req);
        const list = Array.isArray(body.items) ? body.items : [];
        const safe = [];
        for (const it of list.slice(0, 60)) {
          const f = String(it && it.file || '');
          if (!f) continue;
          const abs = path.resolve(f);
          const rel = path.relative(desktopPath, abs);
          if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
          safe.push({ file: abs, key: it.key ? String(it.key) : undefined });
        }
        const r = await icons.ensureIcons(safe, ICON_CACHE_DIR);
        return sendJSON(res, 200, r);
      }

      // 图标缓存文件
      if (p.startsWith('/icons/') && req.method === 'GET') {
        const key = p.slice('/icons/'.length).replace(/\.png$/i, '');
        if (!/^[a-f0-9]{8,40}$/i.test(key)) { res.writeHead(404); return res.end('Not Found'); }
        const file = icons.iconPath(ICON_CACHE_DIR, key);
        if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Not Found'); }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        return fs.createReadStream(file).pipe(res);
      }

      if (p === '/api/open' && req.method === 'POST') {
        const body = await readBody(req);
        let target = String(body.path || '').trim();
        if (target && body.mkdir) {
          // 「打开文件夹」时目录可能还没建出来（还没备份过 / 换了新位置），先建再打开
          try { fs.mkdirSync(target, { recursive: true }); } catch { /* 建不了就让下面退到父目录 */ }
        }
        if (target) win.openInExplorer(target);
        return sendJSON(res, 200, { ok: true, path: target });
      }

      if (p === '/api/shutdown' && req.method === 'POST') {
        if (job && job.state === 'running') {
          return sendJSON(res, 409, { error: '正在整理文件，等这一次完成后再退出（现在退出会留下搬了一半的状态）' });
        }
        if (bjob && bjob.state === 'running') {
          return sendJSON(res, 409, { error: '正在备份桌面，等这一次完成后再退出（现在退出会留下一份不完整的备份）' });
        }
        sendJSON(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 500);
        return;
      }

      // ---- 静态资源 ----
      let rel = p === '/' ? '/index.html' : p;
      const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
      if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found');
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      writeErrorLog(e, 'http ' + p);
      try { sendJSON(res, 500, { error: e.message || String(e) }); } catch { /* ignore */ }
    }
  });
}

// ---------- 应用窗口 ----------
function findBrowser() {
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

/**
 * 开窗尺寸按主屏可用区域算：1366×768 的笔记本、1920×1080 的台机、
 * 4K 开 150% 缩放的机器，都能拿到一个「装得下、又不挤」的窗口。
 * 1336 那条线是四个分组并排所需的最小宽度。
 */
function windowBox() {
  const s = win.screenBox();
  if (!s || !s.w || !s.h) return { w: 1160, h: 840, x: 140, y: 80 };
  const w = Math.max(900, Math.min(Math.round(s.w * 0.86), 1680));
  const h = Math.max(600, Math.min(Math.round(s.h * 0.9), 1000));
  return {
    w,
    h,
    x: Math.round(s.x + (s.w - w) / 2),
    y: Math.round(s.y + (s.h - h) / 2)
  };
}

function openWindow(port) {
  const url = `http://127.0.0.1:${port}/`;
  if (NO_OPEN) return;
  const browser = findBrowser();
  const b = windowBox();
  const args = [`--app=${url}`, `--window-size=${b.w},${b.h}`, `--window-position=${b.x},${b.y}`, '--no-first-run', '--no-default-browser-check'];
  try {
    if (browser) {
      spawn(browser, args, { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* ignore */ }
}

// ---------- 启动 ----------
function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.removeListener('listening', onOk);
      if (e.code === 'EADDRINUSE') resolve(false);
      else reject(e);
    };
    const onOk = () => {
      server.removeListener('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}

async function existingInstance() {
  try {
    const inst = JSON.parse(fs.readFileSync(INSTANCE_PATH, 'utf8'));
    if (inst && inst.port) {
      const ok = await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: inst.port, path: '/api/ping', timeout: 800 }, r => {
          let d = '';
          r.on('data', c => { d += c; });
          r.on('end', () => resolve(d.includes('"ok":true')));
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      if (ok) return inst;
    }
  } catch { /* no instance */ }
  return null;
}

(async function main() {
  const inst = await existingInstance();
  if (inst) {
    openWindow(inst.port);
    setTimeout(() => process.exit(0), 800);
    return;
  }

  const server = createServer();
  let port = 0;
  for (let p = 4390; p < 4420; p++) {
    if (await tryListen(server, p)) { port = p; break; }
  }
  if (!port) {
    console.error('无法找到可用端口');
    process.exit(1);
  }

  fs.writeFileSync(INSTANCE_PATH, JSON.stringify({ pid: process.pid, port, at: Date.now() }), 'utf8');
  openWindow(port);

  // 兜底：启动后静默刷新一次桌面，清掉上次可能残留的图标残影（不阻塞窗口打开）
  setTimeout(() => {
    try { win.refreshShell({ dirs: [win.getDesktopPath()] }); } catch { /* 失败不影响使用 */ }
  }, 2500).unref();

  // 后台预热图标缓存：等用户打开重排面板时，真实图标已经就位，不用再等
  setTimeout(async () => {
    try {
      const files = shorts.listShortcutFiles(desktopDirs()).map(f => ({ file: f.file }));
      for (let i = 0; i < files.length; i += 30) {
        await icons.ensureIcons(files.slice(i, i + 30), ICON_CACHE_DIR);
      }
    } catch { /* 预热失败不影响正常使用 */ }
  }, 4500).unref();

  // 空闲 60 分钟自动退出
  setInterval(() => {
    if (Date.now() - lastActivity > 60 * 60 * 1000) process.exit(0);
  }, 5 * 60 * 1000).unref();

  const cleanup = () => {
    try {
      const cur = JSON.parse(fs.readFileSync(INSTANCE_PATH, 'utf8'));
      if (cur.pid === process.pid) fs.unlinkSync(INSTANCE_PATH);
    } catch { /* ignore */ }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(0));
})();

'use strict';
/**
 * 桌面整理 - 核心引擎
 * 职责：扫描桌面 -> 分类 -> 生成整理方案 -> 执行移动 -> 记录日志 -> 撤销
 */
const fs = require('fs');
const path = require('path');

// 快捷方式类文件：永远不动（用户的入口，动了会出乱子）
const SHORTCUT_EXTS = ['.lnk', '.url', '.website', '.appref-ms', '.pif', '.scf'];
// 系统/临时文件：永远不动
const IGNORE_NAMES = ['desktop.ini', 'thumbs.db', '.ds_store', 'iconcache.db'];

/**
 * 六大类别定义
 * subMode: map=按类型细分 / date=按修改年月细分 / ext=按扩展名细分 / none=不细分
 */
const CATEGORIES = [
  {
    key: 'office',
    name: '办公文档',
    folder: '办公文档',
    hint: 'Word · Excel · PPT · PDF',
    subHint: '细分为 Word 文档 / Excel 表格 / PPT 演示 / PDF / 其他文档',
    subMode: 'map',
    map: {
      'Word 文档': ['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'rtf', 'odt', 'wps'],
      'Excel 表格': ['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'csv', 'tsv', 'ods', 'et', 'ett'],
      'PPT 演示': ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'pot', 'potx', 'odp', 'dps', 'dpt'],
      'PDF': ['pdf'],
      '其他文档': ['vsd', 'vsdx', 'mpp', 'mpt', 'pub', 'one', 'epub', 'mobi', 'azw3', 'pages', 'numbers', 'key', 'tex', 'hwp', 'xmind', 'mm']
    }
  },
  {
    key: 'image',
    name: '图片',
    folder: '图片',
    hint: 'JPG · PNG · GIF · WEBP · PSD',
    subHint: '按修改月份细分（如 2026-11），照片多了也不乱',
    subMode: 'date',
    exts: ['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'gif', 'bmp', 'webp', 'avif', 'tif', 'tiff',
      'heic', 'heif', 'svg', 'ico', 'psd', 'ai', 'eps', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'exr', 'sketch', 'fig']
  },
  {
    key: 'note',
    name: '记事本',
    folder: '记事本',
    hint: 'TXT · MD · LOG · NFO',
    subHint: '按修改月份细分，方便按时间找回笔记',
    subMode: 'date',
    exts: ['txt', 'text', 'md', 'markdown', 'log', 'nfo', 'rtfd']
  },
  {
    key: 'folder',
    name: '文件夹',
    folder: '文件夹',
    hint: '桌面上散落的文件夹',
    subHint: '整枚移动，不再细分（避免破坏原有结构）',
    subMode: 'none'
  },
  {
    key: 'archive',
    name: '压缩包',
    folder: '压缩包',
    hint: 'ZIP · RAR · 7Z · ISO',
    subHint: '按格式细分为 ZIP / RAR / 7Z / ISO / 其他',
    subMode: 'ext',
    exts: ['zip', 'zipx', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'xz', 'txz', 'zst', 'cab',
      'iso', 'img', 'lzh', 'ace', 'arj', '001', 'z', 'r00', 'part1', 'pkg', 'dmg', 'wim', 'vhd']
  },
  {
    key: 'unknown',
    name: '未知文件',
    folder: '未知文件',
    hint: '快捷方式和系统图标以外的其他文件',
    subHint: '按扩展名细分（如 EXE / BAT / JSON / 无扩展名）',
    subMode: 'ext'
  }
];

// 扩展名 -> { cat, sub } 索引
const EXT_INDEX = new Map();
for (const c of CATEGORIES) {
  if (c.subMode === 'map') {
    for (const [sub, list] of Object.entries(c.map)) {
      for (const e of list) if (!EXT_INDEX.has(e)) EXT_INDEX.set(e, { cat: c.key, sub });
    }
  } else if (c.exts) {
    for (const e of c.exts) if (!EXT_INDEX.has(e)) EXT_INDEX.set(e, { cat: c.key, sub: null });
  }
}

const CAT_MAP = new Map(CATEGORIES.map(c => [c.key, c]));

function extOf(name) {
  const e = path.extname(name || '').toLowerCase();
  return e ? e.slice(1) : '';
}

function pad2(n) { return String(n).padStart(2, '0'); }

function monthFolder(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function classify(name, isDir) {
  if (isDir) return { cat: 'folder', ext: '', sub: null };
  const lowerExt = path.extname(name || '').toLowerCase();
  if (SHORTCUT_EXTS.includes(lowerExt)) return { skip: '桌面快捷方式，保持不动' };
  const ext = extOf(name);
  if (!ext) return { cat: 'unknown', ext: '', sub: null };
  const hit = EXT_INDEX.get(ext);
  if (hit) return { cat: hit.cat, ext, sub: hit.sub };
  return { cat: 'unknown', ext, sub: null };
}

function subFolderOf(cat, item) {
  switch (cat.subMode) {
    case 'map': return item.sub || '其他文档';
    case 'date': return monthFolder(item.mtime);
    case 'ext': return item.ext ? item.ext.toUpperCase() : '无扩展名';
    default: return null;
  }
}

/** 扫描桌面，返回分类结果 */
function scanDesktop(desktopPath, hiddenNames) {
  const hidden = hiddenNames instanceof Set ? hiddenNames : new Set();
  const buckets = new Map(CATEGORIES.map(c => [c.key, []]));
  const skipped = [];

  let entries;
  try {
    entries = fs.readdirSync(desktopPath, { withFileTypes: true });
  } catch (e) {
    throw new Error('无法读取桌面文件夹：' + e.message);
  }

  for (const ent of entries) {
    const name = ent.name;
    const lower = name.toLowerCase();

    if (IGNORE_NAMES.includes(lower)) { skipped.push({ name, reason: '系统文件' }); continue; }
    if (name.startsWith('~$')) { skipped.push({ name, reason: 'Office 临时文件' }); continue; }
    if (name.startsWith('.') || hidden.has(name)) { skipped.push({ name, reason: '隐藏或系统文件' }); continue; }

    const full = path.join(desktopPath, name);
    let st;
    try { st = fs.lstatSync(full); } catch { skipped.push({ name, reason: '无访问权限' }); continue; }
    if (st.isSymbolicLink()) { skipped.push({ name, reason: '符号链接' }); continue; }

    const isDir = st.isDirectory();
    const cls = classify(name, isDir);
    if (cls.skip) { skipped.push({ name, reason: cls.skip }); continue; }

    const cat = CAT_MAP.get(cls.cat);
    if (!cat) { skipped.push({ name, reason: '未识别' }); continue; }

    const item = {
      name,
      path: full,
      isDir,
      size: isDir ? 0 : st.size,
      mtime: st.mtimeMs,
      ext: cls.ext || '',
      sub: cls.sub || null
    };
    item.subFolder = subFolderOf(cat, item);
    buckets.get(cat.key).push(item);
  }

  const categories = CATEGORIES.map(c => {
    const items = buckets.get(c.key) || [];
    items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return {
      key: c.key,
      name: c.name,
      folder: c.folder,
      hint: c.hint,
      subHint: c.subHint,
      subMode: c.subMode,
      count: items.length,
      size: items.reduce((s, i) => s + i.size, 0),
      items
    };
  });

  return { desktopPath, categories, skipped, total: categories.reduce((s, c) => s + c.count, 0) };
}

/** 生成整理方案（不落盘） */
function buildPlan(scan, opts) {
  const selected = new Set(opts.selected || []);
  const targetRoot = path.resolve(String(opts.targetRoot || '').trim());
  const groups = [];
  let total = 0;

  for (const cat of scan.categories) {
    if (!selected.has(cat.key) || cat.count === 0) continue;
    const catDir = path.join(targetRoot, cat.folder);
    const subMap = new Map();

    for (const item of cat.items) {
      const destDir = item.subFolder ? path.join(catDir, item.subFolder) : catDir;
      if (!subMap.has(destDir)) subMap.set(destDir, { dir: destDir, sub: item.subFolder, items: [] });
      subMap.get(destDir).items.push({
        from: item.path, name: item.name, isDir: item.isDir, size: item.size, mtime: item.mtime
      });
      total++;
    }

    groups.push({
      key: cat.key,
      name: cat.name,
      folder: cat.folder,
      dir: catDir,
      count: cat.count,
      subs: [...subMap.values()]
    });
  }

  return { targetRoot, groups, total, skipped: scan.skipped };
}

/** 目标目录重名时自动加序号 */
function uniqueDest(destDir, name, isDir) {
  let candidate = path.join(destDir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = isDir ? '' : path.extname(name);
  const base = isDir ? name : name.slice(0, name.length - ext.length);
  for (let i = 2; i < 9999; i++) {
    candidate = path.join(destDir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('无法生成唯一文件名：' + name);
}

const fsp = fs.promises;

/**
 * 手写递归复制。
 * 注意：绝对不要用 fs.cpSync —— Node 22 在 Windows 上遇到「源目录名含中文」
 * 会直接段错误（0xC0000005）崩掉整个进程，导致搬了一半、日志也没了。
 */
async function copyTree(src, dst, stats) {
  const st = await fsp.lstat(src);
  if (st.isSymbolicLink()) {
    stats.failed.push({ name: path.basename(src), reason: '符号链接，已跳过' });
    return;
  }
  if (st.isDirectory()) {
    await fsp.mkdir(dst, { recursive: true });
    const names = await fsp.readdir(src);
    for (const name of names) {
      await copyTree(path.join(src, name), path.join(dst, name), stats);
    }
    try { await fsp.utimes(dst, st.atime, st.mtime); } catch { /* ignore */ }
  } else {
    try {
      await fsp.copyFile(src, dst);
      stats.copied++;
      try { const s2 = await fsp.stat(src); await fsp.utimes(dst, s2.atime, s2.mtime); } catch { /* ignore */ }
    } catch (e) {
      stats.failed.push({ name: path.basename(src), reason: e.code || e.message });
    }
  }
}

/** 移动（跨盘时先复制校验再删源，确保不丢数据） */
async function moveItem(from, to, isDir) {
  try {
    await fsp.rename(from, to);
    return 'rename';
  } catch (e) {
    if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTEMPTY', 'BUSY'].includes(e.code)) throw e;
  }

  const stats = { copied: 0, failed: [] };
  if (isDir) {
    await copyTree(from, to, stats);
    if (stats.failed.length) {
      // 有文件没复制成功：清掉半成品，保留原文件夹，绝不删源
      try { await fsp.rm(to, { recursive: true, force: true }); } catch { /* ignore */ }
      const first = stats.failed[0];
      const err = new Error(`文件夹内有 ${stats.failed.length} 个文件无法复制（${first.name}：${first.reason}）`);
      err.code = 'COPY_PARTIAL';
      throw err;
    }
  } else {
    await fsp.copyFile(from, to);
    try {
      const st = await fsp.stat(from);
      await fsp.utimes(to, st.atime, st.mtime);
    } catch { /* ignore */ }
    const dst = await fsp.stat(to);
    if (dst.size === 0 && (await fsp.stat(from)).size > 0) throw new Error('复制校验失败');
  }

  await fsp.rm(from, { recursive: isDir, force: true });
  return 'copy';
}

/**
 * 执行方案（异步分批，边搬边落日志，进程被中断也能撤销）
 * hooks: { onProgress({done,total,name}) }
 */
async function executePlan(plan, dataDir, hooks = {}) {
  const startedAt = Date.now();
  const log = {
    id: new Date(startedAt).toISOString().replace(/[:.]/g, '-'),
    startedAt,
    status: 'running',
    targetRoot: plan.targetRoot,
    moved: [],
    skipped: [],
    failed: []
  };

  const flush = () => {
    if (!dataDir) return;
    try { saveLog(dataDir, log); } catch { /* 磁盘异常时不能阻塞搬家 */ }
  };

  const tick = () => new Promise(r => setImmediate(r));

  let total = 0;
  for (const g of plan.groups) for (const s of g.subs) total += s.items.length;
  log.total = total;
  flush(); // 先落一份空日志，保证"开始过"这件事有据可查

  let done = 0;
  for (const g of plan.groups) {
    for (const sub of g.subs) {
      try { fs.mkdirSync(sub.dir, { recursive: true }); }
      catch (e) {
        for (const it of sub.items) {
          log.failed.push({ name: it.name, reason: '无法创建目录：' + e.message });
          done++;
        }
        flush();
        continue;
      }

      for (const it of sub.items) {
        try {
          if (!fs.existsSync(it.from)) {
            log.skipped.push({ name: it.name, reason: '文件已不存在' });
          } else {
            const dest = uniqueDest(sub.dir, it.name, it.isDir);
            const mode = await moveItem(it.from, dest, it.isDir);
            log.moved.push({ from: it.from, to: dest, isDir: it.isDir, category: g.name, mode });
          }
        } catch (e) {
          log.failed.push({ name: it.name, reason: e.code || e.message });
        }
        done++;
        // 每搬完一个就落盘，并让出事件循环（前端进度条才能动）
        flush();
        if (hooks.onProgress) hooks.onProgress({ done, total, name: it.name });
        await tick();
      }
      flush();
    }
  }

  log.status = 'done';
  log.finishedAt = Date.now();
  log.movedCount = log.moved.length;
  flush();
  return log;
}

/** 保存日志 */
function saveLog(dataDir, log) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, log.id + '.json'), JSON.stringify(log, null, 2), 'utf8');
}

/** 撤销某次整理 */
async function undoLog(log, dataDir) {
  const result = { restored: 0, failed: [] };
  const entries = [...(log.moved || [])].reverse();
  for (const e of entries) {
    try {
      if (!fs.existsSync(e.to)) { result.failed.push({ name: path.basename(e.to), reason: '目标已不存在' }); continue; }
      const backDir = path.dirname(e.from);
      fs.mkdirSync(backDir, { recursive: true });
      const dest = uniqueDest(backDir, path.basename(e.from), e.isDir);
      await moveItem(e.to, dest, e.isDir);
      result.restored++;
    } catch (err) {
      result.failed.push({ name: path.basename(e.to), reason: err.code || err.message });
    }
  }
  // 清理整理过程中产生的空文件夹
  for (const g of new Set(log.moved.map(m => path.dirname(m.to)))) {
    let d = g;
    while (d && d !== log.targetRoot && d.startsWith(log.targetRoot)) {
      try {
        if (fs.readdirSync(d).length === 0) fs.rmdirSync(d); else break;
      } catch { break; }
      d = path.dirname(d);
    }
  }
  // 目标根目录如果空了，一并删掉
  try {
    if (fs.existsSync(log.targetRoot) && fs.readdirSync(log.targetRoot).length === 0) fs.rmdirSync(log.targetRoot);
  } catch { /* ignore */ }

  // 删除本次在桌面创建的快捷方式，避免留下失效入口
  if (log.shortcut && log.shortcut.path) {
    try {
      const st = fs.lstatSync(log.shortcut.path);
      if (st.isSymbolicLink()) fs.rmdirSync(log.shortcut.path);
      else fs.unlinkSync(log.shortcut.path);
      result.removedShortcut = true;
    } catch { /* ignore */ }
  }

  if (dataDir) {
    try { fs.unlinkSync(path.join(dataDir, 'logs', log.id + '.json')); } catch { /* ignore */ }
  }
  return result;
}

function listLogs(dataDir, limit) {
  const dir = path.join(dataDir, 'logs');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const logs = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      logs.push({
        id: j.id, startedAt: j.startedAt, finishedAt: j.finishedAt,
        status: j.status || 'done', reconstructed: !!j.reconstructed,
        total: j.total || 0,
        targetRoot: j.targetRoot, movedCount: (j.moved || []).length,
        failedCount: (j.failed || []).length
      });
    } catch { /* 忽略损坏日志 */ }
  }
  logs.sort((a, b) => b.startedAt - a.startedAt);
  return logs.slice(0, limit || 20);
}

function readLog(dataDir, id) {
  const p = path.join(dataDir, 'logs', String(id).replace(/[^0-9T\-Z_a-zA-Z.]/g, '') + '.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

module.exports = {
  CATEGORIES, SHORTCUT_EXTS,
  scanDesktop, buildPlan, executePlan, undoLog, listLogs, readLog, saveLog,
  classify, monthFolder
};

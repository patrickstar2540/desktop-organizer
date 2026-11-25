'use strict';
/**
 * 桌面备份
 *
 * 做两件事：
 *   1. 把桌面上的文件和快捷方式原样复制一份到 <备份根>\桌面备份\<id>\files\<n>\
 *   2. 由 server 另外写入 icons.json（每个图标的名字与坐标），见 server.js
 *
 * 备份位置由用户自己选（默认和「整理桌面」的存放位置同一个文件夹），
 * 所以这里的函数都接收 baseDir —— 也就是「直接装着 bk-xxx 目录」的那一层。
 *
 * 原则和整理一样：备份过程只读桌面，绝不删除、绝不改名。
 * 恢复时也绝不覆盖桌面上已经存在的东西 —— 只把「备份里有、桌面上没有」的放回去。
 */
const fs = require('fs');
const path = require('path');
const fsp = fs.promises;

// 系统和临时文件不进备份
const SKIP_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store', 'iconcache.db']);
// 最多保留几份备份（再多就删最旧的）
const KEEP = 5;
// 单个目录最多扫这么多项，避免桌面里放了个超大素材夹把界面卡死
const MAX_ENTRIES = 12000;
// 备份存档统一放在用户选的文件夹下面这一层，免得和整理出来的分类文件夹混在一起
const SAVE_DIR_NAME = '桌面备份';

/** 用户选的是「备份根目录」，真正的存档都在它下面的 桌面备份\ 里 */
function defaultBase(archiveRoot) {
  const abs = path.resolve(archiveRoot);
  // 用户自己就选了「桌面备份」这个文件夹，别再套一层
  if (path.basename(abs).toLowerCase() === SAVE_DIR_NAME.toLowerCase()) return abs;
  return path.join(abs, SAVE_DIR_NAME);
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function safeId(id) {
  return String(id || '').replace(/[^0-9A-Za-z._-]/g, '');
}

function listBackups(baseDir) {
  const dir = baseDir;
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    let isDir = false;
    try { isDir = fs.statSync(path.join(dir, name)).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    const m = readJSON(path.join(dir, name, 'meta.json'));
    if (m && m.id) out.push(m);
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

function getBackup(baseDir, id) {
  const sid = safeId(id);
  if (!sid) return null;
  const m = readJSON(path.join(baseDir, sid, 'meta.json'));
  return m && m.id === sid ? m : null;
}

function freeSpace(dir) {
  // 目录可能还没建出来（用户刚选了一个新文件夹），往上找到存在的一层再问
  let p = path.resolve(dir);
  for (let i = 0; i < 6; i++) {
    try {
      const s = fs.statfsSync(p);
      return s.bavail * s.bsize;
    } catch {
      const up = path.dirname(p);
      if (up === p) break;
      p = up;
    }
  }
  return 0;
}

function skipName(name) {
  const lower = name.toLowerCase();
  return SKIP_NAMES.has(lower) || name.startsWith('~$') || name.startsWith('.');
}

/* ---------------- 扫描（只为显示体积，不做任何改动） ---------------- */

async function walkSize(dir, acc, depth) {
  if (acc.files > MAX_ENTRIES) return;
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (acc.files > MAX_ENTRIES) return;
    if (skipName(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 8) await walkSize(full, acc, depth + 1);
    } else if (e.isFile()) {
      try { acc.size += (await fsp.stat(full)).size; } catch { /* 没权限就算了 */ }
      acc.files++;
    }
  }
}

/** 桌面现状：多少项、多大，用来在界面上告诉用户这份备份要占多少空间 */
async function scanDesktop(dirs) {
  const items = [];
  let totalBytes = 0;
  let totalFiles = 0;
  for (const dir of dirs) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (skipName(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const acc = { files: 0, size: 0 };
        await walkSize(full, acc, 0);
        items.push({ dir, name: e.name, isDir: true, size: acc.size, files: acc.files });
        totalBytes += acc.size;
        totalFiles += acc.files;
      } else if (e.isFile()) {
        let size = 0;
        try { size = (await fsp.stat(full)).size; } catch { /* ignore */ }
        items.push({ dir, name: e.name, isDir: false, size, files: 1 });
        totalBytes += size;
        totalFiles++;
      }
    }
  }
  return { items, totalBytes, totalFiles, itemCount: items.length };
}

/* ---------------- 复制 ---------------- */

/**
 * 手写递归复制。
 * 和 organizer.js 里一样，不用 fs.cpSync —— Node 22 在 Windows 上遇到中文目录名会崩进程。
 *
 * prevDst 是「上一份备份里同一个位置」。如果那个文件的大小和修改时间都一样，
 * 说明这次没变过，直接建硬链接（瞬间完成、不重复占空间），只有变过/新增的才真的复制。
 */
async function copyTree(src, dst, st, prevDst) {
  let s;
  try { s = await fsp.lstat(src); } catch (e) { st.failed.push({ name: path.basename(src), reason: e.code || e.message }); return; }
  if (s.isSymbolicLink()) {
    st.failed.push({ name: path.basename(src), reason: '符号链接，已跳过' });
    return;
  }
  if (s.isDirectory()) {
    try { await fsp.mkdir(dst, { recursive: true }); } catch (e) {
      st.failed.push({ name: path.basename(src), reason: e.code || e.message });
      return;
    }
    let names = [];
    try { names = await fsp.readdir(src); } catch (e) {
      st.failed.push({ name: path.basename(src), reason: e.code || e.message });
      return;
    }
    for (const name of names) {
      await copyTree(
        path.join(src, name),
        path.join(dst, name),
        st,
        prevDst ? path.join(prevDst, name) : null
      );
    }
    try { await fsp.utimes(dst, s.atime, s.mtime); } catch { /* ignore */ }
  } else {
    // 上一份里已有且没变过 → 硬链接复用
    if (prevDst && await sameAsPrev(prevDst, s)) {
      try {
        await fsp.link(prevDst, dst);
        st.linked++;
        return;
      } catch { /* 跨卷 / 不支持硬链接，退回复制 */ }
    }
    try {
      await fsp.copyFile(src, dst);
      try { await fsp.utimes(dst, s.atime, s.mtime); } catch { /* ignore */ }
      st.copied++;
      st.copiedBytes += s.size;
    } catch (e) {
      st.failed.push({ name: path.basename(src), reason: e.code || e.message });
    }
  }
}

/** 上一份备份里的同一个文件，大小和修改时间都对得上就算「没变过」 */
async function sameAsPrev(prevPath, srcStat) {
  try {
    const p = await fsp.lstat(prevPath);
    return p.isFile() && p.size === srcStat.size && Math.abs(p.mtimeMs - srcStat.mtimeMs) < 2000;
  } catch { return false; }
}

/* ---------------- 创建备份 ---------------- */

/**
 * @param {string} baseDir     备份存档所在目录（<备份根>\桌面备份）
 * @param {string[]} dirs      桌面目录（用户桌面 + 公共桌面）
 * @param {object} hooks       { onProgress({done,total,name}), onPhase(text) }
 */
async function createBackup(baseDir, dirs, hooks = {}) {
  const at = Date.now();
  const id = 'bk-' + new Date(at).toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  const base = path.join(baseDir, id);

  const scan = await scanDesktop(dirs);
  if (!scan.itemCount) throw new Error('桌面上没有可以备份的东西');

  const free = freeSpace(baseDir);
  if (free && scan.totalBytes > free - 300 * 1024 * 1024) {
    throw new Error('磁盘剩余空间不够（需要约 ' + fmtBytes(scan.totalBytes) + '，可用 ' + fmtBytes(free) + '），先清理一下再备份');
  }

  // 上一份备份用来做「增量」：没变过的文件直接硬链接，不重复占空间
  const prev = listBackups(baseDir)[0] || null;
  const prevFileOf = (item) => {
    if (!prev) return null;
    const pi = (prev.items || []).find(x => x.name === item.name && x.dir === item.dir);
    if (!pi) return null;
    return path.join(baseDir, prev.id, 'files', String(pi.sub == null ? 0 : pi.sub), item.name);
  };

  await fsp.mkdir(base, { recursive: true });

  const meta = {
    id, at,
    baseDir,
    dirs: [],
    items: [],
    totalBytes: 0,
    copiedBytes: 0,
    fileCount: 0,
    newCount: 0,
    reusedCount: 0,
    prevId: prev ? prev.id : '',
    skipped: [],
    iconCount: 0
  };

  const idxOf = new Map();
  for (let i = 0; i < dirs.length; i++) {
    idxOf.set(dirs[i], i);
    meta.dirs.push({ src: dirs[i], sub: String(i) });
    await fsp.mkdir(path.join(base, 'files', String(i)), { recursive: true });
  }

  const prevNames = new Set(prev ? (prev.items || []).map(x => x.name + '|' + x.dir) : []);

  const total = scan.items.length;
  let done = 0;
  for (const it of scan.items) {
    const n = idxOf.get(it.dir);
    if (n === undefined) { done++; continue; }
    if (hooks.onProgress) hooks.onProgress({ done, total, name: it.name });
    const src = path.join(it.dir, it.name);
    const dst = path.join(base, 'files', String(n), it.name);
    const prevDst = prevFileOf(it);

    // 桌面上新出现的项目（上次备份里没有）—— 一键备份时最关心的就是这个数
    if (prev && !prevNames.has(it.name + '|' + it.dir)) meta.newCount++;

    if (it.isDir) {
      const st = { copied: 0, linked: 0, copiedBytes: 0, failed: [] };
      await copyTree(src, dst, st, prevDst);
      meta.items.push({
        name: it.name, dir: it.dir, sub: String(n), isDir: true,
        size: it.size, files: st.copied + st.linked, failed: st.failed.length
      });
      if (st.failed.length) meta.skipped.push({ name: it.name, reason: `文件夹里有 ${st.failed.length} 个文件没复制成功` });
      meta.totalBytes += it.size;
      meta.copiedBytes += st.copiedBytes;
      meta.fileCount += st.copied + st.linked;
      meta.reusedCount += st.linked;
    } else {
      const st = { copied: 0, linked: 0, copiedBytes: 0, failed: [] };
      await copyTree(src, dst, st, prevDst);
      if (st.failed.length) {
        meta.skipped.push({ name: it.name, reason: st.failed[0].reason });
      } else {
        meta.items.push({ name: it.name, dir: it.dir, sub: String(n), isDir: false, size: it.size });
        meta.totalBytes += it.size;
        meta.copiedBytes += st.copiedBytes;
        meta.fileCount += st.copied + st.linked;
        meta.reusedCount += st.linked;
      }
    }
    done++;
    if (hooks.onProgress) hooks.onProgress({ done, total, name: it.name });
  }

  meta.finishedAt = Date.now();
  writeJSON(path.join(base, 'meta.json'), meta);
  prune(baseDir);
  return meta;
}

/** 只保留最近 KEEP 份，避免备份目录无限长大 */
function prune(baseDir) {
  const list = listBackups(baseDir);
  for (const old of list.slice(KEEP)) removeTree(path.join(baseDir, old.id));
  cleanOrphans(baseDir);
}

/**
 * 清掉「没有 meta.json 的 bk- 目录」。
 * 它们来自中途退出的备份，或删到一半被占用的旧备份 —— 留着只是占空间，
 * 界面上本来也看不到。只处理一小时以前的，避免误删正在写的那一份。
 */
function cleanOrphans(baseDir) {
  let ents = [];
  try { ents = fs.readdirSync(baseDir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (!e.isDirectory() || !e.name.startsWith('bk-')) continue;
    const full = path.join(baseDir, e.name);
    if (fs.existsSync(path.join(full, 'meta.json'))) continue;
    try {
      const age = Date.now() - fs.statSync(full).mtimeMs;
      if (age > 3600 * 1000) removeTree(full);
    } catch { /* ignore */ }
  }
}

/**
 * 逐个文件删除。
 * 不用 fs.rmSync(dir, {recursive:true})：一次删上百个文件容易触发各种
 * 「批量删除」保护/占用提示，逐个删反而稳，失败也只影响单个文件。
 * 返回留下的文件数，用来告诉用户「为什么没删掉」。
 */
function removeTree(dir, stat) {
  const st = stat || { left: 0, error: '' };
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* 目录已不在 */ }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) removeTree(full, st);
    else {
      try { fs.unlinkSync(full); } catch (err) {
        st.left++;
        if (!st.error) st.error = err.code || err.message;
      }
    }
  }
  try { fs.rmdirSync(dir); } catch (err) {
    if (!st.error) st.error = err.code || err.message;
  }
  return st;
}

/* ---------------- 恢复文件 ---------------- */

/**
 * 把备份里的文件放回桌面：
 *  - 桌面上已经有同名项的，一律跳过（不覆盖用户现在的东西）
 *  - 只补回「备份里有、桌面上没有」的
 */
async function restoreFiles(baseDir, meta, hooks = {}) {
  const base = path.join(baseDir, meta.id);
  const result = { restored: 0, skipped: 0, failed: [] };
  const items = meta.items || [];
  let done = 0;
  for (const it of items) {
    const n = it.sub == null ? '0' : String(it.sub);
    const src = path.join(base, 'files', n, it.name);
    const dest = path.join(it.dir, it.name);
    if (hooks.onProgress) hooks.onProgress({ done, total: items.length, name: it.name });
    done++;

    if (!fs.existsSync(src)) { result.skipped++; continue; }
    if (fs.existsSync(dest)) { result.skipped++; continue; }
    try {
      if (it.isDir) {
        const st = { copied: 0, linked: 0, copiedBytes: 0, failed: [] };
        await copyTree(src, dest, st, null);
        if (st.failed.length) result.failed.push({ name: it.name, reason: `有 ${st.failed.length} 个文件没恢复` });
        else result.restored++;
      } else {
        // 恢复用真实复制，不用硬链接：否则以后改了备份里的文件会连带改到桌面
        await fsp.copyFile(src, dest);
        result.restored++;
      }
    } catch (e) {
      result.failed.push({ name: it.name, reason: e.code || e.message });
    }
  }
  return result;
}

function deleteBackup(baseDir, id) {
  const sid = safeId(id);
  if (!sid) return { ok: false, missing: true };
  const dir = path.join(baseDir, sid);
  if (!fs.existsSync(dir)) return { ok: false, missing: true };
  const st = removeTree(dir);
  if (fs.existsSync(dir)) return { ok: false, left: st.left, error: st.error };
  return { ok: true };
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)) + ' ' + u[i];
}

module.exports = {
  defaultBase, listBackups, getBackup, scanDesktop, createBackup, restoreFiles,
  deleteBackup, freeSpace, fmtBytes, KEEP, SAVE_DIR_NAME
};

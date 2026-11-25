'use strict';
/**
 * 桌面清理引擎（只处理快捷方式）
 *
 * 做两件事：
 *  1. 找出「失效图标」—— 指向的程序/文件夹已经不在了的 .lnk / .url；
 *  2. 把用户勾选的那些丢进回收站，同时在本地留一份原始的 .lnk，随时能放回来。
 *
 * 边界（很重要）：
 *  - 只碰桌面根目录下的 .lnk / .url，绝不递归、绝不碰文件本身；
 *  - 只能删「上一次扫描结果里确实被判为失效」的那些，防止参数被乱传；
 *  - 删除走回收站，不永久删除。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const win = require('./winutil');
const icons = require('./icons');

/* ---------------- 读取快捷方式指向 ---------------- */

const INSPECT = `
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
$ws = New-Object -ComObject WScript.Shell
$res = New-Object System.Collections.ArrayList
foreach ($f in $cfg.files) {
  $o = [ordered]@{
    file = $f; name = ''; ext = ''; target = ''; args = ''; url = '';
    isFile = $false; isDir = $false; drive = ''; driveOk = $true;
    corrupt = $false; unc = $false; unresolved = $false; mtime = 0; size = 0
  }
  try {
    $fi = Get-Item -LiteralPath $f -ErrorAction Stop
    $o.name = $fi.Name
    $o.ext = $fi.Extension.ToLower()
    $o.size = [int64]$fi.Length
    $span = ([DateTime]$fi.LastWriteTimeUtc) - [DateTime]'1970-01-01'
    $o.mtime = [int64]$span.TotalMilliseconds
  } catch { }

  if ($o.ext -eq '.url') {
    try {
      $txt = [IO.File]::ReadAllText($f)
      $m = [regex]::Match($txt, '(?im)^\\s*URL\\s*=\\s*(.+?)\\s*$')
      if ($m.Success) { $o.url = $m.Groups[1].Value.Trim() }
    } catch { $o.corrupt = $true }
  } else {
    try {
      $sc = $ws.CreateShortcut($f)
      $raw = [string]$sc.TargetPath
      $o.args = [string]$sc.Arguments
      if ($raw) {
        $raw = $raw.Trim().Trim('"')
        $o.target = [Environment]::ExpandEnvironmentVariables($raw)
      }
    } catch { $o.corrupt = $true }
  }

  $t = [string]$o.target
  if ($t) {
    if ($t.StartsWith('\\\\')) {
      $o.unc = $true
    } elseif ($t.Contains('%')) {
      # 环境变量展开不了（比如只剩 %SOMEVAR%），不敢判断，交给上层跳过
      $o.unresolved = $true
    } else {
      try {
        if ([IO.File]::Exists($t)) { $o.isFile = $true }
        elseif ([IO.Directory]::Exists($t)) { $o.isDir = $true }
        else {
          $root = ''
          try { $root = [IO.Path]::GetPathRoot($t) } catch { }
          if ($root -and $root.Trim().Length -ge 2) {
            $o.drive = $root
            try { $o.driveOk = [IO.Directory]::Exists($root) } catch { $o.driveOk = $true }
          }
        }
      } catch { }
    }
  }
  [void]$res.Add([pscustomobject]$o)
}
ConvertTo-Json -InputObject @($res) -Compress -Depth 3
`;

/* 删除到回收站：不进回收站不敢删，用户还能自己右键还原 */
const RECYCLE = `
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName Microsoft.VisualBasic
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
$ok = 0
foreach ($f in $cfg.files) {
  try {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($f, 'OnlyErrorDialogs', 'SendToRecycleBin')
    $ok++
  } catch {
    $msg = $_.Exception.Message
    $b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($f + ' :: ' + $msg))
    [Console]::Out.WriteLine('FAIL|' + $b)
  }
}
[Console]::Out.WriteLine('DELETED|' + $ok)
`;

function b64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

/** 桌面根目录下的快捷方式（不递归） */
function listFiles(dirs) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs.filter(Boolean)) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (ext !== '.lnk' && ext !== '.url') continue;
      if (e.name.startsWith('~$')) continue;
      const file = path.join(dir, e.name);
      const key = file.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file, name: path.parse(e.name).name, ext });
    }
  }
  return out;
}

function inspect(files) {
  if (!files.length) return [];
  const payload = b64(JSON.stringify({ files }));
  let raw = '';
  try {
    raw = win.runPS(INSPECT.replace('__PAYLOAD__', payload), { timeout: 90000 });
  } catch (e) {
    throw new Error('读取快捷方式失败：' + e.message);
  }
  let parsed = [];
  try {
    const t = String(raw).trim();
    if (t) parsed = JSON.parse(t);
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) parsed = [parsed];
  return parsed.filter(Boolean);
}

/* ---------------- 判定 ---------------- */

const EXE_RE = /\.(exe|com|bat|cmd)$/i;

/**
 * @returns {{status:'ok'|'broken'|'suspect'|'skip', kind?:string, reason?:string}}
 */
function analyze(x) {
  const ext = String(x.ext || '').toLowerCase();

  if (ext === '.url') {
    const url = String(x.url || '').trim();
    if (!url) return { status: 'broken', kind: 'url', reason: '网址快捷方式里没有内容' };
    if (/^file:/i.test(url)) {
      let p = url.replace(/^file:\/{1,3}/i, '');
      try { p = decodeURIComponent(p); } catch { /* 保持原样 */ }
      p = p.replace(/\//g, '\\').replace(/^([A-Za-z]):/, '$1:');
      if (!fs.existsSync(p)) return { status: 'broken', kind: 'file', reason: '指向的本地文件已经不在了' };
    }
    return { status: 'ok' };
  }

  if (x.corrupt) return { status: 'broken', kind: 'file', reason: '快捷方式文件已损坏，双击也打不开' };

  const t = String(x.target || '').trim();
  const args = String(x.args || '');
  if (!t) {
    if (/shell:|::\{|ms-appx:/i.test(args)) return { status: 'ok' };   // 应用商店应用
    return { status: 'broken', kind: 'file', reason: '快捷方式没有指向任何程序' };
  }
  if (/shell:|ms-appx:/i.test(t) || x.unc) return { status: 'skip', reason: '网络位置，没法确认' };
  if (x.unresolved) return { status: 'skip', reason: '路径里有认不出的环境变量' };
  if (x.isFile || x.isDir) return { status: 'ok' };

  if (x.driveOk === false) {
    const d = String(x.drive || '').trim();
    return { status: 'suspect', kind: EXE_RE.test(t) ? 'program' : 'file', reason: `所在磁盘 ${d} 现在没连上` };
  }
  return {
    status: 'broken',
    kind: EXE_RE.test(t) ? 'program' : 'file',
    reason: EXE_RE.test(t) ? '指向的程序已经不在了' : '指向的位置已经不在了'
  };
}

/* ---------------- 扫描 ---------------- */

let snap = { at: 0, map: new Map(), items: [] };

/**
 * @param {string[]} dirs 桌面目录（当前用户 + 公共）
 * @param {{cacheDir?:string}} opts
 */
async function scan(dirs, opts = {}) {
  const files = listFiles(dirs);
  const userDirs = new Set(dirs.map(d => path.resolve(d).toLowerCase()));

  let raw = [];
  try {
    raw = inspect(files.map(f => f.file));
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const byFile = new Map();
  for (const r of raw) if (r && r.file) byFile.set(String(r.file).toLowerCase(), r);

  const items = [];
  let skipped = 0;
  for (const f of files) {
    const r = byFile.get(f.file.toLowerCase());
    if (!r) { skipped++; continue; }
    const a = analyze(r);
    if (a.status === 'ok') continue;
    if (a.status === 'skip') { skipped++; continue; }
    const dir = path.dirname(f.file);
    items.push({
      file: f.file,
      name: r.name ? path.basename(String(r.name), path.extname(String(r.name))) : f.name,
      ext: f.ext,
      target: String(r.target || ''),
      url: String(r.url || ''),
      kind: a.kind,
      status: a.status,
      reason: a.reason,
      dir: userDirs.has(path.resolve(dir).toLowerCase()) ? '桌面' : '公共桌面',
      mtime: Number(r.mtime) || 0,
      size: Number(r.size) || 0,
      iconKey: icons.keyFor(f.file),
      iconUrl: ''
    });
  }

  // 确定失效的排前面，可疑的排后面；同组按名字
  items.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'broken' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  if (opts.cacheDir && items.length) {
    try {
      const r = await icons.ensureIcons(items.slice(0, 40).map(it => ({ file: it.file, key: it.iconKey })), opts.cacheDir);
      for (const it of items) it.iconUrl = (r.icons && r.icons[it.iconKey]) || '';
    } catch { /* 图标拿不到就不显示，不影响清理 */ }
  }

  const counts = {
    scanned: files.length,
    broken: items.filter(i => i.status === 'broken').length,
    suspect: items.filter(i => i.status === 'suspect').length,
    skipped
  };

  snap = {
    at: Date.now(),
    items,
    map: new Map(items.map(it => [it.file.toLowerCase(), it]))
  };

  return { ok: true, items, counts, at: snap.at };
}

/* ---------------- 删除 ---------------- */

function cleanupRoot(dataDir) {
  return path.join(dataDir, 'cleanup');
}

function logDir(dataDir, id) {
  return path.join(cleanupRoot(dataDir), id);
}

function newId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function deleteToRecycle(files) {
  const payload = b64(JSON.stringify({ files }));
  let raw;
  try {
    raw = win.runPS(RECYCLE.replace('__PAYLOAD__', payload), { timeout: 120000 });
  } catch (e) {
    return { ok: false, error: '删除失败：' + e.message };
  }
  const lines = String(raw).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const del = lines.find(l => l.startsWith('DELETED|'));
  const failed = [];
  for (const l of lines) {
    if (!l.startsWith('FAIL|')) continue;
    let txt = '';
    try { txt = Buffer.from(l.slice(5), 'base64').toString('utf8'); } catch { txt = l.slice(5); }
    const i = txt.indexOf(' :: ');
    failed.push(i > 0
      ? { file: txt.slice(0, i), error: txt.slice(i + 4) }
      : { file: txt, error: '删除失败' });
  }
  return { ok: true, deleted: del ? Number(del.split('|')[1]) || 0 : 0, failed };
}

/**
 * 清理指定快捷方式。
 * 只会处理「上一次 scan 里被判为失效」的文件，别的一律拒绝。
 */
function remove(files, dirs, dataDir) {
  const allowed = new Set(dirs.filter(Boolean).map(d => path.resolve(d).toLowerCase()));
  const picked = [];

  for (const raw of files) {
    const abs = path.resolve(String(raw || ''));
    const parent = path.dirname(abs).toLowerCase();
    if (!allowed.has(parent)) {
      return { ok: false, error: '只能清理桌面上的快捷方式：' + path.basename(abs) };
    }
    const ext = path.extname(abs).toLowerCase();
    if (ext !== '.lnk' && ext !== '.url') {
      return { ok: false, error: '只清理快捷方式，不动文件本身：' + path.basename(abs) };
    }
    const rec = snap.map.get(abs.toLowerCase());
    if (!rec) {
      return { ok: false, error: '「' + path.basename(abs) + '」不在刚才的检测结果里，请重新扫描' };
    }
    if (!fs.existsSync(abs)) continue;      // 已经被人手动删掉了
    picked.push({ ...rec, file: abs });
  }

  if (!picked.length) return { ok: false, error: '这些快捷方式已经不在了，重新扫描一下' };

  // 先留底：把 .lnk 原件复制一份，再删
  const id = newId();
  const dir = logDir(dataDir, id);
  const storeDir = path.join(dir, 'files');
  const rows = [];
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    picked.forEach((p, i) => {
      const store = String(i + 1).padStart(2, '0') + '-' + path.basename(p.file);
      fs.copyFileSync(p.file, path.join(storeDir, store));
      rows.push({
        name: p.name, file: p.file, store,
        target: p.target || p.url || '', kind: p.kind, status: p.status, reason: p.reason
      });
    });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      id, at: Date.now(), items: rows, restoredAt: 0
    }, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: '本地留底失败，为了安全这次没有删除：' + e.message };
  }

  const r = deleteToRecycle(picked.map(p => p.file));
  if (!r.ok) return { ok: false, error: r.error };

  if (!r.deleted) {
    // 一个都没删掉，这份留底就是噪音
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    const first = (r.failed[0] && r.failed[0].error) || '可能被占用或没有权限';
    return { ok: false, error: '没有删掉任何图标：' + first };
  }

  pruneLogs(dataDir);
  dropFromSnap(picked.map(p => p.file));

  return {
    ok: true, deleted: r.deleted, failed: r.failed, logId: id,
    names: rows.map(x => x.name), files: rows.map(x => x.file)
  };
}

function dropFromSnap(files) {
  const set = new Set(files.map(f => path.resolve(f).toLowerCase()));
  snap.items = snap.items.filter(it => !set.has(it.file.toLowerCase()));
  for (const f of set) snap.map.delete(f);
}

/* ---------------- 留底与还原 ---------------- */

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

function listLogs(dataDir) {
  const root = cleanupRoot(dataDir);
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const m = readManifest(logDir(dataDir, n));
    if (!m) continue;
    out.push({
      id: m.id || n,
      at: m.at || 0,
      count: (m.items || []).length,
      names: (m.items || []).slice(0, 3).map(x => x.name).filter(Boolean),
      restoredAt: m.restoredAt || 0
    });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, 10);
}

function restore(id, dataDir, dirs) {
  const safe = String(id || '');
  if (!/^[a-z0-9-]{4,40}$/i.test(safe)) return { ok: false, error: '记录编号不对' };
  const dir = logDir(dataDir, safe);
  const m = readManifest(dir);
  if (!m) return { ok: false, error: '找不到这次清理的记录' };

  let restored = 0;
  let skipped = 0;
  const failed = [];
  for (const it of m.items || []) {
    const src = path.join(dir, 'files', it.store || '');
    const dst = it.file;
    try {
      if (!fs.existsSync(src)) { failed.push({ file: dst, error: '留底文件不见了' }); continue; }
      if (fs.existsSync(dst)) { skipped++; continue; }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      restored++;
    } catch (e) {
      failed.push({ file: dst, error: e.message });
    }
  }

  if (restored) {
    m.restoredAt = Date.now();
    try { fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2), 'utf8'); } catch { /* ignore */ }
    // 放回来的图标要能重新被扫到
    for (const it of m.items || []) {
      if (!fs.existsSync(it.file)) continue;
      if (!snap.map.has(it.file.toLowerCase())) {
        snap.items.push({
          file: it.file, name: it.name, ext: path.extname(it.file).toLowerCase(),
          target: it.target || '', url: '', kind: it.kind || 'file',
          status: 'broken', reason: it.reason || '指向的位置已经不在了',
          dir: dirLabel(it.file, dirs), mtime: 0, size: 0, iconKey: icons.keyFor(it.file), iconUrl: ''
        });
        snap.map.set(it.file.toLowerCase(), snap.items[snap.items.length - 1]);
      }
    }
  }

  return { ok: true, restored, skipped, failed };
}

/** 这个快捷方式在「我的桌面」还是「公共桌面」 */
function dirLabel(file, dirs) {
  const list = (dirs || []).filter(Boolean).map(d => path.resolve(d).toLowerCase());
  const parent = path.dirname(path.resolve(file)).toLowerCase();
  return list[0] && parent === list[0] ? '桌面' : '公共桌面';
}

/** 最多留 12 份留底 */
function pruneLogs(dataDir) {
  const root = cleanupRoot(dataDir);
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return;
  }
  const withAt = dirs.map(n => {
    const m = readManifest(logDir(dataDir, n));
    return { n, at: (m && m.at) || 0 };
  }).sort((a, b) => b.at - a.at);
  for (const x of withAt.slice(12)) {
    try { fs.rmSync(logDir(dataDir, x.n), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = { scan, remove, restore, listLogs, analyze, listFiles };

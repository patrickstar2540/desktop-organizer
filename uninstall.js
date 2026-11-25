'use strict';
/**
 * 按图标卸载 + 残留收尾
 *
 * 三段：
 *  1. 识别 —— 桌面图标（.lnk 的 TargetPath）反查注册表卸载项，算出「这是哪个软件」；
 *  2. 卸载 —— 调用软件自己的卸载程序（MSI 用 msiexec /x，其余用 UninstallString）；
 *  3. 收尾 —— 卸载完重新扫一遍，列出还剩下的东西，用户勾了才动，全部进回收站。
 *
 * 边界（很重要）：
 *  - 只能清「本次任务自己算出来的候选路径」，前端传别的路径一律拒绝；
 *  - 系统目录、盘符根、用户目录根、AppData 根本身，永久黑名单；
 *  - 注册表只读展示，任何情况下都不写、不删；
 *  - 卸载程序是软件自己的，我们只负责找到并启动它。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const win = require('./winutil');
const icons = require('./icons');
const cls = require('./classify');

/* ==================== 一、注册表软件清单 ==================== */

const LIST_PS = String.raw`
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$out = @()
foreach ($k in @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)) {
  try {
    Get-ItemProperty $k -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName } |
      ForEach-Object {
        $out += [pscustomobject]@{
          key    = [string]$_.PSChildName
          hive   = $(if ($k -like 'HKCU*') { 'HKCU' } elseif ($k -like '*WOW6432Node*') { 'HKLM32' } else { 'HKLM' })
          name   = [string]$_.DisplayName
          pub    = [string]$_.Publisher
          ver    = [string]$_.DisplayVersion
          loc    = [string]$_.InstallLocation
          icon   = [string]$_.DisplayIcon
          uninst = [string]$_.UninstallString
          quiet  = [string]$_.QuietUninstallString
          size   = [int64]($_.EstimatedSize | ForEach-Object { if ($_) { $_ * 1024 } else { 0 } })
          sysc   = [int]($_.SystemComponent | ForEach-Object { if ($_) { $_ } else { 0 } })
          parent = [string]$_.ParentKeyName
          rel    = [string]$_.ReleaseType
        }
      }
  } catch {}
}
Write-Output ($out | ConvertTo-Json -Compress)
`;

/** 平台客户端本身：它们的目录是整个平台，绝不能当成某个游戏的安装目录 */
const PLATFORM_EXE = /^(steam|epicgameslauncher|battle\.net|uplay|ubisoftconnect|origin|wegame|galaxyclient|riotclientservices|gameloop|eadesktop|ea app)\.exe$/i;
/** 平台的图标缓存目录：里面全是 .ico，不是软件本体 */
const ICON_CACHE_DIR = /\/(steam(2)?[^/]*\/)?(steam\/)?games$|\/(icons?|cache|thumbnails?)$/i;

let rawCache = { at: 0, list: [] };
const APP_TTL = 60 * 1000;

/**
 * 这个目录能不能当「安装目录」用。
 * 有些软件的 UninstallString 是系统目录里的通用 stub（cmd.exe / rundll32.exe），
 * 把它推出来的目录当安装目录，会让「目录里还有几百个 exe」这种事发生，
 * 更糟的是收尾时可能列到系统目录头上去。
 */
function junkDir(raw) {
  // 统一成 / 再比：以前这里一边换 \ 一边换 /，导致 c:/windows/* 一直漏网
  const s = String(raw || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  if (s.length <= 3) return true;
  const sysRoot = String(process.env.SystemRoot || 'C:/Windows')
    .toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  if (s === sysRoot || s.startsWith(sysRoot + '/')) return true;
  if (/^[a-z]:\/windows(\/|$)/.test(s)) return true;
  // MSI 的安装包缓存、临时解包目录：不是软件本体
  if (/\/windows\/(installer|temp|assembly)(\/|$)/.test(s)) return true;
  const roots = [
    'c:/program files', 'c:/program files (x86)', 'c:/programdata',
    'c:/users', 'c:/users/public'
  ];
  return roots.includes(s);
}

/** 读全部已安装软件（含 Windows 隐藏的系统组件条目）。带 60 秒缓存。 */
function rawApps(fresh) {
  if (!fresh && rawCache.list.length && Date.now() - rawCache.at < APP_TTL) return rawCache.list;
  let raw = '';
  try { raw = win.runPS(LIST_PS, { timeout: 90000 }); } catch { raw = ''; }
  let list = [];
  try { list = JSON.parse(raw); } catch { list = []; }
  if (!Array.isArray(list)) list = list ? [list] : [];

  const norm = s => String(s || '').trim().toLowerCase().replace(/^"|"$/g, '').replace(/\\/g, '/').replace(/\/+$/, '');
  const dirOf = p => {
    const s = norm(String(p || '').split(',')[0]);
    const i = s.lastIndexOf('/');
    return i > 0 ? s.slice(0, i) : '';
  };
  const baseOf = p => norm(p).split('/').pop();
  const bare = s => norm(s).replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');

  for (const a of list) {
    const dirs = new Set();
    // 注册表里的值经常带脏东西：InstallLocation 带引号，DisplayIcon 还带图标序号
    a.loc = String(a.loc || '').replace(/^"|"$/g, '').trim();
    a.iconFile = String(a.icon || '').replace(/^"|"$/g, '').replace(/,\s*-?\d+\s*$/, '').trim();
    // 安装位置：最可信
    if (a.loc) dirs.add(norm(a.loc));
    // 图标：只有指向程序/资源文件时才能反推目录。
    // Steam 会把图标缓存到 <steam>\steam\games\xxx.ico，那目录里全是别人的图标
    if (a.iconFile) {
      const d = dirOf(a.iconFile);
      if (d && !ICON_CACHE_DIR.test(d)) dirs.add(d);
    }
    // 卸载命令里的 exe：如果是平台客户端（steam.exe / ea app.exe），
    // 它的目录是整个平台，不是这个软件的 —— 推出来就会在收尾时删掉 Steam
    if (a.uninst) {
      const m = String(a.uninst).match(/"?([A-Za-z]:[\\/][^"]+?\.exe)/i);
      if (m && !PLATFORM_EXE.test(baseOf(m[1]))) {
        const d = dirOf(m[1]);
        if (d) dirs.add(d);
      }
    }
    a.dirs = [...dirs].filter(d => !junkDir(d));
    a.name = a.name || '';
    a.display = cls.cleanAppName(a.name);
    a.bare = bare(a.name);
    a.pubBare = bare(a.pub);
    a.msi = /msiexec/i.test(a.uninst || '');
    a.proto = /\b[a-z][a-z0-9+.-]*:\/\//i.test(a.uninst || '') ? (String(a.uninst).match(/\b([a-z][a-z0-9+.-]*):\/\/(\S+)/i) || [])[1] : '';
    a.id = (a.hive + '\\' + a.key).toLowerCase();
  }
  rawCache = { at: Date.now(), list };
  return list;
}

/** 只返回「能在控制面板里看到的」软件 —— 桌面图标要靠它匹配，多出来的碎片会撞车 */
function listApps(fresh) {
  return rawApps(fresh).filter(a => !a.sysc && !a.parent);
}

/** 全部软件，带分类。给「所有已安装软件」面板用 */
function listAll(fresh) {
  const items = rawApps(fresh).map(a => {
    const c = cls.classifyApp(a);
    let blocked = '';
    if (a.parent) blocked = '是别的软件的子组件，单独卸会把主机软件弄坏';
    else if (!String(a.uninst || '').trim()) blocked = '没有提供卸载程序，只能手动删';
    return {
      id: a.id,
      name: a.display,
      pub: (a.pub || '').trim(),
      ver: (a.ver || '').trim(),
      size: Number(a.size) || 0,
      loc: (a.loc || '').trim(),
      msi: !!a.msi,
      hidden: !!a.sysc,
      proto: a.proto || '',
      cat: c.cat,
      why: c.why,
      risk: c.risk,
      blocked,
      canUninstall: !blocked,
      icon: a.iconFile || '',
      iconKey: a.iconFile ? icons.keyFor(a.iconFile) : ''
    };
  });

  // 同一个软件常在注册表里躺好几条：64 位一条、32 位一条、用户级一条
  // （Path of Exile 2 就有 3 条）。控制面板和设置里只显示一条，这里也合并，
  // 否则用户会以为装了三个同名游戏。
  const seen = new Map();
  const out = [];
  for (const it of items) {
    const k = it.name.toLowerCase() + '|' + it.pub.toLowerCase();
    const prev = seen.get(k);
    if (prev) {
      prev.dups += 1;
      prev.dupIds.push(it.id);
      // 体积取大的那份（通常是完整安装），但别把 0 覆盖成有值又反过来
      if (it.size > prev.size) prev.size = it.size;
      if (!prev.loc && it.loc) prev.loc = it.loc;
      if (!prev.icon && it.icon) { prev.icon = it.icon; prev.iconKey = it.iconKey; }
      if (!prev.canUninstall && it.canUninstall) {
        prev.canUninstall = true; prev.blocked = ''; prev.proto = it.proto;
      }
      if (it.hidden === false) prev.hidden = false;
      continue;
    }
    it.dups = 1;
    it.dupIds = [it.id];
    seen.set(k, it);
    out.push(it);
  }
  return out;
}

function invalidate() { rawCache = { at: 0, list: [] }; }

/* ==================== 二、图标 → 软件 匹配 ==================== */

const norm = s => String(s || '').trim().toLowerCase().replace(/^"|"$/g, '').replace(/\\/g, '/').replace(/\/+$/, '');
const dirOf = p => {
  const s = norm(String(p || '').split(',')[0]);
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i) : '';
};
const bare = s => norm(s).replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
const lnkBare = name => bare(String(name || '').replace(/\s*[-–—]\s*快捷方式$/, ''));

/**
 * 给一个快捷方式指向的 exe，猜它属于哪个已安装软件。
 * 返回按可信度排序的候选，score >= 88 视为可直接采用。
 */
function matchTarget(target, lnkName, apps) {
  const nt = norm(target);
  const ndir = dirOf(target);
  if (!nt) return [];

  const out = [];
  for (const a of apps) {
    let score = 0;
    let how = '';
    for (const d of a.dirs) {
      if (nt === d || nt.startsWith(d + '/')) {
        const s = 100 + Math.min(40, d.length / 5);
        if (s > score) { score = s; how = '路径在安装目录内'; }
      } else if (ndir === d) {
        if (92 > score) { score = 92; how = '与安装目录同级'; }
      } else if (d.startsWith(ndir + '/')) {
        if (88 > score) { score = 88; how = '图标在安装目录上层'; }
      }
    }
    if (score === 0) {
      const lb = lnkBare(lnkName);
      if (a.bare && lb && a.bare === lb) { score = 70; how = '名字完全一致'; }
      else if (a.bare && lb.length >= 3 && (a.bare.includes(lb) || lb.includes(a.bare))) { score = 58; how = '名字部分相同'; }
    }
    if (score > 0) out.push({ app: a, score: Math.round(score), how });
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, 6);
}

/* ==================== 三、桌面图标清单 ==================== */

const SCAN_LNK_PS = `
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
$ws = New-Object -ComObject WScript.Shell
$r = @()
foreach ($f in $cfg.files) {
  $o = [ordered]@{ f = $f; t = ''; a = ''; ok = $true; co = ''; pr = '' }
  try { $s = $ws.CreateShortcut($f); $o.t = [string]$s.TargetPath; $o.a = [string]$s.Arguments }
  catch { $o.ok = $false }
  if ($o.t) {
    try {
      if ([IO.File]::Exists($o.t)) {
        $vi = (Get-Item -LiteralPath $o.t -ErrorAction Stop).VersionInfo
        $o.co = [string]$vi.CompanyName
        $o.pr = [string]$vi.ProductName
      }
    } catch { }
  }
  $r += [pscustomobject]$o
}
Write-Output ($r | ConvertTo-Json -Compress)
`;

/** 列出桌面所有 .lnk 并匹配到软件 */
function scanDesktop(dirs, opts = {}) {
  const apps = listApps();
  const cacheDir = opts.cacheDir || '';
  const files = [];
  for (const d of dirs.filter(Boolean)) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!/\.lnk$/i.test(n)) continue;
      files.push({ dir: d, file: path.join(d, n), name: path.parse(n).name });
    }
  }

  let recs = [];
  if (files.length) {
    const payload = Buffer.from(JSON.stringify({ files: files.map(f => f.file) }), 'utf8').toString('base64');
    let raw = '';
    try { raw = win.runPS(SCAN_LNK_PS.replace('__PAYLOAD__', payload), { timeout: 60000 }); } catch { raw = ''; }
    try { recs = JSON.parse(raw); } catch { recs = []; }
    if (!Array.isArray(recs)) recs = [recs];
  }
  const byFile = new Map();
  for (const r of recs) if (r && r.f) byFile.set(String(r.f).toLowerCase(), r);

  const out = [];
  for (const f of files) {
    const rec = byFile.get(f.file.toLowerCase()) || {};
    const t = String(rec.t || '').trim();
    const args = String(rec.a || '').trim();
    const isUwp = /shell:|appsFolder|windowsapps|ms-appx/i.test(t + ' ' + args);
    const exists = !!t && !isUwp && fs.existsSync(t);
    const isExe = /\.exe$/i.test(t);
    let isDirTarget = false;
    if (exists && !isExe) {
      try { isDirTarget = fs.statSync(t).isDirectory(); } catch { /* 当文件处理 */ }
    }
    const kind = isUwp ? 'uwp' : !t ? 'empty' : !exists ? 'dead' : isExe ? 'program' : isDirTarget ? 'folder' : 'file';

    // 只有指向 .exe 的才算「软件入口」；指向文件夹/文档的不能拿去卸载
    const cands = kind === 'program' ? matchTarget(t, f.name, apps) : [];
    const top = cands[0];
    const matched = !!(top && top.score >= 70);
    let iconKey = '';
    let iconUrl = '';
    if (cacheDir) {
      try {
        iconKey = icons.keyFor(f.file);
        if (icons.isCached(cacheDir, iconKey, f.file)) iconUrl = '/icons/' + iconKey + '.png?v=' + icons.CACHE_VER;
      } catch { /* 没图标就用首字占位 */ }
    }

    // 分类：认出了软件才分日常/专业/游戏，其余统一进「认不出」那一列
    let cat = 'other';
    if (matched) {
      const c = cls.classifyShortcut({
        name: f.name, ext: '.lnk', target: t, url: '',
        company: String(rec.co || ''), product: String(rec.pr || ''),
        exists, isDir: isDirTarget
      }, null).category;
      cat = c === 'tool' || c === 'game' || c === 'niche' ? c : 'niche';
    }

    out.push({
      file: f.file,
      dir: f.dir,
      name: f.name,
      target: t,
      args,
      iconKey,
      iconUrl,
      kind,
      uwp: isUwp,
      alive: exists,
      appId: matched ? top.app.id : '',
      appName: top ? top.app.name : '',
      score: top ? top.score : 0,
      how: top ? top.how : '',
      group: cat,                    // tool | niche | game | other
      canUninstall: matched,
      tag: otherTag(kind, matched, top),
      candidates: cands.map(c => ({ id: c.app.id, name: c.app.name, pub: c.app.pub, score: c.score, how: c.how }))
    });
  }
  out.sort((a, b) => {
    const rank = x => (x.appId ? 0 : x.score > 0 ? 1 : x.kind === 'program' ? 2 : x.kind === 'uwp' ? 3 : x.kind === 'dead' ? 4 : 5);
    const d = rank(a) - rank(b);
    return d || a.name.localeCompare(b.name, 'zh');
  });

  const counts = { tool: 0, niche: 0, game: 0, other: 0 };
  for (const it of out) counts[it.group] = (counts[it.group] || 0) + 1;

  return { items: out, apps: apps.length, counts, at: Date.now() };
}

/** 「认不出」那一列里，每一项为什么不能卸 */
function otherTag(kind, matched, top) {
  if (matched) return '';
  if (kind === 'uwp') return '商店应用';
  if (kind === 'dead') return '已失效';
  if (kind === 'folder') return '指向文件夹';
  if (kind === 'file') return '指向文件';
  if (kind === 'empty') return '读不到指向';
  if (top && top.score > 0) return '认不准';
  return '没安装记录';
}

/* ==================== 四、安全边界 ==================== */

const SYS_DIRS = [
  'c:\\windows', 'c:\\windows\\system32', 'c:\\program files', 'c:\\program files (x86)',
  'c:\\programdata', 'c:\\users', 'c:\\users\\public'
];

/** 整棵子树都不许碰的目录（比 SYS_DIRS 更严：连子目录也不动） */
const PROTECTED_TREES = [
  'c:\\windows',
  'c:\\program files\\common files',
  'c:\\program files (x86)\\common files',
  'c:\\program files\\windowsapps',
  'c:\\programdata\\microsoft',
  'c:\\programdata\\package cache',   // 删了以后这个软件想修复/卸载都失败
  'c:\\program files\\windows defender',
  'c:\\program files\\windows nt'
];

function userRoots() {
  const list = [os.homedir(), process.env.LOCALAPPDATA, process.env.APPDATA, process.env.ProgramData]
    .filter(Boolean).map(p => path.resolve(p).toLowerCase());
  // 用户主目录下的关键子目录，整个删掉会出事
  const home = path.resolve(os.homedir()).toLowerCase();
  for (const sub of ['desktop', '桌面', 'documents', '文档', 'downloads', '下载', 'pictures', 'music', 'videos',
    'appdata', 'appdata\\local', 'appdata\\roaming', 'appdata\\locallow',
    'appdata\\local\\temp', 'onedrive']) {
    list.push(path.join(home, sub).toLowerCase());
  }
  return list;
}

/**
 * 这个路径能不能进回收站。
 * 返回 null 表示可以，否则返回拒绝原因。
 */
function unsafeReason(raw) {
  const s = String(raw || '').trim();
  // 必须是带盘符的绝对路径，相对路径一律不认（会被解析到软件自己目录下）
  if (!/^[a-zA-Z]:[\\/]/.test(s)) return '只处理带盘符的完整路径';

  const abs = path.resolve(s);
  const low = abs.toLowerCase();
  const segs = low.split('\\').filter(Boolean);
  if (segs.length < 2) return '不能删除盘符根目录';
  if (SYS_DIRS.includes(low)) return '这是系统目录';
  if (userRoots().includes(low)) return '这是用户或系统的根目录';
  if (PROTECTED_TREES.some(t => low === t || low.startsWith(t + '\\'))) return '这是受保护的系统目录';

  const cwd = path.resolve(process.cwd()).toLowerCase();
  if (low === cwd || low.startsWith(cwd + '\\')) return '这是软件自己的目录';
  return null;
}

/* ==================== 五、目录大小 ==================== */

const SIZE_PS = `
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
$r = @()
foreach ($p in $cfg.paths) {
  $s = [int64]0
  $n = 0
  # 不用 Get-ChildItem：它给每个文件造一个 PSObject 走管道，几万个文件能慢十倍。
  # 直接用 DirectoryInfo 枚举，拿到的就是 FileInfo，取 Length 是纯托管调用。
  $stack = New-Object 'System.Collections.Generic.Stack[string]'
  $stack.Push($p)
  while ($stack.Count -gt 0) {
    $d = $stack.Pop()
    try {
      $di = New-Object System.IO.DirectoryInfo $d
      foreach ($f in $di.GetFiles()) { $s += $f.Length; $n++ }
      foreach ($sub in $di.GetDirectories()) { $stack.Push($sub.FullName) }
    } catch {}
  }
  $r += [pscustomobject]@{ p = $p; s = [int64]$s; n = [int]$n }
}
Write-Output ($r | ConvertTo-Json -Compress)
`;

function dirSizes(paths) {
  const list = [...new Set((paths || []).filter(p => p && fs.existsSync(p)))];
  if (!list.length) return new Map();
  const payload = Buffer.from(JSON.stringify({ paths: list }), 'utf8').toString('base64');
  let raw = '';
  try { raw = win.runPS(SIZE_PS.replace('__PAYLOAD__', payload), { timeout: 120000 }); } catch { return new Map(); }
  let arr = [];
  try { arr = JSON.parse(raw); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [arr];
  const m = new Map();
  for (const x of arr) if (x && x.p) m.set(path.resolve(x.p).toLowerCase(), { size: Number(x.s) || 0, files: Number(x.n) || 0 });
  return m;
}

/* ==================== 六、残留候选 ==================== */

/** AppData / ProgramData 下的顶层目录清单（只看一层，很快） */
function appDataDirs() {
  const roots = [
    ['LocalAppData', process.env.LOCALAPPDATA],
    ['Roaming', process.env.APPDATA],
    ['ProgramData', process.env.ProgramData || 'C:\\ProgramData']
  ];
  const out = [];
  for (const [label, root] of roots) {
    if (!root || !fs.existsSync(root)) continue;
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      out.push({ label, root, name: e.name, path: path.join(root, e.name) });
    }
  }
  return out;
}

/**
 * 在 AppData/ProgramData 里找这个软件的残留目录。
 * 只有「名字对得上」才算候选，并且要标出是不是同厂商共用目录。
 */
function residualCandidates(app, apps) {
  const words = [];
  const push = w => {
    const b = bare(w);
    if (b && b.length >= 4 && !words.includes(b)) words.push(b);
  };
  push(app.name);
  push(app.pub);
  for (const d of app.dirs) push(path.basename(d.replace(/\//g, '\\')));
  // 名字里去掉常见后缀再试一次
  push(String(app.name).replace(/\s*(v?\d[\d.]*|x64|x86|64-bit|32-bit|\(.*?\))\s*$/i, ''));

  // 这个 Publisher 旗下还有别的软件吗？有的话它名下的目录就是共用目录
  const sameVendor = apps.filter(a => a.pubBare && app.pubBare && a.pubBare === app.pubBare && a.id !== app.id);

  const out = [];
  for (const d of appDataDirs()) {
    const nb = bare(d.name);
    if (!nb) continue;
    let hit = '';
    let level = 0;
    if (words.includes(nb)) { hit = '名字一致'; level = 2; }
    else if (words.some(w => nb.length >= 4 && w.length >= 4 && (nb.startsWith(w) || w.startsWith(nb)))) { hit = '名字相近'; level = 1; }
    if (!hit) continue;

    const vendorOnly = app.pubBare && nb === app.pubBare;
    const shared = vendorOnly && sameVendor.length > 0;
    out.push({
      path: d.path,
      label: d.label,
      name: d.name,
      how: hit,
      level,
      shared,
      sharedWith: shared ? sameVendor.slice(0, 4).map(a => a.name) : [],
      // 共用目录不给默认勾，让用户自己决定
      safe: level === 2 && !shared
    });
  }
  out.sort((a, b) => (b.level - a.level) || a.name.localeCompare(b.name, 'zh'));
  return out.slice(0, 14);
}

/** Documents 下的存档目录，单独拎出来只做警告，永不勾选 */
function saveDirs(app) {
  const docs = path.join(os.homedir(), 'Documents');
  if (!fs.existsSync(docs)) return [];
  let names = [];
  try { names = fs.readdirSync(docs, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; }
  const keys = [bare(app.name), app.pubBare].filter(k => k && k.length >= 4);
  if (!keys.length) return [];
  return names
    .filter(n => { const b = bare(n); return keys.some(k => b && (b.includes(k) || k.includes(b))); })
    .map(n => ({ path: path.join(docs, n), name: n }))
    .slice(0, 6);
}

/* ==================== 七、卸载计划 ==================== */

const plans = new Map();
const PLAN_TTL = 30 * 60 * 1000;

function prunePlans() {
  const now = Date.now();
  for (const [k, v] of plans) if (now - v.at > PLAN_TTL) plans.delete(k);
}

/** 解析 UninstallString，拆成 exe + 参数 */
function parseUninstall(app, preferQuiet) {
  const raw = String((preferQuiet && app.quiet) || app.uninst || '').trim();
  if (!raw) return null;
  if (/msiexec/i.test(raw)) {
    const g = raw.match(/\{[0-9A-F-]{36}\}/i);
    if (!g) return null;
    return { exe: 'msiexec.exe', args: ['/x', g[0], '/qb', '/norestart'], msi: true };
  }

  // "F:\steam\steam.exe" steam://uninstall/12345
  // 这是「让平台去处理」，不是这个软件的卸载程序。
  // 直接 spawn 会把 steam://... 当成文件名传给 Steam，什么都不会发生；
  // 必须交给 shell 的协议处理器（start "" "steam://..."）。
  const pm = raw.match(/^"?([A-Za-z]:[\\/][^"]+?)"?\s+([a-z][a-z0-9+.-]*:\/\/\S+)$/i);
  const protoOnly = raw.match(/^([a-z][a-z0-9+.-]*:\/\/\S+)$/i);
  if (pm && PLATFORM_EXE.test(norm(pm[1]).split('/').pop())) {
    return { exe: 'cmd.exe', args: ['/c', 'start', '', pm[2]], proto: pm[2], msi: false, platform: true };
  }
  if (protoOnly) {
    return { exe: 'cmd.exe', args: ['/c', 'start', '', protoOnly[1]], proto: protoOnly[1], msi: false, platform: true };
  }

  // "C:\path\unins000.exe" /S  →  exe + 其余参数
  let exe = '';
  let rest = '';
  const m = raw.match(/^"([^"]+)"\s*(.*)$/);
  if (m) { exe = m[1]; rest = m[2]; }
  else {
    const m2 = raw.match(/^(.+?\.exe)\s*(.*)$/i);
    if (m2) { exe = m2[1]; rest = m2[2]; }
    else { const sp = raw.indexOf(' '); exe = sp > 0 ? raw.slice(0, sp) : raw; rest = sp > 0 ? raw.slice(sp + 1) : ''; }
  }
  exe = exe.replace(/^"|"$/g, '').trim();
  const args = rest.match(/"[^"]*"|\S+/g)?.map(s => s.replace(/^"|"$/g, '')) || [];
  return { exe, args, msi: false };
}

/** 建一个卸载任务：算出会动哪些东西，先摊给用户看 */
function makePlan(body) {
  prunePlans();
  const wantId = String(body.appId || '').toLowerCase();
  let apps = listApps();
  let app = apps.find(a => a.id === wantId);
  if (!app) {
    // 缓存里没有：可能刚装完/刚卸完，刷新一次再找
    apps = listApps(true);
    app = apps.find(a => a.id === wantId);
  }
  if (!app) return { error: '找不到这个软件的卸载信息，可能已经卸载了' };

  const cmd = parseUninstall(app, !!body.quiet);
  if (!cmd) return { error: '这个软件没有提供卸载命令，可能需要手动处理' };

  // 安装目录：这里不算真实大小（Program Files 下的大目录递归统计要几十秒），
  // 先用注册表里的估算值，真正的体积等卸载完再量。
  const installDirs = (app.dirs || [])
    .map(d => d.replace(/\//g, '\\'))
    .filter(d => !junkDir(d) && fs.existsSync(d));
  const estSize = Number(app.size) || 0;

  // 快捷方式：只认前端报上来的、确实在桌面根目录里的那几个
  const desktopDirs = (body.desktops || []).map(d => path.resolve(d).toLowerCase());
  const lnkFiles = [];
  for (const raw of (body.lnkFiles || [])) {
    const abs = path.resolve(String(raw || ''));
    if (!/\.lnk$/i.test(abs)) continue;
    if (!desktopDirs.includes(path.dirname(abs).toLowerCase())) continue;
    if (!fs.existsSync(abs)) continue;
    lnkFiles.push(abs);
  }

  // AppData / ProgramData 候选：只列名字，不算大小
  const resid = residualCandidates(app, apps);

  const all = [];
  let seq = 0;
  const add = (o) => { all.push({ id: 'r' + (++seq), ...o }); };

  for (const f of lnkFiles) {
    add({
      kind: 'shortcut', path: f, label: path.basename(f),
      size: safeStat(f), files: 1,
      group: 'shortcut', defaultOn: true, safe: true,
      note: '卸载后就没用了'
    });
  }
  for (const d of installDirs) {
    add({
      kind: 'dir', path: d, label: path.basename(d.replace(/\\/g, '/')) || d,
      size: estSize, files: 0, sizeGuess: !!estSize,
      group: 'install', defaultOn: true, safe: true,
      note: '软件自己的安装目录'
    });
  }
  for (const r of resid) {
    add({
      kind: 'dir', path: r.path, label: `${r.label} · ${r.name}`,
      size: 0, files: 0, sizeUnknown: true,
      group: 'cache', defaultOn: false, safe: r.safe,
      note: r.shared ? `和 ${r.sharedWith.join('、')} 共用，删掉会影响它们` : `缓存/配置目录（${r.how}）`,
      shared: r.shared
    });
  }

  // 4. 注册表项：只展示
  const regKeys = [];
  if (app.msi) {
    const g = String(app.uninst).match(/\{[0-9A-F-]{36}\}/i);
    if (g) regKeys.push({ path: `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${g[0]}`, label: '卸载项（MSI）' });
  }
  regKeys.push({
    path: `${app.hive === 'HKCU' ? 'HKCU' : 'HKLM'}\\${app.hive === 'HKLM32'
      ? 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
      : 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'}\\${app.key}`,
    label: '卸载项'
  });

  const plan = {
    id: crypto.randomBytes(6).toString('hex'),
    at: Date.now(),
    app: {
      id: app.id, name: app.name, pub: app.pub, ver: app.ver,
      loc: app.loc, size: app.size, msi: app.msi,
      hasQuiet: !!app.quiet
    },
    cmd: { exe: cmd.exe, args: cmd.args, quiet: !!body.quiet },
    targets: all,
    regKeys,
    saves: saveDirs(app),
    lnkFile: body.lnkFile || (lnkFiles[0] || ''),
    status: 'planned',
    _appDirs: installDirs,
    // 卸载会不会成功，最硬的证据是这条注册表项有没有消失
    _regPath: `${app.hive === 'HKCU' ? 'HKCU:' : 'HKLM:'}\\${app.hive === 'HKLM32'
      ? 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
      : 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'}\\${app.key}`
  };
  plans.set(plan.id, plan);
  return { plan: publicPlan(plan) };
}

function publicPlan(p) {
  return {
    id: p.id,
    app: p.app,
    cmd: p.cmd,
    targets: p.targets,
    regKeys: p.regKeys,
    saves: p.saves,
    lnkFile: p.lnkFile,
    status: p.status,
    result: p.result || null
  };
}

/* ==================== 八、执行卸载 ==================== */

const RUNNING = new Map();   // planId -> { child, at }

/** 主 exe 还在不在（用来判断卸载有没有真的跑完） */
function stillThere(app) {
  const exes = [];
  for (const d of app.dirs) {
    const dd = d.replace(/\//g, '\\');
    if (!fs.existsSync(dd)) continue;
    let names = [];
    try { names = fs.readdirSync(dd); } catch { continue; }
    for (const n of names) if (/\.exe$/i.test(n)) exes.push(path.join(dd, n));
  }
  return exes.length;
}

/** 需要用管理员权限时，让系统弹 UAC 重新拉起 */
function elevateRun(exe, args) {
  const list = (args || []).map(a => `'${String(a).replace(/'/g, "''")}'`).join(',');
  const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
try {
  Start-Process -FilePath '${String(exe).replace(/'/g, "''")}' -ArgumentList @(${list}) -Verb RunAs
  Write-Output 'OK'
} catch { Write-Output ('ERR|' + $_.Exception.Message) }`;
  try {
    return win.runPS(ps, { timeout: 40000 }).trim().startsWith('OK');
  } catch { return false; }
}

function runPlan(planId, opts = {}) {
  const plan = plans.get(String(planId));
  if (!plan) return { error: '任务已过期，请重新打开这个软件' };
  if (plan.status === 'running') return { error: '这个卸载已经在进行中了' };

  const { exe, args } = plan.cmd;
  if (!exe) return { error: '没有可执行的卸载命令' };

  plan.status = 'running';
  plan.startedAt = Date.now();

  let child;
  try {
    child = spawn(exe, args || [], {
      detached: false,
      windowsHide: false,
      stdio: 'ignore'
    });
  } catch (e) {
    plan.status = 'failed';
    plan.result = { ok: false, error: '卸载程序启动失败：' + e.message };
    return { error: plan.result.error };
  }
  plan.pid = child.pid;
  RUNNING.set(plan.id, { child, at: Date.now() });

  child.on('exit', () => { /* 退出不代表卸完，交给 waitFor 判断 */ });
  child.on('error', (e) => {
    if (plan.status !== 'running') return;
    // 权限不够时 CreateProcess 会直接失败，换成 UAC 提权再来一次
    if (/EACCES|EPERM|ENOENT|UNKNOWN/i.test(String(e.code || '') + e.message)) {
      if (elevateRun(exe, args)) {
        plan.elevated = true;
        return;                       // waitFor 还在看着目录，让它继续判断
      }
    }
    plan.status = 'failed';
    plan.result = { ok: false, error: `卸载程序启动失败：${e.message}` };
  });

  waitFor(plan, child).catch(() => {
    plan.status = 'failed';
    plan.result = { ok: false, error: '等待卸载完成时出错' };
  });

  return { ok: true, planId: plan.id, pid: child.pid, cmd: `${exe} ${(args || []).join(' ')}` };
}

/**
 * 等卸载真正结束。
 * 不能只看进程退出 —— 卸载程序常常自己再起一个进程然后本尊先退。
 * 所以主要看安装目录里的 exe 有没有在减少、目录有没有消失。
 */
async function waitFor(plan, child) {
  const dirs = plan._appDirs || [];
  const before = stillThere({ dirs });
  const maxMs = 8 * 60 * 1000;
  const t0 = Date.now();
  let quiet = 0;

  if (!dirs.length) {
    // 连安装目录都不知道（只靠名字匹配上的），只能等进程，再兜底给 90 秒
    while (Date.now() - t0 < 90000) {
      await sleep(1500);
      if (plan.status !== 'running') return;
      if (childExited(child)) break;
    }
  } else {
    while (Date.now() - t0 < maxMs) {
      await sleep(2000);
      if (plan.status !== 'running') return;
      const grown = Date.now() - t0;
      const live = dirs.filter(d => fs.existsSync(d)).length;
      if (live === 0) break;                      // 安装目录整个没了
      const exes = stillThere({ dirs });
      if (before > 0 && exes === 0) break;        // 里面一个 exe 都不剩了
      if (exes < before) {                        // 在删，再确认一轮
        if (++quiet >= 2) break;
      } else {
        quiet = 0;
        // 进程早早退了、目录一动不动、已经过了 8 秒 → 多半是用户关了卸载向导
        if (childExited(child) && grown > 8000) break;
      }
    }
  }
  await sleep(1500);
  finishPlan(plan);
}

function childExited(child) {
  return child.exitCode !== null || child.killed;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 异步算目录体积，不阻塞服务（同步跑 PowerShell 会把整个 HTTP 服务卡住） */
function dirSizesAsync(paths) {
  return new Promise(resolve => {
    const list = [...new Set((paths || []).filter(p => p && fs.existsSync(p)))];
    if (!list.length) return resolve(new Map());
    const payload = Buffer.from(JSON.stringify({ paths: list }), 'utf8').toString('base64');
    const script = "$ProgressPreference='SilentlyContinue';" + SIZE_PS.replace('__PAYLOAD__', payload);
    execFile(win.psExe(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve(new Map());
        let arr = [];
        try { arr = JSON.parse(stdout); } catch { arr = []; }
        if (!Array.isArray(arr)) arr = arr ? [arr] : [];
        const m = new Map();
        for (const x of arr) if (x && x.p) m.set(path.resolve(x.p).toLowerCase(), { size: Number(x.s) || 0, files: Number(x.n) || 0 });
        resolve(m);
      });
  });
}

/** 卸载之后重新算一遍还剩什么 */
function finishPlan(plan) {
  const apps = listApps(true);
  RUNNING.delete(plan.id);
  plan.status = 'done';
  plan.endedAt = Date.now();

  const rows = [];
  const appDirs = plan._appDirs || [];

  // 原来的候选，挨个看还在不在
  for (const t of plan.targets) {
    const alive = fs.existsSync(t.path);
    const quick = t.kind === 'shortcut' ? safeStat(t.path) : 0;
    rows.push({
      id: t.id, kind: t.kind, group: t.group, path: t.path, label: t.label,
      note: t.note, shared: !!t.shared,
      exists: alive,
      // -1 表示「还在，体积待算」
      size: alive ? (t.kind === 'shortcut' ? quick : -1) : (t.size || 0),
      files: alive && t.kind === 'shortcut' ? 1 : 0,
      gone: !alive,
      defaultOn: alive && t.defaultOn && !t.shared
    });
  }

  // 再补一轮：卸载后才露出来的安装目录
  for (const d of appDirs) {
    const dd = d.replace(/\//g, '\\');
    if (!fs.existsSync(dd)) continue;
    if (rows.some(r => r.path.toLowerCase() === dd.toLowerCase())) continue;
    rows.push({
      id: 'x' + rows.length, kind: 'dir', group: 'install', path: dd,
      label: path.basename(dd), note: '卸载后还留着的目录',
      exists: true, size: -1, files: 0, gone: false, defaultOn: true, shared: false
    });
  }

  plan.result = {
    ok: true,
    rows,
    left: rows.filter(r => r.exists).length,
    freed: rows.filter(r => r.gone).reduce((s, r) => s + (r.size || 0), 0),
    sizing: true,
    at: Date.now()
  };
  invalidate();

  // 体积慢慢算，算完前端下次轮询就能看到
  (async () => {
    const pend = rows.filter(r => r.exists && r.size === -1);
    if (!pend.length) { plan.result.sizing = false; return; }
    const map = await dirSizesAsync(pend.map(r => r.path));
    for (const r of pend) {
      const st = map.get(path.resolve(r.path).toLowerCase());
      r.size = st ? st.size : 0;
      r.files = st ? st.files : 0;
      r.sizeUnknown = !st;
    }
    plan.result.sizing = false;
  })().catch(() => { plan.result.sizing = false; });
}

function safeStat(p) { try { return fs.statSync(p).size; } catch { return 0; } }

/* ==================== 八·五、批量卸载（一次勾选多个，逐个弹窗） ==================== */

const batches = new Map();
const BATCH_TTL = 3 * 60 * 60 * 1000;
const ONE_MAX_MS = 6 * 60 * 1000;
const UN_DEBUG = process.env.WB_UN_DEBUG === '1';
function dbg(...a) { if (UN_DEBUG) console.log('[batch]', ...a); }

/** 注册表项还在不在：true = 还在，false = 已经没了（卸载成功最硬的证据），null = 查不了 */
function regExistsAsync(psPath) {
  return new Promise(resolve => {
    if (!psPath) return resolve(null);
    const script = `if (Test-Path -LiteralPath '${String(psPath).replace(/'/g, "''")}') { 'Y' } else { 'N' }`;
    execFile(win.psExe(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
      (err, stdout) => {
        const t = String(stdout || '').trim();
        if (t.endsWith('Y')) return resolve(true);
        if (t.endsWith('N')) return resolve(false);
        resolve(null);
      });
  });
}

/** 安装目录里还有没有进程在跑（NSIS 那种 fork 出去的卸载器就靠这个认出来） */
function procsFromDirs(dirs) {
  return new Promise(resolve => {
    const list = (dirs || []).map(d => String(d).replace(/\//g, '\\').toLowerCase()).filter(Boolean);
    if (!list.length) return resolve(0);
    const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $_.ExecutablePath }`;
    execFile(win.psExe(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        let n = 0;
        for (const line of String(stdout || '').split(/\r?\n/)) {
          const p = line.trim().toLowerCase().replace(/\//g, '\\');
          if (!p) continue;
          if (list.some(d => p === d || p.startsWith(d + '\\'))) n++;
        }
        resolve(n);
      });
  });
}

function pruneBatches() {
  const now = Date.now();
  for (const [k, v] of batches) {
    if (v.state !== 'running' && now - v.at > BATCH_TTL) batches.delete(k);
  }
}

/**
 * 建一份待卸载清单（只算方案，不动手）。
 * 每一项都是一个软件，同一软件在桌面上有多个图标时合并成一条。
 */
function batchCreate(body) {
  pruneBatches();
  const items = [];
  const seen = new Set();

  for (const raw of (body.items || [])) {
    const appId = String((raw && raw.appId) || '').toLowerCase();
    if (!appId || seen.has(appId)) continue;
    seen.add(appId);

    const lnkFiles = Array.isArray(raw.lnkFiles) ? raw.lnkFiles.map(String) : [];
    const r = makePlan({ appId, lnkFiles, desktops: body.desktops });
    if (r.error) {
      items.push({
        appId, name: String(raw.name || appId), status: 'bad', msg: r.error,
        planId: '', iconUrl: String(raw.iconUrl || ''), file: String(raw.file || '')
      });
      continue;
    }
    const p = r.plan;
    items.push({
      appId,
      name: p.app.name,
      pub: p.app.pub,
      ver: p.app.ver,
      loc: p.app.loc,
      msi: !!p.app.msi,
      size: p.app.size || 0,
      iconUrl: String(raw.iconUrl || ''),
      file: String(raw.file || ''),
      lnkCount: lnkFiles.length || (p.lnkFile ? 1 : 0),
      residCount: (p.targets || []).filter(t => t.group === 'cache').length,
      saves: (p.saves || []).map(s => s.name),
      status: 'ready',
      msg: '',
      planId: p.id
    });
  }

  if (!items.length) return { error: '没有拿到可以卸载的软件，重新勾选一次' };
  const b = {
    id: crypto.randomBytes(5).toString('hex'),
    at: Date.now(),
    state: 'ready',
    index: -1,
    stop: false,
    items,
    startedAt: 0,
    endedAt: 0
  };
  batches.set(b.id, b);
  return { batch: snapshot(b) };
}

function batchSnapshot(id) {
  const b = batches.get(String(id));
  if (!b) return { error: '这份卸载清单已经过期，重新选一次' };
  return { batch: snapshot(b) };
}

function batchStart(id) {
  const b = batches.get(String(id));
  if (!b) return { error: '这份卸载清单已经过期，重新选一次' };
  if (b.state === 'running') return { error: '已经在卸载了，别急' };
  if (b.state !== 'ready') return { error: '这份清单已经跑过了，重新选一次' };
  if (!b.items.some(it => it.status === 'ready')) return { error: '清单里没有能卸载的软件' };

  b.state = 'running';
  b.startedAt = Date.now();
  b.index = -1;
  runBatch(b).catch(e => {
    b.state = 'done';
    b.error = e.message || '批量卸载出错了';
    b.endedAt = Date.now();
  });
  return { batch: snapshot(b) };
}

/** 停止：当前这个弹出来的卸载窗口不动它（卸一半强杀更糟），后面的不再弹 */
function batchStop(id) {
  const b = batches.get(String(id));
  if (!b) return { error: '这份卸载清单已经过期' };
  b.stop = true;
  for (const it of b.items) {
    if (it.status === 'ready') { it.status = 'skipped'; it.msg = '你按了停止，没有弹它的卸载窗口'; }
  }
  if (b.state === 'ready') { b.state = 'stopped'; b.endedAt = Date.now(); }
  return { batch: snapshot(b) };
}

/** 最近有没有被改过：还在删东西的卸载器会把目录 mtime 刷新的 */
function dirTouched(dirs, ms) {
  const now = Date.now();
  for (const d of dirs || []) {
    try {
      if (now - fs.statSync(d).mtimeMs < ms) return true;
    } catch { /* 目录没了就算没动 */ }
  }
  return false;
}

async function runBatch(b) {
  for (let i = 0; i < b.items.length; i++) {
    const it = b.items[i];
    if (b.stop) {
      if (it.status === 'ready') { it.status = 'skipped'; it.msg = '你按了停止，没有弹它的卸载窗口'; }
      continue;
    }
    if (it.status !== 'ready') continue;

    b.index = i;
    it.status = 'running';
    it.startedAt = Date.now();
    try {
      await runOne(b, it);
    } catch (e) {
      it.status = 'error';
      it.msg = e.message || '卸载时出错了';
      it.endedAt = Date.now();
    }
  }
  b.index = -1;
  b.state = b.stop ? 'stopped' : 'done';
  b.endedAt = Date.now();
  invalidate();
}

/**
 * 跑一个软件的卸载程序，然后判断这次到底卸掉了没有。
 *
 * 判定顺序（先硬后软）：
 *  1. 注册表卸载项消失  → 成功
 *  2. 安装目录消失 / 目录里 exe 全没了 → 成功
 *  3. 卸载程序已退出 + 注册表项还在 + 目录没变化 + 目录里没有进程 → 取消/失败
 */
async function runOne(b, it) {
  const plan = plans.get(String(it.planId));
  if (!plan) {
    it.status = 'error';
    it.msg = '卸载方案过期了，重新勾选一次';
    return;
  }

  const dirs = plan._appDirs || [];
  const before = stillThere({ dirs });
  const t0 = Date.now();
  plan.status = 'running';
  plan.startedAt = t0;

  let child = null;
  let childErr = '';
  let startFailed = false;
  try {
    child = spawn(plan.cmd.exe, plan.cmd.args || [], { windowsHide: false, stdio: 'ignore' });
    plan.pid = child.pid;
    child.on('error', (e) => {
      childErr = e.message || '启动失败';
      dbg('child error', childErr);
      // 权限不够时 CreateProcess 会直接失败，换成 UAC 提权再来一次
      if (!plan.elevated && /EACCES|EPERM|ENOENT|UNKNOWN/i.test(String(e.code || '') + childErr)) {
        if (elevateRun(plan.cmd.exe, plan.cmd.args || [])) {
          plan.elevated = true;
          it.msg = '已用管理员权限启动它的卸载程序';
          return;
        }
      }
      startFailed = true;
    });
  } catch (e) {
    childErr = e.message || '启动失败';
    startFailed = true;
  }
  if (!child) {
    // 权限不够时会直接失败，换成 UAC 提权重来一次
    if (elevateRun(plan.cmd.exe, plan.cmd.args || [])) {
      plan.elevated = true;
      it.msg = '已用管理员权限启动它的卸载程序';
    } else {
      plan.status = 'done';
      it.status = 'error';
      it.msg = `卸载程序没能启动：${childErr || '系统拒绝了'}`;
      it.endedAt = Date.now();
      return;
    }
  }

  let exitedAt = 0;
  let regAt = 0;
  let lastExes = before;
  let same = 0;
  let verdict = '';
  // MSI 的 /qb 会把活交给 msiexec 服务，本尊退得早、目录也可能几十秒不动，别急着判取消
  const cancelGate = plan.cmd.msi ? 60000 : 18000;

  dbg('run', it.name, 'dirs', dirs, 'before', before, 'cmd', plan.cmd.exe, JSON.stringify(plan.cmd.args), 'child', child && child.pid);

  while (true) {
    await sleep(1400);
    const elapsed = Date.now() - t0;

    if (dirs.length && dirs.every(d => !fs.existsSync(d))) { dbg('dirs gone'); verdict = 'ok'; break; }

    const exes = stillThere({ dirs });
    if (before > 0 && exes === 0) { dbg('no exe left'); verdict = 'ok'; break; }
    if (exes === lastExes) same++; else { lastExes = exes; same = 0; }

    const exited = !child || childExited(child);
    if (exited && !exitedAt) exitedAt = Date.now();
    // 进程根本没起来（被系统拒绝、路径没了）：别干等
    if (startFailed) { verdict = 'error'; break; }
    // 没有安装目录可看的时候，只能从开始计时
    const gate = exited ? Date.now() - exitedAt : (dirs.length ? 0 : elapsed);

    dbg('tick', Math.round(elapsed / 1000) + 's', 'exited', exited, 'gate', gate, 'exes', exes, 'err', childErr);

    if (gate > 2500 && Date.now() - regAt > 4000) {
      regAt = Date.now();
      const exists = await regExistsAsync(plan._regPath);
      dbg('reg exists =', exists);
      if (exists === false) { verdict = 'ok'; break; }
      if (exists === true && exited && gate > cancelGate && same >= 4 && !dirTouched(dirs, 90000)) {
        const live = await procsFromDirs(dirs);
        dbg('procs in dirs =', live);
        if (!live) { verdict = 'cancel'; break; }
      }
    }

    if (elapsed > ONE_MAX_MS) {
      const exists = await regExistsAsync(plan._regPath);
      verdict = exists === false ? 'ok' : 'timeout';
      break;
    }
  }

  // 「取消」这个结论下得重，落锤前再核一次注册表
  if (verdict === 'cancel') {
    const exists = await regExistsAsync(plan._regPath);
    if (exists === false) verdict = 'ok';
  }

  it.endedAt = Date.now();
  it.duration = it.endedAt - t0;
  invalidate();

  if (verdict === 'ok') {
    it.status = 'ok';
    it.msg = hintOk(dirs);
    try {
      finishPlan(plan);
      it.rows = plan.result.rows || [];
      it.left = plan.result.left || 0;
      it.sizing = !!plan.result.sizing;
    } catch { /* 收尾失败不影响卸载结论 */ }
  } else {
    plan.status = 'done';
    plan.result = { ok: false, rows: [], left: 0, freed: 0, sizing: false, at: Date.now() };
    it.status = verdict === 'timeout' ? 'timeout' : verdict === 'error' ? 'error' : 'cancel';
    it.msg = verdict === 'timeout'
      ? '等了 6 分钟还没结束，先跳过它继续下一个'
      : verdict === 'error'
        ? `卸载程序没能启动：${childErr || '系统拒绝了'}`
        : '卸载程序退出了，但软件还在 —— 多半是在向导里点了取消';
  }
}

function hintOk(dirs) {
  return dirs && dirs.length && dirs.every(d => !fs.existsSync(d))
    ? '安装目录也一起没了'
    : '已从系统里卸掉';
}

function snapshot(b) {
  const items = b.items.map(it => ({
    appId: it.appId,
    name: it.name,
    pub: it.pub || '',
    ver: it.ver || '',
    loc: it.loc || '',
    msi: !!it.msi,
    size: it.size || 0,
    iconUrl: it.iconUrl || '',
    file: it.file || '',
    lnkCount: it.lnkCount || 0,
    residCount: it.residCount || 0,
    saves: it.saves || [],
    status: it.status,
    msg: it.msg || '',
    planId: it.planId || '',
    duration: it.duration || 0,
    left: it.left || 0,
    sizing: !!it.sizing,
    rows: it.rows || null
  }));

  const counts = { ok: 0, cancel: 0, timeout: 0, error: 0, skipped: 0, bad: 0, ready: 0, running: 0 };
  for (const it of items) counts[it.status] = (counts[it.status] || 0) + 1;

  return {
    id: b.id,
    state: b.state,
    index: b.index,
    total: items.length,
    startedAt: b.startedAt || 0,
    endedAt: b.endedAt || 0,
    error: b.error || '',
    items,
    counts
  };
}

/* ==================== 九、清残留（回收站） ==================== */

const DEL_PS = `
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
Add-Type -AssemblyName Microsoft.VisualBasic
$ok = 0; $fail = 0
foreach ($p in $cfg.paths) {
  try {
    if (Test-Path -LiteralPath $p -PathType Container) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    }
    $ok++
  } catch {
    $fail++
    $b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p + ' :: ' + $_.Exception.Message))
    [Console]::Out.WriteLine('FAIL|' + $b)
  }
}
Write-Output ('DONE|' + $ok + '|' + $fail)
`;

/** 只能清这个 plan 里列过、且确实还存在的路径 */
function cleanResidual(planId, ids) {
  const plan = plans.get(String(planId));
  if (!plan) return { error: '任务已过期，请重新扫描一次残留' };
  if (plan.status !== 'done') return { error: '还没卸载完，先别清残留' };

  const want = new Set((ids || []).map(String));
  const picked = [];
  const refused = [];
  for (const row of (plan.result?.rows || [])) {
    if (!want.has(row.id)) continue;
    const reason = unsafeReason(row.path);
    if (reason) { refused.push({ path: row.path, reason }); continue; }
    if (!fs.existsSync(row.path)) continue;
    picked.push(row.path);
  }
  if (!picked.length) return { error: '选中的项目都已经不在了' };

  const payload = Buffer.from(JSON.stringify({ paths: picked }), 'utf8').toString('base64');
  let out = '';
  try { out = win.runPS(DEL_PS.replace('__PAYLOAD__', payload), { timeout: 180000 }); }
  catch (e) { return { error: '清理失败：' + e.message }; }

  const fails = [];
  let ok = 0;
  for (const line of String(out).split(/\r?\n/)) {
    if (line.startsWith('FAIL|')) {
      try { fails.push(Buffer.from(line.slice(5), 'base64').toString('utf8')); } catch { /* ignore */ }
    } else if (line.startsWith('DONE|')) {
      const p = line.split('|');
      ok = Number(p[1]) || 0;
    }
  }

  const cleaned = picked.filter(p => !fs.existsSync(p));
  plan.result.rows.forEach(r => { if (cleaned.includes(r.path)) r.exists = false; });
  plan.cleaned = (plan.cleaned || []).concat(cleaned);

  return { ok: true, cleaned: cleaned.length, failed: fails, refused };
}

/* ==================== 十、杂项 ==================== */

/** 在注册表编辑器里定位到某个键 */
function revealReg(keyPath) {
  const p = String(keyPath || '').trim();
  if (!/^(HKLM|HKCU)\\/i.test(p)) return { error: '不是合法的注册表路径' };
  const ps = String.raw`
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$target = '__KEY__'
try {
  $k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Applets\Regedit'
  if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
  Set-ItemProperty -Path $k -Name LastKey -Value $target -Force
  Get-Process regedit -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 200
  Start-Process regedit.exe
  Write-Output 'OK'
} catch { Write-Output ('ERR|' + $_.Exception.Message) }
`.replace('__KEY__', p.replace(/'/g, "''"));
  try {
    const r = win.runPS(ps, { timeout: 20000 }).trim();
    if (!r.startsWith('OK')) return { error: r.replace(/^ERR\|/, '') || '打不开注册表编辑器' };
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

/** 在资源管理器里打开 */
function revealPath(p) {
  const abs = path.resolve(String(p || ''));
  if (!fs.existsSync(abs)) return { error: '这个位置已经不在了' };
  try {
    spawn('explorer.exe', ['/select,', abs], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

function getStatus(planId) {
  const plan = plans.get(String(planId));
  if (!plan) return { error: '任务已过期' };
  const appDirs = plan._appDirs || [];
  return {
    status: plan.status,
    pid: plan.pid || 0,
    running: plan.status === 'running',
    dirsAlive: appDirs.filter(d => fs.existsSync(d)).length,
    dirsTotal: appDirs.length,
    elapsed: plan.startedAt ? Date.now() - plan.startedAt : 0,
    result: plan.status === 'done' ? plan.result : null
  };
}

module.exports = {
  listApps, listAll, invalidate, scanDesktop, matchTarget,
  makePlan, runPlan, getStatus, cleanResidual,
  batchCreate, batchStart, batchSnapshot, batchStop,
  revealReg, revealPath, unsafeReason, dirSizes, dirSizesAsync, residualCandidates,
  _plans: plans, _batches: batches
};

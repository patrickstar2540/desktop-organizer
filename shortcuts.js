'use strict';
/**
 * 桌面上 .lnk / .url 元数据扫描
 *
 * 只读：列出桌面上的快捷方式，读出每个指向哪里、发布者是谁。
 * 不修改、不删除任何文件。
 */
const fs = require('fs');
const path = require('path');
const win = require('./winutil');

const SCRIPT = `
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ProgressPreference='SilentlyContinue'
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
$ws = New-Object -ComObject WScript.Shell
$res = New-Object System.Collections.ArrayList
foreach ($f in $cfg.files) {
  $ext = [IO.Path]::GetExtension($f).ToLower()
  $t = ''; $url = ''
  if ($ext -eq '.url') {
    try {
      $txt = [IO.File]::ReadAllText($f)
      if ($txt -match 'URL=([^\\r\\n]+)') { $url = $Matches[1].Trim() }
    } catch { }
  } else {
    try { $sc = $ws.CreateShortcut($f); $t = [string]$sc.TargetPath } catch { }
  }
  $co = ''; $prod = ''; $exists = $false; $isDir = $false
  if ($t) {
    if ([IO.Directory]::Exists($t)) { $exists = $true; $isDir = $true }
    elseif ([IO.File]::Exists($t)) {
      $exists = $true
      try {
        $vi = (Get-Item -LiteralPath $t -ErrorAction Stop).VersionInfo
        $co = [string]$vi.CompanyName
        $prod = [string]$vi.ProductName
      } catch { }
    }
  }
  [void]$res.Add([pscustomobject]@{ file = $f; target = $t; url = $url; company = $co; product = $prod; exists = $exists; isDir = $isDir })
}
ConvertTo-Json -InputObject @($res) -Compress -Depth 3
`;

/**
 * 列出桌面上的快捷方式文件（不含隐藏/临时文件）
 *
 * 桌面上的图标其实来自两个目录：当前用户桌面 + 公共桌面（C:\Users\Public\Desktop），
 * 后者装的是「所有用户」的快捷方式（Steam、微信、Chrome 之类常常在这里）。
 * 只扫用户桌面的话，这些图标会被当成"障碍物"留在原地 —— 表现为整理完中间还剩一堆。
 *
 * @param {string|string[]} dirs 一个或多个桌面目录，靠前的优先（同名以先出现的为准）
 */
function listShortcutFiles(dirs) {
  const list = Array.isArray(dirs) ? dirs.filter(Boolean) : [dirs].filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const dir of list) {
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
      const name = path.basename(e.name, path.extname(e.name));
      // 两个桌面同名的快捷方式，桌面只会显示一个，这里也只算一个
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({ file: path.join(dir, e.name), name, ext });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return out;
}

/** 批量读取指向与发布者信息 */
function scanMeta(list) {
  if (!list.length) return list;
  const payload = Buffer.from(JSON.stringify({ files: list.map(x => x.file) }), 'utf8').toString('base64');
  let raw;
  try {
    raw = win.runPS(SCRIPT.replace('__PAYLOAD__', payload), { timeout: 120000 });
  } catch (e) {
    for (const it of list) {
      it.target = ''; it.url = ''; it.company = ''; it.product = '';
      it.exists = false; it.isDir = false;
    }
    return list;
  }
  let parsed = [];
  try {
    const t = String(raw).trim();
    if (t) parsed = JSON.parse(t);
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) parsed = [parsed];
  const byFile = new Map();
  for (const p of parsed) {
    if (p && p.file) byFile.set(String(p.file).toLowerCase(), p);
  }
  for (const it of list) {
    const p = byFile.get(it.file.toLowerCase()) || {};
    it.target = p.target || '';
    it.url = p.url || '';
    it.company = p.company || '';
    it.product = p.product || '';
    it.exists = !!p.exists;
    it.isDir = !!p.isDir;
  }
  return list;
}

/** 桌面图标显示名 → 快捷方式（用于把图标和文件对上） */
function stemOf(fileName) {
  return path.basename(fileName, path.extname(fileName));
}

module.exports = { listShortcutFiles, scanMeta, stemOf };

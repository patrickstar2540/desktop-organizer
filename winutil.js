'use strict';
/**
 * Windows 原生能力封装（全部带降级方案）
 * - 读取真实桌面路径（兼容 OneDrive 重定向）
 * - 读取隐藏/系统文件名单
 * - 创建 .lnk 快捷方式（降级：目录联接 -> .url）
 * - 系统原生的"选择文件夹"对话框
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * powershell.exe 的绝对路径（只解析一次）
 *
 * 正常情况下 PATH 里就有 powershell，直接按名字调也能成。但 PATH 被改坏的机器
 * （装过一堆开发工具、或者被安全软件清过）会直接 ENOENT，整套识别就全废，
 * 而 PowerShell 的位置是固定的，按系统目录找比信任 PATH 稳。
 * Sysnative 那个是给「32 位进程跑在 64 位系统上」用的：那时访问 System32
 * 会被重定向到 SysWOW64，走 Sysnative 才拿得到真正的 64 位目录。
 */
let PS_EXE = null;
function psExe() {
  if (PS_EXE) return PS_EXE;
  const windir = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(windir, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { PS_EXE = c; return PS_EXE; }
  }
  PS_EXE = 'powershell.exe';
  return PS_EXE;
}

function runPS(script, opts = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  if (opts.sta) args.push('-STA');
  args.push('-EncodedCommand', Buffer.from("$ProgressPreference='SilentlyContinue';" + script, 'utf16le').toString('base64'));
  return execFileSync(psExe(), args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeout || 120000,
    maxBuffer: 8 * 1024 * 1024
  }) || '';
}

/** 真实桌面路径 */
function getDesktopPath() {
  try {
    const out = runPS("[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Environment]::GetFolderPath('Desktop')", { timeout: 15000 }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch { /* 降级 */ }
  const candidates = [];
  if (process.env.OneDrive) candidates.push(path.join(process.env.OneDrive, 'Desktop'), path.join(process.env.OneDrive, '桌面'));
  candidates.push(path.join(process.env.USERPROFILE || os.homedir(), 'Desktop'));
  candidates.push(path.join(process.env.USERPROFILE || os.homedir(), '桌面'));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return path.join(os.homedir(), 'Desktop');
}

/** 隐藏 / 系统属性文件名单 */
function getHiddenNames(dir) {
  const set = new Set();
  try {
    const out = runPS(
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
      `Get-ChildItem -LiteralPath ${psQuote(dir)} -Force -ErrorAction SilentlyContinue | ` +
      "Where-Object { $_.Attributes -match 'Hidden|System' } | ForEach-Object { $_.Name }",
      { timeout: 20000 }
    );
    for (const line of out.split(/\r?\n/)) {
      const n = line.trim();
      if (n) set.add(n);
    }
  } catch { /* 拿不到就靠黑名单兜底 */ }
  return set;
}

/** 创建标准 .lnk 快捷方式 */
function createLnk(lnkPath, opts = {}) {
  const { target, args, workingDir, icon, desc } = opts;
  let script = "$ErrorActionPreference='Stop';$ws = New-Object -ComObject WScript.Shell;" +
    `$s = $ws.CreateShortcut(${psQuote(lnkPath)});` +
    `$s.TargetPath = ${psQuote(target)};`;
  if (args) script += `$s.Arguments = ${psQuote(args)};`;
  if (workingDir) script += `$s.WorkingDirectory = ${psQuote(workingDir)};`;
  if (icon) script += `$s.IconLocation = ${psQuote(icon)};`;
  if (desc) script += `$s.Description = ${psQuote(desc)};`;
  script += "$s.Save();";
  runPS(script, { timeout: 30000 });
  if (!fs.existsSync(lnkPath)) throw new Error('快捷方式未能生成');
  return lnkPath;
}

/** 创建指向文件夹的快捷方式 */
function createFolderShortcut(lnkPath, targetPath, description) {
  // 方案一：标准 .lnk
  try {
    createLnk(lnkPath, {
      target: targetPath,
      workingDir: targetPath,
      desc: description || '打开整理后的文件夹'
    });
    return 'lnk';
  } catch { /* 降级 */ }

  // 方案二：目录联接（无管理员权限也可用）
  try {
    fs.symlinkSync(targetPath, lnkPath, 'junction');
    return 'junction';
  } catch { /* 降级 */ }

  // 方案三：.url 文件
  try {
    const urlPath = lnkPath.replace(/\.lnk$/i, '.url');
    const fileUrl = 'file:///' + targetPath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
    fs.writeFileSync(urlPath, `[InternetShortcut]\r\nURL=${fileUrl}\r\n`, 'utf8');
    return 'url';
  } catch (e) {
    throw new Error('创建快捷方式失败：' + e.message);
  }
}

/** 原生选择文件夹对话框，取消时返回空串 */
function pickFolder(defaultPath, title) {
  const script = `
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.Size = New-Object System.Drawing.Size(1,1)
$owner.StartPosition = 'CenterScreen'
$owner.Opacity = 0
$owner.Show()
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = ${psQuote(title || '请选择文件夹')}
$dlg.ShowNewFolderButton = $true
${defaultPath ? `$dlg.SelectedPath = ${psQuote(defaultPath)}` : ''}
$res = $dlg.ShowDialog($owner)
$owner.Close()
if ($res -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }
`;
  const out = runPS(script, { sta: true, timeout: 300000 }).trim();
  return out;
}

/**
 * 强制资源管理器重绘桌面。
 * 为什么需要：跨磁盘移动是「复制到新盘 + 删除桌面原件」，
 * 一次性删除大量项时 Explorer 的目录变更通知会丢，导致
 * 文件其实已经不在了、桌面上却还留着图标，双击报「位置不可用」。
 * 这里双保险：SHChangeNotify 广播变更 + 对桌面视图发刷新命令（等价右键→刷新）。
 *
 * @param {{deleted?: Array<{path:string,isDir?:boolean}>, dirs?: string[]}} opts
 */
function refreshShell(opts = {}) {
  const deleted = (opts.deleted || []).filter(x => x && x.path);
  const dirs = (opts.dirs || []).filter(Boolean);
  const payload = Buffer.from(JSON.stringify({ deleted, dirs }), 'utf8').toString('base64');

  const script = `
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json

if (-not ('WB.ShellApi' -as [type])) {
Add-Type -Namespace WB -Name ShellApi -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shell32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern void SHChangeNotify(int eventId, uint flags, string item1, string item2);
'@
Add-Type -Namespace WB -Name DeskView -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern IntPtr FindWindow(string cls, string win);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string win);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
public static IntPtr DefView() {
  IntPtr pm = FindWindow("Progman", null);
  IntPtr dv = FindWindowEx(pm, IntPtr.Zero, "SHELLDLL_DefView", null);
  if (dv != IntPtr.Zero) return dv;
  IntPtr w = IntPtr.Zero;
  while ((w = FindWindowEx(IntPtr.Zero, w, "WorkerW", null)) != IntPtr.Zero) {
    IntPtr d = FindWindowEx(w, IntPtr.Zero, "SHELLDLL_DefView", null);
    if (d != IntPtr.Zero) return d;
  }
  return IntPtr.Zero;
}
'@
}

$SHCNE_DELETE = 0x00000004
$SHCNE_RMDIR = 0x00000010
$SHCNE_UPDATEDIR = 0x00001000
$SHCNE_ASSOCCHANGED = 0x08000000
$SHCNF_PATHW = 0x0005
$SHCNF_IDLIST = 0x0000
$SHCNF_FLUSH = 0x1000

foreach ($d in $cfg.deleted) {
  $ev = if ($d.isDir) { $SHCNE_RMDIR } else { $SHCNE_DELETE }
  [WB.ShellApi]::SHChangeNotify($ev, ($SHCNF_PATHW -bor $SHCNF_FLUSH), $d.path, $null)
}
foreach ($p in $cfg.dirs) {
  [WB.ShellApi]::SHChangeNotify($SHCNE_UPDATEDIR, ($SHCNF_PATHW -bor $SHCNF_FLUSH), $p, $null)
}
[WB.ShellApi]::SHChangeNotify($SHCNE_ASSOCCHANGED, ($SHCNF_IDLIST -bor $SHCNF_FLUSH), $null, $null)

# 等价于在桌面空白处右键 -> 刷新
$dv = [WB.DeskView]::DefView()
if ($dv -ne [IntPtr]::Zero) {
  [void][WB.DeskView]::SendMessage($dv, 0x0111, [IntPtr]0x7103, [IntPtr]::Zero)
  'REFRESH=OK'
} else {
  'REFRESH=NO_DEFVIEW'
}
`;

  try {
    const out = runPS(script, { timeout: 45000 });
    return { ok: /REFRESH=OK/.test(out), raw: out.trim() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 主屏的可用区域（已经扣掉任务栏），并把系统缩放换算回浏览器的 CSS 像素。
 * 4K 屏开 150% 缩放时物理宽是 3840，但浏览器只有 2560 个 CSS 像素可用，
 * 不换算的话窗口会开到屏幕外面去。
 */
function screenBox() {
  const fallback = { w: 0, h: 0, x: 0, y: 0, scale: 1 };
  try {
    const out = runPS(
      'Add-Type -AssemblyName System.Windows.Forms;' +
      'Add-Type -AssemblyName System.Drawing;' +
      '$a=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea;' +
      '$g=[System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero);' +
      '$d=96; if($g -ne $null){ $d=$g.DpiX };' +
      'Write-Output ($a.Width.ToString()+"|"+$a.Height.ToString()+"|"+$a.X.ToString()+"|"+$a.Y.ToString()+"|"+$d.ToString())',
      { timeout: 20000 }
    ).trim();
    const parts = out.split('|').map(v => Number(String(v).trim()));
    if (parts.length >= 4 && parts.slice(0, 4).every(Number.isFinite) && parts[0] > 0 && parts[1] > 0) {
      const dpi = parts[4] > 48 ? parts[4] : 96;
      const scale = dpi / 96;
      return {
        w: Math.round(parts[0] / scale),
        h: Math.round(parts[1] / scale),
        x: Math.round(parts[2] / scale),
        y: Math.round(parts[3] / scale),
        scale
      };
    }
  } catch { /* 拿不到就交给调用方用默认尺寸 */ }
  return fallback;
}

/** 在资源管理器中打开路径 */
function openInExplorer(target) {
  const { spawn } = require('child_process');
  const p = fs.existsSync(target) ? target : path.dirname(target);
  spawn('explorer.exe', [p], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

module.exports = {
  getDesktopPath, getHiddenNames, createLnk, createFolderShortcut,
  pickFolder, openInExplorer, refreshShell, runPS, psExe, screenBox
};

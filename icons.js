'use strict';
/**
 * 桌面快捷方式真实图标提取
 *
 * 用 Windows Shell 的 IShellItemImageFactory 取 256px 图标（和桌面显示的一致），
 * 再借 WPF 编码成保留透明通道的 PNG，落盘到 data/icon-cache 里做缓存。
 * 全部是只读操作：只读取图标，不碰快捷方式本身。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const win = require('./winutil');

const ICON_SIZE = 256;
const MAX_BATCH = 40;
/** 缓存版本：提取算法变化时递增，会自动清掉旧图重新生成 */
const CACHE_VER = '2';

const SCRIPT = `
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
try { Add-Type -AssemblyName PresentationCore | Out-Null } catch { }
try { Add-Type -AssemblyName WindowsBase | Out-Null } catch { }
try { Add-Type -AssemblyName System.Drawing | Out-Null } catch { }

$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json

if (-not ('WBShortcutIcon' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WBShortcutIcon
{
    [StructLayout(LayoutKind.Sequential)]
    public struct SIZE { public int cx; public int cy; public SIZE(int x, int y) { cx = x; cy = y; } }

    [ComImport]
    [Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItemImageFactory
    {
        [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr hObject);

    // 找出“真正有图案”的范围。
    // 坑：很多 .ico 的 256 画布上，图案只占中间一小块，四周是大片透明 + 一层很淡的阴影
    // （alpha 30~80，铺满整个画布）。如果只按 alpha>0 取包围盒，量出来永远是 100%，
    // 于是图标被整体缩小，看起来就“小得离谱”。所以这里只看“实心”（alpha>=140）的像素。
    // 另外像“白底卡片 + 中间小 logo”这种，四边主色是白的，跳过主色也能收紧。
    static void AddBorder(byte[] px, int w, int x, int y, int[] cnt, ref int total)
    {
        int i = (y * w + x) * 4;
        total++;
        int a = px[i + 3];
        if (a < 200) { cnt[32768]++; return; }   // 淡阴影/半透明边缘不算“底色”
        int key = ((px[i + 2] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i] >> 3);
        cnt[key]++;
    }

    public static int[] TrimBox(byte[] px, int w, int h)
    {
        // 32768 是「透明/半透明」专用格；255,255,255 量化后的键正好是 32767，不能混用
        int[] cnt = new int[32769];
        int total = 0;
        for (int x = 0; x < w; x++)
        {
            AddBorder(px, w, x, 0, cnt, ref total);
            if (h > 1) AddBorder(px, w, x, h - 1, cnt, ref total);
        }
        for (int y = 0; y < h; y++)
        {
            AddBorder(px, w, 0, y, cnt, ref total);
            if (w > 1) AddBorder(px, w, w - 1, y, cnt, ref total);
        }

        int best = 0, bestKey = -1;
        for (int k = 0; k < 32768; k++) if (cnt[k] > best) { best = cnt[k]; bestKey = k; }

        bool hasBg = bestKey >= 0 && best * 100.0 / Math.Max(1, total) >= 55.0;
        int bgB = 0, bgG = 0, bgR = 0;
        if (hasBg)
        {
            bgR = ((bestKey >> 10) & 31) << 3;
            bgG = ((bestKey >> 5) & 31) << 3;
            bgB = (bestKey & 31) << 3;
        }

        int minX = w, minY = h, maxX = -1, maxY = -1;
        for (int y = 0; y < h; y++)
        {
            int off = y * w * 4;
            for (int x = 0; x < w; x++)
            {
                int i = off + x * 4;
                if (px[i + 3] < 140) continue;
                if (hasBg)
                {
                    int d = Math.Abs(px[i] - bgB) + Math.Abs(px[i + 1] - bgG) + Math.Abs(px[i + 2] - bgR);
                    if (d <= 40) continue;
                }
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
        return new int[] { minX, minY, maxX, maxY };
    }

    public static IntPtr Get(string path, int size, out int hr)
    {
        IShellItemImageFactory f = null;
        hr = -1;
        try
        {
            SHCreateItemFromParsingName(path, IntPtr.Zero, new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), out f);
            IntPtr h;
            hr = f.GetImage(new SIZE(size, size), 0x04 | 0x01 | 0x100, out h);
            if (hr != 0) return IntPtr.Zero;
            return h;
        }
        catch (Exception e)
        {
            hr = Marshal.GetHRForException(e);
            return IntPtr.Zero;
        }
    }
}
'@
}

# 裁掉“白底/透明留白”，让图案占满画布：解决图标大小看起来参差不齐的问题
function Try-Trim([string]$file, $src) {
  try {
    $conv = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap
    $conv.BeginInit()
    $conv.Source = $src
    $conv.DestinationFormat = [System.Windows.Media.PixelFormats]::Bgra32
    $conv.EndInit()

    $w = $conv.PixelWidth
    $h = $conv.PixelHeight
    $stride = $w * 4
    $px = New-Object byte[] ($stride * $h)
    $conv.CopyPixels($px, $stride, 0)

    $box = [WBShortcutIcon]::TrimBox($px, $w, $h)
    $minX = $box[0]; $minY = $box[1]; $maxX = $box[2]; $maxY = $box[3]
    if ($maxX -lt 0) { return $false }

    $bw = $maxX - $minX + 1
    $bh = $maxY - $minY + 1
    $ratio = [math]::Max($bw, $bh) / [math]::Max($w, $h)
    # 本来就已经铺满（>=86%）就不动，避免把正常图标放大得失真
    if ($ratio -ge 0.86) { return $false }

    $pad = [int][math]::Round([math]::Max($bw, $bh) * 0.05)
    $x = [math]::Max(0, $minX - $pad)
    $y = [math]::Max(0, $minY - $pad)
    $cw = [math]::Min($w - $x, $bw + $pad * 2)
    $ch = [math]::Min($h - $y, $bh + $pad * 2)
    if ($cw -lt 8 -or $ch -lt 8) { return $false }

    $rect = New-Object System.Windows.Int32Rect($x, $y, $cw, $ch)
    $crop = New-Object System.Windows.Media.Imaging.CroppedBitmap($src, $rect)
    $crop.Freeze()

    $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
    $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($crop))
    $fs = [IO.File]::Create($file)
    try { $enc.Save($fs) } finally { $fs.Close() }
    return $true
  } catch { return $false }
}

function Save-Png([IntPtr]$hbm, [string]$out) {
  $done = $false
  # 优先走 WPF 编码：能保留 PNG 的透明通道，图标边缘不会出现黑框
  try {
    $src = [System.Windows.Interop.Imaging]::CreateBitmapSourceFromHBitmap(
      $hbm, [IntPtr]::Zero, [System.Windows.Int32Rect]::Empty,
      [System.Windows.Media.Imaging.BitmapSizeOptions]::FromEmptyOptions())
    $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
    $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($src))
    $fs = [IO.File]::Create($out)
    try { $enc.Save($fs) } finally { $fs.Close() }
    [void](Try-Trim $out $src)
    $done = $true
  } catch { $done = $false }
  if ($done) { return $true }
  # 兜底：GDI+（透明会变白底，但至少图标是对的）
  try {
    $bmp = [System.Drawing.Bitmap]::FromHbitmap($hbm)
    try { $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $bmp.Dispose() }
    return $true
  } catch { return $false }
}

$done = New-Object System.Collections.ArrayList
$fail = New-Object System.Collections.ArrayList
foreach ($it in $cfg.items) {
  $hr = 0
  $h = [IntPtr]::Zero
  try { $h = [WBShortcutIcon]::Get($it.f, [int]$cfg.size, [ref]$hr) } catch { }
  if ($h -eq [IntPtr]::Zero) {
    [void]$fail.Add([pscustomobject]@{ k = $it.k; msg = "GetImage $hr" })
    continue
  }
  try {
    if (Save-Png $h $it.o) { [void]$done.Add($it.k) }
    else { [void]$fail.Add([pscustomobject]@{ k = $it.k; msg = 'save failed' }) }
  } catch {
    [void]$fail.Add([pscustomobject]@{ k = $it.k; msg = $_.Exception.Message })
  } finally {
    [void][WBShortcutIcon]::DeleteObject($h)
  }
}
ConvertTo-Json -InputObject ([pscustomobject]@{ done = @($done); fail = @($fail) }) -Compress -Depth 4
`;

/** 图标缓存键：只看路径，同一路径换了内容用 mtime 判断过期 */
function keyFor(file) {
  return crypto.createHash('sha1').update(String(file).toLowerCase(), 'utf8').digest('hex').slice(0, 20);
}

function iconUrl(key) {
  return '/icons/' + key + '.png?v=' + CACHE_VER;
}

function iconPath(cacheDir, key) {
  return path.join(cacheDir, key + '.png');
}

/** 缓存是否可用（存在且不比快捷方式旧） */
function isCached(cacheDir, key, srcFile) {
  const p = iconPath(cacheDir, key);
  try {
    const a = fs.statSync(p);
    if (!a.size) return false;
    const b = fs.statSync(srcFile);
    return a.mtimeMs >= b.mtimeMs;
  } catch { return false; }
}

/**
 * 一次性把一堆路径塞进 -EncodedCommand 会撞上 Windows 命令行 32767 字符的上限
 * （表现是 spawn ENAMETOOLONG，且整个批次静默失败），所以按实际字节数自动分批。
 */
const CMD_LIMIT = 30000;

function encodeCmd(items) {
  const b64 = Buffer.from(JSON.stringify({ size: ICON_SIZE, items }), 'utf8').toString('base64');
  return Buffer.from("$ProgressPreference='SilentlyContinue';" + SCRIPT.replace('__PAYLOAD__', b64), 'utf16le').toString('base64');
}

/** 按“真实编码后的命令长度”分批，保证每批都在 Windows 命令行上限内 */
function splitBatches(items) {
  const groups = [];
  let cur = [];
  for (const it of items) {
    cur.push(it);
    if (encodeCmd(cur).length <= CMD_LIMIT) continue;
    cur.pop();
    if (cur.length) groups.push(cur);
    cur = [it];
  }
  if (cur.length) groups.push(cur);
  if (process.env.WB_ICON_DEBUG) {
    console.error('[icons] split groups=' + groups.length + ' sizes=' + groups.map(g => g.length).join(','));
  }
  return groups;
}

function runOne(items) {
  return new Promise((resolve) => {
    const payload = { size: ICON_SIZE, items };
    const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const script = SCRIPT.replace('__PAYLOAD__', b64);
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from("$ProgressPreference='SilentlyContinue';" + script, 'utf16le').toString('base64')];
    try {
      execFile(win.psExe(), args, { windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (process.env.WB_ICON_DEBUG) {
            console.error('[icons] items=' + items.length, 'cmdLen=' + args[args.length - 1].length,
              'err=' + (err && err.message), 'stderr=' + String(stderr || '').slice(0, 300),
              'stdoutLen=' + String(stdout || '').length);
          }
          if (err && !stdout) return resolve({ ok: false, error: err.message, done: [], fail: [] });
          try {
            const t = String(stdout || '').trim();
            const j = t ? JSON.parse(t.slice(t.indexOf('{'))) : {};
            resolve({ ok: true, done: j.done || [], fail: j.fail || [] });
          } catch (e) {
            resolve({ ok: false, error: '解析图标结果失败', done: [], fail: [] });
          }
        });
    } catch (e) {
      if (process.env.WB_ICON_DEBUG) console.error('[icons] spawn throw items=' + items.length, e.message, 'b64len=' + args[args.length - 1].length);
      resolve({ ok: false, error: e.message, done: [], fail: [] });
    }
  });
}

async function runExtract(items) {
  const groups = splitBatches(items);
  const done = [];
  const fail = [];
  let ok = true;
  for (const g of groups) {
    const r = await runOne(g);
    if (!r.ok) {
      ok = false;
      for (const it of g) fail.push({ k: it.k, msg: r.error || 'extract failed' });
      continue;
    }
    for (const k of r.done) done.push(k);
    for (const f of r.fail) fail.push(f);
  }
  return { ok, done, fail };
}

/**
 * 批量提取图标（只处理缺缓存/过期的）
 * @param {Array<{file:string,key?:string}>} items
 * @param {string} cacheDir
 * @returns {Promise<{ok:boolean, icons:Object<string,string>, done:string[], failed:string[], error?:string}>}
 */
const inflight = new Set();

/** 版本变化时清空图标缓存（只是缓存文件，快捷方式不受影响） */
function ensureCacheVer(cacheDir) {
  const f = path.join(cacheDir, '.ver');
  try {
    if (fs.readFileSync(f, 'utf8').trim() === CACHE_VER) return;
  } catch { /* 没有版本文件，当作旧缓存 */ }
  try {
    for (const n of fs.readdirSync(cacheDir)) {
      if (n.toLowerCase().endsWith('.png')) fs.unlinkSync(path.join(cacheDir, n));
    }
    fs.writeFileSync(f, CACHE_VER);
  } catch { /* 清不掉就沿用旧缓存，最多图标大小不齐 */ }
}

/**
 * 批量提取图标。
 * 除了桌面快捷方式（.lnk/.url），也接受 .exe / .ico —— 「所有已安装软件」
 * 的图标来自注册表 DisplayIcon，是程序或图标文件本身。
 */
async function ensureIcons(items, cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });
  ensureCacheVer(cacheDir);
  const icons = {};
  const todo = [];
  const seen = new Set();

  for (const raw of items.slice(0, MAX_BATCH)) {
    const file = String(raw && raw.file || '').replace(/,\s*-?\d+\s*$/, '').trim();
    if (!file) continue;
    const ext = path.extname(file).toLowerCase();
    if (!['.lnk', '.url', '.exe', '.ico', '.dll'].includes(ext)) continue;
    const key = raw.key || keyFor(file);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isCached(cacheDir, key, file)) { icons[key] = iconUrl(key); continue; }
    if (inflight.has(key)) continue;
    if (!fs.existsSync(file)) continue;
    todo.push({ k: key, f: file, o: iconPath(cacheDir, key) });
  }

  if (!todo.length) return { ok: true, icons, done: [], failed: [] };

  for (const t of todo) inflight.add(t.k);
  let r;
  try {
    r = await runExtract(todo);
  } finally {
    for (const t of todo) inflight.delete(t.k);
  }
  for (const k of r.done || []) {
    const p = iconPath(cacheDir, k);
    if (fs.existsSync(p)) icons[k] = iconUrl(k);
  }
  return {
    ok: true,
    icons,
    done: r.done || [],
    failed: (r.fail || []).map(x => (x && x.k) || String(x)),
    partial: !!(r.fail && r.fail.length)
  };
}

module.exports = { keyFor, iconPath, isCached, ensureIcons, ICON_SIZE, CACHE_VER };

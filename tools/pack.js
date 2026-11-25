'use strict';
/**
 * 打包成可分享的 zip
 *
 * 这个软件没有构建步骤（纯 Node 内置模块，零依赖），所谓打包就是：
 * 把源码 + 前端 + 图标 + 启动器 + 说明书挑出来，排除 data\（含个人记录），压成一个 zip。
 *
 * 两种包：
 *   标准版 —— 只有程序本身（~240 KB），对方要先自己装 Node 18+
 *   便携版 —— 额外带 node\node.exe（Node 22 运行时，84 MB），解压即用，不用装任何东西
 *
 * 用法：
 *   node tools/pack.js              只出标准版
 *   node tools/pack.js --portable   只出便携版
 *   node tools/pack.js --all        两个都出
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const win = require('../winutil');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');

const ARGS = process.argv.slice(2);
const WANT_STD = ARGS.includes('--all') || !ARGS.includes('--portable');
const WANT_PORTABLE = ARGS.includes('--all') || ARGS.includes('--portable');

// 便携版多带 node\，说明书换成不需要装 Node 的那份
const PORTABLE_README = '第一次使用请读我-便携版.txt';

const FILES = [
  'server.js', 'organizer.js', 'backup.js', 'cleanup.js', 'deskfiles.js',
  'desktopicons.js', 'shortcuts.js', 'icons.js', 'uninstall.js', 'classify.js',
  'winutil.js', 'install-shortcut.js',
  'app.ico',
  // 双击入口：编译好的启动器（tools\make-launcher.js 生成），没有它就重新生成一次
  '桌面整理器.exe',
  '桌面整理器.vbs', '桌面整理器.bat', '放到桌面（可选）.vbs',
  '使用说明.txt', '第一次使用请读我.txt'
];

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return fs.statSync(to).size;
}

function dirBytes(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
  }
  return n;
}

function zipDir(srcDir, zipPath) {
  // Compress-Archive 对大文件慢且不报细节，这里直接用 .NET 的 ZipFile
  const ps = [
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `if (Test-Path '${zipPath}') { Remove-Item '${zipPath}' -Force }`,
    `[System.IO.Compression.ZipFile]::CreateFromDirectory('${srcDir}', '${zipPath}', ` +
      '[System.IO.Compression.CompressionLevel]::Optimal, $true)',
    `Write-Output ('ZIP=' + (Get-Item '${zipPath}').Length)`
  ].join('\n');
  win.runPS(ps, { timeout: 600000 });
}

/** 找到要打进便携版的 node.exe：就是当前跑这个脚本的那个，所以一定跑得起来 */
function bundledNodeSource() {
  const exe = process.execPath;
  if (!/node\.exe$/i.test(exe) || !fs.existsSync(exe)) {
    throw new Error('当前不是用 node.exe 运行的，拿不到运行时（' + exe + '）');
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) throw new Error('Node 版本过低：' + process.versions.node + '，至少需要 18');
  const license = path.join(path.dirname(exe), 'LICENSE');
  return { exe, version: process.versions.node, license: fs.existsSync(license) ? license : null };
}

function build(portable) {
  const name = portable ? '桌面整理器-便携版' : '桌面整理器';
  const PKG = path.join(OUT_DIR, name);
  const ZIP = path.join(OUT_DIR, name + '.zip');

  fs.mkdirSync(PKG, { recursive: true });
  let count = 0;
  const missing = [];

  for (const f of FILES) {
    let src = path.join(ROOT, f);
    let dstName = f;
    // 便携版：换说明书
    if (portable && f === '第一次使用请读我.txt') {
      src = path.join(ROOT, PORTABLE_README);
      dstName = '第一次使用请读我.txt';
    }
    if (!fs.existsSync(src)) { missing.push(f); continue; }
    copyFile(src, path.join(PKG, dstName));
    count++;
  }

  for (const f of fs.readdirSync(path.join(ROOT, 'public'))) {
    const src = path.join(ROOT, 'public', f);
    if (!fs.statSync(src).isFile()) continue;
    copyFile(src, path.join(PKG, 'public', f));
    count++;
  }

  if (missing.length) {
    console.error('缺文件：' + missing.join(', '));
    if (missing.indexOf('桌面整理器.exe') >= 0) {
      console.error('（启动器还没编译，先跑 node tools\\make-launcher.js）');
    }
    process.exit(1);
  }

  let nodeInfo = '';
  if (portable) {
    const n = bundledNodeSource();
    copyFile(n.exe, path.join(PKG, 'node', 'node.exe'));
    // 再发布就属于「分发 Node 运行时」，带上它的授权文件（MIT + 第三方声明）
    if (n.license) copyFile(n.license, path.join(PKG, 'node', 'LICENSE.txt'));
    count += n.license ? 2 : 1;

    // 打出来的东西得真的能跑，先用它自己报个版本号
    const ver = execFileSync(path.join(PKG, 'node', 'node.exe'), ['--version'], {
      encoding: 'utf8', timeout: 30000
    }).trim();
    if (ver !== 'v' + n.version) throw new Error('复制后的 node.exe 报版本 ' + ver + '，与 ' + n.version + ' 不一致');
    nodeInfo = '  Node ' + ver + ' 已内置';
  }

  zipDir(PKG, ZIP);

  const raw = dirBytes(PKG);
  const zipSize = fs.statSync(ZIP).size;
  console.log('');
  console.log((portable ? '便携版' : '标准版') + '：' + count + ' 个文件，解开 ' +
    (raw / 1024 / 1024).toFixed(1) + ' MB' + nodeInfo);
  console.log('  ' + PKG);
  console.log('  ' + ZIP + '（' + (zipSize / 1024 / 1024).toFixed(1) + ' MB）');
  return ZIP;
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const built = [];
if (WANT_STD) built.push(build(false));
if (WANT_PORTABLE) built.push(build(true));

// 校验值：没买数字签名时，这是唯一能免费给对方的「完整性凭证」——
// 传过去的包被改过、传坏了，一对哈希就知道。
if (built.length) {
  const lines = [
    '桌面整理器 · 分发包校验值（SHA-256）',
    '生成时间：' + new Date().toLocaleString('zh-CN'),
    '',
    '核对方法：在 PowerShell 里执行',
    '  Get-FileHash .\\桌面整理器-便携版.zip -Algorithm SHA256',
    '算出来的值应该与下面一行完全一致（大小写不敏感）。',
    '不一致说明文件在传输中被改动或损坏，别运行。',
    ''
  ];
  for (const z of built) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(z)).digest('hex');
    lines.push(hash + '  ' + path.basename(z) + '  (' +
      (fs.statSync(z).size / 1024 / 1024).toFixed(1) + ' MB)');
  }
  fs.writeFileSync(path.join(OUT_DIR, 'SHA256SUMS.txt'), lines.join('\r\n') + '\r\n', 'utf8');
  console.log('\n校验值已写入 dist\\SHA256SUMS.txt');
}

'use strict';
/**
 * 生成 桌面整理器.exe（Windows 启动器）
 *
 * 用户在资源管理器里双击的就是它 —— 一个真正的 exe，不是 .vbs 脚本，
 * 不会让人怀疑「这后缀是什么」。它本身只有 10 KB，做的事是：
 * 找到 Node（优先本目录 node\node.exe）→ 跑 server.js → 自己退出。
 *
 * 编译用系统里装着的 .NET SDK（dotnet），目标框架 net462 —— 因为
 * Win10 1607 起就自带 .NET Framework 4.6.2+，所以这个 exe 在任何
 * 目标机器上都能直接跑，不需要用户装 .NET，也不需要用户装 Node（便携版）。
 *
 * 用法：node tools/make-launcher.js
 * 产物：<项目根>\桌面整理器.exe
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(__dirname, 'launcher');
const OUT_EXE = path.join(ROOT, '桌面整理器.exe');

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net462</TargetFramework>
    <AssemblyName>桌面整理器</AssemblyName>
    <RootNamespace>DesktopOrganizer.Launcher</RootNamespace>
    <ApplicationIcon>app.ico</ApplicationIcon>
    <ApplicationManifest>app.manifest</ApplicationManifest>
    <AssemblyTitle>桌面整理器</AssemblyTitle>
    <Product>桌面整理器</Product>
    <Description>桌面图标整理、备份、清理、快捷方式重排、软件卸载</Description>
    <Version>1.0.0</Version>
    <FileVersion>1.0.0.0</FileVersion>
    <NeutralLanguage>zh-CN</NeutralLanguage>
    <Deterministic>true</Deterministic>
    <DebugType>none</DebugType>
    <GenerateAssemblyInfo>true</GenerateAssemblyInfo>
    <NoWarn>CS1591</NoWarn>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Program.cs" />
  </ItemGroup>
</Project>
`;

function findDotnet() {
  const tries = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'dotnet', 'dotnet.exe'),
    path.join(process.env['ProgramW6432'] || 'C:\\Program Files', 'dotnet', 'dotnet.exe')
  ];
  for (const t of tries) if (fs.existsSync(t)) return t;
  try {
    const p = execFileSync('where', ['dotnet'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    if (p && fs.existsSync(p)) return p;
  } catch { /* not on PATH */ }
  throw new Error('找不到 dotnet（.NET SDK）。装一个 SDK 或改用现成的 exe。');
}

function main() {
  const dotnet = findDotnet();
  const work = path.join(os.tmpdir(), 'do-launcher-' + process.pid);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  // 源码 + 图标 + 清单复制到临时目录编译，项目目录里不留 bin\ obj\
  fs.copyFileSync(path.join(SRC, 'Program.cs'), path.join(work, 'Program.cs'));
  fs.copyFileSync(path.join(SRC, 'app.manifest'), path.join(work, 'app.manifest'));
  fs.copyFileSync(path.join(ROOT, 'app.ico'), path.join(work, 'app.ico'));
  fs.writeFileSync(path.join(work, 'launcher.csproj'), CSPROJ, 'utf8');

  const env = Object.assign({}, process.env, {
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1'
  });

  console.log('编译启动器（net462，win32 图标内嵌）…');
  const out = path.join(work, 'out');
  try {
    execFileSync(dotnet, ['build', '-c', 'Release', '-o', out, '-v', 'm', '-nologo'], {
      cwd: work, env, encoding: 'utf8', timeout: 600000, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    console.error('编译失败：\n' + (e.stdout || '') + (e.stderr || ''));
    throw e;
  }

  const built = path.join(out, '桌面整理器.exe');
  if (!fs.existsSync(built)) throw new Error('编译产物不存在：' + built);
  fs.copyFileSync(built, OUT_EXE);

  const size = fs.statSync(OUT_EXE).size;
  console.log('已生成 ' + OUT_EXE + '（' + (size / 1024).toFixed(1) + ' KB）');

  fs.rmSync(work, { recursive: true, force: true });
  return OUT_EXE;
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { main, OUT_EXE };

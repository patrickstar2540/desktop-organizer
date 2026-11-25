'use strict';
/**
 * 在桌面创建「桌面整理器」快捷方式（双击 放到桌面（可选）.vbs 调用）
 *
 * 优先指向 桌面整理器.exe —— 用户看到的是一个正常程序，不是脚本文件；
 * 老包（只有 .vbs）就退回用 wscript 拉起 桌面整理器.vbs。
 */
const path = require('path');
const fs = require('fs');
const win = require('./winutil');

const base = __dirname;
const desktop = win.getDesktopPath();
const systemRoot = process.env.SystemRoot || 'C:\\Windows';

const exe = path.join(base, '桌面整理器.exe');
const vbs = path.join(base, '桌面整理器.vbs');
const ownIcon = path.join(base, 'app.ico');

if (!fs.existsSync(exe) && !fs.existsSync(vbs)) {
  console.error('缺少启动文件：桌面整理器.exe / 桌面整理器.vbs 都不在');
  process.exit(1);
}

const lnk = path.join(desktop, '桌面整理器.lnk');
// 图标：exe 自带多尺寸图标；退一步用 app.ico；再退一步用系统图标
const icon = fs.existsSync(exe)
  ? exe
  : (fs.existsSync(ownIcon) ? ownIcon : path.join(systemRoot, 'System32', 'imageres.dll') + ',3');

function make(opts) {
  win.createLnk(lnk, Object.assign({ workingDir: base, icon, desc: '桌面图标整理工具' }, opts));
}

try {
  if (fs.existsSync(exe)) {
    make({ target: exe });
  } else {
    // 旧包兜底：wscript 拉起 .vbs；连这个都失败就干脆指向 .vbs 本身
    try {
      make({ target: path.join(systemRoot, 'System32', 'wscript.exe'), args: `"${vbs}"` });
    } catch (e) {
      make({ target: vbs });
    }
  }
  console.log('OK: ' + lnk);
  process.exit(0);
} catch (e) {
  console.error('创建失败：' + e.message);
  process.exit(1);
}

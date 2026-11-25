'use strict';
/**
 * 桌面文件扫描（非快捷方式）
 *
 * 用途：让「桌面文件」这一组能像快捷方式一样参与图标重排。
 * 只读 —— 不移动、不改名、不删除。真正归档的动作由 server 调 organizer.executePlan 执行。
 *
 * 六类直接复用 organizer 的分类规则（办公文档 / 图片 / 记事本 / 文件夹 / 压缩包 / 未知文件），
 * 所以「重排」和「整理」对同一个文件的判断永远一致。
 */
const fs = require('fs');
const path = require('path');
const org = require('./organizer');

const FILE_KEYS = org.CATEGORIES.map(c => c.key);
const META = new Map(org.CATEGORIES.map(c => [c.key, { key: c.key, name: c.name, folder: c.folder }]));

const SKIP_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store', 'iconcache.db']);
const SHORTCUT_EXTS = new Set(['.lnk', '.url', '.website', '.appref-ms', '.pif', '.scf']);

/**
 * 列出桌面上的文件与文件夹
 * @param {string[]} dirs    桌面目录（用户桌面 + 公共桌面）
 * @param {Set} hidden       隐藏文件名字集合（桌面不显示的）
 */
function list(dirs, hidden) {
  const out = [];
  const seen = new Set();
  const hide = hidden instanceof Set ? hidden : new Set();

  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const name = e.name;
      const lower = name.toLowerCase();
      if (SKIP_NAMES.has(lower)) continue;
      if (hide.has(name)) continue;
      if (name.startsWith('~$') || name.startsWith('.')) continue;
      if (seen.has(lower)) continue;

      const ext = path.extname(name).toLowerCase();
      if (SHORTCUT_EXTS.has(ext)) continue;

      const full = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;

      const isDir = st.isDirectory();
      const cls = org.classify(name, isDir);
      if (cls.skip || !cls.cat) continue;

      seen.add(lower);
      out.push({
        name,
        // Windows 默认隐藏已知扩展名，桌面图标名是不带扩展名的；关掉这个选项时才是全名
        stem: isDir ? name : name.slice(0, name.length - path.extname(name).length),
        file: full,
        dir,
        isDir,
        cat: cls.cat,
        ext: cls.ext || '',
        size: isDir ? 0 : st.size,
        mtime: st.mtimeMs
      });
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return out;
}

/**
 * 把文件对到桌面图标上。
 * 图标名和文件名不一定一样（隐藏扩展名），所以先试「不带扩展名」，再试「带扩展名」。
 *
 * @param {Array} files        list() 的结果
 * @param {Array} icons        桌面图标 [{i,x,y,name}]
 * @param {Map}   usedByName   已经被快捷方式占用的同名序号 {name -> count}
 * @returns {Array} 每个文件补上 iconName / occ / i / x / y
 */
function attachIcons(files, icons, usedByName) {
  const byName = new Map();
  const counter = new Map();
  for (const ic of icons) {
    const n = counter.get(ic.name) || 0;
    counter.set(ic.name, n + 1);
    if (!byName.has(ic.name)) byName.set(ic.name, []);
    byName.get(ic.name).push({ i: ic.i, occ: n, x: ic.x, y: ic.y });
  }

  const used = new Map(usedByName instanceof Map ? usedByName : []);
  const out = [];
  for (const f of files) {
    const cands = f.isDir ? [f.name] : [f.stem, f.name];
    let hit = null;
    for (const cn of cands) {
      const slots = byName.get(cn);
      if (!slots) continue;
      const n = used.get(cn) || 0;
      if (n < slots.length) {
        const slot = slots[n];
        used.set(cn, n + 1);
        hit = { iconName: cn, occ: slot.occ, i: slot.i, x: slot.x, y: slot.y };
        break;
      }
    }
    if (!hit) continue;
    out.push({ ...f, ...hit });
  }
  return out;
}

/** 按六类分成 { office:[...], image:[...], ... } */
function groupByCategory(items) {
  const buckets = {};
  for (const k of FILE_KEYS) buckets[k] = [];
  for (const it of items) {
    if (!buckets[it.cat]) buckets[it.cat] = [];
    buckets[it.cat].push(it);
  }
  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }
  return buckets;
}

module.exports = { FILE_KEYS, META, list, attachIcons, groupByCategory };

'use strict';
/**
 * 桌面图标位置引擎
 *
 * 只做一件事：读取桌面图标当前的坐标，然后把它们挪到新的坐标。
 * 绝不创建、绝不删除、绝不改名 —— 全程只有 LVM_SETITEMPOSITION 一条消息。
 *
 * 原理：Windows 桌面的图标列表是 Progman > SHELLDLL_DefView > SysListView32，
 * 坐标是「网格」：左上角第一个格子是 (x0,y0)，横竖分别是 cellW / cellH。
 * 读取坐标和文字需要往 explorer.exe 里申请一小块内存（跨进程读结构体），
 * 写入坐标不需要，直接发消息即可。
 */

const win = require('./winutil');

const CS = String.raw`
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class DeskIcons {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string c, string w);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string w);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern bool InvalidateRect(IntPtr h, IntPtr r, bool e);
  [DllImport("user32.dll")] static extern bool UpdateWindow(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, uint p);
  [DllImport("kernel32.dll")] static extern IntPtr VirtualAllocEx(IntPtr p, IntPtr a, IntPtr s, uint t, uint pr);
  [DllImport("kernel32.dll")] static extern bool VirtualFreeEx(IntPtr p, IntPtr a, IntPtr s, uint t);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr p, IntPtr a, byte[] b, IntPtr s, out IntPtr r);
  [DllImport("kernel32.dll")] static extern bool WriteProcessMemory(IntPtr p, IntPtr a, byte[] b, IntPtr s, out IntPtr w);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int left, top, right, bottom; }

  [StructLayout(LayoutKind.Sequential)]
  struct LVITEMW {
    public uint mask; public int iItem; public int iSubItem;
    public uint state; public uint stateMask;
    public IntPtr pszText; public int cchTextMax; public int iImage;
    public IntPtr lParam; public int iIndent; public int iGroupId;
    public uint cColumns; public IntPtr puColumns; public IntPtr piColFmt; public int iGroup;
  }

  const uint LVM_FIRST = 0x1000;
  const uint LVM_GETITEMCOUNT     = LVM_FIRST + 4;
  const uint LVM_SETITEMPOSITION  = LVM_FIRST + 15;
  const uint LVM_GETITEMPOSITION  = LVM_FIRST + 16;
  const uint LVM_GETITEMSPACING   = LVM_FIRST + 51;
  const uint LVM_GETITEMTEXTW     = LVM_FIRST + 115;

  static IntPtr lv = IntPtr.Zero;
  static IntPtr proc = IntPtr.Zero;
  static IntPtr buf = IntPtr.Zero;
  static IntPtr textAddr = IntPtr.Zero;
  static int itemSize = 0;

  static IntPtr FindList() {
    IntPtr pm = FindWindow("Progman", null);
    IntPtr dv = IntPtr.Zero;
    if (pm != IntPtr.Zero) dv = FindWindowEx(pm, IntPtr.Zero, "SHELLDLL_DefView", null);
    if (dv == IntPtr.Zero) {
      IntPtr w = IntPtr.Zero;
      while ((w = FindWindowEx(IntPtr.Zero, w, "WorkerW", null)) != IntPtr.Zero) {
        IntPtr d = FindWindowEx(w, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (d != IntPtr.Zero) { dv = d; break; }
      }
    }
    if (dv == IntPtr.Zero) return IntPtr.Zero;
    return FindWindowEx(dv, IntPtr.Zero, "SysListView32", null);
  }

  /*
   * 缩放不是 100% 时（笔记本常见的 125% / 150%），DPI 不感知的进程调
   * GetClientRect 拿到的是被系统「缩小」过的逻辑尺寸，而 LVM_GETITEMSPACING
   * 给的格子和 LVM_GETITEMPOSITION 给的坐标都是物理像素。两者一混，
   * 算出来的列数会少一大截 —— 表现为整理完右边空着一条、还有图标被判定「放不下」。
   * 把当前线程临时切成「每显示器感知」，读到的尺寸就和坐标是同一套单位了。
   * Win10 1607 以下没有这个 API，异常吞掉即可，行为跟原来一样。
   */
  static void UsePhysicalPixels() {
    try { SetThreadDpiAwarenessContext((IntPtr)(-4)); } catch { }
  }

  static bool Attach() {
    UsePhysicalPixels();
    lv = FindList();
    if (lv == IntPtr.Zero) return false;
    uint pid;
    GetWindowThreadProcessId(lv, out pid);
    proc = OpenProcess(0x0008 | 0x0010 | 0x0020, false, pid);
    if (proc == IntPtr.Zero) return false;
    buf = VirtualAllocEx(proc, IntPtr.Zero, (IntPtr)8192, 0x1000, 0x04);
    if (buf == IntPtr.Zero) return false;
    textAddr = (IntPtr)(buf.ToInt64() + 1024);
    itemSize = Marshal.SizeOf(typeof(LVITEMW));
    return true;
  }

  static void Detach() {
    if (buf != IntPtr.Zero) VirtualFreeEx(proc, buf, IntPtr.Zero, 0x8000);
    if (proc != IntPtr.Zero) CloseHandle(proc);
    buf = IntPtr.Zero; proc = IntPtr.Zero;
  }

  public struct Icon { public int i; public int x; public int y; public string name; }

  static Icon[] ReadAll() {
    int count = (int)SendMessage(lv, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero);
    Icon[] list = new Icon[count];
    IntPtr got;
    for (int i = 0; i < count; i++) {
      byte[] pt = new byte[8];
      SendMessage(lv, LVM_GETITEMPOSITION, (IntPtr)i, buf);
      ReadProcessMemory(proc, buf, pt, (IntPtr)8, out got);
      LVITEMW it = new LVITEMW();
      it.mask = 0x0001; it.iItem = i; it.pszText = textAddr; it.cchTextMax = 260;
      byte[] raw = new byte[itemSize];
      IntPtr tmp = Marshal.AllocHGlobal(itemSize);
      Marshal.StructureToPtr(it, tmp, false);
      Marshal.Copy(tmp, raw, 0, itemSize);
      Marshal.FreeHGlobal(tmp);
      WriteProcessMemory(proc, buf, raw, (IntPtr)itemSize, out got);
      SendMessage(lv, LVM_GETITEMTEXTW, (IntPtr)i, buf);
      byte[] txt = new byte[520];
      ReadProcessMemory(proc, textAddr, txt, (IntPtr)520, out got);
      string name = Encoding.Unicode.GetString(txt);
      int z = name.IndexOf('\0');
      if (z >= 0) name = name.Substring(0, z);
      list[i] = new Icon { i = i, x = BitConverter.ToInt32(pt, 0), y = BitConverter.ToInt32(pt, 4), name = name };
    }
    return list;
  }

  public static string Read() {
    if (!Attach()) return "ERR|NO_LISTVIEW";
    try {
      RECT wr; RECT cr;
      GetWindowRect(lv, out wr);
      GetClientRect(lv, out cr);
      long sp = (long)SendMessage(lv, LVM_GETITEMSPACING, IntPtr.Zero, IntPtr.Zero);
      int cellW = (int)(sp & 0xFFFF);
      int cellH = (int)((sp >> 16) & 0xFFFF);
      int style = GetWindowLong(lv, -16);
      bool autoArrange = (style & 0x0100) != 0;
      StringBuilder sb = new StringBuilder();
      sb.Append("META|" + wr.left + "|" + wr.top + "|" + cr.right + "|" + cr.bottom + "|" +
                cellW + "|" + cellH + "|" + (autoArrange ? "1" : "0") + "\n");
      Icon[] all = ReadAll();
      foreach (Icon ic in all) {
        sb.Append("I|" + ic.i + "|" + ic.x + "|" + ic.y + "|" +
                  Convert.ToBase64String(Encoding.UTF8.GetBytes(ic.name)) + "\n");
      }
      return sb.ToString();
    } finally { Detach(); }
  }

  public static string Apply(string payload) {
    if (!Attach()) return "ERR|NO_LISTVIEW";
    try {
      Icon[] all = ReadAll();
      Dictionary<string, List<int>> map = new Dictionary<string, List<int>>();
      for (int k = 0; k < all.Length; k++) {
        string n = all[k].name;
        if (!map.ContainsKey(n)) map[n] = new List<int>();
        map[n].Add(k);
      }
      string[] lines = payload.Split('\n');
      int applied = 0;
      int missing = 0;
      for (int li = 1; li < lines.Length; li++) {
        string line = lines[li].Trim();
        if (line.Length == 0) continue;
        string[] f = line.Split('|');
        if (f.Length < 5) continue;
        int occ = int.Parse(f[1]);
        int x = int.Parse(f[2]);
        int y = int.Parse(f[3]);
        string name = Encoding.UTF8.GetString(Convert.FromBase64String(f[4]));
        if (!map.ContainsKey(name) || occ >= map[name].Count) { missing++; continue; }
        int idx = map[name][occ];
        SendMessage(lv, LVM_SETITEMPOSITION, (IntPtr)idx, (IntPtr)((y << 16) | (x & 0xFFFF)));
        applied++;
      }
      InvalidateRect(lv, IntPtr.Zero, false);
      UpdateWindow(lv);
      return "APPLIED|" + applied + "|MISSING|" + missing + "|TOTAL|" + all.Length;
    } finally { Detach(); }
  }
}
`;

const SCRIPT =
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8\n" +
  "$ProgressPreference='SilentlyContinue'\n" +
  "Add-Type -TypeDefinition @'\n" + CS + "\n'@\n" +
  "$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__'))\n" +
  "if ($payload.StartsWith('READ')) { [Console]::Out.Write([DeskIcons]::Read()) }\n" +
  "else { [Console]::Out.Write([DeskIcons]::Apply($payload)) }\n";

function run(payload) {
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  const out = win.runPS(SCRIPT.replace('__PAYLOAD__', b64), { timeout: 90000 });
  return out;
}

/** 读取桌面全部图标（名称 + 坐标）与网格参数 */
function read() {
  let raw;
  try {
    raw = run('READ');
  } catch (e) {
    return { ok: false, error: '读取桌面图标失败：' + e.message };
  }
  const lines = String(raw).split(/\r?\n/).filter(Boolean);
  const metaLine = lines.find(l => l.startsWith('META|'));
  if (!metaLine) {
    const err = lines.find(l => l.startsWith('ERR|'));
    return { ok: false, error: err === 'ERR|NO_LISTVIEW' ? '找不到桌面图标视图（资源管理器可能没在运行）' : '读取桌面图标失败' };
  }
  const m = metaLine.split('|');
  const icons = [];
  for (const l of lines) {
    if (!l.startsWith('I|')) continue;
    const p = l.split('|');
    let name = '';
    try { name = Buffer.from(p[4] || '', 'base64').toString('utf8'); } catch { name = ''; }
    icons.push({ i: Number(p[1]), x: Number(p[2]), y: Number(p[3]), name });
  }

  const cellW = Number(m[5]);
  const cellH = Number(m[6]);
  const clientW = Number(m[3]);
  const clientH = Number(m[4]);
  const autoArrange = m[7] === '1';

  // 网格原点：所有图标坐标都满足 x ≡ x0 (mod cellW)，取出现次数最多的余数
  const x0 = modeResidue(icons.map(v => v.x), cellW);
  const y0 = modeResidue(icons.map(v => v.y), cellH);

  let cols = Math.max(1, Math.floor((clientW - x0 - cellW) / cellW) + 1);
  const rows = Math.max(1, Math.floor((clientH - y0 - cellH) / cellH) + 1);

  /*
   * 最右一列离屏幕右边还剩将近一格时，看起来就像「漏了一列」：
   * 2560 宽的屏幕、75 的格子，第 33 列落在 x=2416，右边留下 96px 的空档，
   * 而图标本身只有 48px 宽 —— 明明塞得下却不放，右侧整块就不贴边了。
   * 只要图标本身还放得下，就再给一列，让右边整块贴住屏幕右边。
   */
  const iconW = Math.max(16, Math.round(cellW * 0.66));
  if (cellW > 0 && x0 + cols * cellW + iconW <= clientW) cols += 1;

  return {
    ok: true,
    icons,
    metrics: { x0, y0, cellW, cellH, clientW, clientH, cols, rows, autoArrange }
  };
}

function modeResidue(values, mod) {
  if (!values.length || !mod) return 0;
  const counter = new Map();
  for (const v of values) {
    const r = ((v % mod) + mod) % mod;
    counter.set(r, (counter.get(r) || 0) + 1);
  }
  let best = 0, bestN = -1;
  for (const [r, n] of counter) {
    if (n > bestN || (n === bestN && r < best)) { best = r; bestN = n; }
  }
  return best;
}

/** 估算一次调用最终会生成的 -EncodedCommand 长度（命令行上限 32767，留余量） */
const CMD_LIMIT = 29000;
function cmdLen(payload) {
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  return Buffer.from(SCRIPT.replace('__PAYLOAD__', b64), 'utf16le').toString('base64').length;
}

/**
 * 写入坐标
 * 注意：一次把上百个图标塞进 -EncodedCommand 会超 Windows 命令行上限
 * （spawnSync ENAMETOOLONG，整批静默失败），所以按真实长度自动分批。
 * @param {Array<{name:string, occ:number, x:number, y:number}>} items
 */
function applyPositions(items) {
  if (!items.length) return { ok: true, applied: 0, missing: 0 };

  const lines = items.map(it => 'A|' + (it.occ | 0) + '|' + (it.x | 0) + '|' + (it.y | 0) + '|' +
    Buffer.from(String(it.name), 'utf8').toString('base64'));

  const batches = [];
  let cur = [];
  for (const l of lines) {
    cur.push(l);
    if (cmdLen(['APPLY'].concat(cur).join('\n')) <= CMD_LIMIT) continue;
    cur.pop();
    if (cur.length) batches.push(cur);
    cur = [l];
  }
  if (cur.length) batches.push(cur);

  let applied = 0;
  let missing = 0;
  let total = 0;
  for (const batch of batches) {
    let raw;
    try {
      raw = run(['APPLY'].concat(batch).join('\n'));
    } catch (e) {
      return { ok: false, error: '写入图标位置失败：' + e.message };
    }
    const line = String(raw).split(/\r?\n/).find(l => l.startsWith('APPLIED|') || l.startsWith('ERR|'));
    if (!line) return { ok: false, error: '写入图标位置失败（无返回）' };
    if (line.startsWith('ERR|')) return { ok: false, error: '找不到桌面图标视图' };
    const p = line.split('|');
    applied += Number(p[1]) || 0;
    missing += Number(p[3]) || 0;
    total = Number(p[5]) || total;
  }
  return { ok: true, applied, missing, total };
}

/* ---------------- 布局计算（纯函数，可单独测试） ---------------- */

function cellOf(x, y, m) {
  return {
    c: Math.min(m.cols - 1, Math.max(0, Math.round((x - m.x0) / m.cellW))),
    r: Math.min(m.rows - 1, Math.max(0, Math.round((y - m.y0) / m.cellH)))
  };
}

/**
 * @param {Array} icons      全部桌面图标 [{i,x,y,name}]
 * @param {object} metrics   read() 返回的 metrics
 * @param {object} plan      { order:[key...], groups:{key:{enabled,side,items:[{name,occ}]}}, gap:'keep'|'fill' }
 * @param {Set} movingKeys   参与移动的 `${name}#${occ}` 集合（其余图标视为障碍物）
 */
function computeLayout(icons, metrics, plan, movingKeys) {
  const m = metrics;
  const occByIndex = occMap(icons);
  const occ = new Set();
  for (const ic of icons) {
    const key = `${ic.name}#${occByIndex.get(ic.i)}`;
    if (movingKeys.has(key)) continue;
    const cell = cellOf(ic.x, ic.y, m);
    occ.add(cell.c + ',' + cell.r);
  }

  const ascCols = [];
  for (let c = 0; c < m.cols; c++) ascCols.push(c);
  const descCols = ascCols.slice().reverse();

  const result = [];
  const summary = [];
  let overflow = 0;

  for (const side of ['left', 'right']) {
    const seq = side === 'left' ? ascCols : descCols;
    const free = [];
    for (const c of seq) {
      for (let r = 0; r < m.rows; r++) {
        if (!occ.has(c + ',' + r)) free.push({ c, r });
      }
    }
    const groupList = plan.order
      .map(k => plan.groups[k])
      .filter(g => g && g.enabled && g.side === side && g.items.length);

    // 右侧是从屏幕右边往里填的，如果按面板顺序填，①就会跑到最外沿、③跑到中间，
    // 和「面板里 ① ② ③ 从左到右」的直觉正好相反。所以右侧倒过来填：
    // 面板最后一个组落在最右边，整块的从左到右顺序和面板完全一致。
    const fillList = side === 'right' ? groupList.slice().reverse() : groupList;

    let p = 0;
    let placedAny = false;
    for (const g of fillList) {
      if (plan.gap === 'keep' && placedAny && p < free.length) {
        const curCol = free[p].c;
        while (p < free.length && free[p].c === curCol) p++;
      }
      let placed = 0;
      const colSet = new Set();
      for (const item of g.items) {
        // 组内分块（桌面文件按类型分开时用）：这一项开始新的一列
        if (item.brk && placed > 0 && p < free.length) {
          const curCol = free[p].c;
          while (p < free.length && free[p].c === curCol) p++;
        }
        if (p >= free.length) { overflow++; continue; }
        const cell = free[p++];
        colSet.add(cell.c);
        const x = m.x0 + cell.c * m.cellW;
        const y = m.y0 + cell.r * m.cellH;
        result.push({ name: item.name, occ: item.occ, x, y, group: g.key, c: cell.c, r: cell.r });
        placed++;
      }
      placedAny = placedAny || placed > 0;
      summary.push({
        key: g.key, side, count: placed,
        cols: [...colSet].sort((a, b) => a - b)
      });
    }
  }

  // 说明列表按面板顺序输出，避免“同一侧的两个组在弹窗里顺序颠倒”
  const rank = new Map(plan.order.map((k, i) => [k, i]));
  summary.sort((a, b) => (rank.get(a.key) ?? 99) - (rank.get(b.key) ?? 99));

  return { positions: result, summary, overflow };
}

/** 每个图标在同名图标中的序号：Map<i, occ> */
function occMap(icons) {
  const map = new Map();
  const counter = new Map();
  for (const ic of icons) {
    const n = counter.get(ic.name) || 0;
    map.set(ic.i, n);
    counter.set(ic.name, n + 1);
  }
  return map;
}

/**
 * 分两步落位：先把所有要动的图标挪到「目标区域之外的空格子」，
 * 再一次性放到最终位置。
 *
 * 为什么要这样：LVM_SETITEMPOSITION 落到已经有图标的格子上时，Windows 会把
 * 原来那个图标往下挤一格，连锁下来整列就错位了（实测 103 个图标会错 20~30 个）。
 * 先清场再摆位，目标格上一定没有别的图标，就不会触发挤压。
 *
 * @param {Array} positions computeLayout 的结果
 * @param {Array} icons     当前桌面图标
 * @param {object} metrics
 */
function applyStaged(positions, icons, metrics) {
  const m = metrics;
  const cellOfPos = (x, y) => cellOf(x, y, m);
  const targets = new Set();
  for (const p of positions) {
    const c = cellOfPos(p.x, p.y);
    targets.add(c.c + ',' + c.r);
  }
  const taken = new Set();
  for (const ic of icons) {
    const c = cellOfPos(ic.x, ic.y);
    taken.add(c.c + ',' + c.r);
  }

  // 找一批「既不在目标区域、现在也没人占」的格子当临时车位
  const slots = [];
  for (let c = 0; c < m.cols && slots.length < positions.length; c++) {
    for (let r = 0; r < m.rows && slots.length < positions.length; r++) {
      const key = c + ',' + r;
      if (targets.has(key) || taken.has(key)) continue;
      slots.push({ c, r });
    }
  }
  // 桌面太挤、没有临时车位就退化成直接落位
  if (slots.length < positions.length) {
    return applyPositions(positions.map(p => ({ name: p.name, occ: p.occ, x: p.x, y: p.y })));
  }

  const park = positions.map((p, i) => ({
    name: p.name, occ: p.occ,
    x: m.x0 + slots[i].c * m.cellW,
    y: m.y0 + slots[i].r * m.cellH
  }));
  const r1 = applyPositions(park);
  if (!r1.ok) return r1;
  const r2 = applyPositions(positions.map(p => ({ name: p.name, occ: p.occ, x: p.x, y: p.y })));
  if (!r2.ok) return r2;
  return { ok: true, applied: r2.applied, missing: r2.missing + r1.missing, total: r2.total };
}

module.exports = { read, applyPositions, applyStaged, computeLayout, occMap, cellOf };

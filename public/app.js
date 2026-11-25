'use strict';

/* ---------------- 工具 ---------------- */
const $ = (s) => document.querySelector(s);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtSize(n) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)) + ' ' + u[i];
}

function fmtDate(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '操作失败');
  return data;
}

// 兜底：任何未捕获的脚本错误都提示出来，避免「点了没反应」却查不到原因
window.addEventListener('error', (e) => {
  try { toast('出错了：' + (e.message || '未知错误'), true); } catch { /* 还没初始化就忽略 */ }
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason && (e.reason.message || e.reason);
  try { toast('出错了：' + (msg || '未知错误'), true); } catch { /* ignore */ }
});


let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3000);
}

/* 常驻错误提示：不会自动消失，改路径时自动清掉 */
function setFieldError(msg) {
  const el = $('#targetErr');
  el.textContent = msg;
  el.classList.remove('hidden');
  $('#targetInput').classList.add('invalid');
}

function clearFieldError() {
  $('#targetErr').classList.add('hidden');
  $('#targetInput').classList.remove('invalid');
}

/* ---------------- 图标 ---------------- */
const ICONS = {
  office: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M9 13h6M9 17h4"/></svg>`,
  image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m3.5 17.5 4.7-4.7 3.5 3.5 3-3 5.8 5.8"/></svg>`,
  note: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3.5" width="16" height="17" rx="2.5"/><path d="M8 8.5h8M8 12.5h8M8 16.5h5"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2.2h8a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5Z"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4.5" rx="1.4"/><path d="M4.5 8.5h15V19a1.8 1.8 0 0 1-1.8 1.8H6.3A1.8 1.8 0 0 1 4.5 19V8.5Z"/><path d="M10 12.5h4"/></svg>`,
  unknown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M9.8 12.2a2.2 2.2 0 1 1 3.3 2c-.7.4-1.1 1-1.1 1.8"/><circle cx="12" cy="18.2" r=".75" fill="currentColor" stroke="none"/></svg>`
};

const TINTS = {
  office: ['#eef1ff', '#4f46e5'],
  image: ['#e7f8f2', '#0f9c78'],
  note: ['#fff5e6', '#c2760a'],
  folder: ['#eaf2ff', '#2563eb'],
  archive: ['#f5ecff', '#7c3aed'],
  unknown: ['#f0f3f8', '#5a6a80']
};

/* ---------------- 状态 ---------------- */
const state = {
  data: null,
  selected: new Set(),
  expanded: new Set(),
  busy: false,
  backup: null,
  view: 'organize',
  cfg: { targetRoot: '', backupRoot: '', backupBase: '' }
};

/* ---------------- 渲染 ---------------- */
function render() {
  const d = state.data;
  if (!d) return;

  $('#desktopPath').textContent = '桌面：' + d.desktopPath;
  $('#catGrid').innerHTML = d.categories.map(c => {
    const empty = c.count === 0;
    const on = state.selected.has(c.key) && !empty;
    const [tint, fg] = TINTS[c.key] || TINTS.unknown;
    const open = state.expanded.has(c.key);
    return `
      <div class="card ${on ? 'on' : ''} ${empty ? 'empty' : ''}" data-key="${c.key}" role="checkbox" aria-checked="${on}" tabindex="0">
        <div class="card-top">
          <div class="ico" style="--tint:${tint};--fg:${fg}">${ICONS[c.key] || ICONS.unknown}</div>
          <div class="tick">✓</div>
        </div>
        <div class="card-name">${escapeHtml(c.name)} <span class="count">${c.count}</span></div>
        <div class="card-hint">${escapeHtml(c.hint)}</div>
        <div class="card-sub">${escapeHtml(c.subHint)}</div>
        ${c.count ? `<button class="card-more" data-more="${c.key}">${open ? '收起' : '查看'} ${c.count} 个文件</button>
        <ul class="file-list ${open ? '' : 'hidden'}" data-list="${c.key}">
          ${c.items.map(i => `<li><span>${i.isDir ? '📁 ' : ''}${escapeHtml(i.name)}</span><span class="sz">${i.isDir ? '文件夹' : fmtSize(i.size)}</span></li>`).join('')}
          ${c.count > c.items.length ? `<li class="more-tip">…还有 ${c.count - c.items.length} 个</li>` : ''}
        </ul>` : ''}
      </div>`;
  }).join('');

  // 桌面路径快捷选项
  const sugs = d.suggestions || [];
  $('#quickPaths').innerHTML = sugs.map(p => `<button class="chip" data-path="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join('');

  // 输入框初值（不覆盖用户已输入的内容）
  const ti = $('#targetInput');
  if (!ti.value) ti.value = d.defaults.targetRoot || '';
  if (!state.inited) {
    $('#shortcutName').value = d.defaults.shortcutName || '已整理的文件';
    $('#chkShortcut').checked = true;
    state.inited = true;
  }

  updateStats();
}

function updateStats() {
  const d = state.data;
  if (!d) return;
  let files = 0;
  for (const c of d.categories) if (state.selected.has(c.key)) files += c.count;
  const cats = state.selected.size;
  $('#statTotal').textContent = files;
  $('#statCats').textContent = '已选 ' + cats + ' 类';
  $('#selSummary').textContent = '已选 ' + cats + ' 类';
  const warn = files === 0 ? '还没有选中任何文件' : '';
  $('#statWarn').textContent = warn;
}

function toggle(key) {
  const cat = state.data.categories.find(c => c.key === key);
  if (!cat || cat.count === 0) return;
  if (state.selected.has(key)) state.selected.delete(key); else state.selected.add(key);
  render();
}

/* ---------------- 交互 ---------------- */
function bindEvents() {
  $('#catGrid').addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) {
      e.stopPropagation();
      const k = more.dataset.more;
      if (state.expanded.has(k)) state.expanded.delete(k); else state.expanded.add(k);
      render();
      return;
    }
    const card = e.target.closest('.card');
    if (card) toggle(card.dataset.key);
  });

  $('#catGrid').addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && e.target.classList.contains('card')) {
      e.preventDefault();
      toggle(e.target.dataset.key);
    }
  });

  $('#btnAll').addEventListener('click', () => {
    state.data.categories.forEach(c => { if (c.count) state.selected.add(c.key); });
    render();
  });

  $('#btnNone').addEventListener('click', () => { state.selected.clear(); render(); });

  $('#quickPaths').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-path]');
    if (chip) { $('#targetInput').value = chip.dataset.path; clearFieldError(); }
  });

  $('#targetInput').addEventListener('input', clearFieldError);

  // 改了存放位置就记住它（备份页要用这个值判断「是不是还跟备份同一个文件夹」）
  $('#targetInput').addEventListener('change', async () => {
    const p = $('#targetInput').value.trim();
    if (!p) return;
    try {
      const r = await api('/api/settings', { targetRoot: p });
      state.cfg = { ...(state.cfg || {}), targetRoot: r.targetRoot };
      clearFieldError();
    } catch (e) {
      setFieldError(e.message);
    }
  });

  $('#btnOpenTarget').addEventListener('click', async () => {
    const p = $('#targetInput').value.trim();
    if (!p) { setFieldError('先填一个存放位置，再打开文件夹。'); return; }
    try { await api('/api/open', { path: p, mkdir: true }); } catch (e) { toast(e.message, true); }
  });

  $('#btnPick').addEventListener('click', async () => {
    const btn = $('#btnPick');
    btn.disabled = true; btn.textContent = '选择中…';
    try {
      const r = await api('/api/pick-folder', { current: $('#targetInput').value, title: '选择整理后文件的存放位置' });
      if (r.path) {
        $('#targetInput').value = r.path;
        clearFieldError();
        const s = await api('/api/settings', { targetRoot: r.path });
        state.cfg = { ...(state.cfg || {}), targetRoot: s.targetRoot };
      }
    } catch (err) {
      setFieldError(err.message);
      $('#targetInput').focus();
    } finally {
      btn.disabled = false; btn.textContent = '浏览…';
    }
  });

  $('#btnRefresh').addEventListener('click', async () => {
    if (state.view === 'backup') {
      const btn = $('#btnRefresh');
      btn.disabled = true; btn.textContent = '扫描中…';
      try {
        await refreshBackupPage();
        toast('已重新统计桌面');
      } catch (e) { toast(e.message, true); }
      finally { btn.disabled = false; btn.textContent = '重新扫描'; }
      return;
    }
    const btn = $('#btnRefresh');
    btn.disabled = true; btn.textContent = '扫描中…';
    try {
      state.data = await api('/api/rescan', {});
      state.expanded.clear();
      render();
      await loadBackupState();
      toast(`扫描完成，桌面共 ${state.data.total} 个可整理项目`);
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; btn.textContent = '重新扫描'; }
  });

  $('#btnPreview').addEventListener('click', () => openPlan());
  $('#btnRun').addEventListener('click', () => openPlan());

  // 一级页面：整理桌面 / 桌面备份
  $('#topNav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-nav]');
    if (b) setView(b.dataset.nav);
  });

  $('#btnBackupNow').addEventListener('click', () => goBackup({ autoCreate: true }));
  $('#btnBackupLater').addEventListener('click', () => {
    bkUI.bannerDismissed = true;
    renderBackupBanner();
    toast('已收起提示，随时可以在顶部切到「桌面备份」');
  });
  $('#btnHistory').addEventListener('click', showHistory);

  // ---- 备份页 ----
  $('#bkCreate').addEventListener('click', () => {
    if (backupReady()) doBackup({});
    else askFirstBackupRoot({});
  });
  $('#bkOpenFolder').addEventListener('click', openBackupFolder);
  $('#bkPick').addEventListener('click', pickBackupRoot);
  $('#bkOpen').addEventListener('click', async () => {
    const p = $('#bkRootInput').value.trim();
    if (!p) { setBkRootError('先填一个备份位置，再打开文件夹。'); return; }
    try {
      if (state.cfg && p !== state.cfg.backupBase && p !== state.cfg.backupRoot) await saveBackupRoot(p);
      openBackupFolder();
    } catch (e) { setBkRootError(e.message); }
  });
  $('#bkRootInput').addEventListener('input', clearBkRootError);
  $('#bkRootInput').addEventListener('change', async () => {
    const p = $('#bkRootInput').value.trim();
    if (!p) return;
    if (state.cfg && p === state.cfg.backupRoot) return;
    try {
      const r = await saveBackupRoot(p);
      toast(r && r.synced ? '备份位置已更新，整理位置也跟着改了' : '备份位置已更新');
    } catch (e) {
      setBkRootError(e.message);
    }
  });
  $('#bkQuick').addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-bkpath]');
    if (!chip) return;
    $('#bkRootInput').value = chip.dataset.bkpath;
    try {
      const r = await saveBackupRoot(chip.dataset.bkpath);
      toast(r && r.synced ? '备份位置已更新，整理位置也跟着改了' : '备份位置已更新');
    } catch (err) { setBkRootError(err.message); }
  });
  // ---- 清理页 ----
  $('#viewClean').addEventListener('click', (e) => {
    const gobk = e.target.closest('[data-cl-gobk]');
    if (gobk) {
      goBackup({
        autoCreate: true,
        after() {
          setView('clean');
          toast('备份好了，可以放心清理了');
        }
      });
      return;
    }
    const scan = e.target.closest('[data-cl-scan]');
    if (scan) {
      const has = clUI.scan && (clUI.scan.counts.broken + clUI.scan.counts.suspect) > 0;
      if (has) showCleanResult(clUI.scan);
      else openCleanScan();
      return;
    }
    if (e.target.closest('[data-cl-uninstall]')) { openUninstall('desk'); return; }
    if (e.target.closest('[data-cl-unall]')) { openUninstall('all'); return; }
    const rs = e.target.closest('[data-cl-restore]');
    if (rs) { restoreClean(rs.dataset.clRestore, rs); return; }
  });
  $('#viewClean').addEventListener('change', (e) => {
    const ack = e.target.closest('[data-cl-ack]');
    if (ack) setCleanAck(ack.checked);
  });

  $('#btnClose').addEventListener('click', async () => {
    try {
      await api('/api/shutdown', {});
    } catch (e) {
      toast(e.message, true);
      return;
    }
    window.close();
    setTimeout(() => { document.body.innerHTML = '<div style="padding:40px;font-family:Segoe UI,Microsoft YaHei;color:#8b95a5">已退出，可以关闭这个窗口了。</div>'; }, 300);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

/* ---------------- 弹窗 ---------------- */
function closeModal() {
  // 卸载面板一关，就别再往出弹卸载窗口了（正在跑的那个不动）
  try {
    if (unUI && unUI.batch && unUI.batch.state === 'running' && !unUI.stopped) unStop();
    stopUnPoll();
  } catch { /* 卸载面板还没初始化，跟我没关系 */ }
  const m = $('#modalRoot');
  m.innerHTML = '';
  m.style.display = 'none';
}

function modal(html, opts = {}) {
  const root = $('#modalRoot');
  root.style.display = 'block';
  root.innerHTML = `<div class="overlay" data-overlay><div class="modal">${html}</div></div>`;
  if (opts.dismissible !== false) {
    root.querySelector('[data-overlay]').addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-overlay')) closeModal();
    });
  }
  return root.querySelector('.modal');
}

function payload() {
  const targetRoot = $('#targetInput').value.trim();
  return {
    selected: [...state.selected],
    targetRoot,
    makeShortcut: $('#chkShortcut').checked,
    shortcutName: $('#shortcutName').value.trim() || '已整理的文件'
  };
}

async function openPlan() {
  if (state.busy) return;
  const body = payload();
  if (!body.targetRoot) {
    $('#targetInput').focus();
    setFieldError('还没有填存放位置，先选一个文件夹（不能选在桌面里面）。');
    return;
  }
  if (!body.selected.length) { toast('请至少勾选一种类别', true); return; }
  // 参数都齐全了，再问要不要先备份（没备份过才问，且只问一次）
  if (!backupReady() && !bkUI.promptShown) { withBackupCheck(openPlan); return; }

  state.busy = true;
  try {
    const plan = await api('/api/plan', body);
    clearFieldError();
    showPlanModal(plan, body);
  } catch (e) {
    setFieldError(e.message);
  } finally {
    state.busy = false;
  }
}

function showPlanModal(plan, body) {
  let shown = 0;
  const groupsHtml = plan.groups.map(g => {
    const subsHtml = g.subs.map(s => `
      <div class="plan-sub">
        ${s.sub ? `<div class="plan-subname">${escapeHtml(s.sub)}</div>` : ''}
        <div class="plan-files">
          ${s.items.map(it => {
            shown++;
            if (shown > 400) return '';
            return `<div class="plan-file"><span class="nm">${it.isDir ? '📁 ' : ''}${escapeHtml(it.name)}</span><span class="sz">${it.isDir ? '' : fmtSize(it.size)}</span></div>`;
          }).join('')}
        </div>
      </div>`).join('');
    return `
      <div class="plan-group">
        <div class="plan-ghead">
          <span>${escapeHtml(g.folder)}</span>
          <span class="badge">${g.count} 项</span>
        </div>
        ${subsHtml}
      </div>`;
  }).join('');

  const moreTip = plan.total > shown ? `<p class="muted" style="text-align:center">…共 ${plan.total} 项，这里只展示前 400 项</p>` : '';

  const m = modal(`
    <div class="modal-head">
      <div>
        <h3>整理方案确认</h3>
        <p>下面这些文件会被移动到新位置，桌面上的原文件将不再保留（可撤销）</p>
      </div>
      <button class="modal-close" data-close>✕</button>
    </div>
    <div class="modal-body">
      <div class="plan-target">存放位置：<b>${escapeHtml(plan.targetRoot)}</b></div>
      ${groupsHtml}
      ${moreTip}
    </div>
    <div class="modal-foot">
      <span class="left">共 ${plan.total} 项 · ${plan.groups.length} 个类别</span>
      <button class="btn" data-close>取消</button>
      <button class="btn primary" data-confirm>开始整理</button>
    </div>
  `);

  m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  m.querySelector('[data-confirm]').addEventListener('click', () => execute(m, body));
}

async function execute(m, body) {
  const btn = m.querySelector('[data-confirm]');
  btn.disabled = true;
  btn.textContent = '整理中…';
  let started;
  try {
    started = await api('/api/execute', body);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '开始整理';
    setFieldError(e.message);
    return;
  }
  clearFieldError();
  showProgress(started.total || 0);
  pollJob(0);
}

/* ---------------- 进度 ---------------- */
function showProgress(total) {
  const m = modal(`
    <div class="modal-head">
      <div><h3>正在整理…</h3><p>文件正在搬运，请不要关闭窗口</p></div>
    </div>
    <div class="modal-body">
      <div class="prog-wrap">
        <div class="prog-bar"><i id="progFill"></i></div>
        <div class="prog-meta">
          <span><b id="progDone">0</b> / <span id="progTotal">${total}</span> 个文件</span>
          <span class="prog-cur" id="progCur">准备中…</span>
        </div>
      </div>
      <div class="prog-tip">
        跨磁盘搬运（比如 C 盘搬到 F 盘）需要复制 + 校验，大文件、素材文件夹会慢一些，进度会实时更新。<br>
        万一中途被打断，已经搬走的文件会留在「整理记录」里，可以一键撤销回桌面。
      </div>
    </div>
  `, { dismissible: false });
  return m;
}

function updateProgress(j) {
  const fill = $('#progFill');
  if (!fill) return;
  const total = j.total || 1;
  const pct = Math.max(2, Math.min(100, Math.round((j.done / total) * 100)));
  fill.style.width = pct + '%';
  $('#progDone').textContent = j.done;
  $('#progTotal').textContent = j.total || total;
  if (j.current) $('#progCur').textContent = j.current;
}

async function pollJob(fails) {
  try {
    const j = await api('/api/job');
    if (j.state === 'running') {
      updateProgress(j);
      setTimeout(() => pollJob(0), 250);
      return;
    }
    if (j.state === 'done') {
      closeModal();
      showResult(j.result);
      api('/api/job/ack', {}).catch(() => {});
      await refreshAfterRun();
      return;
    }
    if (j.state === 'error') {
      closeModal();
      setFieldError('整理中断：' + j.error);
      toast('整理中断：' + j.error, true);
      api('/api/job/ack', {}).catch(() => {});
      await refreshAfterRun();
      return;
    }
    // idle：没有任务了
    closeModal();
    toast('任务已结束，请用「重新扫描」看看当前状态', true);
  } catch (e) {
    if (fails > 24) {
      closeModal();
      setFieldError('和后台失去联系了，可能是软件进程被中断。已经搬走的文件都记在「整理记录」里，可以撤销回桌面。');
      return;
    }
    setTimeout(() => pollJob(fails + 1), 600);
  }
}

async function refreshAfterRun() {
  try {
    state.data = await api('/api/rescan', {});
    state.selected = new Set([...state.selected].filter(k => {
      const c = state.data.categories.find(x => x.key === k);
      return c && c.count > 0;
    }));
    render();
  } catch { /* ignore */ }
}

function showResult(r) {
  const sc = r.shortcut;
  const m = modal(`
    <div class="modal-head">
      <div><h3>整理完成</h3><p>所有文件已移动到新的位置</p></div>
      <button class="modal-close" data-close>✕</button>
    </div>
    <div class="modal-body">
      <div class="result-hero">
        <div class="result-icon">✓</div>
        <div class="result-title">已整理 ${r.movedCount} 个文件</div>
        <div class="result-desc">${escapeHtml(r.targetRoot)}</div>
      </div>
      <div class="result-stats">
        <div class="stat"><b>${r.movedCount}</b><span>成功移动</span></div>
        <div class="stat"><b>${(r.skipped || []).length}</b><span>跳过</span></div>
        <div class="stat"><b>${(r.failed || []).length}</b><span>失败</span></div>
      </div>
      ${sc ? `<div class="plan-target" style="margin-top:14px">桌面快捷方式：${sc.ok ? '<b>' + escapeHtml(sc.path) + '</b>' : '<span style="color:#b45309">创建失败（' + escapeHtml(sc.error || '') + '），可直接用「打开文件夹」进入</span>'}</div>` : ''}
      ${(r.skipped || []).length || (r.failed || []).length ? `
        <ul class="result-list">
          ${(r.skipped || []).slice(0, 12).map(s => `<li>· 跳过 ${escapeHtml(s.name)}（${escapeHtml(s.reason)}）</li>`).join('')}
          ${(r.failed || []).slice(0, 12).map(s => `<li>· 失败 ${escapeHtml(s.name)}（${escapeHtml(s.reason)}）</li>`).join('')}
        </ul>` : ''}
      <div class="hint-box" data-refresh-hint>
        ${r.desktopRefreshed === false
          ? '桌面可能还显示着已搬走的图标（点它只会提示「位置不可用」），点下面的「刷新桌面」即可清除。'
          : '如果桌面上还有搬走的图标残影，点「刷新桌面」就能清掉。'}
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn danger-ghost" data-undo>撤销这次整理</button>
      <button class="btn" data-refresh>刷新桌面</button>
      <button class="btn" data-open>打开文件夹</button>
      <button class="btn primary" data-close>完成</button>
    </div>
  `);

  m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  m.querySelector('[data-open]').addEventListener('click', () => api('/api/open', { path: r.targetRoot }));

  showUndoBar({
    kind: 'files',
    id: r.logId,
    text: `刚整理了 ${r.movedCount} 个文件到 ${r.targetRoot}`
  });

  const refreshBtn = m.querySelector('[data-refresh]');
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true; refreshBtn.textContent = '刷新中…';
    try {
      const res = await api('/api/refresh-shell', {});
      if (res.ok) {
        refreshBtn.textContent = '已刷新';
        const hint = m.querySelector('[data-refresh-hint]');
        if (hint) hint.textContent = '桌面已刷新，之前那些打不开的图标应该已经消失了。';
        setTimeout(() => { refreshBtn.disabled = false; refreshBtn.textContent = '刷新桌面'; }, 1600);
      } else {
        throw new Error('刷新失败，试试在桌面空白处右键 → 刷新');
      }
    } catch (e) {
      refreshBtn.disabled = false; refreshBtn.textContent = '刷新桌面';
      toast(e.message, true);
    }
  });

  const undoBtn = m.querySelector('[data-undo]');
  undoBtn.addEventListener('click', async () => {
    if (!confirm('撤销后，这次整理的文件会全部移回桌面原来的位置，确定吗？')) return;
    undoBtn.disabled = true; undoBtn.textContent = '撤销中…';
    try {
      const res = await api('/api/undo', { id: r.logId });
      closeModal();
      hideUndoBar();
      toast(`已撤销，${res.restored} 个文件回到桌面${res.failed && res.failed.length ? '，' + res.failed.length + ' 个失败' : ''}`);
      state.data = await api('/api/rescan', {});
      render();
    } catch (e) {
      undoBtn.disabled = false; undoBtn.textContent = '撤销这次整理';
      toast(e.message, true);
    }
  });
}

async function showHistory() {
  const m = modal(`
    <div class="modal-head">
      <div><h3>整理记录</h3><p>文件整理和图标重排都能一键撤回，文件会回到桌面原位置</p></div>
      <button class="modal-close" data-close>✕</button>
    </div>
    <div class="modal-body" data-body><div class="empty-state">读取中…</div></div>
    <div class="modal-foot"><button class="btn" data-close>关闭</button></div>
  `);
  m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));

  try {
    const [fileRes, iconRes] = await Promise.all([
      api('/api/logs'),
      api('/api/shortcuts/logs').catch(() => ({ logs: [] }))
    ]);
    const files = fileRes.logs || [];
    const iconLogs = iconRes.logs || [];
    const body = m.querySelector('[data-body]');

    if (!files.length && !iconLogs.length) {
      body.innerHTML = '<div class="empty-state">还没有整理记录</div>';
      return;
    }

    const fileRows = files.map(l => `
      <div class="log-row">
        <div>
          <div class="log-time">${fmtDate(l.startedAt)}${l.status === 'running' ? ' <span class="tag-warn">未完成</span>' : ''}</div>
          <div class="log-meta">${l.movedCount} 个文件 → ${escapeHtml(l.targetRoot)}${l.failedCount ? ` · ${l.failedCount} 个失败` : ''}</div>
        </div>
        <div class="log-actions"><button class="btn danger-ghost" data-undo="${escapeHtml(l.id)}">撤销</button></div>
      </div>`).join('');

    const iconRows = iconLogs.map(l => `
      <div class="log-row">
        <div>
          <div class="log-time">${fmtDate(l.at)}</div>
          <div class="log-meta">重排 ${l.movedCount} 个图标位置 · 组序 ${(l.order || []).length} 组</div>
        </div>
        <div class="log-actions"><button class="btn danger-ghost" data-undoicon="${escapeHtml(l.id)}">还原</button></div>
      </div>`).join('');

    body.innerHTML =
      (files.length ? `<div class="log-sec">文件整理</div>${fileRows}` : '') +
      (iconLogs.length ? `<div class="log-sec">图标重排</div>${iconRows}` : '');

    body.querySelectorAll('[data-undo]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('撤销后，这些文件会移回桌面原来的位置，确定吗？')) return;
        btn.disabled = true; btn.textContent = '撤销中…';
        try {
          const res = await api('/api/undo', { id: btn.dataset.undo });
          closeModal();
          hideUndoBar();
          toast(`已撤销，${res.restored} 个文件回到桌面`);
          state.data = await api('/api/rescan', {});
          render();
        } catch (e) {
          btn.disabled = false; btn.textContent = '撤销';
          toast(e.message, true);
        }
      });
    });

    body.querySelectorAll('[data-undoicon]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '还原中…';
        try {
          const res = await api('/api/shortcuts/undo', { id: btn.dataset.undoicon });
          closeModal();
          hideUndoBar();
          toast(`已还原 ${res.restored} 个图标的位置${res.skipped ? `，${res.skipped} 个已被你挪过所以没动` : ''}`);
        } catch (e) {
          btn.disabled = false; btn.textContent = '还原';
          toast(e.message, true);
        }
      });
    });
  } catch (e) {
    m.querySelector('[data-body]').innerHTML = `<div class="empty-state">读取失败：${escapeHtml(e.message)}</div>`;
  }
}

/* ---------------- 撤销条 ---------------- */
let undoState = null;

function showUndoBar(st) {
  undoState = st;
  const bar = $('#undoBar');
  if (!bar) return;
  $('#undoText').innerHTML = `<b>${escapeHtml(st.text)}</b>${st.kind === 'icons' ? '，图标位置已记录' : ''} · 不满意可以撤回`;
  const btn = $('#undoBtn');
  btn.disabled = false;
  btn.textContent = '撤销';
  bar.classList.remove('hidden');
}

function hideUndoBar() {
  undoState = null;
  const bar = $('#undoBar');
  if (bar) bar.classList.add('hidden');
}

async function doUndo() {
  if (!undoState) return;
  const st = undoState;
  const btn = $('#undoBtn');
  btn.disabled = true;
  btn.textContent = '撤销中…';
  try {
    let msg;
    if (st.kind === 'icons') {
      let back = '';
      if (st.archiveId) {
        const a = await api('/api/undo', { id: st.archiveId });
        back = `，${a.restored} 个文件已移回桌面`;
      }
      let n = 0, skipped = 0;
      if (st.id) {
        const res = await api('/api/shortcuts/undo', { id: st.id });
        n = res.restored; skipped = res.skipped || 0;
      }
      msg = `已还原 ${n} 个图标的位置${back}${skipped ? `，${skipped} 个已被你挪过所以没动` : ''}`;
      closeModal();
    } else {
      const res = await api('/api/undo', { id: st.id });
      msg = `已撤销，${res.restored} 个文件回到桌面`;
      closeModal();
      state.data = await api('/api/rescan', {});
      render();
    }
    hideUndoBar();
    toast(msg);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '撤销';
    toast(e.message, true);
  }
}

/* ---------------- 桌面快捷方式重排 ---------------- */
const SC_META = {
  tool: { name: '日常软件', color: '#2563eb', tint: '#eef3ff' },
  niche: { name: '专业（小众）软件', color: '#0f9c78', tint: '#e7f8f2' },
  game: { name: '游戏', color: '#d97706', tint: '#fff5e6' },
  file: { name: '桌面文件', color: '#7c3aed', tint: '#f4efff' }
};
const SC_KEYS = ['tool', 'niche', 'game', 'file'];
/* 桌面文件的六个类型：名称与颜色只用于显示，顺序由用户左右拖出来 */
const FILE_META = {
  office: { name: '办公文档', color: '#2563eb', glyph: 'doc' },
  image: { name: '图片', color: '#0f9c78', glyph: 'img' },
  note: { name: '记事本', color: '#b45309', glyph: 'note' },
  folder: { name: '文件夹', color: '#0891b2', glyph: 'folder' },
  archive: { name: '压缩包', color: '#7c3aed', glyph: 'zip' },
  unknown: { name: '未知文件', color: '#64748b', glyph: 'unk' }
};
/* 六个类型各自的图形：手绘 SVG，和别的分类一样有「看得见的图标」，拖起来更直观 */
const FILE_GLYPH = {
  doc: '<path d="M13.9 3.3H7A1.9 1.9 0 0 0 5.1 5.2v13.6A1.9 1.9 0 0 0 7 20.7h10a1.9 1.9 0 0 0 1.9-1.9V8.5z"/><path d="M13.9 3.3v5.2h5"/><path d="M8.7 12.6h6.6M8.7 16.1h4.3"/>',
  img: '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.6"/><circle cx="8.8" cy="9.8" r="1.5"/><path d="M4.4 17.3l4.2-3.8a2.1 2.1 0 0 1 2.8.1l4.3 3.9"/><path d="M15.4 14.4l1.3-1.1a1.8 1.8 0 0 1 2.4.1l1.4 1.3"/>',
  note: '<rect x="4.3" y="3.6" width="11.6" height="16.8" rx="2.2"/><path d="M7.6 8.2h5M7.6 11.5h5M7.6 14.8h3.1"/><path d="M17.6 8.7l2.2 2.2-4.9 4.9-2.9.7.7-2.9z"/>',
  folder: '<path d="M3.7 8A2.2 2.2 0 0 1 5.9 5.8h2.9l2 2h7.3A2.2 2.2 0 0 1 20.3 10v7.2a2.2 2.2 0 0 1-2.2 2.2H5.9a2.2 2.2 0 0 1-2.2-2.2z"/><path d="M3.9 10.1h16.2"/>',
  zip: '<rect x="4.4" y="4.1" width="15.2" height="15.8" rx="2.1"/><path d="M4.4 8.3h15.2"/><path d="M12 8.3v2.3M12 12.5v2.3M12 16.7v1.4"/>',
  unk: '<path d="M13.9 3.3H7A1.9 1.9 0 0 0 5.1 5.2v13.6A1.9 1.9 0 0 0 7 20.7h10a1.9 1.9 0 0 0 1.9-1.9V8.5z"/><path d="M13.9 3.3v5.2h5"/><path d="M9.7 13.1a2.3 2.3 0 1 1 3.2 2.1c-.5.3-.8.7-.8 1.2v.3"/><circle cx="12.1" cy="18.6" r=".6" fill="currentColor" stroke="none"/>'
};
const SC_VIEW_KEY = 'desktop-organizer.scView';
const SC_SIZE_KEY = 'desktop-organizer.scIconSize';
const SC_PV_KEY = 'desktop-organizer.scPvOpen';
/* 图标视图的四档大小：icon = 图标边长，tile = 单个格子最小宽度 */
const SC_SIZES = [
  { icon: 30, tile: 62, label: '小' },
  { icon: 40, tile: 76, label: '中' },
  { icon: 54, tile: 94, label: '大' },
  { icon: 70, tile: 116, label: '特大' }
];

const sc = {
  data: null,
  order: [],
  groups: null,
  tray: [],
  gap: 'keep',
  busy: false,
  fileOrder: ['office', 'image', 'note', 'folder', 'archive', 'unknown'],
  fileCounts: {},
  fileMode: 'arrange',
  mode: localStorage.getItem(SC_VIEW_KEY) === 'name' ? 'name' : 'icon',
  size: (() => {
    const n = parseInt(localStorage.getItem(SC_SIZE_KEY) || '1', 10);
    return Number.isFinite(n) ? Math.min(SC_SIZES.length - 1, Math.max(0, n)) : 1;
  })(),
  drag: null,     // { kind:'chip', el } | { kind:'col', key, el } | { kind:'ftype', key, el }
  drop: null,     // { kind:'chip', zone, index } | { kind:'col', index } | { kind:'ftype', index }
  preview: null,  // 最近一次的预览结果
  // 效果图默认要不要展开：用户手动点过就听用户的；
  // 没点过的矮屏幕（768 及以下）先收起来，否则四张卡片会被挤得只剩两行
  pvOpen: (() => {
    const saved = localStorage.getItem(SC_PV_KEY);
    if (saved === '1') return true;
    if (saved === '0') return false;
    return (window.innerHeight || 900) >= 760;
  })(),
  iconSeq: 0
};

function scItems(key) {
  return key === 'tray' ? sc.tray : sc.groups[key].items;
}

function firstChar(s) {
  const a = Array.from(String(s || ''));
  return a[0] || '?';
}

/* ---------- 结构 ---------- */
function chipHtml(it, from) {
  const tip = it.reason ? `${it.name} — ${it.reason}` : it.name;
  const img = it.iconUrl ? `<img src="${escapeHtml(it.iconUrl)}" alt="" draggable="false">` : '';
  return `<div class="sc-chip${it.iconUrl ? ' has-ic' : ''}" draggable="true"
      data-key="${escapeHtml(it.iconKey || '')}" data-name="${escapeHtml(it.name)}" data-occ="${it.occ}" data-from="${from}"
      title="${escapeHtml(tip)}">
    <span class="sc-ic${it.iconUrl ? ' has' : ''}"><span class="ph">${escapeHtml(firstChar(it.name))}</span>${img}</span>
    <span class="nm">${escapeHtml(it.name)}</span>
  </div>`;
}

/* 桌面文件这一组：没有具体图标，只有六个类型——每个都带图形，只能左右拖，顺序就是桌面上先后 */
function fileTilesHtml() {
  return sc.fileOrder.map((k, i) => {
    const meta = FILE_META[k] || { name: k, color: '#64748b', glyph: 'unk' };
    const n = sc.fileCounts[k] || 0;
    return `<div class="sc-ftile${n ? '' : ' zero'}" draggable="true" data-ftype="${k}"
        style="--fc:${meta.color}" title="按住左右拖动，决定「${meta.name}」在桌面上的先后（第 ${i + 1} 位）">
      <span class="sc-ft-ic">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
             stroke-linecap="round" stroke-linejoin="round">${FILE_GLYPH[meta.glyph] || ''}</svg>
        <em class="sc-ft-n">${n}</em>
      </span>
      <span class="sc-ft-nm">${meta.name}</span>
    </div>`;
  }).join('');
}

function fileBodyHtml() {
  return `<div class="sc-fhint">同类先聚成一块，再按下面的顺序分开摆 —— 按住类型左右拖</div>
    <div class="sc-ftrow" data-frow>${fileTilesHtml()}</div>
    <label class="sc-archive">
      <input type="checkbox" data-archive ${sc.fileMode === 'folder' ? 'checked' : ''}>
      <span><b>建分类文件夹并归档</b><i>在桌面建 6 个文件夹，把文件移进去</i></span>
    </label>
    <div class="sc-ftip">不勾归档：六类先各自聚成一块，再按上面的顺序一块一块摆开。<br>勾了归档：桌面上只留下 6 个分类文件夹，文件本身不再占位置（移动可撤回）。</div>`;
}

function colHtml(k, idx) {
  const g = sc.groups[k];
  const meta = SC_META[k];
  const isFile = k === 'file';

  const bodyHtml = isFile
    ? `<div class="sc-fbody" data-fdrop>${fileBodyHtml()}</div>`
    : `<div class="sc-drop" data-drop="${k}">
        ${g.items.map(it => chipHtml(it, k)).join('')}
        <div class="sc-empty${g.items.length ? ' hidden' : ''}">把图标拖到这里</div>
      </div>`;

  return `
  <section class="sc-col${isFile ? ' col-file' : ''}${g.enabled ? '' : ' off'}" data-col="${k}" draggable="true" style="--c:${meta.color};--tint:${meta.tint}">
    <header class="sc-col-head" title="按住这一条（或这张卡片上任意空白处）拖动，调整这一组的先后">
      <span class="sc-grip">⠿</span>
      <span class="sc-idx">${idx + 1}</span>
      <span class="sc-col-name">${meta.name}</span>
      <span class="sc-count" data-count="${k}">${g.items.length}</span>
      <span class="sc-move">
        <button data-movecol="up" data-k="${k}" title="往前挪一位" aria-label="往前挪一位">↑</button>
        <button data-movecol="down" data-k="${k}" title="往后挪一位" aria-label="往后挪一位">↓</button>
      </span>
    </header>
    <div class="sc-col-ctl">
      <label class="sc-check"><input type="checkbox" data-enable="${k}" ${g.enabled ? 'checked' : ''}><span>参与整理</span></label>
      <div class="sc-side" title="这一组挪到桌面的哪一边">
        <button data-side="left" data-k="${k}" class="${g.side === 'left' ? 'on' : ''}">左</button>
        <button data-side="right" data-k="${k}" class="${g.side === 'right' ? 'on' : ''}">右</button>
      </div>
    </div>
    ${bodyHtml}
    <div class="sc-more" data-morefoot="${k}"></div>
  </section>`;
}

async function openShortcuts() {
  if (sc.busy) return;
  sc.busy = true;
  const m = modal(
    '<div class="modal-head"><div><h3>整理桌面快捷方式</h3><p>正在读取桌面图标…</p></div></div>' +
    '<div class="modal-body"><div class="empty-state">读取中，大约需要 2 秒…</div></div>'
  );
  m.classList.add('wide');
  try {
    const d = await api('/api/shortcuts');
    sc.data = d;
    sc.order = d.order.slice();
    sc.gap = d.gap;
    sc.groups = {};
    for (const k of SC_KEYS) {
      sc.groups[k] = {
        enabled: d.enabled[k] !== false,
        side: d.sides[k] === 'right' ? 'right' : 'left',
        items: d.groups[k].map(x => ({ ...x }))
      };
    }
    sc.tray = d.groups.other.map(x => ({ ...x }));
    sc.fileOrder = Array.isArray(d.fileOrder) && d.fileOrder.length
      ? d.fileOrder.slice()
      : ['office', 'image', 'note', 'folder', 'archive', 'unknown'];
    sc.fileCounts = d.fileCounts || {};
    sc.fileMode = d.fileMode === 'folder' ? 'folder' : 'arrange';
    renderShortcuts();
  } catch (e) {
    m.innerHTML =
      `<div class="modal-head"><div><h3>整理桌面快捷方式</h3><p>读取失败</p></div><button class="modal-close" data-close>✕</button></div>` +
      `<div class="modal-body"><div class="empty-state">${escapeHtml(e.message)}</div></div>` +
      `<div class="modal-foot"><button class="btn" data-close>关闭</button></div>`;
    m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  } finally {
    sc.busy = false;
  }
}

function renderShortcuts() {
  const counting = k => sc.groups[k].enabled && !(k === 'file' && sc.fileMode === 'folder');
  const total = SC_KEYS.reduce((n, k) => n + (counting(k) ? sc.groups[k].items.length : 0), 0);
  const m = modal(`
    <div class="modal-head">
      <div>
        <h3>整理桌面快捷方式 <span class="tag-exp">实验性</span></h3>
        <p>只调整图标的位置 —— 不删除、不移动、不改名任何文件</p>
      </div>
      <div class="sc-head-right">
        <div class="sc-size" title="图标视图下调整图标大小（Ctrl + 滚轮也能调）">
          <span class="lbl">图标大小</span>
          <div class="seg" role="group" aria-label="图标大小">
            ${SC_SIZES.map((s, i) => `<button data-size="${i}" class="${sc.size === i ? 'on' : ''}" title="${s.label}图标">${s.label}</button>`).join('')}
          </div>
        </div>
        <div class="sc-viewseg" role="group" aria-label="显示方式">
          <button data-view="icon" class="${sc.mode === 'icon' ? 'on' : ''}" title="显示桌面图标的真实样子">图标</button>
          <button data-view="name" class="${sc.mode === 'name' ? 'on' : ''}" title="只显示名字，更紧凑">名字</button>
        </div>
        <button class="modal-close" data-close>✕</button>
      </div>
    </div>
    <div class="modal-body sc-body">
      ${sc.data && sc.data.metrics && sc.data.metrics.autoArrange ? `
        <div class="sc-warn">
          <strong>先关掉「自动排列图标」</strong>
          <div>桌面右键 → <b>查看</b> → 取消勾选 <b>自动排列图标</b>（「对齐到网格」可以留着）。否则 Windows 会立刻把图标弹回原位。</div>
        </div>` : ''}
      <div class="sc-guide">
        <div class="gi"><b>1</b><span><em>拖动图标</em> → 换到别的分类，或在组内调顺序</span></div>
        <div class="gi"><b>2</b><span><em>拖动整张卡片</em>（按标题条或卡片空白处，也可点 ↑↓）→ 同一侧里，面板从左到右就是桌面从左到右</span></div>
        <div class="gi"><b>3</b><span>勾选「参与整理」+ 选「左/右」→ 决定这组排桌面的哪一侧</span></div>
        <div class="gi"><b>4</b><span><em>桌面文件</em> → 六个类型只能<em>左右拖</em>，顺序就是它们在桌面上从左到右的先后</span></div>
      </div>
      <div class="sc-cols">${sc.order.map((k, i) => colHtml(k, i)).join('')}</div>
      <div class="sc-tray${sc.tray.length ? '' : ' empty'}">
        <div class="sc-tray-head">未归类 / 不参与 <span>这些图标不会被挪动，可以拖进上面的框</span></div>
        <div class="sc-tray-body" data-drop="tray">
          ${sc.tray.map(it => chipHtml(it, 'other')).join('')}
          <div class="sc-empty${sc.tray.length ? ' hidden' : ''}">没有未归类的图标</div>
        </div>
      </div>
    </div>
    <section class="pv-band${sc.pvOpen ? '' : ' collapsed'}" data-pvband>
      <div class="pv-head">
        <button class="pv-fold" data-pvfold title="${sc.pvOpen ? '收起效果图，给上面腾地方' : '展开效果图'}">${sc.pvOpen ? '▾' : '▸'}</button>
        <div class="pv-title"><b>桌面效果</b><i>灰点是现在的位置，彩点是重排后的位置</i></div>
        <div class="pv-flag" data-pvflag></div>
        <div class="sc-gap pv-gap">
          <span>组与组之间</span>
          <div class="seg">
            <button data-gap="keep" class="${sc.gap === 'keep' ? 'on' : ''}">另起一列</button>
            <button data-gap="fill" class="${sc.gap === 'fill' ? 'on' : ''}">不留空接着排</button>
          </div>
        </div>
      </div>
      <div class="pv-body">
        <div class="pv-canvas" data-pvcanvas><div class="pv-blank">正在算…</div></div>
        <div class="pv-legend" data-pvlegend></div>
      </div>
    </section>
    <div class="modal-foot">
      <div class="sc-foot-left">
        <span class="muted" style="font-size:12px">本次会挪动 <b data-total>${total}</b> 个图标</span>
      </div>
      <button class="btn" data-close>取消</button>
      <button class="btn primary" data-run ${total ? '' : 'disabled'}>确认重排</button>
    </div>
  `, { dismissible: false });
  m.classList.add('wide', 'sc-modal', sc.mode === 'icon' ? 'view-icon' : 'view-name');
  bindScEvents(m);
  applyScIconSize();
  renumberCols();
  requestAnimationFrame(updateScFades);
  loadScIcons();
  schedulePv(0);
}

/* ---------- 局部刷新（不重建 DOM，所以拖动时不会闪一下） ---------- */
function scChrome() {
  const m = document.querySelector('.sc-modal');
  if (!m) return;
  let total = 0;
  for (const k of SC_KEYS) {
    const g = sc.groups[k];
    const col = m.querySelector(`.sc-col[data-col="${k}"]`);
    if (!col) continue;
    col.classList.toggle('off', !g.enabled);
    const cb = col.querySelector('[data-enable]');
    if (cb) cb.checked = g.enabled;
    const cnt = col.querySelector('[data-count]');
    if (cnt) cnt.textContent = g.items.length;
    const isCounting = g.enabled && !(k === 'file' && sc.fileMode === 'folder');
    col.classList.toggle('counting', isCounting);
    if (isCounting) total += g.items.length;
  }
  const t = m.querySelector('[data-total]');
  if (t) t.textContent = total;
  const run = m.querySelector('[data-run]');
  if (run) run.disabled = total === 0;
  const trayEl = m.querySelector('.sc-tray');
  if (trayEl) trayEl.classList.toggle('empty', sc.tray.length === 0);
  for (const k of [...SC_KEYS, 'tray']) {
    const zone = m.querySelector(`[data-drop="${k}"]`);
    if (!zone) continue;
    const empty = zone.querySelector('.sc-empty');
    const has = zone.querySelector('.sc-chip');
    if (empty) empty.classList.toggle('hidden', !!has);
  }
  schedulePv();
}

function setScView(mode) {
  sc.mode = mode === 'name' ? 'name' : 'icon';
  try { localStorage.setItem(SC_VIEW_KEY, sc.mode); } catch { /* ignore */ }
  const m = document.querySelector('.sc-modal');
  if (m) {
    m.classList.toggle('view-icon', sc.mode === 'icon');
    m.classList.toggle('view-name', sc.mode === 'name');
  }
  m.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === sc.mode));
  requestAnimationFrame(updateScFades);
}

/* 图标大小：只改 CSS 变量，不重建 DOM，所以不会闪 */
function applyScIconSize() {
  const m = document.querySelector('.sc-modal');
  const s = SC_SIZES[sc.size];
  if (m) {
    m.style.setProperty('--sc-icon', s.icon + 'px');
    m.style.setProperty('--sc-tile', s.tile + 'px');
  }
  document.querySelectorAll('[data-size]').forEach(b => b.classList.toggle('on', Number(b.dataset.size) === sc.size));
  requestAnimationFrame(updateScFades);
}

function setScSize(i) {
  const n = Math.min(SC_SIZES.length - 1, Math.max(0, i));
  if (n === sc.size) return;
  sc.size = n;
  try { localStorage.setItem(SC_SIZE_KEY, String(n)); } catch { /* ignore */ }
  applyScIconSize();
}

/* ---------- 图标 ---------- */
async function loadScIcons() {
  const need = [];
  for (const k of [...SC_KEYS, 'tray']) for (const it of scItems(k)) if (!it.iconUrl && it.file) need.push(it);
  if (!need.length) return;
  const seq = ++sc.iconSeq;
  for (let i = 0; i < need.length; i += 20) {
    const chunk = need.slice(i, i + 20);
    try {
      const r = await api('/api/shortcuts/icons', { items: chunk.map(x => ({ file: x.file, key: x.iconKey })) });
      if (seq !== sc.iconSeq) return;
      paintIcons(r.icons || {});
    } catch { /* 取不到图标就用首字母占位，不影响整理 */ }
  }
}

function paintIcons(map) {
  if (!map || !Object.keys(map).length) return;
  for (const k of [...SC_KEYS, 'tray']) {
    for (const it of scItems(k)) {
      const url = map[it.iconKey];
      if (url) it.iconUrl = url;
    }
  }
  document.querySelectorAll('.sc-chip').forEach(el => {
    const url = map[el.dataset.key];
    if (!url) return;
    const box = el.querySelector('.sc-ic');
    if (!box || box.querySelector('img')) return;
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.addEventListener('load', () => box.classList.add('has'));
    img.src = url;
    box.appendChild(img);
  });
  requestAnimationFrame(updateScFades);
}

/* 列里内容超出时：底部渐隐 + 明确提示还剩多少个 */
function updateScFades() {
  document.querySelectorAll('.sc-modal .sc-col').forEach(col => {
    const z = col.querySelector('.sc-drop');
    const foot = col.querySelector('[data-morefoot]');
    if (!z) return;
    const can = z.scrollHeight > z.clientHeight + 4;
    z.classList.toggle('can-scroll', can);
    z.classList.toggle('at-end', can && z.scrollTop + z.clientHeight >= z.scrollHeight - 6);
    if (!foot) return;
    const zr = z.getBoundingClientRect();
    let n = 0;
    z.querySelectorAll('.sc-chip').forEach(el => {
      if (el.getBoundingClientRect().bottom > zr.bottom + 4) n++;
    });
    foot.textContent = n ? `还有 ${n} 个 · 往下滚` : '';
    foot.classList.toggle('show', n > 0);
  });
}

/* ---------- 事件 ---------- */
function bindScEvents(m) {
  m.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { closeModal(); return; }

    const viewBtn = e.target.closest('.sc-modal [data-view]');
    if (viewBtn) { setScView(viewBtn.dataset.view); return; }

    const sizeBtn = e.target.closest('[data-size]');
    if (sizeBtn) { setScSize(Number(sizeBtn.dataset.size)); return; }

    const sideBtn = e.target.closest('[data-side]');
    if (sideBtn) {
      const k = sideBtn.dataset.k;
      sc.groups[k].side = sideBtn.dataset.side;
      sideBtn.parentNode.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === sideBtn));
      schedulePv();
      return;
    }

    const moveBtn = e.target.closest('[data-movecol]');
    if (moveBtn) { moveColByOne(moveBtn.dataset.k, moveBtn.dataset.movecol === 'up' ? -1 : 1); return; }

    const gapBtn = e.target.closest('[data-gap]');
    if (gapBtn) {
      sc.gap = gapBtn.dataset.gap;
      gapBtn.parentNode.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === gapBtn));
      schedulePv(0);
      return;
    }

    if (e.target.closest('[data-pvfold]')) { setPvOpen(!sc.pvOpen); return; }

    if (e.target.closest('[data-run]')) applyShortcuts(e.target.closest('[data-run]'));
  });

  m.addEventListener('change', (e) => {
    if (e.target.dataset && e.target.dataset.archive !== undefined) {
      sc.fileMode = e.target.checked ? 'folder' : 'arrange';
      // 要归档就一定得“参与整理”，顺手替用户勾上，避免勾了却没反应
      if (e.target.checked) sc.groups.file.enabled = true;
      scChrome();
      return;
    }
    const k = e.target.dataset && e.target.dataset.enable;
    if (!k) return;
    sc.groups[k].enabled = e.target.checked;
    scChrome();
  });

  m.addEventListener('dragstart', (e) => {
    // 整张卡片都是 drag 手柄，所以先判断这次抓的是「卡片里的东西」还是「卡片本身」。
    // 顺序很重要：图块/类型 → 控件 → 卡片
    const ft = e.target.closest('[data-ftype]');
    if (ft) {
      sc.drag = { kind: 'ftype', key: ft.dataset.ftype, el: ft };
      ft.classList.add('dragging');
      m.classList.add('is-dragging');
      try {
        e.dataTransfer.setData('text/plain', ft.dataset.ftype);
        e.dataTransfer.effectAllowed = 'move';
      } catch { /* ignore */ }
      return;
    }
    const chip = e.target.closest('.sc-chip');
    if (chip) {
      sc.drag = { kind: 'chip', el: chip };
      chip.classList.add('dragging');
      m.classList.add('is-dragging');
      try {
        e.dataTransfer.setData('text/plain', chip.dataset.name);
        e.dataTransfer.effectAllowed = 'move';
      } catch { /* ignore */ }
      return;
    }
    // 点按钮、勾选框、左/右切换时不能把整张卡片带起来
    if (e.target.closest('button, input, label, a')) { e.preventDefault(); return; }

    const col = e.target.closest('.sc-cols > .sc-col');
    if (col) {
      sc.drag = { kind: 'col', key: col.dataset.col, el: col };
      col.classList.add('dragging');
      m.classList.add('is-dragging');
      try {
        e.dataTransfer.setData('text/plain', col.dataset.col);
        e.dataTransfer.effectAllowed = 'move';
        // 拖一整张卡片太糊，用标题条当拖动时的影子
        const head = col.querySelector('.sc-col-head') || col;
        e.dataTransfer.setDragImage(head, 24, 16);
      } catch { /* ignore */ }
    }
  });

  m.addEventListener('dragend', () => clearScDrag());
  m.addEventListener('scroll', updateScFades, true);

  // Ctrl + 滚轮：不放鼠标去找按钮也能改图标大小
  m.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || sc.mode !== 'icon') return;
    if (e.target.closest('.sc-modal-head, .modal-head')) return;
    e.preventDefault();
    setScSize(sc.size + (e.deltaY > 0 ? 1 : -1));
  }, { passive: false });

  m.addEventListener('dragover', (e) => {
    if (!sc.drag) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
    if (sc.drag.kind === 'ftype') updateFtypeDrop(e);
    else if (sc.drag.kind === 'col') updateColDrop(e);
    else updateChipDrop(e);
  });

  m.addEventListener('drop', (e) => {
    if (!sc.drag) return;
    e.preventDefault();
    if (sc.drag.kind === 'ftype') commitFtypeDrop();
    else if (sc.drag.kind === 'col') commitColDrop();
    else commitChipDrop();
    clearScDrag();
  });
}

/* 桌面文件六类的拖动排序：还是「离谁近就插到谁旁边」，只是限定在这一个框里 */
function updateFtypeDrop(e) {
  const el = sc.drag.el;
  const row = document.querySelector('.sc-ftrow');
  if (!row) return;
  const rr = row.getBoundingClientRect();
  // 已经把类型拖出这个框了：不留提示，松手也不算数，免得手一滑就跑到队尾
  if (e.clientX < rr.left - 40 || e.clientX > rr.right + 40
    || e.clientY < rr.top - 30 || e.clientY > rr.bottom + 30) {
    if (sc.drop && sc.drop.kind === 'ftype') {
      row.querySelectorAll('.sc-ftile.drop-before, .sc-ftile.drop-after')
        .forEach(x => x.classList.remove('drop-before', 'drop-after'));
      sc.drop = null;
    }
    return;
  }
  const tiles = [...row.querySelectorAll('.sc-ftile')].filter(x => x !== el);
  const index = flowInsertIndex(tiles.map(x => x.getBoundingClientRect()), e.clientX, e.clientY);
  if (sc.drop && sc.drop.kind === 'ftype' && sc.drop.index === index) return;
  sc.drop = { kind: 'ftype', index };
  row.querySelectorAll('.sc-ftile').forEach(x => x.classList.remove('drop-before', 'drop-after'));
  if (tiles[index]) tiles[index].classList.add('drop-before');
  else if (tiles.length) tiles[tiles.length - 1].classList.add('drop-after');

  // 一行放不下要横向滚的时候，拖到两端让它自己滚一下
  if (row.scrollWidth > row.clientWidth + 2) {
    if (e.clientX > rr.right - 18) row.scrollLeft += 10;
    else if (e.clientX < rr.left + 18) row.scrollLeft -= 10;
  }
}

function commitFtypeDrop() {
  if (!sc.drag || sc.drag.kind !== 'ftype' || !sc.drop || sc.drop.kind !== 'ftype') return;
  const key = sc.drag.key;
  const rest = sc.fileOrder.filter(k => k !== key);
  const idx = Math.min(rest.length, Math.max(0, sc.drop.index));
  rest.splice(idx, 0, key);
  sc.fileOrder = rest;
  const row = document.querySelector('.sc-ftrow');
  if (row) row.innerHTML = fileTilesHtml();
  schedulePv(0);
}

function clearScDropHints() {
  document.querySelectorAll('.sc-col.ins-a, .sc-col.ins-b').forEach(el => el.classList.remove('ins-a', 'ins-b'));
  document.querySelectorAll('.sc-drop.over, .sc-tray-body.over').forEach(el => el.classList.remove('over'));
  document.querySelectorAll('.sc-chip.drop-before').forEach(el => el.classList.remove('drop-before'));
  document.querySelectorAll('.sc-ftile.drop-before, .sc-ftile.drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
  document.querySelectorAll('.sc-drop.drop-end, .sc-tray-body.drop-end').forEach(el => el.classList.remove('drop-end'));
  sc.drop = null;
}

function clearScDrag() {
  if (sc.drag && sc.drag.el) sc.drag.el.classList.remove('dragging');
  sc.drag = null;
  clearScDropHints();
  const m = document.querySelector('.sc-modal');
  if (m) m.classList.remove('is-dragging');
}

/* 落点怎么算：找离鼠标最近的那个元素，鼠标落在它右半边就插到它后面。
   窗口宽的时候是一行，窄的时候会折成两行两列 —— 这套算法两种都对。 */
function flowInsertIndex(rects, x, y) {
  if (!rects.length) return 0;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  const r = rects[best];
  return x > r.left + r.width / 2 ? best + 1 : best;
}

/* 列拖拽：算出会插到第几个（折行时按上下左右一起算） */
function updateColDrop(e) {
  const cols = [...document.querySelectorAll('.sc-cols > .sc-col')].filter(el => el !== sc.drag.el);
  const index = flowInsertIndex(cols.map(el => el.getBoundingClientRect()), e.clientX, e.clientY);
  if (sc.drop && sc.drop.kind === 'col' && sc.drop.index === index) return;
  sc.drop = { kind: 'col', index };
  document.querySelectorAll('.sc-col.ins-a, .sc-col.ins-b').forEach(el => el.classList.remove('ins-a', 'ins-b'));
  if (!cols.length) return;
  if (index < cols.length) cols[index].classList.add('ins-a');
  else cols[cols.length - 1].classList.add('ins-b');
}

function commitColDrop() {
  const drag = sc.drag;
  if (!drag || !sc.drop) return;
  const cols = [...document.querySelectorAll('.sc-cols > .sc-col')].filter(el => el !== drag.el);
  const ref = cols[sc.drop.index] || null;
  drag.el.parentNode.insertBefore(drag.el, ref);
  renumberCols();
  sc.order = [...document.querySelectorAll('.sc-cols > .sc-col')].map(el => el.dataset.col);
  schedulePv(0);
}

function renumberCols() {
  const cols = [...document.querySelectorAll('.sc-cols > .sc-col')];
  cols.forEach((el, i) => {
    const idx = el.querySelector('.sc-idx');
    if (idx) idx.textContent = i + 1;
    const up = el.querySelector('[data-movecol="up"]');
    const down = el.querySelector('[data-movecol="down"]');
    if (up) up.disabled = i === 0;
    if (down) down.disabled = i === cols.length - 1;
  });
}

function moveColByOne(key, delta) {
  const cols = [...document.querySelectorAll('.sc-cols > .sc-col')];
  const from = cols.findIndex(el => el.dataset.col === key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= cols.length) return;
  const el = cols[from];
  if (delta > 0) el.parentNode.insertBefore(el, cols[to].nextSibling);
  else el.parentNode.insertBefore(el, cols[to]);
  renumberCols();
  sc.order = [...document.querySelectorAll('.sc-cols > .sc-col')].map(e => e.dataset.col);
  schedulePv(0);
}

/* 图块拖拽：找离鼠标最近的那个图块，鼠标在它左半就插到前面、右半就插到后面。
   比按行列硬算稳得多——窗口宽窄、图标大小、名字长短都不会让落点跑偏。 */
function chipInsertIndex(container, x, y, draggedEl) {
  const chips = [...container.querySelectorAll('.sc-chip')].filter(el => el !== draggedEl);
  if (!chips.length) return 0;
  let best = 0;
  let bestD = Infinity;
  chips.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  });
  const r = chips[best].getBoundingClientRect();
  return x > r.left + r.width / 2 ? best + 1 : best;
}

function updateChipDrop(e) {
  let zone = e.target.closest('[data-drop]');
  if (!zone) {
    const col = e.target.closest('.sc-col');
    const tray = e.target.closest('.sc-tray');
    if (col) zone = col.querySelector('[data-drop]');
    else if (tray) zone = tray.querySelector('[data-drop]');
  }
  if (!zone) return;
  const index = chipInsertIndex(zone, e.clientX, e.clientY, sc.drag.el);
  if (sc.drop && sc.drop.kind === 'chip' && sc.drop.zone === zone && sc.drop.index === index) return;

  sc.drop = { kind: 'chip', zone, index };
  document.querySelectorAll('.sc-drop.over, .sc-tray-body.over').forEach(el => { if (el !== zone) el.classList.remove('over'); });
  document.querySelectorAll('.sc-col.ins-a, .sc-col.ins-b').forEach(el => el.classList.remove('ins-a', 'ins-b'));
  zone.classList.add('over');
  document.querySelectorAll('.sc-chip.drop-before').forEach(el => el.classList.remove('drop-before'));
  document.querySelectorAll('.drop-end').forEach(el => el.classList.remove('drop-end'));
  const chips = [...zone.querySelectorAll('.sc-chip')].filter(el => el !== sc.drag.el);
  if (index < chips.length) chips[index].classList.add('drop-before');
  else zone.classList.add('drop-end');
}

function commitChipDrop() {
  const drag = sc.drag;
  if (!drag || !sc.drop || sc.drop.kind !== 'chip') return;
  const { zone, index } = sc.drop;
  const chips = [...zone.querySelectorAll('.sc-chip')].filter(el => el !== drag.el);
  zone.insertBefore(drag.el, chips[index] || null);
  drag.el.dataset.from = zone.dataset.drop;
  const key = zone.dataset.drop;
  if (key !== 'tray' && sc.groups[key] && !sc.groups[key].enabled) {
    sc.groups[key].enabled = true;
  }
  syncModelFromDom();
  scChrome();
  updateScFades();
}

function syncModelFromDom() {
  const pool = new Map();
  for (const k of [...SC_KEYS, 'tray']) for (const it of scItems(k)) pool.set(it.name + '#' + it.occ, it);
  for (const k of SC_KEYS) {
    sc.groups[k].items = [...document.querySelectorAll(`.sc-drop[data-drop="${k}"] .sc-chip`)]
      .map(el => pool.get(el.dataset.name + '#' + el.dataset.occ)).filter(Boolean);
  }
  sc.tray = [...document.querySelectorAll('.sc-tray-body .sc-chip')]
    .map(el => pool.get(el.dataset.name + '#' + el.dataset.occ)).filter(Boolean);
}

/* ---------- 预览 / 执行 ---------- */
function scPayload() {
  const groups = {};
  for (const k of SC_KEYS) {
    groups[k] = {
      enabled: sc.groups[k].enabled,
      side: sc.groups[k].side,
      items: sc.groups[k].items.map(i => ({ name: i.name, occ: i.occ }))
    };
  }
  return {
    order: sc.order, gap: sc.gap, groups,
    fileOrder: sc.fileOrder.slice(), fileMode: sc.fileMode
  };
}

/**
 * 桌面缩略图。
 * 点有多大 = 桌面上一格图标有多大，按比例缩过来 —— 不能写死：
 * 同一块屏幕，图标调大以后桌面可能只剩 20 列，调小能放 34 列，
 * 写死的点会让 34 列糊成一片、让 20 列散成芝麻。
 * 坐标是图标左上角，缩略图里按格子中心摆，看起来才和真桌面一样。
 */
function scMapHtml(metrics, positions, opts) {
  opts = opts || {};
  const m = metrics;
  const w = Math.max(120, Math.round(opts.w || 520));
  const h = Math.max(80, Math.round(opts.h || 260));
  const pad = 6;                       // 留一圈，最边上的点才不会被圆角切掉
  const iw = w - pad * 2;
  const ih = h - pad * 2;
  const halfW = m.cellW * 0.5;
  const halfH = m.cellH * 0.42;
  const L = v => (pad + (v + halfW) / m.clientW * iw).toFixed(1);
  const T = v => (pad + (v + halfH) / m.clientH * ih).toFixed(1);
  const cellPx = iw * (m.cellW / m.clientW);
  const dot = Math.max(3, Math.min(14, Math.round(cellPx * 0.52)));
  const ghost = Math.max(2, Math.round(dot * 0.8));
  const ghosts = (sc.data && sc.data.ghosts ? sc.data.ghosts : []).map(g =>
    `<i class="now" style="left:${L(g.x)}px;top:${T(g.y)}px"></i>`
  ).join('');
  const dots = (positions || []).map(p =>
    `<i class="target" style="left:${L(p.x)}px;top:${T(p.y)}px;background:${(SC_META[p.group] || {}).color || '#64748b'}"></i>`
  ).join('');
  return `<div class="sc-map pv-map" style="width:${w}px;height:${h}px;--d:${dot}px;--gd:${ghost}px">${ghosts}${dots}</div>`;
}

/**
 * 效果图该占多大：先量这一条实际能用多宽，再按桌面比例定高。
 * 宽的时候左图右字；窄了（小屏、150% 缩放、窗口拉窄）就把字挪到图下面，
 * 否则图例会被挤出面板 —— 那正是「显示不全」的来源。
 */
function pvFit() {
  const body = document.querySelector('.pv-body');
  const m = (sc.preview && sc.preview.metrics) || (sc.data && sc.data.metrics);
  if (!body || !m || !m.clientW) return null;
  const avail = body.clientWidth;
  if (!avail) return null;
  const stack = avail < 700;
  body.classList.toggle('stack', stack);
  const gap = 16;
  const legendW = stack ? 0 : Math.min(330, Math.max(190, Math.round(avail * 0.3)));
  const roomW = stack ? avail : avail - legendW - gap;
  const ratio = m.clientH / m.clientW;
  // 高度上限跟着窗口走：矮屏幕（768 那个级别）别把上半部分挤没了
  const hCap = Math.round(Math.min(300, Math.max(120, (window.innerHeight || 900) * 0.26)));
  let w = Math.max(120, roomW);
  let h = Math.round(w * ratio);
  if (h > hCap) { h = hCap; w = Math.round(h / ratio); }
  if (w > roomW) { w = roomW; h = Math.round(w * ratio); }
  body.style.setProperty('--pv-legend-w', stack ? '100%' : legendW + 'px');
  return { w, h };
}

function paintPv(r, el) {
  el = el || pvScope();
  if (!el.canvas) return;
  sc.preview = r;
  paintPvMap(el, true);
  if (el.legend) el.legend.innerHTML = pvLegendHtml(r);
  if (el.flag) el.flag.innerHTML = pvFlagHtml(r);
}

/* 只重画桌面图（窗口变化、换排法都用得上），图例不动 */
function paintPvMap(el, flash) {
  el = el || pvScope();
  if (!el.canvas || !sc.preview) return;
  const size = pvFit();
  if (!size) return;
  const key = size.w + 'x' + size.h;
  if (el.canvas.dataset.size === key && !flash) return;
  el.canvas.dataset.size = key;
  el.canvas.innerHTML = scMapHtml(sc.preview.metrics, sc.preview.positions, size);
  if (flash) {
    // 轻轻闪一下，让人看到「这张图刚刚更新了」
    el.canvas.classList.remove('flash');
    void el.canvas.offsetWidth;
    el.canvas.classList.add('flash');
  }
}

/* ---------- 面板里的实时效果图 ---------- */
const pvRun = { timer: 0, inflight: false, dirty: false, seq: 0 };

function pvScope() {
  return {
    band: document.querySelector('[data-pvband]'),
    canvas: document.querySelector('[data-pvcanvas]'),
    legend: document.querySelector('[data-pvlegend]'),
    flag: document.querySelector('[data-pvflag]')
  };
}

/* 任何一次改动（拖图标、拖类型、换左右、换排法、勾归档）都会走到这里。
   80 毫秒的合并窗口：连续拖动时只在停下来的那一刻算一次。 */
function schedulePv(delay) {
  if (!sc.pvOpen) return;
  clearTimeout(pvRun.timer);
  pvRun.timer = setTimeout(runPv, delay == null ? 80 : delay);
}

async function runPv() {
  const el = pvScope();
  if (!el.band || !el.canvas) return;
  if (pvRun.inflight) { pvRun.dirty = true; return; }
  pvRun.inflight = true;
  const seq = ++pvRun.seq;
  try {
    const r = await api('/api/shortcuts/layout', scPayload());
    if (seq !== pvRun.seq) return;
    paintPv(r, el);
  } catch (e) {
    if (seq !== pvRun.seq) return;
    paintPvError(e.message, el);
  } finally {
    pvRun.inflight = false;
    if (pvRun.dirty) { pvRun.dirty = false; schedulePv(0); }
  }
}

function paintPvError(msg, el) {
  el = el || pvScope();
  sc.preview = null;
  if (!el.canvas) return;
  el.canvas.innerHTML = `<div class="pv-blank">${escapeHtml(msg || '暂时算不出来')}</div>`;
  if (el.legend) el.legend.innerHTML = '';
  if (el.flag) el.flag.innerHTML = '';
}

function pvLegendHtml(r) {
  const rows = r.summary.map(s => {
    const meta = SC_META[s.key] || { name: s.key, color: '#64748b' };
    // 「不留空接着排」时相邻两组会共用列，说「占 N 列」容易让人以为互不相干
    const shared = r.gap === 'fill' && r.summary.some(o =>
      o.key !== s.key && o.side === s.side && o.cols.some(c => s.cols.includes(c)));
    const span = shared ? '和相邻的组接在同一列' : (s.cols.length > 1 ? `占 ${s.cols.length} 列` : '占 1 列');
    return `<div class="pv-row">
      <span class="sw" style="background:${meta.color}"></span>
      <b>${meta.name}</b>
      <span class="mut">${s.side === 'left' ? '左侧' : '右侧'} · ${s.count} 个 · ${span}</span>
    </div>`;
  }).join('');

  const arch = r.fileMode === 'folder'
    ? `<div class="pv-row">
        <span class="sw" style="background:${SC_META.file.color}"></span>
        <b>桌面文件</b>
        <span class="mut">归档进 6 个文件夹 · ${r.archivedCount} 个</span>
      </div>`
    : '';

  const warn = r.overflow
    ? `<div class="pv-warn">有 ${r.overflow} 个图标没找到空位，会留在原地 —— 试试「不留空接着排」或者少勾一组。</div>`
    : '';

  return `${rows}${arch}${warn}
    <div class="pv-note">同一侧内，从左到右就是面板从左到右 · 已避开桌面上的文件、文件夹和系统图标${r.nonShortcut ? `（这类不参与的有 ${r.nonShortcut} 个）` : ''}</div>`;
}

function pvFlagHtml(r) {
  if (r.overflow) return `<span class="pv-chip warn">位置不够</span>`;
  if (r.fileMode === 'folder') return `<span class="pv-chip">归档 ${r.archivedCount} 个文件</span>`;
  return '';
}

function setPvOpen(open) {
  sc.pvOpen = !!open;
  try { localStorage.setItem(SC_PV_KEY, sc.pvOpen ? '1' : '0'); } catch { /* ignore */ }
  const band = document.querySelector('[data-pvband]');
  if (band) band.classList.toggle('collapsed', !sc.pvOpen);
  const btn = document.querySelector('[data-pvfold]');
  if (btn) {
    btn.textContent = sc.pvOpen ? '▾' : '▸';
    btn.title = sc.pvOpen ? '收起效果图，给上面腾地方' : '展开效果图';
  }
  if (sc.pvOpen) schedulePv(0);
}

/* 窗口大小变了（最大化、拉窄、换显示器）：重新量一次可用宽度再画图。
   只重画图，不重新请求，所以是瞬时的。 */
let pvResizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(pvResizeTimer);
  pvResizeTimer = setTimeout(() => {
    if (!document.querySelector('.sc-modal')) return;
    requestAnimationFrame(() => {
      updateScFades();
      paintPvMap(null, false);
    });
  }, 120);
});

/* 归档会真的移动文件，先问一次 */
function confirmArchive(n) {
  return new Promise((resolve) => {
    const m = modal(`
      <div class="modal-head">
        <div><h3>把 ${n} 个桌面文件移进文件夹？</h3><p>这一步会真的移动文件，不只是挪图标</p></div>
      </div>
      <div class="modal-body">
        <div class="bk-note">桌面上会建 6 个文件夹（办公文档 / 图片 / 记事本 / 文件夹 / 压缩包 / 未知文件），
        然后按类型把文件放进去。同一类里重名的会自动加序号，不会覆盖任何东西。</div>
        <ul class="bk-points">
          <li><b>搬完能撤回</b>：这次移动会记进「整理记录」，随时可以一键还原。</li>
          <li><b>建议先备份</b>：万一搬乱了，「桌面备份」里能拿回来。</li>
        </ul>
      </div>
      <div class="modal-foot">
        <button class="btn" data-no>再想想</button>
        <button class="btn primary" data-yes>确认移动</button>
      </div>
    `, { dismissible: false });
    m.querySelector('[data-no]').addEventListener('click', () => { closeModal(); resolve(false); });
    m.querySelector('[data-yes]').addEventListener('click', () => { closeModal(); resolve(true); });
  });
}

async function applyShortcuts() {
  if (sc.busy) return;
  const fileCount = sc.groups.file ? sc.groups.file.items.length : 0;
  if (sc.fileMode === 'folder' && fileCount > 0) {
    const ok = await confirmArchive(fileCount);
    if (!ok) { renderShortcuts(); return; }
  }

  // 先换成「正在重排」，否则确认框一关就是几秒钟的白屏
  sc.busy = true;
  const total = SC_KEYS.reduce((n, k) => n + (sc.groups[k].enabled && !(k === 'file' && sc.fileMode === 'folder')
    ? sc.groups[k].items.length : 0), 0);
  modal(`
    <div class="modal-head"><div><h3>正在重排</h3><p>把 ${total} 个图标摆到新位置，大约需要 3 秒</p></div></div>
    <div class="modal-body"><div class="empty-state">正在挪图标… 期间桌面可能会闪一下，别动鼠标就好</div></div>
  `, { dismissible: false });

  try {
    const r = await api('/api/shortcuts/apply', scPayload());
    sc.busy = false;
    showScResult(r);
  } catch (e) {
    sc.busy = false;
    // 失败就回到面板，让用户能改完再试（而不是停在一个死掉的弹窗上）
    renderShortcuts();
    toast(e.message, true);
  }
}

function showScResult(r) {
  const rows = (r.summary || []).map(s => {
    const meta = SC_META[s.key];
    return `<div class="sc-sum-row">
      <span class="sw" style="background:${meta.color}"></span>
      <span>${meta.name}</span>
      <span class="muted">→ 桌面${s.side === 'left' ? '左' : '右'}侧 · ${s.count} 个</span>
    </div>`;
  }).join('');

  const m = modal(`
    <div class="modal-head">
      <div><h3>重排完成</h3><p>只挪了图标位置，桌面上的文件一个都没动</p></div>
      <button class="modal-close" data-close>✕</button>
    </div>
    <div class="modal-body">
      <div class="result-hero">
        <div class="result-icon">✓</div>
        <div class="result-title">已重排 ${r.moved} 个图标</div>
        <div class="result-desc">${r.overflow ? `有 ${r.overflow} 个没找到空位，留在原地` : '只挪了位置，桌面上的文件一个都没动'}</div>
      </div>
      <div class="sc-summary">${rows}</div>
      ${r.archive ? `<div class="result-tip">已把 ${r.archive.moved} 个文件移进 6 个分类文件夹${r.archive.failed ? `（${r.archive.failed} 个没搬成功）` : ''}。</div>` : ''}
      ${r.adjusted ? `<div class="result-tip">有 ${r.adjusted} 个图标被系统顺带挤开了一格，已经自动补正。</div>` : ''}
      ${r.remembered ? `<div class="result-tip">已记住你调整的 ${r.remembered} 个分类，下次打开直接就是对的。</div>` : ''}
      <div class="hint-box">不满意？点「还原到原来的位置」就能把全部图标挪回去，一步撤回。</div>
    </div>
    <div class="modal-foot">
      <button class="btn danger-ghost" data-undo>还原到原来的位置</button>
      <button class="btn primary" data-close>完成</button>
    </div>
  `);
  m.classList.add('wide');
  m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));

  showUndoBar({
    kind: 'icons',
    id: r.logId || '',
    archiveId: r.archive ? r.archive.id : '',
    text: r.archive
      ? `刚重排了 ${r.moved} 个图标，并把 ${r.archive.moved} 个文件归档`
      : `刚重排了 ${r.moved} 个图标`
  });

  const undoBtn = m.querySelector('[data-undo]');
  undoBtn.addEventListener('click', async () => {
    undoBtn.disabled = true;
    undoBtn.textContent = '还原中…';
    try {
      const res = await api('/api/shortcuts/undo', { id: r.logId });
      closeModal();
      hideUndoBar();
      toast(`已还原 ${res.restored} 个图标的位置${res.skipped ? `，${res.skipped} 个已被你挪过所以没动` : ''}`);
    } catch (e) {
      undoBtn.disabled = false;
      undoBtn.textContent = '还原到原来的位置';
      toast(e.message, true);
    }
  });
}
/* ---------------- 清理桌面 ---------------- */
const CL_ICON = {
  danger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.6 2.9 19.4h18.2z"/><path d="M12 9.6v4.2"/><circle cx="12" cy="16.9" r=".7" fill="currentColor" stroke="none"/></svg>',
  uninstall: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.6h16"/><path d="M6.6 7.6 7.5 19a1.7 1.7 0 0 0 1.7 1.5h5.6A1.7 1.7 0 0 0 16.5 19l.9-11.4"/><path d="M9.6 7.6V5.4A1.4 1.4 0 0 1 11 4h2a1.4 1.4 0 0 1 1.4 1.4v2.2"/><path d="M10.6 11.4v5.4M13.4 11.4v5.4"/></svg>'
};

const clUI = {
  ack: false,        // 未备份时用户自己勾的风险确认（只对本次打开有效）
  scan: null,
  logs: [],
  sel: new Set(),
  modal: null,
  busy: false,
  arm: false,        // 危险按钮的「再点一次确认」
  armTimer: 0
};

/** 备份过了，或者用户自己认了风险 */
function cleanGateOk() {
  return backupReady() || clUI.ack;
}

function renderCleanGate() {
  const el = $('#clGate');
  if (!el) return;
  const b = state.backup || {};

  if (b.hasBackup) {
    const last = b.last;
    el.innerHTML = `
      <div class="cl-gate-in ok">
        <span class="cl-gate-ic" aria-hidden="true">✓</span>
        <div class="cl-gate-txt">
          <b>已经备份过桌面</b>
          <p>${last ? `上次备份 ${fmtDate(last.at)}，一共 ${b.count || 1} 份。` : ''}清掉的快捷方式在回收站和本地各留一份，随时能放回桌面。</p>
        </div>
        <button class="btn" data-cl-gobk>再备份一次</button>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="cl-gate-in warn">
      <span class="cl-gate-ic" aria-hidden="true">!</span>
      <div class="cl-gate-txt">
        <b>还没有备份过桌面</b>
        <p>清理会把勾选的快捷方式从桌面上删掉。没有备份就清理，只能靠回收站找回来 —— 建议先花十几秒备份一次。</p>
      </div>
      <button class="btn primary" data-cl-gobk>去备份（推荐）</button>
    </div>
    <label class="cl-risk${clUI.ack ? ' on' : ''}">
      <input type="checkbox" data-cl-ack ${clUI.ack ? 'checked' : ''}>
      <span>我知道未备份就清理桌面图标的风险，仍然继续
        <em>勾上之后本次可以直接清理；关掉软件再打开要重新确认。</em></span>
    </label>`;
}

function renderCleanCards() {
  const el = $('#clCards');
  if (!el) return;
  const s = clUI.scan;
  const broken = s ? s.counts.broken : 0;
  const suspect = s ? s.counts.suspect : 0;
  const total = broken + suspect;

  const badge = !s
    ? '<span class="cl-badge">未扫描</span>'
    : (total ? `<span class="cl-badge hot">${total} 个</span>` : '<span class="cl-badge ok">0 个</span>');

  let body;
  if (!s) {
    body = `<p class="cl-card-p">扫描是只读的：只检查每个快捷方式还指不指得到东西，不动桌面上任何文件。扫完会列出清单，你再决定清哪些。</p>`;
  } else if (!total) {
    body = `<p class="cl-card-p good">桌面很干净，没有发现失效的快捷方式。</p>
      <p class="cl-card-sub">检查了 ${s.counts.scanned} 个快捷方式${s.counts.skipped ? `，${s.counts.skipped} 个（网络位置 / 应用商店应用）没法判断，已跳过` : ''}。</p>`;
  } else {
    body = `<div class="cl-sum">
        ${broken ? `<span class="cl-sum-i bad"><b>${broken}</b> 个确定失效</span>` : ''}
        ${suspect ? `<span class="cl-sum-i soft"><b>${suspect}</b> 个可能是 U 盘 / 移动硬盘没插</span>` : ''}
      </div>
      <p class="cl-card-sub">上次扫描：${fmtDate(s.at)}，共检查 ${s.counts.scanned} 个快捷方式${s.counts.skipped ? `，跳过 ${s.counts.skipped} 个没法判断的` : ''}。</p>`;
  }

  const btnLabel = !s ? '开始扫描' : (total ? '查看并清理' : '再扫一次');

  el.innerHTML = `
    <article class="cl-card">
      <div class="cl-card-top">
        <div class="cl-ico warn" aria-hidden="true">${CL_ICON.danger}</div>
        <div class="cl-card-tt">
          <h3>失效图标 ${badge}</h3>
          <p>快捷方式指向的程序被卸载、挪走或删掉了，双击只会报错。清掉它们，桌面会清爽很多。</p>
        </div>
      </div>
      <div class="cl-card-body">${body}</div>
      <div class="cl-card-foot">
        <button class="btn primary" data-cl-scan>${btnLabel}</button>
        <span class="muted">${s ? '清理前可以逐个勾掉不想动的' : '不会删除任何文件'}</span>
      </div>
    </article>

    <article class="cl-card">
      <div class="cl-card-top">
        <div class="cl-ico soon" aria-hidden="true">${CL_ICON.uninstall}</div>
        <div class="cl-card-tt">
          <h3>按软件卸载 ${unBadge()}</h3>
          <p>桌面图标按类型排成几列，勾选多个软件后，它会一个接一个弹出软件自己的卸载向导，卸完再收尾。</p>
        </div>
      </div>
      <div class="cl-card-body">
        <ol class="cl-steps">
          <li><i>1</i>按分类勾软件</li>
          <li><i>2</i>看一眼清单</li>
          <li><i>3</i>自动逐个弹窗</li>
          <li><i>4</i>收尾残留</li>
        </ol>
        <p class="cl-card-sub">${unUI.scan
          ? `上次识别：${unUI.scan.items.length} 个图标里 ${unUI.scan.items.filter(i => i.canUninstall).length} 个认出了软件。`
          : '取消也算一次结果，会自动进下一个；随时能停。'}</p>
      </div>
      <div class="cl-card-foot">
        <button class="btn" data-cl-uninstall>打开卸载面板</button>
        <span class="muted">卸载由软件自己的程序完成</span>
      </div>
    </article>

    <article class="cl-card">
      <div class="cl-card-top">
        <div class="cl-ico soon" aria-hidden="true">${CL_ICON.danger}</div>
        <div class="cl-card-tt">
          <h3>所有已安装的软件 ${unAllBadge()}</h3>
          <p>不只是桌面上有图标的。把注册表里那一长串按用途分成日常、专业、游戏、驱动、运行库，一眼看出空间被谁占了。</p>
        </div>
      </div>
      <div class="cl-card-body">
        <ol class="cl-steps">
          <li><i>1</i>按分类找软件</li>
          <li><i>2</i>看一眼清单</li>
          <li><i>3</i>自动逐个弹窗</li>
          <li><i>4</i>收尾残留</li>
        </ol>
        <p class="cl-card-sub">${unUI.all
          ? `上次读取：共 ${unUI.all.total} 个，${unUI.all.uninstallable} 个有卸载程序。`
          : '装过忘了的、试用版、控制面板里藏起来的，都能在这里找到。'}</p>
      </div>
      <div class="cl-card-foot">
        <button class="btn" data-cl-unall>打开软件清单</button>
        <span class="muted">含 Windows 隐藏的系统组件</span>
      </div>
    </article>`;
}

function unAllBadge() {
  const a = unUI.all;
  if (!a) return '<span class="cl-badge">未读取</span>';
  return `<span class="cl-badge">${a.total} 个软件</span>`;
}

function unBadge() {
  const s = unUI.scan;
  if (!s) return '<span class="cl-badge">未识别</span>';
  const n = s.items.filter(i => i.canUninstall).length;
  return n ? `<span class="cl-badge">${n} 个可卸载</span>` : '<span class="cl-badge">0 个</span>';
}

function renderCleanStats() {
  const s = clUI.scan;
  const logs = clUI.logs || [];
  const brokenEl = $('#clStatBroken');
  if (brokenEl) brokenEl.textContent = s ? String(s.counts.broken + s.counts.suspect) : '—';
  const logsEl = $('#clStatLogs');
  if (logsEl) logsEl.textContent = String(logs.length);
  const rsEl = $('#clStatRestored');
  if (rsEl) rsEl.textContent = String(logs.filter(x => x.restoredAt).length);
  const tip = $('#clCountTip');
  if (tip) tip.textContent = s ? `上次扫描 ${fmtDate(s.at)}` : '先扫描一次，看看有没有失效的图标';
}

function renderCleanHistory() {
  const el = $('#clHist');
  if (!el) return;
  const logs = clUI.logs || [];
  if (!logs.length) {
    el.innerHTML = `
      <div class="cl-hist-empty">
        <div class="cl-empty-ic" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.6h16"/><path d="M6.8 6.6 7.6 18a1.8 1.8 0 0 0 1.8 1.6h5.2A1.8 1.8 0 0 0 16.4 18l.8-11.4"/><path d="M9.8 6.6V5a1.4 1.4 0 0 1 1.4-1.4h1.6A1.4 1.4 0 0 1 14.2 5v1.6"/></svg>
        </div>
        <b>还没有清理过</b>
        <span>清理过的快捷方式会在这里留一条记录，随时能放回桌面。</span>
      </div>`;
    return;
  }
  el.innerHTML = logs.map(x => {
    const more = x.count > x.names.length ? ' 等' : '';
    const list = x.names.length ? '：' + escapeHtml(x.names.join('、')) + more : '';
    return `
      <div class="cl-his-row">
        <span class="cl-his-t">${fmtDate(x.at)}</span>
        <span class="cl-his-m">清理 ${x.count} 个${list}</span>
        ${x.restoredAt
          ? '<span class="cl-his-done">已还原</span>'
          : `<button class="btn cl-his-btn" data-cl-restore="${escapeHtml(x.id)}">放回桌面</button>`}
      </div>`;
  }).join('');
}

async function refreshCleanPage() {
  renderCleanGate();
  renderCleanCards();
  renderCleanStats();
  renderCleanHistory();
  try {
    const r = await api('/api/cleanup/logs');
    clUI.logs = r.logs || [];
    if (typeof r.hasBackup === 'boolean') {
      state.backup = { ...(state.backup || {}), hasBackup: r.hasBackup };
    }
  } catch {
    clUI.logs = [];
  }
  renderCleanGate();
  renderCleanStats();
  renderCleanHistory();
}

/* ---------- 扫描 ---------- */
async function openCleanScan() {
  if (clUI.busy) return;
  clUI.busy = true;
  const m = modal(
    '<div class="modal-head"><div><h3>扫描桌面图标</h3><p>正在检查每个快捷方式还能不能打开…</p></div></div>' +
    '<div class="modal-body"><div class="empty-state">大约需要 2 秒，期间不会改动任何文件</div></div>'
  );
  m.classList.add('wide');
  try {
    const r = await api('/api/cleanup/scan', {});
    clUI.scan = r;
    if (typeof r.hasBackup === 'boolean') {
      state.backup = { ...(state.backup || {}), hasBackup: r.hasBackup };
    }
    renderCleanGate();
    renderCleanCards();
    renderCleanStats();
    // 先放开 busy 再画弹窗：否则弹窗里的「清理」按钮会一直是禁用状态
    clUI.busy = false;
    showCleanResult(r);
  } catch (e) {
    m.innerHTML =
      `<div class="modal-head"><div><h3>扫描失败</h3><p>没有改动任何文件</p></div><button class="modal-close" data-close>✕</button></div>` +
      `<div class="modal-body"><div class="empty-state">${escapeHtml(e.message)}</div></div>` +
      `<div class="modal-foot"><button class="btn" data-close>关闭</button></div>`;
    m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  } finally {
    clUI.busy = false;
  }
}

function cleanRowHtml(it) {
  const kindName = { program: '程序', folder: '文件夹', url: '网址', file: '文件' }[it.kind] || '文件';
  const checked = it.status === 'broken';
  const where = it.target || it.url || '（没有指向任何东西）';
  return `
    <label class="cl-row${it.status === 'suspect' ? ' suspect' : ''}">
      <input type="checkbox" data-f="${escapeHtml(it.file)}" ${checked ? 'checked' : ''}>
      <span class="cl-row-ic">${it.iconUrl
        ? `<img src="${escapeHtml(it.iconUrl)}" alt="" draggable="false">`
        : `<span class="cl-row-ph">${escapeHtml(Array.from(it.name || '?')[0] || '?')}</span>`}</span>
      <span class="cl-row-main">
        <span class="cl-row-name">${escapeHtml(it.name)}
          <i class="cl-kind">${kindName}</i>
          <i class="cl-kind where">${escapeHtml(it.dir || '桌面')}</i>
          ${it.status === 'suspect' ? '<i class="cl-kind soft">磁盘没连上</i>' : ''}
        </span>
        <span class="cl-row-target" title="${escapeHtml(where)}">${escapeHtml(where)}</span>
        <span class="cl-row-why">${escapeHtml(it.reason || '')}</span>
      </span>
    </label>`;
}

function showCleanResult(r) {
  disarmClean();
  const items = r.items || [];
  const broken = items.filter(i => i.status === 'broken');
  const suspect = items.filter(i => i.status === 'suspect');
  clUI.sel = new Set(broken.map(i => i.file));

  if (!items.length) {
    const m = modal(`
      <div class="modal-head">
        <div><h3>没有发现失效图标</h3><p>检查了 ${r.counts.scanned} 个快捷方式</p></div>
        <button class="modal-close" data-close>✕</button>
      </div>
      <div class="modal-body">
        <div class="cl-empty">
          <div class="cl-ok-ic" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.4 4.3L19 7"/></svg>
          </div>
          <b>桌面上每个快捷方式都还能打开</b>
          <span>${r.counts.skipped ? `另有 ${r.counts.skipped} 个是网络位置或应用商店应用，本来就没法判断，已跳过。` : '暂时没有需要清理的图标。'}</span>
        </div>
      </div>
      <div class="modal-foot">
        <span class="left">这次只做了检查，没有改动任何文件</span>
        <button class="btn" data-close>知道了</button>
      </div>`);
    m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
    return;
  }

  const m = modal(`
    <div class="modal-head">
      <div>
        <h3>发现 ${items.length} 个失效图标</h3>
        <p>${broken.length} 个确定打不开了${suspect.length ? `，${suspect.length} 个可能是磁盘没连上（默认没勾）` : ''}。不勾的不会被清理。</p>
      </div>
      <button class="modal-close" data-close>✕</button>
    </div>
    <div class="modal-body">
      <div class="cl-tools">
        <label class="cl-check"><input type="checkbox" data-all><span>全选</span></label>
        <span class="muted" data-sel></span>
        <span class="cl-tools-sp"></span>
        <button class="link" data-rescan>重新扫描</button>
      </div>
      <div class="cl-list" data-list>${items.map(cleanRowHtml).join('')}</div>
      <div class="cl-risk inline${cleanGateOk() ? ' hidden' : ''}" data-risk>
        <input type="checkbox" data-ack2 ${clUI.ack ? 'checked' : ''}>
        <span>还没备份过桌面：我知道未备份就清理的风险，仍然继续</span>
      </div>
      <p class="cl-tip">清理会把快捷方式丢进回收站，同时在本机留一份原件 —— 之后可以在「最近清理」里放回桌面。</p>
    </div>
    <div class="modal-foot">
      <span class="left" data-tip></span>
      <button class="btn" data-cancel>再想想</button>
      <button class="btn danger" data-do disabled>清理</button>
    </div>
  `);
  m.classList.add('wide');
  clUI.modal = m;

  const list = m.querySelector('[data-list]');
  list.addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-f]');
    if (!cb) return;
    if (cb.checked) clUI.sel.add(cb.dataset.f);
    else clUI.sel.delete(cb.dataset.f);
    disarmClean();
    updateCleanFoot();
  });

  m.querySelector('[data-all]').addEventListener('change', (e) => {
    const on = e.target.checked;
    m.querySelectorAll('input[data-f]').forEach(cb => {
      cb.checked = on;
      if (on) clUI.sel.add(cb.dataset.f); else clUI.sel.delete(cb.dataset.f);
    });
    disarmClean();
    updateCleanFoot();
  });

  const rescan = m.querySelector('[data-rescan]');
  if (rescan) rescan.addEventListener('click', () => {
    disarmClean();
    clUI.modal = null;
    closeModal();
    openCleanScan();
  });

  const ack2 = m.querySelector('[data-ack2]');
  if (ack2) ack2.addEventListener('change', () => setCleanAck(ack2.checked));

  m.querySelectorAll('[data-close], [data-cancel]').forEach(b => b.addEventListener('click', () => {
    disarmClean();
    clUI.modal = null;
    closeModal();
  }));
  m.querySelector('[data-do]').addEventListener('click', armClean);

  updateCleanFoot();
}

/** 第一次点「清理」只是待命，4 秒内再点一次才真的删 */
function disarmClean() {
  if (!clUI.arm) return;
  clUI.arm = false;
  clearTimeout(clUI.armTimer);
  const m = clUI.modal;
  const btn = m && m.querySelector('[data-do]');
  if (btn) btn.classList.remove('arming');
}

function armClean() {
  const m = clUI.modal;
  if (!m) return;
  const btn = m.querySelector('[data-do]');
  if (!btn || btn.disabled) return;
  if (clUI.arm) {
    disarmClean();
    doClean();
    return;
  }
  clUI.arm = true;
  btn.classList.add('arming');
  btn.textContent = `再点一次，确实清理 ${clUI.sel.size} 个`;
  clearTimeout(clUI.armTimer);
  clUI.armTimer = setTimeout(() => {
    if (!clUI.modal) return;
    disarmClean();
    updateCleanFoot();
  }, 6000);
}

function updateCleanFoot() {
  const m = clUI.modal;
  if (!m) return;
  const rows = [...m.querySelectorAll('input[data-f]')];
  const total = rows.length;
  const n = clUI.sel.size;
  const all = m.querySelector('[data-all]');
  if (all) {
    all.checked = n > 0 && n === total;
    all.indeterminate = n > 0 && n < total;
  }
  const sel = m.querySelector('[data-sel]');
  if (sel) sel.textContent = `已选 ${n} / ${total}`;

  const ok = cleanGateOk();
  const risk = m.querySelector('[data-risk]');
  if (risk) risk.classList.toggle('hidden', ok);

  const btn = m.querySelector('[data-do]');
  if (btn) {
    if (!clUI.arm) btn.textContent = n ? `清理选中的 ${n} 个` : '还没有选中';
    btn.disabled = !n || !ok || clUI.busy;
    if (btn.disabled) btn.classList.remove('arming');
  }
  const tip = m.querySelector('[data-tip]');
  if (tip) {
    tip.textContent = !ok
      ? '还没备份：先勾选下面的风险确认'
      : (clUI.arm
        ? '再点一次才会真的删掉，6 秒后自动取消'
        : `已选 ${n} 个${total - n > 0 ? `，其余 ${total - n} 个不动` : ''}`);
  }
}

function setCleanAck(v) {
  clUI.ack = !!v;
  renderCleanGate();
  renderCleanCards();
  const m = clUI.modal;
  if (m) {
    const cb = m.querySelector('[data-ack2]');
    if (cb) cb.checked = clUI.ack;
    updateCleanFoot();
  }
}

function dropScanItems(files) {
  if (!clUI.scan) return;
  const set = new Set(files.map(f => String(f).toLowerCase()));
  clUI.scan.items = clUI.scan.items.filter(it => !set.has(it.file.toLowerCase()));
  clUI.scan.counts.broken = clUI.scan.items.filter(i => i.status === 'broken').length;
  clUI.scan.counts.suspect = clUI.scan.items.filter(i => i.status === 'suspect').length;
}

async function doClean() {
  if (clUI.busy) return;
  const files = [...clUI.sel];
  if (!files.length) return;
  clUI.busy = true;
  const m = clUI.modal;
  const btn = m && m.querySelector('[data-do]');
  if (btn) { btn.disabled = true; btn.textContent = '正在清理…'; }
  try {
    const r = await api('/api/cleanup/delete', { files, ackNoBackup: clUI.ack });
    clUI.modal = null;
    closeModal();
    dropScanItems(files);
    renderCleanCards();
    renderCleanStats();
    await refreshCleanPage();
    const failed = (r.failed || []).length;
    toast(`已清理 ${r.deleted} 个失效图标${failed ? `，${failed} 个没删掉（可能被占用）` : ''}，可以在「最近清理」里放回桌面`);
  } catch (e) {
    toast(e.message, true);
    if (btn) {
      btn.disabled = false;
      updateCleanFoot();
    }
  } finally {
    clUI.busy = false;
  }
}

async function restoreClean(id, btn) {
  if (!id) return;
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '放回中…'; }
  try {
    const r = await api('/api/cleanup/restore', { id });
    const failed = (r.failed || []).length;
    toast(r.restored
      ? `已放回桌面 ${r.restored} 个快捷方式${r.skipped ? `，${r.skipped} 个桌面上已经有了` : ''}${failed ? `，${failed} 个失败` : ''}`
      : `没有放回任何图标${r.skipped ? '（桌面上已经有同名的了）' : ''}`);
    await refreshCleanPage();
  } catch (e) {
    toast(e.message, true);
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

/* ---------------- 按软件卸载（批量，一次勾多个） ---------------- */

const UN_GROUPS = [
  { key: 'tool', name: '日常软件', color: '#2563eb', tint: '#eef3ff' },
  { key: 'niche', name: '专业（小众）软件', color: '#0f9c78', tint: '#e7f8f2' },
  { key: 'game', name: '游戏', color: '#d97706', tint: '#fff5e6' },
  { key: 'other', name: '认不出 / 卸不了', color: '#64748b', tint: '#f1f5f9' }
];
/* 图标三档大小：icon = 图标边长，tile = 单个格子最小宽度 */
const UN_SIZES = [
  { icon: 28, tile: 72, label: '小' },
  { icon: 40, tile: 86, label: '中' },
  { icon: 52, tile: 102, label: '大' }
];
const UN_SIZE_KEY = 'desktop-organizer.unIconSize';

const unUI = {
  mode: 'desk',      // desk=按桌面图标 / all=所有已安装软件
  all: null,         // 全部软件清单（含分类）
  cat: 'daily',      // 全部软件视图里当前看的分类
  riskyOn: false,    // 是否允许勾选「系统组件 / 驱动」这类
  scan: null,        // 桌面图标识别结果
  step: 'pick',      // pick | list | run | done
  sel: new Set(),    // 勾中的 appId
  q: '',
  size: (() => {
    const n = parseInt(localStorage.getItem(UN_SIZE_KEY) || '1', 10);
    return Number.isFinite(n) ? Math.min(UN_SIZES.length - 1, Math.max(0, n)) : 1;
  })(),
  onlyCan: false,
  batch: null,       // 服务端给的清单 / 进度
  hasBackup: false,
  poll: null,
  busy: false,
  msg: '',
  err: '',
  needBackup: false,
  ackRisk: false,
  stopped: false,
  pick: new Set(),   // 残留勾选：planId|rowId
  iconSeq: 0,
  arm: false,
  armTimer: 0
};

/** 「所有已安装软件」的六个分类 —— 顺序就是用户认知里的顺序 */
const UN_CATS = [
  { key: 'daily', name: '日常软件', short: '日常', color: '#4a86e8', tint: 'rgba(74,134,232,.09)' },
  { key: 'pro', name: '专业 / 开发', short: '专业', color: '#8e6bd8', tint: 'rgba(142,107,216,.09)' },
  { key: 'game', name: '游戏', short: '游戏', color: '#2f9e6b', tint: 'rgba(47,158,107,.09)' },
  { key: 'driver', name: '驱动 / 硬件', short: '驱动', color: '#d08a2c', tint: 'rgba(208,138,44,.10)', risky: true },
  { key: 'runtime', name: '系统组件 · 运行库', short: '运行库', color: '#8b8f96', tint: 'rgba(139,143,150,.10)', risky: true },
  { key: 'unknown', name: '认不出', short: '认不出', color: '#7b8794', tint: 'rgba(123,135,148,.09)' }
];

const UN_CAT_MAP = UN_CATS.reduce((o, c) => (o[c.key] = c, o), {});

const UN_STATUS = {
  ready: '等待',
  running: '进行中',
  ok: '成功',
  cancel: '取消',
  timeout: '没等到结果',
  error: '出错',
  skipped: '跳过',
  bad: '准备失败'
};

function unFetch(path, body) {
  return fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  }).then(async res => ({ ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) }));
}

function unItems() {
  return (unUI.scan && unUI.scan.items) || [];
}

function unItemByFile(f) {
  return unItems().find(x => x.file === f) || null;
}

function unSizeMeta() {
  return UN_SIZES[unUI.size] || UN_SIZES[1];
}

function stopUnPoll() {
  if (unUI.poll) { clearInterval(unUI.poll); unUI.poll = null; }
}

/* ---------- 打开 / 扫描 ---------- */

async function openUninstall(mode) {
  unUI.mode = mode === 'all' ? 'all' : 'desk';
  unUI.step = 'pick';
  unUI.sel.clear();
  unUI.batch = null;
  unUI.pick.clear();
  unUI.err = ''; unUI.msg = ''; unUI.needBackup = false; unUI.ackRisk = false;
  unUI.stopped = false;
  unUI.q = '';
  unUI.riskyOn = false;
  stopUnPoll();

  const m = modal(`
    <div class="modal-head">
      <div class="un-head">
        <h3>${unUI.mode === 'all' ? '卸载已安装的软件' : '按软件卸载'}</h3>
        <div class="un-steps" id="unSteps"></div>
      </div>
      <button class="modal-close" data-close aria-label="关闭">&times;</button>
    </div>
    <div class="modal-body" id="unBody"></div>
    <div class="modal-foot" id="unFoot"></div>`, { dismissible: false });
  m.classList.add('wide', 'un-modal');
  bindUninstall(m);
  paintUn();

  if (unUI.mode === 'all') {
    const stale = !unUI.all || Date.now() - (unUI.all.at || 0) > 3 * 60 * 1000;
    if (stale) await loadUnAll();
    else paintUn();
    return;
  }

  // 上次扫描太旧就重扫，省得拿旧清单去卸已经变了的桌面
  const stale = !unUI.scan || Date.now() - (unUI.scan.at || 0) > 2 * 60 * 1000;
  if (stale) await loadUnScan();
  else if (unItems().some(x => !x.iconUrl)) loadUnIcons();
}

/* ---------- 全部软件：读清单 ---------- */

async function loadUnAll(fresh) {
  unUI.busy = true;
  unUI.msg = '正在读注册表里的软件清单…';
  paintUn();
  const r = await unFetch('/api/uninstall/all', { fresh: !!fresh });
  unUI.busy = false;
  unUI.msg = '';
  if (!r.ok) {
    unUI.err = r.data.error || '读取软件清单失败了';
    paintUn();
    return;
  }
  unUI.all = r.data;
  unUI.err = '';
  if (typeof r.data.hasBackup === 'boolean') unUI.hasBackup = r.data.hasBackup;
  // 勾选里可能有已经卸掉的，顺手清掉
  const live = new Set(unAllItems().map(x => x.id));
  for (const id of [...unUI.sel]) if (!live.has(id)) unUI.sel.delete(id);
  // 落在空分类里就跳回第一个有东西的分类
  if (!unAllItems().some(x => x.cat === unUI.cat)) {
    const first = UN_CATS.find(c => unAllItems().some(x => x.cat === c.key));
    if (first) unUI.cat = first.key;
  }
  paintUn();
  loadUnAllIcons();
}

function unAllItems() {
  return (unUI.all && unUI.all.items) || [];
}

function unAllCat(key) {
  return UN_CAT_MAP[key] || (UN_CAT_MAP[key] = { key, name: key, short: key, color: '#8b8f96', tint: 'rgba(0,0,0,.06)' });
}

/** 当前分类下、过了搜索和筛选的条目 */
function unAllList(cat) {
  const key = cat || unUI.cat;
  const q = unUI.q.trim().toLowerCase();
  let list = unAllItems().filter(x => x.cat === key);
  if (unUI.onlyCan) list = list.filter(x => x.canUninstall);
  if (q) list = list.filter(x => (x.name + ' ' + (x.pub || '')).toLowerCase().includes(q));
  return list.sort((a, b) => {
    const d = (b.canUninstall ? 1 : 0) - (a.canUninstall ? 1 : 0);
    return d || (b.size || 0) - (a.size || 0);
  });
}

/** 这一条能不能勾：系统组件/驱动要有「我知道风险」的开关才允许 */
function unAllPickable(it) {
  if (!it || !it.canUninstall) return false;
  const c = unAllCat(it.cat);
  return !c.risky || unUI.riskyOn;
}

async function loadUnScan() {
  unUI.busy = true;
  unUI.msg = '正在认领桌面图标…';
  paintUn();
  const r = await unFetch('/api/uninstall/apps', {});
  unUI.busy = false;
  unUI.msg = '';
  if (!r.ok) {
    unUI.err = r.data.error || '读取桌面图标失败了';
  } else {
    unUI.scan = r.data;
    unUI.err = '';
    // 勾选里可能有图标已经不在桌面上了，顺手清掉
    const live = new Set(unItems().filter(x => x.appId).map(x => x.appId));
    for (const id of [...unUI.sel]) if (!live.has(id)) unUI.sel.delete(id);
  }
  paintUn();
  if (unUI.scan) loadUnIcons();
}

async function loadUnIcons() {
  const need = unItems().filter(x => !x.iconUrl && x.file);
  if (!need.length) return;
  const seq = ++unUI.iconSeq;
  for (let i = 0; i < need.length; i += 20) {
    if (seq !== unUI.iconSeq) return;
    const chunk = need.slice(i, i + 20);
    try {
      const r = await unFetch('/api/uninstall/icons', { items: chunk.map(x => ({ file: x.file, key: x.iconKey })) });
      if (seq !== unUI.iconSeq) return;
      const map = (r.data && r.data.icons) || {};
      for (const it of chunk) if (map[it.iconKey]) it.iconUrl = map[it.iconKey];
      paintUnIcons();
    } catch { /* 取不到就用首字占位，不影响卸载 */ }
  }
}

/** 只换图标，不重画整个网格（保持滚动位置） */
function paintUnIcons() {
  document.querySelectorAll('.un-tile').forEach(el => {
    const it = unItemByFile(el.dataset.f);
    if (!it || !it.iconUrl) return;
    const box = el.querySelector('.un-tile-ic');
    if (!box || box.querySelector('img')) return;
    box.innerHTML = '';
    const img = document.createElement('img');
    img.alt = ''; img.draggable = false;
    img.src = it.iconUrl;
    box.appendChild(img);
  });
}

/* ---------- 渲染骨架 ---------- */

function paintUn() {
  const steps = document.getElementById('unSteps');
  if (!steps) return;
  const order = ['pick', 'list', 'run', 'done'];
  const names = { pick: '勾选软件', list: '确认清单', run: '逐个卸载', done: '结果' };
  const at = order.indexOf(unUI.step);
  steps.innerHTML = order.map((k, i) => `
    <span class="un-step${i === at ? ' on' : ''}${i < at ? ' done' : ''}">
      <i>${i + 1}</i>${names[k]}
    </span>`).join('<em class="un-arrow"></em>');

  const body = document.getElementById('unBody');
  const foot = document.getElementById('unFoot');
  if (!body || !foot) return;

  if (unUI.step === 'pick') {
    if (unUI.mode === 'all') { body.innerHTML = unAllPickHtml(); foot.innerHTML = unAllPickFoot(); }
    else { body.innerHTML = unPickHtml(); foot.innerHTML = unPickFoot(); }
  }
  else if (unUI.step === 'list') { body.innerHTML = unListHtml(); foot.innerHTML = unListFoot(); }
  else if (unUI.step === 'run') { body.innerHTML = unRunHtml(); foot.innerHTML = unRunFoot(); }
  else { body.innerHTML = unDoneHtml(); foot.innerHTML = unDoneFoot(); }

  applyUnSize();
  bindUnBody();
  if (unUI.step === 'pick' && unUI.mode === 'all') setTimeout(fillUnSizes, 500);
}

function applyUnSize() {
  const cols = document.querySelector('.un-cols');
  if (!cols) return;
  const s = unSizeMeta();
  cols.style.setProperty('--tile', s.tile + 'px');
  cols.style.setProperty('--icon', s.icon + 'px');
}

function bindUnBody() {
  const box = document.getElementById('unSearch');
  if (box && unUI.q) { box.focus(); box.setSelectionRange(unUI.q.length, unUI.q.length); }
}

function unWait(title, tip, extra) {
  return `<div class="un-wait">
    <span class="un-spin"></span><b>${escapeHtml(title)}</b>
    ${tip ? `<p>${escapeHtml(tip)}</p>` : ''}
    ${extra || ''}
  </div>`;
}

function unIconHtml(it) {
  if (it.iconUrl) return `<img src="${escapeHtml(it.iconUrl)}" alt="" draggable="false">`;
  return `<span class="ph">${escapeHtml(firstChar(it.name))}</span>`;
}

/* ---------- 第 1 步：勾选软件（图标网格 + 分类） ---------- */

function unPickHtml() {
  if (unUI.busy && !unUI.scan) {
    return unWait(unUI.msg || '读取中…', '第一次要读注册表里的软件清单，大约两三秒。');
  }
  if (unUI.err && !unUI.scan) {
    return `<div class="un-wait"><b>读取失败</b><p>${escapeHtml(unUI.err)}</p>
      <button class="btn" data-act="rescan">重试一次</button></div>`;
  }
  const s = unUI.scan;
  if (!s) return '';

  const total = s.items.length;
  const canN = s.items.filter(x => x.canUninstall).length;
  return `
    <div class="un-toolbar">
      <input id="unSearch" class="un-search" placeholder="搜图标名，或者软件名" value="${escapeHtml(unUI.q)}" autocomplete="off">
      <div class="un-size">
        <span>图标</span>
        <div class="seg">
          ${UN_SIZES.map((x, i) => `<button data-act="size" data-i="${i}" class="${unUI.size === i ? 'on' : ''}">${x.label}</button>`).join('')}
        </div>
      </div>
      <label class="un-only"><input type="checkbox" data-act="only" ${unUI.onlyCan ? 'checked' : ''}><span>只看能卸的</span></label>
    </div>

    <div class="un-sumline">
      <span>${total} 个图标 · ${canN} 个认出了软件</span>
      <span class="un-sep">·</span>
      <span class="un-sel-n">已选 <b>${unUI.sel.size}</b> 个</span>
      <span class="un-quick">
        <button class="link" data-act="all">全选能卸的</button>
        <button class="link" data-act="none">清空</button>
      </span>
    </div>

    <div class="un-cols">
      ${UN_GROUPS.map((g, i) => unColHtml(g, i)).join('')}
    </div>

    <p class="cl-tip">认不出的多是绿色软件（解压即用、没走安装程序），它们没有卸载程序，标着原因、不参与批量卸载。
      同一软件在桌面上有两个图标时，勾一个就都算上了。</p>`;
}

function unColItems(key) {
  const q = unUI.q.trim().toLowerCase();
  let list = unItems().filter(it => it.group === key);
  if (unUI.onlyCan) list = list.filter(it => it.canUninstall);
  if (q) {
    list = list.filter(it => (it.name + ' ' + (it.appName || '') + ' ' + (it.target || '')).toLowerCase().includes(q));
  }
  return list.sort((a, b) => {
    const d = (b.canUninstall ? 1 : 0) - (a.canUninstall ? 1 : 0);
    return d || a.name.localeCompare(b.name, 'zh');
  });
}

function unColHtml(g, i) {
  const list = unColItems(g.key);
  const pick = list.filter(x => x.canUninstall);
  const allOn = pick.length > 0 && pick.every(x => unUI.sel.has(x.appId));
  return `
    <section class="un-col" data-g="${g.key}" style="--c:${g.color};--tint:${g.tint}">
      <header class="un-col-h">
        <i>${i + 1}</i>
        <b>${g.name}</b>
        <em>${list.length}</em>
        ${pick.length ? `<button class="link" data-act="gsel" data-g="${g.key}">${allOn ? '取消' : '全选'}</button>` : ''}
      </header>
      <div class="un-grid">
        ${list.length ? list.map(unTileHtml).join('') : `<div class="un-empty">${unUI.onlyCan ? '这一类没有能卸的' : '这一类是空的'}</div>`}
      </div>
    </section>`;
}

function unTileHtml(it) {
  const on = it.canUninstall && unUI.sel.has(it.appId);
  const tip = it.canUninstall
    ? `${it.name}\n软件：${cleanAppName(it.appName)}${it.how ? '（' + it.how + '）' : ''}`
    : `${it.name}\n${it.tag || '认不出'} —— 没有可用的卸载入口`;
  return `
    <button class="un-tile${on ? ' on' : ''}${it.canUninstall ? '' : ' off'}"
        data-act="tile" data-f="${escapeHtml(it.file)}" title="${escapeHtml(tip)}">
      <span class="un-tile-ic">${unIconHtml(it)}</span>
      <span class="un-tile-nm">${escapeHtml(it.name)}</span>
      ${it.canUninstall ? '<i class="un-tile-ck"></i>' : `<i class="un-tile-tag">${escapeHtml(it.tag || '—')}</i>`}
    </button>`;
}

function unPickFoot() {
  const s = unUI.scan;
  const n = unUI.sel.size;
  return `
    <span class="left">${s ? `桌面上一共 ${s.items.length} 个快捷方式 · 已选 ${n} 个软件` : '还没读取'}</span>
    <button class="btn" data-act="rescan" ${unUI.busy ? 'disabled' : ''}>重新识别</button>
    <button class="btn" data-close>关掉</button>
    <button class="btn primary" data-act="next" ${n && !unUI.busy ? '' : 'disabled'}>下一步：确认清单</button>`;
}

/* ---------- 第 1 步（另一种）：所有已安装软件 ---------- */

const UN_FIX_KEY = 'unCatFix';

/** 用户手动改过的分类：{ 软件名: 分类 }。存在本地，不影响识别结果本身 */
function unCatFix() {
  try { return JSON.parse(localStorage.getItem(UN_FIX_KEY) || '{}') || {}; } catch { return {}; }
}

function unCatOf(it) {
  const fix = unCatFix();
  return fix[it.name] || it.cat;
}

function setUnCatFix(name, cat) {
  const fix = unCatFix();
  if (!cat || cat === 'auto') delete fix[name];
  else fix[name] = cat;
  try { localStorage.setItem(UN_FIX_KEY, JSON.stringify(fix)); } catch { /* 存不下就只影响这一次 */ }
}

function unCatBar() {
  const items = unAllItems();
  return `<div class="un-catbar">
    ${UN_CATS.map(c => {
      const n = items.filter(x => unCatOf(x) === c.key).length;
      const on = unUI.cat === c.key;
      return `<button class="un-chip${on ? ' on' : ''}" data-act="acat" data-c="${c.key}"
          style="--c:${c.color};--tint:${c.tint}">
        ${c.name}<em>${n}</em></button>`;
    }).join('')}
  </div>`;
}

function unAllPickHtml() {
  if (unUI.busy && !unUI.all) {
    return unWait(unUI.msg || '读取中…', '正在把控制面板里那一长串按用途分好类，大约两三秒。');
  }
  if (unUI.err && !unUI.all) {
    return `<div class="un-wait"><b>读取失败</b><p>${escapeHtml(unUI.err)}</p>
      <button class="btn" data-act="rescan">重试一次</button></div>`;
  }
  const all = unUI.all;
  if (!all) return '';

  const cat = unAllCat(unUI.cat);
  const list = unAllList();
  const catAll = unAllItems().filter(x => unCatOf(x) === unUI.cat);
  const pickN = catAll.filter(x => unAllPickable(x)).length;

  return `
    <div class="un-toolbar">
      <input id="unSearch" class="un-search" placeholder="搜软件名，或者厂商名" value="${escapeHtml(unUI.q)}" autocomplete="off">
      <label class="un-only"><input type="checkbox" data-act="only" ${unUI.onlyCan ? 'checked' : ''}><span>只看能卸的</span></label>
      <button class="link" data-act="afresh" ${unUI.busy ? 'disabled' : ''}>重新读取</button>
    </div>

    <div class="un-sumline">
      <span>一共 ${all.total} 个软件 · ${all.uninstallable} 个有卸载程序</span>
      <span class="un-sep">·</span>
      <span class="un-sel-n">已选 <b>${unUI.sel.size}</b> 个</span>
      <span class="un-quick">
        <button class="link" data-act="aselcat">全选这一类</button>
        <button class="link" data-act="none">清空</button>
      </span>
    </div>

    ${unCatBar()}

    <div class="un-cathead" style="--c:${cat.color};--tint:${cat.tint}">
      <b>${cat.name}</b>
      <em>${catAll.length} 个 · ${fmtSize(catAll.reduce((s, x) => s + (x.size || 0), 0))}</em>
      <span class="un-cattip">${unCatTip(unUI.cat)}</span>
    </div>

    ${cat.risky ? `<label class="un-riskgate">
        <input type="checkbox" data-act="risky" ${unUI.riskyOn ? 'checked' : ''}>
        <span>我知道这类东西卸错了会让别的软件或硬件不好用，允许我勾选</span>
      </label>` : ''}

    <div class="un-alist" id="unAllList">
      ${list.length ? list.map(unAllRow).join('') : `<div class="un-empty big">${unUI.onlyCan ? '这一类没有能卸的' : '这一类是空的'}</div>`}
    </div>

    <p class="cl-tip">分类是按注册表里的信息自动判的：装在哪、谁出的、有没有走平台。
      判错了点右边的分类标签直接改，改完会记住。
      ${cat.risky ? '这一类的条目是「别的软件的一部分」，卸掉它们可能让某些程序打不开 —— 想清理，卸掉对应的主软件更干净。' : ''}</p>`;
}

function unCatTip(key) {
  if (key === 'daily') return '浏览器、聊天、网盘、办公这类天天用的';
  if (key === 'pro') return '开发、设计、剪辑、虚拟机这类吃饭的家伙';
  if (key === 'game') return '从 Steam / 战网 / EA 这些平台装的游戏，和平台客户端本身';
  if (key === 'driver') return '显卡、声卡、网卡、手柄这些硬件的驱动程序';
  if (key === 'runtime') return 'C++ 运行库、.NET、Python 组件 —— 别的软件靠它们才能跑';
  return '注册表里信息太少，只能靠名字猜；你也可以直接改分类';
}

function unAllRow(it) {
  const catKey = unCatOf(it);
  const cat = unAllCat(catKey);
  const pickable = unAllPickable({ ...it, cat: catKey });
  const on = pickable && unUI.sel.has(it.id);
  const cls = ['un-arow'];
  if (on) cls.push('on');
  if (!pickable) cls.push('off');

  const sub = [
    it.pub,
    it.ver && ('v' + it.ver.replace(/^v/i, '')),
    it.dups > 1 ? `注册表里 ${it.dups} 条` : '',
    it.hidden ? '控制面板里默认不显示' : ''
  ].filter(Boolean).join(' · ');

  return `
    <div class="${cls.join(' ')}" data-id="${escapeHtml(it.id)}">
      <input type="checkbox" data-act="arow" data-id="${escapeHtml(it.id)}" ${on ? 'checked' : ''} ${pickable ? '' : 'disabled'}>
      <span class="un-ai">${it.iconUrl ? `<img src="${escapeHtml(it.iconUrl)}" alt="" draggable="false">` : `<i class="ph">${escapeHtml(firstChar(it.name))}</i>`}</span>
      <span class="un-am">
        <b title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</b>
        <em title="${sub}">${escapeHtml(sub || '没有厂商信息')}</em>
      </span>
      <span class="un-asz${it.size ? '' : ' dim'}" title="${it.size ? '' : '注册表里没登记占用，稍后按安装目录算'}">${it.size ? fmtSize(it.size) : (it.sizing ? '统计中' : '—')}</span>
      <span class="un-away" title="${it.proto ? '由它所在的平台负责卸载' : it.msi ? '走 Windows Installer' : '软件自带的卸载程序'}">${it.proto ? '平台' : it.msi ? 'MSI' : '自带'}</span>
      <select class="un-acat sel" data-act="acatone" data-id="${escapeHtml(it.id)}" data-name="${escapeHtml(it.name)}"
          style="--c:${cat.color};--tint:${cat.tint}" title="分类不对？点这里改">
        ${UN_CATS.map(c => `<option value="${c.key}" ${catKey === c.key ? 'selected' : ''}>${c.short}</option>`).join('')}
      </select>
      ${it.blocked ? `<span class="un-why" title="${escapeHtml(it.blocked)}">卸不了</span>` : ''}
    </div>`;
}

function unAllPickFoot() {
  const n = unUI.sel.size;
  const all = unUI.all;
  return `
    <span class="left">${all ? `一共 ${all.total} 个软件 · 已选 ${n} 个` : '还没读取'}</span>
    <button class="btn" data-act="afresh" ${unUI.busy ? 'disabled' : ''}>重新读取</button>
    <button class="btn" data-close>关掉</button>
    <button class="btn primary" data-act="next" ${n && !unUI.busy ? '' : 'disabled'}>下一步：确认清单</button>`;
}

/** 软件图标：注册表 DisplayIcon 指向的 exe / ico，后端按清单白名单校验 */
async function loadUnAllIcons() {
  const need = unAllItems().filter(x => !x.iconUrl && x.icon);
  if (!need.length) return;
  const seq = ++unUI.iconSeq;
  for (let i = 0; i < need.length; i += 24) {
    if (seq !== unUI.iconSeq) return;
    const chunk = need.slice(i, i + 24);
    try {
      const r = await unFetch('/api/uninstall/icons', {
        scope: 'apps',
        items: chunk.map(x => ({ file: x.icon, key: x.iconKey }))
      });
      if (seq !== unUI.iconSeq) return;
      const map = (r.data && r.data.icons) || {};
      for (const it of chunk) if (map[it.iconKey]) it.iconUrl = map[it.iconKey];
      if (Object.keys(map).length) paintUnAllIcons();
    } catch { /* 没图标就用首字，不影响卸载 */ }
  }
}

/** 只换行里的图标，不重画列表（保住滚动位置） */
function paintUnAllIcons() {
  const box = document.getElementById('unAllList');
  if (!box) return;
  const map = new Map(unAllItems().map(x => [x.id, x]));
  box.querySelectorAll('.un-arow').forEach(el => {
    const it = map.get(el.dataset.id);
    if (!it || !it.iconUrl) return;
    const a = el.querySelector('.un-ai');
    if (!a || a.querySelector('img')) return;
    a.innerHTML = `<img src="${it.iconUrl}" alt="" draggable="false">`;
  });
}

/**
 * 补算体积：Steam 游戏这类注册表里不写 EstimatedSize，一行显示「—」很难看。
 * 分批问后端，算完只改那几行的数字。
 */
let unSizeBusy = false;
async function fillUnSizes() {
  if (unSizeBusy || !unUI.all || unUI.mode !== 'all') return;
  const need = unAllList().filter(x => !x.size && x.loc && !x.sizeTried).slice(0, 8);
  if (!need.length) return;
  unSizeBusy = true;
  need.forEach(x => { x.sizeTried = true; x.sizing = true; });
  paintUnSizes();
  try {
    const r = await unFetch('/api/uninstall/sizes', { paths: need.map(x => x.loc) });
    const map = (r.data && r.data.sizes) || {};
    for (const it of need) {
      const hit = map[String(it.loc).toLowerCase()];
      it.sizing = false;
      if (hit && hit.size) { it.size = hit.size; it.sizeReal = true; }
    }
  } catch {
    for (const it of need) it.sizing = false;
  }
  unSizeBusy = false;
  paintUnSizes();
  // 还有没算的就接着来一轮
  if (unAllList().some(x => !x.size && x.loc && !x.sizeTried)) fillUnSizes();
}

function paintUnSizes() {
  const box = document.getElementById('unAllList');
  if (!box) return;
  const map = new Map(unAllItems().map(x => [x.id, x]));
  box.querySelectorAll('.un-arow').forEach(el => {
    const it = map.get(el.dataset.id);
    if (!it) return;
    const sz = el.querySelector('.un-asz');
    if (!sz) return;
    if (it.size) {
      sz.textContent = fmtSize(it.size);
      sz.classList.remove('dim');
      sz.title = it.sizeReal ? '按安装目录实际统计' : '注册表里登记的估计值';
    } else if (it.sizing) {
      sz.textContent = '统计中';
      sz.classList.add('dim');
    } else {
      sz.textContent = '—';
      sz.classList.add('dim');
    }
  });
}

/* ---------- 第 2 步：确认清单（表格） ---------- */

function unListHtml() {
  if (unUI.busy && !unUI.batch) return unWait('正在核对卸载入口…', '顺便看看每个软件会在哪里留下东西。');
  const b = unUI.batch;
  if (!b) {
    return `<div class="un-wait"><b>没能准备这份清单</b>
      <p>${escapeHtml(unUI.err || '不知道出了什么问题，回去重选一次试试')}</p>
      <button class="btn" data-act="back">回去重选</button></div>`;
  }

  const good = b.items.filter(x => x.status !== 'bad');
  const bad = b.items.filter(x => x.status === 'bad');
  const sum = good.reduce((n, x) => n + (x.size || 0), 0);

  return `
    ${unUI.err ? `<div class="un-errbar">${escapeHtml(unUI.err)}</div>` : ''}
    ${unRiskHtml()}

    <div class="un-tblwrap">
      <table class="un-tbl">
        <thead>
          <tr>
            <th class="c-n">#</th>
            <th>软件</th>
            <th class="c-way">怎么卸</th>
            <th class="c-loc">安装位置</th>
            <th class="c-res">残留</th>
            <th class="c-x"></th>
          </tr>
        </thead>
        <tbody>
          ${good.map((it, i) => unTblRow(it, i)).join('')}
        </tbody>
      </table>
    </div>

    ${bad.length ? `
      <div class="un-badbox">
        <b>${bad.length} 个没法自动卸载，已经排除</b>
        ${bad.map(it => `<div class="un-bad-row"><span>${escapeHtml(cleanAppName(it.name))}</span><em>${escapeHtml(it.msg || '')}</em></div>`).join('')}
      </div>` : ''}

    <div class="un-note">
      <b>接下来会怎么跑</b>
      <p>点「开始卸载」后，会按上面的顺序一个一个弹出它们自己的卸载窗口。绿色软件没有卸载程序，不在清单里。
        每个软件卸完（或者你取消）都会自动检查结果，然后进下一个 —— 想停随时能停。</p>
    </div>

    <p class="cl-tip">清单里一共 ${good.length} 个软件${sum ? `，注册表估计占 ${fmtSize(sum)}` : ''}${good.some(x => x.lnkCount > 1) ? ' · 一个软件对应多个桌面图标时一起处理' : ''}。</p>`;
}

function unTblRow(it, i) {
  return `
    <tr data-app="${escapeHtml(it.appId)}">
      <td class="c-n">${i + 1}</td>
      <td class="un-td-app">
        <span class="un-ic">${unIconHtml(it)}</span>
        <span class="un-td-tt">
          <b>${escapeHtml(cleanAppName(it.name))}</b>
          <em>${escapeHtml(it.pub || '不知道是哪家公司')}${it.ver ? ' · ' + escapeHtml(it.ver) : ''}${it.lnkCount > 1 ? ` · ${it.lnkCount} 个桌面图标` : ''}</em>
        </span>
      </td>
      <td class="c-way">${it.msi ? '系统安装包（MSI）' : '它自己的卸载程序'}</td>
      <td class="c-loc" title="${escapeHtml(it.loc || '')}">${it.loc ? escapeHtml(shortPath(it.loc)) : '<span class="muted">注册表里没写</span>'}</td>
      <td class="c-res">${it.residCount ? `${it.residCount} 处` : '—'}</td>
      <td class="c-x"><button class="un-x" data-act="drop" data-app="${escapeHtml(it.appId)}" title="从清单里去掉">✕</button></td>
    </tr>`;
}

function unRiskHtml() {
  const noBk = unUI.needBackup || !unUI.hasBackup;
  if (!noBk) {
    return `<div class="un-bk ok"><b>已经备份过桌面</b><span>万一卸错了，桌面还能退回去。</span></div>`;
  }
  if (unUI.ackRisk) {
    return `<div class="un-risk on">
      <b>已确认：这次不备份直接卸</b>
      <span>出问题只能靠软件自己的卸载记录和回收站兜底。</span>
    </div>`;
  }
  return `<div class="un-risk">
    <b>还没备份过桌面</b>
    <p>卸载会动桌面快捷方式、安装目录和软件自己的配置。备份只复制、不删改，十几秒就好。</p>
    <div class="un-risk-act">
      <button class="btn primary" data-act="gobk">先备份</button>
      <label class="un-risk-ck"><input type="checkbox" data-act="ack"><span>我知道没备份的风险，仍然继续</span></label>
    </div>
  </div>`;
}

function unListFoot() {
  const b = unUI.batch;
  if (!b) return `<span class="left"></span><button class="btn" data-close>关掉</button>`;
  const n = b.items.filter(x => x.status !== 'bad').length;
  const blocked = (unUI.needBackup || !unUI.hasBackup) && !unUI.ackRisk;
  return `
    <span class="left">${n ? `将依次弹出 ${n} 个卸载窗口` : '清单里没有能卸的'}</span>
    <button class="btn" data-act="back" ${unUI.busy ? 'disabled' : ''}>返回重选</button>
    <button class="btn danger" data-act="start" ${n && !unUI.busy && !blocked ? '' : 'disabled'}>开始卸载（${n} 个）</button>`;
}

/* ---------- 第 3 步：逐个卸载 ---------- */

function unRunHtml() {
  const b = unUI.batch;
  if (!b) return '';
  const idx = b.index;
  const cur = idx >= 0 ? b.items[idx] : null;
  const total = b.items.length;
  const doneN = b.items.filter(x => ['ok', 'cancel', 'timeout', 'error', 'skipped', 'bad'].includes(x.status)).length;

  return `
    <div class="un-run-hd">
      <span class="un-ic big${cur ? '' : ' idle'}">${cur ? unIconHtml(cur) : '<span class="ph">…</span>'}</span>
      <div class="un-run-tt">
        <h3>${cur ? `第 ${idx + 1} / ${total} 个 · ${escapeHtml(cleanAppName(cur.name))}` : '正在收尾…'}</h3>
        <p>${cur ? '它的卸载向导已经弹出来了，按提示点完就行。窗口可能藏在后面，看一下任务栏。' : '马上就好'}</p>
      </div>
      <div class="un-run-cnt"><b>${doneN}</b><span>/ ${total}</span></div>
    </div>
    <div class="un-run-bar"><i style="width:${Math.round(doneN / Math.max(1, total) * 100)}%"></i></div>

    <div class="un-run-note">
      <b>怎么算成功、怎么算取消</b>
      <p>软件从系统里消失（注册表卸载项没了 / 安装目录清空）＝ 成功；卸载窗口关掉了、软件还在 ＝ 取消。
        两种都算跑完，会自动进下一个。</p>
    </div>

    <ol class="un-queue">
      ${b.items.map((it, i) => unQueueRow(it, i, b)).join('')}
    </ol>`;
}

function unQueueRow(it, i, b) {
  const st = it.status;
  const mark = st === 'ok' ? '✓' : st === 'cancel' ? '✕' : st === 'timeout' || st === 'error' ? '!' : '';
  return `
    <li class="st-${st}${b.index === i ? ' cur' : ''}">
      <i>${mark}</i>
      <span>${escapeHtml(cleanAppName(it.name))}</span>
      <em>${UN_STATUS[st] || st}${it.duration ? ` · ${Math.round(it.duration / 1000)}s` : ''}</em>
    </li>`;
}

function unRunFoot() {
  const b = unUI.batch;
  const running = b && b.state === 'running';
  return `
    <span class="left">停止只影响后面的软件；正在弹的这个卸载窗口不会被打断</span>
    <button class="btn danger${unUI.stopped ? ' arming' : ''}" data-act="stop" ${running && !unUI.stopped ? '' : 'disabled'}>
      ${unUI.stopped ? '已停：后面的不会再弹' : '停止卸载（不再弹下一个）'}
    </button>`;
}

/* ---------- 第 4 步：结果 + 清残留 ---------- */

function unDoneHtml() {
  const b = unUI.batch;
  if (!b) return `<div class="un-wait"><b>没有结果</b><p>重新打开面板再试一次。</p></div>`;
  const c = b.counts || {};
  const okN = c.ok || 0;
  const cancelN = (c.cancel || 0) + (c.timeout || 0);
  const skipN = (c.skipped || 0) + (c.bad || 0) + (c.error || 0);

  const leftovers = [];
  for (const it of b.items) {
    const rows = (it.rows || []).filter(r => r.exists);
    if (rows.length) leftovers.push({ it, rows });
  }
  const totalLeft = leftovers.reduce((n, x) => n + x.rows.length, 0);

  const failed = b.items.filter(x => x.status === 'cancel' || x.status === 'timeout' || x.status === 'error');

  return `
    <div class="un-done">
      <span class="un-ok${okN ? '' : ' none'}"></span>
      <h3>跑完了：成功 ${okN} 个${cancelN ? `，取消 ${cancelN} 个` : ''}${skipN ? `，跳过 ${skipN} 个` : ''}</h3>
      <p>${okN ? '卸掉的软件，桌面上的图标多半已经被它自己收走了。' : '这次没有卸掉任何软件。'}
        ${cancelN ? '取消的那几个没动，随时可以再卸一次。' : ''}</p>
    </div>

    ${failed.length ? `
      <div class="un-badbox">
        <b>这几个没卸掉</b>
        ${failed.map(it => `<div class="un-bad-row"><span>${escapeHtml(cleanAppName(it.name))}</span><em>${escapeHtml(it.msg || '')}</em></div>`).join('')}
      </div>` : ''}

    ${totalLeft ? `
      <div class="un-glist">
        ${leftovers.map(g => `
          <div class="un-g">
            <div class="un-g-h">
              <span>${escapeHtml(cleanAppName(g.it.name))}</span>
              <em>${g.rows.length} 项</em>
              <button class="link" data-act="pall" data-p="${escapeHtml(g.it.planId)}">全选</button>
            </div>
            ${g.rows.map(r => unRowHtml(r, g.it)).join('')}
          </div>`).join('')}
      </div>
      <p class="cl-tip">这些是卸载程序自己没清掉的东西（桌面图标、剩下的安装目录、缓存）。勾上的一起丢进回收站，随时能捞回来。</p>` : `
      <div class="un-clean-all">
        <span class="un-ok"></span>
        <b>连缓存和安装目录都没剩下</b>
        <p>没什么要收尾的。</p>
      </div>`}`;
}

function unRowHtml(r, it) {
  const key = `${it.planId}|${r.id}`;
  const on = unUI.pick.has(key);
  const size = r.size < 0 ? '<i class="un-pend">统计中</i>' : (r.size ? fmtSize(r.size) : '');
  return `
    <label class="un-g-row${r.shared ? ' shared' : ''}">
      <input type="checkbox" data-rid="${escapeHtml(key)}" ${on ? 'checked' : ''}>
      <span class="un-g-main">
        <b>${escapeHtml(r.label)}</b>
        <em title="${escapeHtml(r.path)}">${escapeHtml(shortPath(r.path))}</em>
      </span>
      <span class="un-g-meta">${size}</span>
      <span class="un-g-note">${escapeHtml(r.note || '')}</span>
    </label>`;
}

function unDoneFoot() {
  const b = unUI.batch;
  const n = unUI.pick.size;
  const left = b ? b.items.reduce((s, it) => s + (it.rows || []).filter(r => r.exists).length, 0) : 0;

  if (!left) {
    return `<span class="left">软件是它们自己的卸载程序卸的，我们只负责排队和检查</span>
      <button class="btn primary" data-close>完成</button>`;
  }
  return `
    <span class="left">${n ? `已选 ${n} 项，其余 ${left - n} 项留着` : '勾上要一起丢进回收站的，或者直接完成'}</span>
    <button class="btn" data-close>${n ? '都留着，先关掉' : '完成'}</button>
    <button class="btn danger${unUI.arm ? ' arming' : ''}" data-act="doclean" ${n && !unUI.busy ? '' : 'disabled'}>
      ${unUI.arm ? `再点一次，确实清掉 ${n} 项` : (n ? `清理选中的 ${n} 项` : '还没选中')}
    </button>`;
}

/* ---------- 事件 ---------- */

function bindUninstall(m) {
  // 点面板外面：正在卸载时先别关，免得误触把整批停掉
  const ov = m.parentElement;
  if (ov) {
    ov.addEventListener('click', (e) => {
      if (e.target !== ov) return;
      if (unUI.step === 'run') { toast('正在卸载中。要停下来，用下面的「停止卸载」'); return; }
      closeModal();
    });
  }

  m.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act], [data-close]');
    if (!el) return;
    if (el.hasAttribute('data-close')) { stopUnPoll(); closeModal(); return; }
    const act = el.dataset.act;

    if (act === 'rescan') { unUI.scan = null; await loadUnScan(); return; }
    if (act === 'afresh') { await loadUnAll(true); return; }
    if (act === 'acat') {
      if (el.tagName === 'SELECT') return;   // 下拉自己走 change
      unUI.q = ''; unUI.cat = el.dataset.c; paintUn(); return;
    }
    if (act === 'aselcat') { selectUnCat(); return; }
    if (act === 'size') { setUnSize(Number(el.dataset.i)); return; }
    if (act === 'tile') { toggleUnTile(el.dataset.f); return; }
    if (act === 'gsel') { toggleUnGroup(el.dataset.g); return; }
    if (act === 'all') { selectAllUn(true); return; }
    if (act === 'none') { selectAllUn(false); return; }
    if (act === 'next') { await unGoList(); return; }
    if (act === 'back') { unUI.step = 'pick'; unUI.err = ''; unUI.needBackup = false; unUI.batch = null; paintUn(); return; }
    if (act === 'drop') { dropUnApp(el.dataset.app); return; }
    if (act === 'gobk') { stopUnPoll(); closeModal(); goBackup({ autoCreate: true }); return; }
    if (act === 'start') { await unStart(); return; }
    if (act === 'stop') { await unStop(); return; }
    if (act === 'pall') { toggleUnPickAll(el.dataset.p); return; }
    if (act === 'doclean') { await unCleanResidual(); return; }
  });

  m.addEventListener('input', (e) => {
    if (e.target.id !== 'unSearch') return;
    unUI.q = e.target.value;
    if (unUI.mode === 'all') { redrawUnAll(); return; }
    const cols = document.querySelector('.un-cols');
    if (!cols) return;
    cols.outerHTML = `<div class="un-cols">${UN_GROUPS.map((g, i) => unColHtml(g, i)).join('')}</div>`;
    applyUnSize();
    paintUnIcons();
  });

  m.addEventListener('change', (e) => {
    const act = e.target.dataset.act || '';

    if (act === 'only') {
      unUI.onlyCan = e.target.checked;
      if (unUI.mode === 'all') redrawUnAll(); else paintUn();
      return;
    }
    if (act === 'ack') {
      unUI.ackRisk = e.target.checked;
      paintUn();
      return;
    }
    if (act === 'risky') {
      unUI.riskyOn = e.target.checked;
      // 关掉开关时，把已经勾上的高风险项一起摘掉，避免"看不见但还在清单里"
      if (!unUI.riskyOn) {
        for (const it of unAllItems()) {
          if (unAllCat(unCatOf(it)).risky) unUI.sel.delete(it.id);
        }
      }
      redrawUnAll();
      return;
    }
    if (act === 'arow') {
      const id = e.target.dataset.id;
      if (e.target.checked) unUI.sel.add(id);
      else unUI.sel.delete(id);
      refreshUnAll();
      return;
    }
    if (act === 'acatone') {
      setUnCatFix(e.target.dataset.name, e.target.value);
      // 改完分类这一行就不在当前分类里了，整条重画
      paintUn();
      return;
    }

    const cb = e.target.closest('input[data-rid]');
    if (!cb) return;
    if (cb.checked) unUI.pick.add(cb.dataset.rid);
    else unUI.pick.delete(cb.dataset.rid);
    disarmUn();
    paintUn();
  });
}

function setUnSize(i) {
  const n = Math.min(UN_SIZES.length - 1, Math.max(0, i));
  if (n === unUI.size) return;
  unUI.size = n;
  try { localStorage.setItem(UN_SIZE_KEY, String(n)); } catch { /* ignore */ }
  document.querySelectorAll('.un-col .seg button').forEach(b => {
    b.classList.toggle('on', Number(b.dataset.i) === n);
  });
  applyUnSize();
}

function toggleUnTile(file) {
  const it = unItemByFile(file);
  if (!it || !it.canUninstall) return;
  if (unUI.sel.has(it.appId)) unUI.sel.delete(it.appId);
  else unUI.sel.add(it.appId);
  refreshUnPick();
}

function toggleUnGroup(g) {
  const list = unColItems(g).filter(x => x.canUninstall);
  const allOn = list.length > 0 && list.every(x => unUI.sel.has(x.appId));
  for (const it of list) {
    if (allOn) unUI.sel.delete(it.appId);
    else unUI.sel.add(it.appId);
  }
  refreshUnPick();
}

function selectAllUn(on) {
  if (!on) unUI.sel.clear();
  else for (const it of unItems()) if (it.canUninstall) unUI.sel.add(it.appId);
  refreshUnPick();
}

/** 勾选变化后只重画网格和计数，不整套重排 */
function refreshUnPick() {
  if (unUI.mode === 'all') { refreshUnAll(); return; }
  const cols = document.querySelector('.un-cols');
  if (cols) {
    cols.outerHTML = `<div class="un-cols">${UN_GROUPS.map((g, i) => unColHtml(g, i)).join('')}</div>`;
    applyUnSize();
    paintUnIcons();
  }
  const nEl = document.querySelector('.un-sel-n b');
  if (nEl) nEl.textContent = String(unUI.sel.size);
  const foot = document.getElementById('unFoot');
  if (foot && unUI.step === 'pick') foot.innerHTML = unPickFoot();
}

/** 「全部软件」：只更新勾选状态和计数，不重画列表（重画会丢滚动位置，还闪） */
function refreshUnAll() {
  const box = document.getElementById('unAllList');
  if (box) {
    const map = new Map(unAllItems().map(x => [x.id, x]));
    box.querySelectorAll('.un-arow').forEach(el => {
      const it = map.get(el.dataset.id);
      if (!it) return;
      const pickable = unAllPickable(it);
      const on = pickable && unUI.sel.has(it.id);
      el.classList.toggle('on', on);
      const cb = el.querySelector('input[data-act="arow"]');
      if (cb) cb.checked = on;
    });
  }
  syncUnCounts();
}

/** 「全部软件」：整条列表重画 —— 只在搜索、切分类、改分类后需要 */
function redrawUnAll() {
  const box = document.getElementById('unAllList');
  if (box) {
    const list = unAllList();
    box.innerHTML = list.length
      ? list.map(unAllRow).join('')
      : `<div class="un-empty big">${unUI.onlyCan ? '这一类没有能卸的' : '这一类是空的'}</div>`;
    paintUnAllIcons();
  }
  syncUnCounts();
}

function syncUnCounts() {
  const nEl = document.querySelector('.un-sel-n b');
  if (nEl) nEl.textContent = String(unUI.sel.size);
  const foot = document.getElementById('unFoot');
  if (foot && unUI.step === 'pick') foot.innerHTML = unAllPickFoot();
}

/** 全选 / 取消当前分类里可勾的那些 */
function selectUnCat() {
  const list = unAllList().filter(x => unAllPickable(x));
  const allOn = list.length > 0 && list.every(x => unUI.sel.has(x.id));
  for (const it of list) {
    if (allOn) unUI.sel.delete(it.id);
    else unUI.sel.add(it.id);
  }
  refreshUnAll();
}

/** 从清单里去掉一个软件：必须让服务端重建清单，否则它照样会被卸 */
async function dropUnApp(appId) {
  const b = unUI.batch;
  if (!b || unUI.busy) return;
  const keep = b.items.filter(x => x.appId !== appId);
  unUI.sel.delete(appId);

  if (!keep.length) {
    unUI.step = 'pick';
    unUI.batch = null;
    paintUn();
    return;
  }

  const items = keep.filter(x => x.status !== 'bad').map(x => ({
    appId: x.appId,
    name: x.name,
    iconUrl: x.iconUrl,
    file: x.file,
    lnkFiles: unUI.mode === 'all' ? [] : unItems().filter(y => y.appId === x.appId).map(y => y.file)
  }));

  unUI.busy = true;
  paintUn();
  const r = await unFetch('/api/uninstall/batch', { items });
  unUI.busy = false;
  if (!r.ok) { toast(r.data.error || '去掉这个失败了', true); paintUn(); return; }
  unUI.batch = r.data.batch;
  if (typeof r.data.hasBackup === 'boolean') unUI.hasBackup = r.data.hasBackup;
  paintUn();
}

/* ---------- 动作：建清单 / 开始 / 停止 / 清残留 ---------- */

async function unGoList() {
  if (!unUI.sel.size) { toast('先勾选要卸载的软件', true); return; }
  const items = [];
  if (unUI.mode === 'all') {
    const byId = new Map(unAllItems().map(x => [x.id, x]));
    for (const id of unUI.sel) {
      const it = byId.get(id);
      if (!it) continue;
      items.push({ appId: id, name: it.name, iconUrl: it.iconUrl || '', file: '', lnkFiles: [] });
    }
  } else {
    for (const appId of unUI.sel) {
      const same = unItems().filter(x => x.appId === appId);
      const first = same[0] || {};
      items.push({
        appId,
        name: first.name || '',
        iconUrl: first.iconUrl || '',
        file: first.file || '',
        lnkFiles: same.map(x => x.file)
      });
    }
  }

  unUI.step = 'list';
  unUI.batch = null;
  unUI.err = '';
  unUI.needBackup = false;
  unUI.busy = true;
  paintUn();

  const r = await unFetch('/api/uninstall/batch', { items });
  unUI.busy = false;
  if (!r.ok) {
    unUI.err = r.data.error || '准备清单失败了';
    paintUn();
    return;
  }
  unUI.batch = r.data.batch;
  unUI.hasBackup = !!r.data.hasBackup;
  unUI.err = '';
  paintUn();
}

async function unStart() {
  if (!unUI.batch || unUI.busy) return;
  unUI.busy = true;
  unUI.err = '';
  paintUn();

  const r = await unFetch('/api/uninstall/batch/start', {
    id: unUI.batch.id, ackNoBackup: unUI.ackRisk
  });
  unUI.busy = false;
  if (!r.ok) {
    unUI.needBackup = r.status === 409;
    unUI.err = r.data.error || '启动失败';
    if (unUI.needBackup) unUI.ackRisk = false;
    paintUn();
    return;
  }
  unUI.batch = r.data.batch;
  unUI.needBackup = false;
  unUI.stopped = false;
  unUI.step = 'run';
  paintUn();
  startUnPoll();
}

function startUnPoll() {
  stopUnPoll();
  unUI.poll = setInterval(async () => {
    if (!unUI.batch) { stopUnPoll(); return; }
    const r = await unFetch('/api/uninstall/batch?id=' + encodeURIComponent(unUI.batch.id));
    if (!r.ok) return;
    unUI.batch = r.data.batch;
    const st = unUI.batch.state;
    if (st === 'done' || st === 'stopped') {
      stopUnPoll();
      unUI.stopped = st === 'stopped';
      unUI.step = 'done';
      unUI.pick.clear();
      paintUn();
      // 桌面上的图标可能已经被卸掉了，下次打开重新扫
      unUI.scan = null;
      if (typeof refreshCleanPage === 'function') refreshCleanPage();
      return;
    }
    if (unUI.step === 'run') paintUn();
  }, 1200);
}

async function unStop() {
  if (!unUI.batch || unUI.stopped) return;
  unUI.stopped = true;
  const r = await unFetch('/api/uninstall/batch/stop', { id: unUI.batch.id });
  if (r.ok) unUI.batch = r.data.batch;
  if (unUI.step === 'run') paintUn();
  toast('已停：当前这个卸载窗口还在，关掉它就算取消；后面的不会再弹了');
}

let unArmTimer = 0;
function disarmUn() {
  unUI.arm = false;
  if (unArmTimer) { clearTimeout(unArmTimer); unArmTimer = 0; }
}

async function unCleanResidual() {
  const keys = [...unUI.pick];
  if (!keys.length || unUI.busy) return;
  if (!unUI.arm) {
    unUI.arm = true;
    unArmTimer = setTimeout(() => { disarmUn(); if (unUI.step === 'done') paintUn(); }, 6000);
    paintUn();
    return;
  }
  disarmUn();

  const byPlan = new Map();
  for (const k of keys) {
    const [pid, rid] = String(k).split('|');
    if (!pid || !rid) continue;
    if (!byPlan.has(pid)) byPlan.set(pid, []);
    byPlan.get(pid).push(rid);
  }

  unUI.busy = true;
  paintUn();
  let cleaned = 0;
  const failed = [];
  for (const [pid, ids] of byPlan) {
    const r = await unFetch('/api/uninstall/residual', { planId: pid, ids });
    if (r.ok) {
      cleaned += r.data.cleaned || 0;
      for (const f of (r.data.refused || [])) failed.push(f.reason || f.path);
    } else {
      failed.push(r.data.error || '清理失败');
    }
  }
  unUI.busy = false;
  unUI.pick.clear();

  // 拉一次最新进度，界面跟真实情况对齐
  const st = await unFetch('/api/uninstall/batch?id=' + encodeURIComponent(unUI.batch.id));
  if (st.ok) unUI.batch = st.data.batch;
  paintUn();

  toast(cleaned ? `清掉 ${cleaned} 项，都进回收站了${failed.length ? `，${failed.length} 项没动` : ''}`
                : (failed.length ? `没能清理：${failed[0]}` : '没有可清理的了'), !cleaned && failed.length);
}

/* ---------- 小工具 ---------- */

function shortPath(p) {
  const s = String(p || '');
  if (s.length <= 46) return s;
  const parts = s.split(/[\\/]/);
  if (parts.length <= 2) return s.slice(0, 22) + '…' + s.slice(-22);
  return parts[0] + '\\…\\' + parts.slice(-2).join('\\');
}

function cleanAppName(n) {
  return String(n || '').replace(/\s+v?\d+(\.\d+)+.*$/i, '').replace(/\s+\d{4}\.\d+.*$/, '').trim() || String(n || '');
}

/* ---------------- 桌面备份 ---------------- */
const bkUI = {
  promptShown: false,   // 「还没备份」的提醒只弹一次
  bannerDismissed: false
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function backupReady() {
  return !!(state.backup && state.backup.hasBackup);
}

/* ---------- 一级页面切换 ---------- */
function setView(v) {
  if (v !== 'organize' && v !== 'backup' && v !== 'clean') v = 'organize';
  state.view = v;
  document.body.dataset.page = v;
  $('#viewOrganize').classList.toggle('hidden', v !== 'organize');
  $('#viewBackup').classList.toggle('hidden', v !== 'backup');
  $('#viewClean').classList.toggle('hidden', v !== 'clean');
  $('#bar').classList.toggle('hidden', v !== 'organize');
  document.querySelectorAll('#topNav .topnav-i').forEach(b => {
    b.classList.toggle('is-on', b.dataset.nav === v);
  });
  if (v === 'backup') {
    $('#viewBackup').scrollTop = 0;
    refreshBackupPage();
  } else if (v === 'clean') {
    $('#viewClean').scrollTop = 0;
    refreshCleanPage();
  } else {
    $('#viewOrganize').scrollTop = 0;
  }
}

function renderBackupEntry() {
  const dot = $('#bkDot');
  if (!dot) return;
  const need = !backupReady();
  dot.classList.toggle('on', need);
  dot.title = need
    ? '还没备份过桌面，建议先备份一次'
    : (state.backup && state.backup.last ? '上次备份：' + fmtDate(state.backup.last.at) : '桌面备份');
}

function renderBackupBanner() {
  const el = $('#backupBanner');
  if (!el) return;
  el.classList.toggle('hidden', backupReady() || bkUI.bannerDismissed);
}

/* ---------- 数据 ---------- */
async function loadBackupState() {
  try {
    const r = await api('/api/backup/list');
    state.backup = r;
    state.cfg = {
      ...(state.cfg || {}),
      targetRoot: r.targetRoot,
      backupRoot: r.backupRoot,
      backupBase: r.root
    };
  } catch { /* 读不到就当没备份过，不影响其它功能 */ }
  renderBackupBanner();
  renderBackupEntry();
  return state.backup;
}

async function refreshBackupPage() {
  try {
    await loadBackupState();
  } catch { /* ignore */ }
  paintBackupPage();
}

/* ---------- 渲染备份页 ---------- */
function paintBackupPage() {
  const b = state.backup || {};
  const last = b.last || null;
  const cur = b.current || {};

  const delta = last ? (cur.itemCount || 0) - (last.itemCount || 0) : 0;
  $('#bkTitle').textContent = last ? '桌面有变化，就再存一份' : '先把桌面存一份，再放心动手';
  $('#bkLead').textContent = last
    ? `上次备份是 ${fmtDate(last.at)}${delta > 0 ? `，之后桌面上多了 ${delta} 项` : (delta < 0 ? `，之后桌面上少了 ${-delta} 项` : '，之后桌面数量没有变化')}。`
    : '备份会复制桌面上的文件、文件夹和快捷方式，同时记下每个图标现在的位置。';

  $('#bkStatItems').textContent = cur.itemCount || 0;
  $('#bkStatSize').textContent = fmtSize(cur.totalBytes || 0);
  $('#bkStatCount').textContent = b.count || 0;

  const note = $('#bkNote');
  if (note) {
    const keep = b.keep || 5;
    note.textContent = last
      ? `再备份只会复制新增和改动过的文件，没变过的直接沿用上一份 · 最多保留 ${keep} 份`
      : `只复制、不删除 · 第一次全量，之后只补新增的文件 · 最多保留 ${keep} 份`;
  }

  const lbl = $('#bkCreateLabel');
  if (lbl) lbl.textContent = last ? '立即备份' : '选择位置并备份';

  $('#bkFree').textContent = b.freeSpace ? '磁盘可用 ' + fmtSize(b.freeSpace) : '';
  $('#bkReal').textContent = b.root || '';

  // 输入框：正在输入时不要覆盖用户手上的内容
  const inp = $('#bkRootInput');
  if (inp && document.activeElement !== inp) inp.value = b.backupRoot || '';

  const sugs = (state.data && state.data.suggestions) || [];
  const q = $('#bkQuick');
  if (q) {
    q.innerHTML = sugs.map(p => `<button class="chip" data-bkpath="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join('');
  }

  paintBackupList(b);
  paintOrigin(b);
}

function paintBackupList(b) {
  const el = $('#bkList');
  if (!el) return;
  const list = b.backups || [];
  const tip = $('#bkListTip');
  if (tip) tip.textContent = list.length ? `最多保留 ${b.keep || 5} 份，超出自动删最旧的` : '';

  if (!list.length) {
    el.innerHTML = `
      <div class="bk-empty">
        <div class="bk-empty-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5A2 2 0 0 1 6 5.5h4l2 2.2h6a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7.5Z"/><path d="M12 11.5v5M9.6 14h4.8"/></svg>
        </div>
        <div class="bk-empty-t">还没有备份</div>
        <div class="bk-empty-d">点上面的「立即备份」，几秒钟就有一份可以后悔的存档。</div>
      </div>`;
    return;
  }

  el.innerHTML = list.map((x, i) => `
    <div class="bk-item">
      <div class="bk-item-ic">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5A2 2 0 0 1 6 5.5h4l2 2.2h6a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7.5Z"/></svg>
      </div>
      <div class="bk-item-body">
        <div class="bk-item-t">
          ${fmtDate(x.at)}
          ${i === 0 ? '<span class="bk-badge">最新</span>' : ''}
          ${x.restoredAt ? `<span class="bk-badge gray">${fmtDate(x.restoredAt)} 恢复过</span>` : ''}
        </div>
        <div class="bk-item-m">
          <span>${x.itemCount} 项</span><i>·</i>
          <span>${fmtSize(x.totalBytes)}</span><i>·</i>
          <span>${x.iconCount ? '图标 ' + x.iconCount + ' 个' : '无图标记录'}</span>
          ${x.newCount ? `<i>·</i><span class="ok-t">新增 ${x.newCount} 项</span>` : ''}
          ${x.skipped ? `<i>·</i><span class="warn-t">${x.skipped} 项跳过</span>` : ''}
        </div>
      </div>
      <div class="bk-item-act">
        <button class="btn" data-restore="${escapeHtml(x.id)}" data-mode="all">恢复</button>
        <button class="btn" data-restore="${escapeHtml(x.id)}" data-mode="icons" title="只把图标摆回原位，不动文件">只恢复图标</button>
        <button class="btn" data-open="${escapeHtml(x.id)}">打开</button>
        <button class="btn danger-ghost" data-del="${escapeHtml(x.id)}">删除</button>
      </div>
    </div>`).join('');

  el.querySelectorAll('[data-restore]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = list.find(x => x.id === btn.dataset.restore);
      if (item) confirmRestore(item, btn.dataset.mode);
    });
  });
  el.querySelectorAll('[data-open]').forEach(btn => {
    btn.addEventListener('click', () => {
      const base = (state.backup && state.backup.root) || '';
      if (!base) return;
      api('/api/open', { path: base + '\\' + btn.dataset.open }).catch(() => {});
    });
  });
  el.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const item = list.find(x => x.id === btn.dataset.del);
      if (!item) return;
      if (!confirm(`删除 ${fmtDate(item.at)} 的备份？\n\n备份里的文件和图标记录都会被删掉，桌面不受影响。`)) return;
      btn.disabled = true;
      try {
        await api('/api/backup/delete', { id: item.id });
        toast('已删除这份备份');
        await refreshBackupPage();
      } catch (e) {
        btn.disabled = false;
        toast(e.message, true);
      }
    });
  });
}

function paintOrigin(b) {
  const el = $('#bkOrigin');
  if (!el) return;
  const n = (b.origin && b.origin.count) || 0;
  if (!n) {
    el.innerHTML = '<div class="bk-empty-inline">还没有图标重排记录。做过一次「桌面快捷方式重排」之后，这里会出现「摆回最初的位置」。</div>';
    return;
  }
  el.innerHTML = `
    <div class="bk-origin">
      <div class="bk-origin-ic">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7H5v4"/><path d="M5.6 11a7 7 0 1 1 1.2 5.4"/></svg>
      </div>
      <div class="bk-origin-text">
        <b>用这个软件之前的样子</b>
        <span>软件记着第一次整理之前每个图标的位置（${n} 个），不用提前备份也能随时摆回去。</span>
      </div>
      <button class="btn" data-origin>摆回最初的位置</button>
    </div>`;
  const btn = el.querySelector('[data-origin]');
  if (btn) btn.addEventListener('click', restoreOrigin);
}

/* ---------- 备份位置 ---------- */
async function saveBackupRoot(p) {
  const path = String(p || '').trim();
  if (!path) return null;
  const r = await api('/api/settings', { backupRoot: path });
  state.cfg = { ...(state.cfg || {}), targetRoot: r.targetRoot, backupRoot: r.backupRoot, backupBase: r.backupBase };
  state.backup = { ...(state.backup || {}), backupRoot: r.backupRoot, targetRoot: r.targetRoot, root: r.backupBase };
  const ti = $('#targetInput');
  if (ti) ti.value = r.targetRoot;
  clearBkRootError();
  paintBackupPage();
  return r;
}

function setBkRootError(msg) {
  const el = $('#bkRootErr');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  $('#bkRootInput').classList.add('invalid');
}

function clearBkRootError() {
  const el = $('#bkRootErr');
  if (!el) return;
  el.classList.add('hidden');
  $('#bkRootInput').classList.remove('invalid');
}

async function pickBackupRoot() {
  const btn = $('#bkPick');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '选择中…';
  try {
    const r = await api('/api/pick-folder', {
      current: $('#bkRootInput').value,
      title: '选择桌面备份的存放位置'
    });
    if (r.path) {
      $('#bkRootInput').value = r.path;
      const s = await saveBackupRoot(r.path);
      toast(s && s.synced ? '备份位置已更新，整理桌面的存放位置也跟着改了' : '备份位置已更新');
    }
  } catch (e) {
    setBkRootError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

/* ---------- 提醒（只弹一次） ---------- */
function withBackupCheck(run) {
  if (backupReady() || bkUI.promptShown) { run(); return; }
  bkUI.promptShown = true;
  showBackupPrompt(run);
}

function showBackupPrompt(run) {
  const m = modal(`
    <div class="modal-head">
      <div>
        <h3>要不要先备份一次？</h3>
        <p>你还没有备份过桌面（这个提醒只出现一次）</p>
      </div>
      <button class="modal-close" data-cancel>✕</button>
    </div>
    <div class="modal-body">
      <div class="bk-hero-mini">
        <div class="bk-hero-mini-ic" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v10"/><path d="m8 9 4 4 4-4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
        </div>
        <div>
          <div class="bk-hero-mini-t">备份 = 后悔药</div>
          <div class="bk-hero-mini-d">桌面上的文件、快捷方式复制一份，每个图标现在在哪个位置也一起记下来。</div>
        </div>
      </div>
      <ul class="bk-points">
        <li><b>文件备份</b>：桌面上的文件、文件夹、快捷方式各复制一份，只读不删。</li>
        <li><b>图标备份</b>：记下每个图标的名字和坐标，重排不满意可以按原样摆回去。</li>
        <li><b>存放位置</b>：默认和整理后的文件放在同一个文件夹，可以自己换。</li>
      </ul>
    </div>
    <div class="modal-foot">
      <button class="btn" data-skip>先不备份，直接开始</button>
      <button class="btn primary" data-gobk>先备份（推荐）</button>
    </div>
  `);
  m.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', closeModal));
  m.querySelector('[data-skip]').addEventListener('click', () => { closeModal(); run(); });
  m.querySelector('[data-gobk]').addEventListener('click', () => {
    closeModal();
    goBackup({ autoCreate: true, after: run });
  });
}

/** 切到备份页；autoCreate 时马上开跑（第一次会先问放哪个文件夹） */
function goBackup(opts = {}) {
  setView('backup');
  if (!opts.autoCreate) return;
  if (backupReady()) doBackup({ after: opts.after });
  else askFirstBackupRoot({ after: opts.after });
}

/**
 * 第一次备份先问「放在哪个文件夹」。
 * 选完这个文件夹，整理桌面的存放位置也会默认跟过来（之后两边都能单独改）。
 */
function askFirstBackupRoot(opts = {}) {
  const cur = (state.cfg && state.cfg.backupRoot) || '';
  const sugs = (state.data && state.data.suggestions) || [];
  const chips = sugs.map(p => `<button class="chip" data-fp="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join('');

  const m = modal(`
    <div class="modal-head">
      <div><h3>备份放在哪个文件夹？</h3><p>第一次备份先选个位置，以后就记住了</p></div>
      <button class="modal-close" data-cancel>✕</button>
    </div>
    <div class="modal-body">
      <div class="path-row">
        <input id="bkFirstInput" class="input" spellcheck="false" placeholder="例如 D:\桌面备份" value="${escapeHtml(cur)}">
        <button class="btn" data-pick>浏览…</button>
      </div>
      <div class="field-err hidden" data-err></div>
      <div class="quick" data-quick>${chips}</div>
      <div class="bk-hint">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>
        <span>存档会放在所选文件夹下面的「桌面备份」里。这个文件夹同时也是「整理桌面」的默认存放位置，整理那边还能单独改。</span>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-cancel>先不备份</button>
      <button class="btn primary" data-go>开始备份</button>
    </div>
  `);

  const input = m.querySelector('#bkFirstInput');
  const errBox = m.querySelector('[data-err]');
  const showErr = (msg) => {
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
    input.classList.add('invalid');
  };
  const clearErr = () => {
    errBox.classList.add('hidden');
    input.classList.remove('invalid');
  };

  m.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', closeModal));

  m.querySelector('[data-pick]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '选择中…';
    try {
      const r = await api('/api/pick-folder', { current: input.value, title: '选择桌面备份的存放位置' });
      if (r.path) { input.value = r.path; clearErr(); }
    } catch (err) { showErr(err.message); }
    finally { btn.disabled = false; btn.textContent = old; }
  });

  m.querySelector('[data-quick]').addEventListener('click', (e) => {
    const c = e.target.closest('[data-fp]');
    if (c) { input.value = c.dataset.fp; clearErr(); }
  });

  input.addEventListener('input', clearErr);

  m.querySelector('[data-go]').addEventListener('click', async (e) => {
    const p = input.value.trim();
    if (!p) { showErr('还没有选文件夹'); input.focus(); return; }
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '准备中…';
    try {
      const r = await saveBackupRoot(p);
      if (!r) throw new Error('备份位置保存失败');
      closeModal();
      if (r.synced) toast('备份位置定了，整理桌面的存放位置也同步成了这个文件夹');
      doBackup({ after: opts.after });
    } catch (err) {
      btn.disabled = false; btn.textContent = '开始备份';
      showErr(err.message);
    }
  });
}

/* ---------- 执行 ---------- */
function bkProgressModal(title, sub, tip) {
  const m = modal(`
    <div class="modal-head"><div><h3>${escapeHtml(title)}</h3><p data-phase>${escapeHtml(sub)}</p></div></div>
    <div class="modal-body">
      <div class="prog-wrap">
        <div class="prog-bar"><i data-fill style="width:5%"></i></div>
        <div class="prog-meta">
          <span><b data-done>0</b> / <span data-total>0</span> 项</span>
          <span class="prog-cur" data-cur>准备中…</span>
        </div>
      </div>
      <div class="prog-tip">${tip}</div>
    </div>
  `, { dismissible: false });
  return m;
}

function updateBkProgress(m, j) {
  const fill = m.querySelector('[data-fill]');
  const total = j.total || 0;
  const pct = total ? Math.max(5, Math.min(100, Math.round((j.done / total) * 100))) : 8;
  if (fill) fill.style.width = pct + '%';
  const d = m.querySelector('[data-done]');
  if (d) d.textContent = j.done || 0;
  const t = m.querySelector('[data-total]');
  if (t) t.textContent = total || '—';
  const c = m.querySelector('[data-cur]');
  if (c && j.current) c.textContent = j.current;
}

/** 备份/恢复任务轮询：后台是独立任务，不会和文件整理抢 */
async function runBkJob(path, body, onTick) {
  await api(path, body);
  for (let i = 0; i < 3000; i++) {
    await sleep(220);
    let j;
    try {
      j = await api('/api/backup/job');
    } catch (e) {
      if (i > 40) throw e;
      continue;
    }
    if (j.state === 'running') { onTick(j); continue; }
    if (j.state === 'error') {
      await api('/api/backup/ack', {}).catch(() => {});
      throw new Error(j.error || '任务失败');
    }
    if (j.state === 'done') {
      await api('/api/backup/ack', {}).catch(() => {});
      return j.result;
    }
    throw new Error('后台任务已经结束，但没拿到结果，刷新一下看看');
  }
  throw new Error('等太久了，先看看备份页的状态');
}

async function doBackup(opts = {}) {
  // 输入框里改过就先存下来，避免「看着改了、其实备份到老地方」
  const inp = $('#bkRootInput');
  const typed = inp ? inp.value.trim() : '';
  if (typed && state.cfg && typed !== state.cfg.backupRoot) {
    try {
      await saveBackupRoot(typed);
      if (state.cfg.backupRoot !== typed) return;
    } catch (e) {
      setBkRootError(e.message);
      return;
    }
  }

  const first = !backupReady();
  const m = bkProgressModal('正在备份桌面…', first ? '只复制，不动原文件' : '只补这次新增和改动过的文件',
    '桌面东西多的话会慢一些（大文件要复制）。备份期间别退出软件，中途退出会留下一份不完整的备份。');
  try {
    const r = await runBkJob('/api/backup/create', {}, (j) => updateBkProgress(m, j));
    closeModal();
    await refreshBackupPage();
    showBackupResult(r, opts.after);
  } catch (e) {
    closeModal();
    toast('备份失败：' + e.message, true);
    refreshBackupPage();
  }
}

function showBackupResult(r, after) {
  const reused = r.reusedCount || 0;
  const extra = reused ? `其中 ${reused} 个文件没变过，直接沿用了上一份，没有重复占空间。` : '';
  const m = modal(`
    <div class="modal-head">
      <div><h3>备份完成</h3><p>现在可以放心动手了</p></div>
      <button class="modal-close" data-close>✕</button>
    </div>
    <div class="modal-body">
      <div class="result-hero">
        <div class="result-icon">✓</div>
        <div class="result-title">已备份 ${r.itemCount} 项</div>
        <div class="result-desc">${r.iconCount
          ? `同时记下了 ${r.iconCount} 个图标的位置`
          : '图标位置没能记录：' + escapeHtml(r.iconError || '未知原因')}</div>
      </div>
      <div class="result-stats">
        <div class="stat"><b>${r.itemCount}</b><span>桌面项目</span></div>
        <div class="stat"><b>${r.fileCount}</b><span>文件</span></div>
        <div class="stat"><b>${fmtSize(r.totalBytes)}</b><span>占用空间</span></div>
      </div>
      ${extra ? `<div class="result-tip">${extra}</div>` : ''}
      ${r.skipped ? `<div class="result-tip">有 ${r.skipped} 项没备份成功（多半是没权限或文件正被占用），可以稍后再备份一次。</div>` : ''}
      <div class="hint-box">以后想回到这一刻：切到「桌面备份」，在历史备份里找到这一条，点「恢复」。</div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-open>打开备份文件夹</button>
      ${after ? '<button class="btn primary" data-after>继续刚才的操作</button>' : '<button class="btn primary" data-close>好</button>'}
    </div>
  `);
  m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  m.querySelector('[data-open]').addEventListener('click', () => {
    openBackupFolder();
  });
  const go = m.querySelector('[data-after]');
  if (go) go.addEventListener('click', () => { closeModal(); after(); });
}

function openBackupFolder() {
  const base = (state.backup && state.backup.root) || '';
  if (!base) { toast('还没设置备份位置', true); return; }
  api('/api/open', { path: base, mkdir: true }).catch(() => {});
}

/** 回到「用这个软件之前」：靠最早一次重排留下的原坐标，不需要提前备份 */
async function restoreOrigin() {
  if (!confirm('把图标摆回「第一次整理之前」的位置？\n\n只改图标坐标，桌面上的文件一个都不会动。')) return;
  const m = bkProgressModal('正在还原最初的位置…', '把图标摆回第一次整理之前',
    '只改图标坐标，文件不动。逐个写入需要几秒钟。');
  const fill = m.querySelector('[data-fill]');
  if (fill) fill.style.width = '30%';
  const cur = m.querySelector('[data-cur]');
  if (cur) cur.textContent = '正在写入坐标…';
  try {
    const r = await api('/api/backup/restore-origin', {});
    closeModal();
    toast(`已把 ${r.applied} 个图标摆回最初的位置${r.missing ? `（${r.missing} 个已不在桌面）` : ''}`);
    state.data = await api('/api/rescan', {});
    render();
    await refreshBackupPage();
  } catch (e) {
    closeModal();
    toast(e.message, true);
  }
}

function confirmRestore(b, mode) {
  const all = mode !== 'icons';
  const msg = all
    ? `恢复到 ${fmtDate(b.at)} 的备份？\n\n· 备份里的文件会补回桌面（桌面上已有的同名项目会被跳过，不会被覆盖）\n· 所有图标会摆回那一刻的坐标\n\n这一步可以放心点：不动、不删你现在的东西。`
    : `把图标摆回 ${fmtDate(b.at)} 的位置？\n\n文件不会动，只改图标坐标。`;
  if (confirm(msg)) runRestore(b.id, mode);
}

async function runRestore(id, mode) {
  const iconsOnly = mode === 'icons';
  const m = bkProgressModal(iconsOnly ? '正在还原图标位置…' : '正在恢复桌面…',
    iconsOnly ? '把图标按备份时的坐标摆回去' : '把备份里的文件放回桌面',
    iconsOnly ? '只改图标坐标，文件一个都不动。' : '桌面上已有的同名项目会被跳过，不会被覆盖。请别关窗口。');
  try {
    const r = await runBkJob('/api/backup/restore',
      { id, files: !iconsOnly, icons: true },
      (j) => updateBkProgress(m, j));
    closeModal();

    const parts = [];
    if (r.files) parts.push(`文件恢复 ${r.files.restored} 项${r.files.skipped ? `（${r.files.skipped} 项桌面上已有，跳过）` : ''}`);
    if (r.icons && r.icons.ok) parts.push(`图标还原 ${r.icons.applied} 个${r.icons.missing ? `（${r.icons.missing} 个已不在桌面）` : ''}`);
    else if (r.icons && !r.icons.ok) parts.push('图标没还原：' + r.icons.error);

    toast(parts.length ? '已恢复：' + parts.join('；') : '恢复完成');

    state.data = await api('/api/rescan', {});
    render();
    await refreshBackupPage();
  } catch (e) {
    closeModal();
    toast('恢复失败：' + e.message, true);
  }
}

/* ---------------- 启动 ---------------- */
(async function init() {
  bindEvents();
  $('#btnShortcuts').addEventListener('click', () => withBackupCheck(openShortcuts));
  $('#undoBtn').addEventListener('click', doUndo);
  $('#undoClose').addEventListener('click', hideUndoBar);
  try {
    state.data = await api('/api/state');
    const valid = new Set(state.data.categories.filter(c => c.count > 0).map(c => c.key));
    state.selected = new Set((state.data.defaults.selected || []).filter(k => valid.has(k)));
    state.backup = state.data.backup || { hasBackup: false };
    state.cfg = {
      targetRoot: state.data.defaults.targetRoot || '',
      backupRoot: state.data.defaults.backupRoot || '',
      backupBase: state.data.defaults.backupBase || ''
    };
    render();
    renderBackupEntry();
    renderBackupBanner();
    paintBackupPage();
  } catch (e) {
    $('#desktopPath').textContent = '读取桌面失败：' + e.message;
    toast(e.message, true);
  }
})();

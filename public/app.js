'use strict';
/* public/app.js — 前端交互逻辑（原生 JS，无依赖） */

const $ = (id) => document.getElementById(id);
const fmtSize = (b) => {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 ? 0 : 1) + ' ' + u[i];
};
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
};

const state = {
  token: localStorage.getItem('ff_token') || '',
  videos: [],
  current: null,     // {name, size, mtime}
  meta: null,        // probe 结果
  segments: [],
  jobs: [],
  lastJobPoll: 0,
};

/* ---------- API ---------- */
async function api(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.token) headers['x-auth-token'] = state.token;
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) { promptToken(true); throw new Error('需要访问口令'); }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function promptToken(force = false) {
  if (!force && state.token) return Promise.resolve();
  return api('/api/config').then((cfg) => {
    if (cfg.needAuth && !state.token) {
      const t = prompt('请输入访问口令 (AUTH_TOKEN):');
      if (t) { state.token = t; localStorage.setItem('ff_token', t); }
    }
  }).catch(() => {});
}

const toast = (msg, type = '') => {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
};

/* ---------- 初始化 ---------- */
async function init() {
  await promptToken();
  try {
    const h = await api('/api/health');
    $('ffver').textContent = h.ffmpeg;
    $('statusDot').classList.add('ok');
  } catch (e) {
    $('statusDot').classList.add('bad');
  }
  bindUI();
  await Promise.all([loadVideos(), loadOutputs(), loadJobs()]);
  setInterval(() => { loadJobs().catch(() => {}); }, 1500);
}

/* ---------- 视频库 ---------- */
async function loadVideos() {
  const vids = await api('/api/videos');
  state.videos = vids;
  const grid = $('fileList');
  grid.innerHTML = '';
  $('libStats').textContent = `${vids.length} 个视频 · 共 ${fmtSize(vids.reduce((s, v) => s + v.size, 0))}`;

  if (!vids.length) {
    grid.innerHTML = '<div class="empty-note">视频库为空<br/>点击右上角「上传」导入本地视频</div>';
    return;
  }
  for (const v of vids) {
    const tile = document.createElement('div');
    tile.className = 'file-tile' + (state.current && state.current.name === v.name ? ' active' : '');
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = `/api/videos/${encodeURIComponent(v.name)}/thumbnail?t=${Math.round(v.mtime)}`;
    img.onerror = () => { tile.querySelector('.thumb-wrap')?.remove() || img.remove(); };
    img.alt = v.name;

    const name = document.createElement('div');
    name.className = 'ft-name';
    name.textContent = v.name;
    const size = document.createElement('div');
    size.className = 'ft-size';
    size.textContent = fmtSize(v.size);

    const loading = document.createElement('div');
    loading.className = 'file-loading';
    loading.textContent = '…';
    tile.appendChild(img); tile.appendChild(loading); tile.appendChild(name); tile.appendChild(size);
    img.addEventListener('load', () => loading.remove());
    img.addEventListener('error', () => loading.remove());

    tile.addEventListener('click', () => selectVideo(v));
    img.addEventListener('click', (e) => { e.stopPropagation(); selectVideo(v); });
    grid.appendChild(tile);
  }
}

async function selectVideo(v) {
  state.current = v;
  state.segments = [];
  renderSegments();
  document.querySelectorAll('.file-tile').forEach((t) => t.classList.remove('active'));
  toast('加载元数据: ' + v.name, 'ok');

  const info = await api(`/api/videos/${encodeURIComponent(v.name)}/info`);
  state.meta = info;
  const dur = info.format.duration || 0;

  $('stageEmpty').hidden = true;
  const video = $('videoEl');
  video.hidden = false;
  video.src = `/api/videos/${encodeURIComponent(v.name)}?t=${Math.round(v.mtime)}`;

  $('timeline').hidden = false;
  const s = $('trimStart'), e = $('trimEnd');
  s.max = e.max = dur;
  s.value = 0; e.value = dur;
  $('startTime').textContent = fmtTime(0);
  $('endTime').textContent = fmtTime(dur);
  $('tlInfo').textContent =
    `${info.video ? info.video.width + '×' + info.video.height + ' · ' + info.video.codec : ''}  音频: ${info.audio ? info.audio.codec : '无'} · 时长 ${fmtTime(dur)}`;

  $('segBtn').disabled = false;
  $('exportBtn').disabled = false;
  updateExportSummary();
}

/* ---------- 上传 ---------- */
function uploadFiles(files) {
  for (const f of files) {
    const fd = new FormData();
    fd.append('file', f);
    const xhr = new XMLHttpRequest();
    const item = document.createElement('div');
    const li = document.createElement('div');
    li.className = 'out-item uploading-item';
    li.innerHTML = `<span class="nm">${f.name}</span><span class="sz" id="upPct">0%</span>`;
    $('outList').prepend(li);
    const pct = li.querySelector('#upPct');
    xhr.open('POST', '/api/upload');
    if (state.token) xhr.setRequestHeader('x-auth-token', state.token);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) pct.textContent = Math.round(e.loaded / e.total * 100) + '%'; };
    xhr.onload = () => {
      li.remove();
      if (xhr.status >= 200 && xhr.status < 300) {
        toast('上传成功: ' + f.name, 'ok');
        loadVideos();
      } else {
        let msg = xhr.statusText;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        toast('上传失败: ' + msg, 'err');
      }
    };
    xhr.onerror = () => { li.remove(); toast('上传失败: 网络错误', 'err'); };
    xhr.send(fd);
  }
}

/* ---------- 时间轴 ---------- */
function bindUI() {
  $('refreshBtn').addEventListener('click', () => loadVideos().catch((e) => toast(e.message, 'err')));
  $('uploadBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { uploadFiles([...e.target.files]); e.target.value = ''; });
  $('outRefresh').addEventListener('click', () => loadOutputs());

  const s = $('trimStart'), e = $('trimEnd');
  s.addEventListener('input', () => {
    if (parseFloat(s.value) >= parseFloat(e.value) - 0.01) s.value = Math.max(0, parseFloat(e.value) - 0.01);
    $('startTime').textContent = fmtTime(parseFloat(s.value));
    syncTimeline(); updateExportSummary();
  });
  e.addEventListener('input', () => {
    if (parseFloat(e.value) <= parseFloat(s.value) + 0.01) e.value = Math.min(parseFloat(s.max), parseFloat(s.value) + 0.01);
    $('endTime').textContent = fmtTime(parseFloat(e.value));
    syncTimeline(); updateExportSummary();
  });
  document.querySelectorAll('.tl-btns .btn').forEach((b) => {
    b.addEventListener('click', () => {
      if (!state.meta) return;
      const el = b.dataset.target === 'start' ? s : e;
      el.value = Math.min(parseFloat(el.max), Math.max(parseFloat(el.min), parseFloat(el.value) + parseFloat(b.dataset.step)));
      el.dispatchEvent(new Event('input'));
    });
  });

  const video = $('videoEl');
  video.addEventListener('timeupdate', syncTimeline);
  video.addEventListener('ended', () => {
    const till = parseFloat(e.value);
    video.currentTime = Math.min(till, s.value);
    if (state.meta && till > 0 && till < state.meta.format.duration) {
      video.pause();
      toast('已播放到选区结束点', '');
    }
  });

  $('seekStartBtn').addEventListener('click', () => { video.currentTime = parseFloat(s.value); });
  $('prevSelBtn').addEventListener('click', () => {
    video.currentTime = parseFloat(s.value);
    video.play();
  });

  $('segBtn').addEventListener('click', addSegment);
  $('clearSegBtn').addEventListener('click', () => { state.segments = []; renderSegments(); });

  $('speedSel').addEventListener('input', () => { $('speedVal').textContent = parseFloat($('speedSel').value).toFixed(2).replace(/\.?0+$/, '') + 'x'; updateExportSummary(); });

  document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => {
    const mode = currentMode();
    $('formatField').hidden = mode === 'audio' || mode === 'thumb';
    $('audioFormatField').hidden = mode !== 'audio';
    if (mode === 'audio') $('resSel').value = '0';
    updateExportSummary();
  }));

  $('exportBtn').addEventListener('click', startExport);
  $('clearDoneBtn').addEventListener('click', async () => {
    for (const j of state.jobs) {
      if (['done', 'failed', 'cancelled'].includes(j.status)) {
        await api(`/api/jobs/${j.id}`, { method: 'DELETE' }).catch(() => {});
      }
    }
    loadJobs();
  });
}

function currentMode() { return document.querySelector('input[name=mode]:checked').value; }

function syncTimeline() {
  const dur = state.meta ? state.meta.format.duration : 0;
  if (!dur) return;
  const s = parseFloat($('trimStart').value), e = parseFloat($('trimEnd').value);
  const t = $('videoEl').currentTime || 0;
  $('tlFill').style.left = (s / dur * 100) + '%';
  $('tlFill').style.width = Math.max(0, ((e - s) / dur * 100)) + '%';
  $('tlPlayhead').style.left = (t / dur * 100) + '%';
}

/* ---------- 片段 ---------- */
function addSegment() {
  const s = parseFloat($('trimStart').value), e = parseFloat($('trimEnd').value);
  if (e - s < 0.05) return toast('片段太短', 'err');
  state.segments.push({ start: round3(s), end: round3(e) });
  renderSegments();
  toast('已添加片段 ' + fmtTime(s) + ' → ' + fmtTime(e), 'ok');
}
const round3 = (x) => Math.round(x * 1000) / 1000;
const segTotal = () => state.segments.reduce((sum, sg) => sum + (sg.end - sg.start), 0);

function renderSegments() {
  const body = $('segBody');
  body.innerHTML = '';
  state.segments.forEach((sg, i) => {
    const tr = document.createElement('tr');
    const dur = sg.end - sg.start;
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td class="seg-preview" title="预览">${fmtTime(sg.start)}</td>
      <td class="seg-preview" title="预览">${fmtTime(sg.end)}</td>
      <td>${fmtTime(dur)}</td>
      <td><button class="seg-del" title="删除">✕</button></td>`;
    tr.querySelector('td.seg-preview').addEventListener('click', () => { $('videoEl').currentTime = sg.start; });
    tr.querySelector('.seg-del').addEventListener('click', () => { state.segments.splice(i, 1); renderSegments(); });
    body.appendChild(tr);
  });
  $('segCount').textContent = state.segments.length;
  $('segTotal').textContent = state.segments.length ? `共 ${state.segments.length} 段 · 总时长 ${fmtTime(segTotal())}` : '还没有片段，先调整时间轴后添加';
  $('clearSegBtn').disabled = !state.segments.length;
  updateExportSummary();
}

/* ---------- 导出 ---------- */
function selectedFilters() {
  return [...document.querySelectorAll('.chips input:checked')].map((c) => c.value);
}

function updateExportSummary() {
  const btn = $('exportBtn');
  if (!state.current) { btn.disabled = true; $('exportSummary').textContent = '请先选择视频'; return; }
  const mode = currentMode();
  let txt = '';
  switch (mode) {
    case 'clip': {
      const s = parseFloat($('trimStart').value), e = parseFloat($('trimEnd').value);
      txt = `区间 ${fmtTime(s)} → ${fmtTime(e)} （${fmtTime(e - s)}）`;
      break;
    }
    case 'segments': {
      const n = state.segments.length;
      txt = n ? `拼接 ${n} 段，总时长 ${fmtTime(segTotal())}` : '片段列表为空，请先添加片段';
      btn.disabled = !n;
      break;
    }
    case 'full': txt = '整片导出（全部内容）'; break;
    case 'audio': txt = '提取音频 ' + $('audioFormatSel').value; break;
    case 'thumb': txt = '生成处于开始点的封面帧'; break;
  }
  const sp = parseFloat($('speedSel').value);
  const fl = selectedFilters();
  if (sp !== 1 && mode !== 'audio' && mode !== 'thumb') txt += ' · ' + sp + 'x 倍速';
  if (fl.length && mode !== 'audio' && mode !== 'thumb') txt += ' · 滤镜: ' + fl.join(',');
  $('exportSummary').textContent = txt;
}

async function startExport() {
  const btn = $('exportBtn');
  btn.disabled = true;
  try {
    const mode = currentMode();
    const params = { format: $('formatSel').value, height: parseInt($('resSel').value, 10) || 0, speed: parseFloat($('speedSel').value), filters: selectedFilters() };
    let type = mode;

    if (mode === 'clip') {
      type = 'clip';
      params.start = parseFloat($('trimStart').value);
      params.end = parseFloat($('trimEnd').value);
    } else if (mode === 'segments') {
      type = 'segments';
      params.segments = JSON.parse(JSON.stringify(state.segments));
    } else if (mode === 'audio') {
      type = 'audio';
      params.format = $('audioFormatSel').value;
      params.start = 0;
    } else if (mode === 'thumb') {
      type = 'thumb';
      params.at = parseFloat($('trimStart').value);
    } else {
      type = 'full';
      params.start = 0; params.end = 0;
    }

    const job = await api('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, video: state.current.name, params }),
    });
    toast('任务已创建', 'ok');
    await loadJobs();
  } catch (e) {
    toast('创建任务失败: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    updateExportSummary();
  }
}

/* ---------- 任务 ---------- */
let renderJobs = 0;
async function loadJobs() {
  const jobs = await api('/api/jobs');
  state.jobs = jobs;
  const active = jobs.some((j) => j.status === 'queued' || j.status === 'running');
  const wrap = $('jobsList');
  if (JSON.stringify(jobs.map((j) => [j.id, j.status, j.progress])) === JSON.stringify(renderJobs)) {
    if (!active) return;
  }
  renderJobs = jobs.map((j) => [j.id, j.status, j.progress]);
  wrap.innerHTML = '';
  if (!jobs.length) { wrap.innerHTML = '<p class="dim center">暂无任务</p>'; return; }

  $('jobCount').textContent = jobs.length;
  const done = (j) => {
    const act = j.status === 'running' ? `<span class="j-fill" style="width:${j.progress}%"></span>` : `<span class="j-fill" style="width:${j.status === 'done' ? 100 : 0}%"></span>`;
    const el = document.createElement('div');
    el.className = 'job';
    el.innerHTML = `
      <div class="j-top">
        <span class="j-status ${j.status}">${j.status}</span>
        <span class="j-name" title="${escapeHtml(j.name)}">${escapeHtml(j.name)}</span>
      </div>
      <div class="j-bar">${act}</div>
      <div class="j-actions">
        ${j.status === 'done' && j.outputUrl ? `<a href="${j.outputUrl}" download>⬇ 下载</a>` : ''}
        ${j.status === 'done' ? `<span class="dim">${fmtSize(j.outputSize)}</span>` : ''}
        ${j.status === 'queued' || j.status === 'running' ? `<button class="j-cancel">取消</button>` : ''}
        <button class="j-del">删除</button>
      </div>
      ${j.status === 'failed' ? `<div class="j-err">${escapeHtml((j.error || '').slice(0, 400))}</div>` : ''}
      ${j.status === 'cancelled' ? `<div class="j-err">已取消</div>` : ''}
      <div class="j-meta"><span>${new Date(j.createdAt).toLocaleTimeString()}</span>${j.endedAt ? `<span>${((j.endedAt - (j.startedAt || j.createdAt)) / 1000).toFixed(1)}s</span>` : ''}</div>`;
    const cancelBtn = el.querySelector('.j-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => api(`/api/jobs/${j.id}/cancel`, { method: 'POST' }).then(loadJobs));
    const delBtn = el.querySelector('.j-del');
    delBtn.addEventListener('click', async () => { await api(`/api/jobs/${j.id}`, { method: 'DELETE' }).catch(() => {}); loadJobs(); });
    wrap.appendChild(el);
  };
  jobs.forEach(done);
  if (!active) loadOutputs();
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- 输出文件 ---------- */
async function loadOutputs() {
  const outs = await api('/api/outputs');
  const list = $('outList');
  list.innerHTML = '';
  if (!outs.length) { list.innerHTML = '<p class="dim center">暂无输出</p>'; return; }
  outs.forEach((o) => {
    const el = document.createElement('div');
    el.className = 'out-item';
    el.innerHTML = `
      <span class="nm" title="${escapeHtml(o.name)}">${escapeHtml(o.name)}</span>
      <span class="sz">${fmtSize(o.size)}</span>
      <a class="a" href="/api/output/${encodeURIComponent(o.name)}" download>⬇</a>
      <button class="del" title="删除">🗑</button>`;
    el.querySelector('.del').addEventListener('click', async () => {
      await api(`/api/output/${encodeURIComponent(o.name)}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'err'));
      loadOutputs();
    });
    list.appendChild(el);
  });
}

/* ---------- 启动 ---------- */
window.addEventListener('DOMContentLoaded', init);
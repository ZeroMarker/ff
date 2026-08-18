'use strict';

/**
 * server.js — Web 视频编辑服务
 *  - 静态前端 / public
 *  - 本地视频库管理(列出/上传/流式播放/缩略图/元数据)
 *  - ffmpeg 任务队列(带并发上限、进度、取消、持久化)
 *  - 输出文件下载/删除
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const ff = require('./lib/ffmpeg');

/* 本地文件白名单校验：仅允许本地文件库中的文件（限制选择本地文件） */
function localVideoPath(name) {
  const fp = ff.safeJoin(VIDEOS_DIR, name);
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) throw new Error('源视频不在本地文件库中: ' + name);
  return fp;
}
function localAssetPath(name) {
  const fp = ff.safeJoin(ASSETS_DIR, name);
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) throw new Error('素材不存在: ' + name);
  return fp;
}

/* ------------------------------------------------------------------ */
/* 配置                                                                 */
/* ------------------------------------------------------------------ */

const PORT = parseInt(process.env.PORT, 10) || 8345;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const VIDEOS_DIR = path.resolve(process.env.VIDEOS_DIR || path.join(ROOT, 'videos'));
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || path.join(ROOT, 'output'));
const ASSETS_DIR = path.resolve(process.env.ASSETS_DIR || path.join(ROOT, 'assets'));
const THUMBS_DIR = path.join(OUTPUT_DIR, 'thumbs');
const JOBS_FILE = path.resolve(process.env.JOBS_FILE || path.join(ROOT, 'jobs', 'state.json'));
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY, 10) || 2;
const MAX_UPLOAD = parseInt(process.env.MAX_UPLOAD_MB, 10) || 8192; // MB
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const UPLOAD_ENABLED = process.env.UPLOAD_ENABLED === '1' || process.env.UPLOAD_ENABLED === 'true'; // 视频不走上传，默认关闭

/* ------------------------------------------------------------------ */
/* 本地文件浏览：允许在配置的根目录白名单内选择任意路径的视频             */
/* ------------------------------------------------------------------ */
const os = require('os');
const FS_ROOTS = (() => {
  const list = (process.env.FS_ROOTS || '')
    .split(/[::]/).map((s) => s.trim()).filter(Boolean)
    .map((p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } });
  if (!list.length) list.push(
    VIDEOS_DIR, OUTPUT_DIR, os.homedir(),
    '/media', '/mnt', '/tmp', '/srv',
  );
  return [...new Set(list.map((p) => p.replace(/\/+$/, '')))];
})();
/* 禁止访问的系统敏感路径前缀 */
const FS_DENY_PREFIX = ['/proc', '/sys', '/dev', '/run', '/etc', '/boot', '/var/lib', '/root', '/snap', '/var/cache', '/var/log' ];
/* 禁止访问的目录名（任意层级） */
const FS_DENY_NAMES = ['.ssh', '.gnupg', '.aws', '.config', 'node_modules', '.git', '.cache', 'keystore', 'secrets'];

function fsResolve(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('缺少路径参数');
  const abs = path.normalize(path.isAbsolute(p) ? p : path.join(process.cwd(), p));
  if (abs.includes('\0')) throw new Error('非法路径');
  let real;
  try { real = fs.realpathSync(abs); } catch { throw new Error('路径不存在: ' + abs); }
  const base = real.endsWith(path.sep) ? real : real + path.sep;
  const inRoot = FS_ROOTS.some((r) => { const rb = r.endsWith(path.sep) ? r : r + path.sep; return real === r || base.startsWith(rb); });
  if (!inRoot) throw new Error('路径不在允许的根目录内: ' + abs);
  if (FS_DENY_PREFIX.some((d) => real === d || real.startsWith(d + path.sep))) throw new Error('该路径被禁止访问');
  if (FS_DENY_NAMES.some((n) => real.split(path.sep).includes(n))) throw new Error('该目录受保护: ' + real.split(path.sep).find((x) => FS_DENY_NAMES.includes(x)));
  return real;
}

function listFsDir(p) {
  const real = fsResolve(p);
  const st = fs.statSync(real);
  if (!st.isDirectory()) throw new Error('不是目录: ' + real);
  const raw = fs.readdirSync(real, { withFileTypes: true });
  const items = [];
  for (const ent of raw) {
    if (FS_DENY_NAMES.includes(ent.name)) continue;
    const fp = path.join(real, ent.name);
    let isDir = ent.isDirectory();
    let isSymlink = ent.isSymbolicLink();
    let size = 0, mtime = 0;
    try {
      if (isSymlink) { const s = fs.statSync(fp); isDir = s.isDirectory(); size = s.size; mtime = s.mtimeMs; }
      else { const s = ent.isDirectory() ? fs.lstatSync(fp) : fs.statSync(fp); size = s.size; mtime = s.mtimeMs; }
    } catch { continue; } // 损坏链接或权限不足跳过
    let type = isDir ? 'dir' : VIDEO_EXT.test(ent.name) ? 'video' : 'file';
    items.push({ name: ent.name, path: fp, type, isSymlink, size, mtime });
  }
  items.sort((a, b) => (a.type !== 'dir') - (b.type !== 'dir') || a.name.localeCompare(b.name, 'zh-CN'));
  let parent = null;
  try { parent = fsResolve(path.dirname(real)); } catch { /* 已到最顶层 */ }
  if (parent && parent === real) parent = null;
  return { path: real, parent, items, roots: FS_ROOTS.slice() };
}

for (const dir of [VIDEOS_DIR, OUTPUT_DIR, ASSETS_DIR, THUMBS_DIR, path.dirname(JOBS_FILE)]) {
  fs.mkdirSync(dir, { recursive: true });
}

/* ------------------------------------------------------------------ */
/* 任务队列（并发上限 + 进度 + 取消）                                   */
/* ------------------------------------------------------------------ */

const jobs = new Map(); // id -> job
const runningChildren = new Set();
let jobSeq = 0;

function loadJobs() {
  try { JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).forEach((j) => {
    if (j.status === 'running' || j.status === 'queued') j.status = 'failed', j.error = '服务重启导致任务中断';
    jobs.set(j.id, j);
  }); } catch { /* 首次运行无状态文件 */ }
}
loadJobs();

function saveJobs() {
  try { fs.writeFileSync(JOBS_FILE, JSON.stringify([...jobs.values()], null, 2)); } catch (e) { console.error('jobs 状态保存失败:', e.message); }
}

class Queue {
  constructor(limit) { this.limit = limit; this.running = 0; this.waiting = []; }
  push(fn) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ fn, resolve, reject });
      this.pump();
    });
  }
  pump() {
    if (this.running >= this.limit || !this.waiting.length) return;
    this.running++;
    const { fn, resolve, reject } = this.waiting.shift();
    Promise.resolve().then(fn).then(
      (v) => { this.running--; this.pump(); resolve(v); },
      (e) => { this.running--; this.pump(); reject(e); },
    );
  }
}
const queue = new Queue(MAX_CONCURRENCY);

function makeJob(meta) {
  const id = crypto.randomUUID();
  const job = {
    id,
    type: meta.type,
    name: meta.name,
    status: 'queued',
    progress: 0,
    createdAt: Date.now(),
    ...meta,
  };
  jobs.set(id, job);
  saveJobs();
  return job;
}

function jobUrl(job) { return `/api/output/${encodeURIComponent(job.outputFile)}`; }

function buildJob(job) {
  const { type, params } = job;
  let input = '';
  if (type !== 'concat') input = job.src ? fsResolve(job.src) : localVideoPath(job.video);

  // 本地图片素材白名单解析 + 字段整理
  if (Array.isArray(params.overlays)) {
    if (params.overlays.length > 40) throw new Error('叠加层最多 40 个');
    params.overlays = params.overlays.map((o, i) => {
      const clean = {
        type: o.type === 'image' ? 'image' : 'text',
        z: Math.round(Number(o.z ?? i) || 0),
        start: parseFloat(o.start) || 0,
        end: o.end != null && o.end !== '' ? parseFloat(o.end) : null,
        opacity: Math.min(1, Math.max(0.05, parseFloat(o.opacity ?? 1))),
      };
      if (clean.type === 'image') {
        clean.file = localAssetPath(o.asset);
        clean.x = clamp01(o.x); clean.y = clamp01(o.y);
        clean.w = Math.min(1.5, Math.max(0.01, parseFloat(o.w) || 0.2));
        clean.h = Math.min(1.5, Math.max(0.01, parseFloat(o.h) || 0.2));
        clean.rotation = parseFloat(o.rotation) || 0;
      } else {
        clean.text = String(o.text ?? '').slice(0, 200);
        if (!clean.text.trim()) throw new Error('文字叠加内容为空');
        clean.x = Math.max(0, Number(o.x) || 0);
        clean.y = Math.max(0, Number(o.y) || 0);
        clean.size = Math.min(400, Math.max(4, parseFloat(o.size) || 48));
        clean.color = /^#?[0-9a-fA-F]{6}$/.test(o.color || '') ? o.color : 'white';
        clean.bg = /^#?[0-9a-fA-F]{6}$/.test(o.bg || '') ? o.bg : '';
        clean.bold = !!o.bold;
        clean.rotation = parseFloat(o.rotation) || 0;
      }
      return clean;
    });
  }

  const extFor = (t) => {
    if (type === 'audio') return params.format || 'mp3';
    if (params.format === 'gif') return 'gif';
    if (type === 'thumb') return 'png';
    if (type === 'frame') return params.ext || 'jpg';
    return params.format || 'mp4';
  };
  const outFile = `${slug(job.video)}-${type}-${Date.now()}.${extFor(type)}`;
  const output = path.join(OUTPUT_DIR, outFile);
  job.outputFile = outFile;

  let built;
  switch (type) {
    case 'clip':
    case 'full':
      built = ff.buildExportArgs(input, output, params);
      break;
    case 'segments':
      built = ff.buildSegmentsArgs(input, output, params);
      break;
    case 'concat': {
      const inputs = (params.paths || []).map((p) => fsResolve(p));
      built = ff.buildConcatArgs(inputs, output, params);
      break;
    }
    case 'audio':
      job.ext = params.format || 'mp3';
      built = ff.buildAudioArgs(input, output, params);
      break;
    case 'thumb':
      built = ff.buildThumbArgs(input, output, params);
      break;
    case 'frame':
      built = ff.buildFrameArgs(input, output, params);
      break;
    default:
      throw new Error('未知任务类型: ' + type);
  }
  built.input = input;
  return built;
}

function clamp01(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

async function startJob(job) {
  job.status = 'running';
  job.startedAt = Date.now();
  saveJobs();

  return queue.push(() => new Promise(async (resolve, reject) => {
    const cancelToken = { cancelled: false };
    job.cancelToken = cancelToken;
    let built;
    let input = '';
    try {
      built = buildJob(job);
      input = built.input || '';
    } catch (e) {
      job.status = 'failed'; job.error = e.message; job.endedAt = Date.now(); saveJobs();
      return reject(e);
    }
    const tempFiles = built.tempFiles || [];
    if (!built.duration && input) {
      try { built.duration = ff.probe(input).format.duration || 0; } catch { built.duration = 0; }
    }
    let childPid = null;
    runningChildren.add(job.id);

    try {
      await ff.runFFmpeg(built.args, {
        duration: built.duration,
        cancelToken,
        onProgress: (p) => { job.progress = Math.round(p * 1000) / 10; },
      });
      if (cancelToken.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
      const size = fs.statSync(built.args[built.args.length - 1]).size;
      Object.assign(job, { status: 'done', progress: 100, endedAt: Date.now(), outputSize: size });
    } catch (e) {
      Object.assign(job, {
        status: e.cancelled ? 'cancelled' : 'failed',
        error: e.message,
        endedAt: Date.now(),
      });
      // 清理残留输出
      try { if (fs.existsSync(built.args[built.args.length - 1])) fs.unlinkSync(built.args[built.args.length - 1]); } catch { }
      if (e.cancelled) { /* 用户主动取消不算失败 */ }
    } finally {
      runningChildren.delete(job.id);
      for (const f of (built && built.tempFiles) || []) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
      saveJobs();
      resolve();
    }
  }));
}

function slug(name) {
  return String(name).replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'media';
}

/* ------------------------------------------------------------------ */
/* 视频库                                                               */
/* ------------------------------------------------------------------ */

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi|m4v|flv|ts|mpeg|mpg|wmv)$/i;

function listVideos() {
  return fs.readdirSync(VIDEOS_DIR)
    .filter((f) => VIDEO_EXT.test(f) && fs.statSync(path.join(VIDEOS_DIR, f)).isFile())
    .map((f) => {
      const st = fs.statSync(path.join(VIDEOS_DIR, f));
      return { name: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function listOutputs() {
  return fs.readdirSync(OUTPUT_DIR)
    .filter((f) => !f.startsWith('thumbs') && fs.statSync(path.join(OUTPUT_DIR, f)).isFile())
    .map((f) => { const st = fs.statSync(path.join(OUTPUT_DIR, f)); return { name: f, size: st.size, mtime: st.mtimeMs }; })
    .sort((a, b) => b.mtime - a.mtime);
}

/* ------------------------------------------------------------------ */
/* 上传                                                                 */
/* ------------------------------------------------------------------ */

const upload = multer({
  storage: multer.diskStorage({
    destination: VIDEOS_DIR,
    filename(req, file, cb) {
      const safe = String(file.originalname).replace(/[\\/]+/g, '_');
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    cb(null, true);
  },
});

/* 叠加图片素材（仅图片） */
const assetUpload = multer({
  storage: multer.diskStorage({
    destination: ASSETS_DIR,
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.png';
      cb(null, `overlay-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    cb(null, /^image\//i.test(file.mimetype) ? true : new Error('只允许图片文件'));
  },
});

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                           */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// 可选简单鉴权：AUTH_TOKEN 设置后，/api/* 需携带 x-auth-token
app.use('/api', (req, res, next) => {
  if (!AUTH_TOKEN) return next();
  if (req.get('x-auth-token') === AUTH_TOKEN) return next();
  if (req.path === '/config') return next(); // 允许读取配置以便前端提示
  res.status(401).json({ error: '需要 token，请刷新页面输入访问口令' });
});

app.use(express.static(path.join(ROOT, 'public')));

/* ---------- 健康与配置 ---------- */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), ffmpeg: ff.ffmpegVersion(), now: Date.now() });
});
app.get('/api/config', (req, res) => {
  res.json({
    maxConcurrency: MAX_CONCURRENCY,
    maxUploadMb: MAX_UPLOAD,
    needAuth: !!AUTH_TOKEN,
    httpPort: PORT,
    uploadEnabled: UPLOAD_ENABLED,
    videosDir: VIDEOS_DIR,
    outputDir: OUTPUT_DIR,
    fsRoots: FS_ROOTS,
  });
});

/* ---------- 视频库 ---------- */
app.get('/api/videos', (req, res) => {
  res.json(listVideos());
});

/* 视频上传（默认关闭：视频由运维直接放入本地 videos/ 目录） */
app.post('/api/upload', (req, res) => {
  if (!UPLOAD_ENABLED) return res.status(403).json({ error: '上传已关闭：请将视频直接放入服务器 videos/ 目录' });
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: '未收到文件(字段名 file)' });
    const name = req.file.filename;
    let info = null;
    try { info = ff.probe(req.file.path).format; } catch { /* 非媒体文件 */ }
    if (info && !info.duration && !info.name) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: '不是可识别的媒体文件' });
    }
    res.json({ name, size: req.file.size, info });
  });
});

/* 流式播放(支持 Range/seek) */
app.get('/api/videos/:name', (req, res) => {
  const fp = path.join(VIDEOS_DIR, decodeURIComponent(req.params.name));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'file not found' });
  res.sendFile(fp);
});

/* 元数据 */
app.get('/api/videos/:name/info', (req, res) => {
  try {
    res.json(ff.probe(path.join(VIDEOS_DIR, decodeURIComponent(req.params.name))));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* 缩略图（按 mtime 缓存） */
app.get('/api/videos/:name/thumbnail', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const fp = path.join(VIDEOS_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'file not found' });

  const st = fs.statSync(fp);
  const cache = path.join(THUMBS_DIR, ff.md5(name + st.mtimeMs) + '.jpg');
  if (!fs.existsSync(cache)) {
    try {
      fs.mkdirSync(THUMBS_DIR, { recursive: true });
      const meta = ff.probe(fp);
      const at = Math.min(1, Math.max(0, (meta.format.duration || 2) * 0.3));
      ff.runFFmpegSync(ff.buildThumbArgs(fp, cache, { at }).args, 240000);
    } catch (e) {
      return res.status(500).json({ error: '无法生成缩略图: ' + e.message });
    }
  }
  res.sendFile(cache);
});

app.delete('/api/videos/:name', (req, res) => {
  const fp = path.join(VIDEOS_DIR, decodeURIComponent(req.params.name));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'file not found' });
  fs.unlinkSync(fp);
  res.json({ ok: true });
});

/* ---------- 本地文件浏览（任意路径，白名单内） ---------- */
app.get('/api/fs', (req, res) => {
  try { res.json(listFsDir(req.query.path || FS_ROOTS[0])); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/fs/roots', (req, res) => {
  res.json(FS_ROOTS);
});

app.get('/api/fs/video', (req, res) => {
  try {
    const fp = fsResolve(req.query.path);
    if (!fs.statSync(fp).isFile()) return res.status(400).json({ error: '不是文件' });
    res.sendFile(fp);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/fs/info', (req, res) => {
  try { res.json(ff.probe(fsResolve(req.query.path))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fs/thumbnail', (req, res) => {
  try {
    const fp = fsResolve(req.query.path);
    const st = fs.statSync(fp);
    const cache = path.join(THUMBS_DIR, ff.md5(fp + ':' + st.size + ':' + st.mtimeMs) + '.jpg');
    if (!fs.existsSync(cache)) {
      fs.mkdirSync(THUMBS_DIR, { recursive: true });
      const meta = ff.probe(fp);
      const at = Math.min(1, Math.max(0, (meta.format.duration || 2) * 0.3));
      ff.runFFmpegSync(ff.buildThumbArgs(fp, cache, { at }).args, 240000);
    }
    res.sendFile(cache);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- 素材库（叠加图片，仅本地文件） ---------- */
function listAssets() {
  return fs.readdirSync(ASSETS_DIR)
    .filter((f) => /\.(png|jpe?g|webp|gif|svg)$/i.test(f) && fs.statSync(path.join(ASSETS_DIR, f)).isFile())
    .map((f) => { const st = fs.statSync(path.join(ASSETS_DIR, f)); return { name: f, size: st.size, mtime: st.mtimeMs, url: '/api/assets/' + encodeURIComponent(f) }; })
    .sort((a, b) => b.mtime - a.mtime);
}

app.get('/api/assets', (req, res) => res.json(listAssets()));

app.post('/api/assets', assetUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到图片(字段名 file)' });
  res.json({ name: req.file.filename, url: '/api/assets/' + encodeURIComponent(req.file.filename) });
});

app.get('/api/assets/:name', (req, res) => {
  res.sendFile(localAssetPath(req.params.name));
});

app.delete('/api/assets/:name', (req, res) => {
  try { fs.unlinkSync(localAssetPath(req.params.name)); } catch (e) { return res.status(404).json({ error: '素材不存在' }); }
  res.json({ ok: true });
});

/* ---------- 任务 ---------- */
app.post('/api/jobs', (req, res) => {
  const { type, video, src, params = {} } = req.body || {};
  const valid = ['clip', 'segments', 'concat', 'audio', 'thumb', 'frame', 'full'];
  if (!valid.includes(type)) return res.status(400).json({ error: '未知任务类型: ' + type });

  /* 本地文件白名单校验：仅允许选择本地磁盘上的文件（任意白名单路径） */
  try {
    if (type === 'concat') {
      if (!Array.isArray(params.paths) || params.paths.length < 2) return res.status(400).json({ error: '拼接至少需要 2 个本地视频路径' });
      for (const p of params.paths) fsResolve(p);
    } else {
      const p = src || (video ? path.join(VIDEOS_DIR, video) : null);
      if (!p) return res.status(400).json({ error: '缺少 src 源文件路径' });
      const real = fsResolve(p);
      if (!VIDEO_EXT.test(real)) return res.status(400).json({ error: '不是视频文件(允许: mp4/webm/mov/mkv/avi/flv/m4v/ts/mpeg/wmv)' });
    }
    if (Array.isArray(params.overlays)) {
      if (params.overlays.length > 40) return res.status(400).json({ error: '叠加层最多 40 个' });
      for (const o of params.overlays) if (o.type === 'image') localAssetPath(o.asset);
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const job = makeJob({ type, video: video || '', src: src || '', params, name: `${type} ⟵ ${src || video || (params.paths || []).join(' + ')}` });
  startJob(job).catch((e) => console.error('[job] ' + job.id, e.message));
  res.json({ id: job.id, status: job.status });
});

app.get('/api/jobs', (req, res) => {
  res.json([...jobs.values()]
    .map((j) => publicJob(j))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50));
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: '任务不存在' });
  res.json(publicJob(j));
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: '任务不存在' });
  if (j.status === 'queued' || j.status === 'running') {
    if (j.cancelToken) j.cancelToken.cancelled = true;
    else { j.status = 'cancelled'; j.endedAt = Date.now(); saveJobs(); }
  }
  res.json(publicJob(j));
});

app.delete('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: '任务不存在' });
  if (j.outputFile) { try { fs.unlinkSync(path.join(OUTPUT_DIR, j.outputFile)); } catch {} }
  jobs.delete(req.params.id);
  saveJobs();
  res.json({ ok: true });
});

function publicJob(j) {
  return {
    id: j.id, type: j.type, name: j.name, status: j.status, progress: j.progress,
    error: j.error, createdAt: j.createdAt, startedAt: j.startedAt, endedAt: j.endedAt,
    outputFile: j.outputFile, outputSize: j.outputSize,
    outputUrl: j.outputFile ? jobUrl(j) : null,
  };
}

/* ---------- 输出文件 ---------- */
app.get('/api/outputs', (req, res) => {
  res.json(listOutputs());
});

app.get('/api/output/:file', (req, res) => {
  const fp = path.join(OUTPUT_DIR, decodeURIComponent(req.params.file));
  if (!fs.existsSync(fp) || fp.includes('..')) return res.status(404).json({ error: 'file not found' });
  res.download(fp, decodeURIComponent(req.params.file));
});

app.delete('/api/output/:file', (req, res) => {
  const fp = path.join(OUTPUT_DIR, decodeURIComponent(req.params.file));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'file not found' });
  fs.unlinkSync(fp);
  res.json({ ok: true });
});

/* ---------- 优雅退出：终止 ffmpeg 子进程 ---------- */
async function shutdown(signal) {
  console.log(`收到 ${signal}，正在停止…`);
  for (const token of [...jobs.values()].map((j) => j.cancelToken).filter(Boolean)) token.cancelled = true;
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('未处理 rejection(已吞噬):', err && err.message));

app.listen(PORT, HOST, () => {
  console.log(`FF Web Editor 已启动: http://${HOST}:${PORT}`);
  console.log(`  视频目录: ${VIDEOS_DIR}`);
  console.log(`  输出目录: ${OUTPUT_DIR}`);
  console.log(`  并发上限: ${MAX_CONCURRENCY}   ffmpeg: ${ff.ffmpegVersion()}`);
  if (AUTH_TOKEN) console.log('  已启用 token 鉴权');
});
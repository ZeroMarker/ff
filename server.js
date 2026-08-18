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
  const input = localVideoPath(job.video);

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
      const inputs = params.videos.map((v) => localVideoPath(v));
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

function runJob(job) {
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
  res.json({ maxConcurrency: MAX_CONCURRENCY, maxUploadMb: MAX_UPLOAD, needAuth: !!AUTH_TOKEN, hasAudio: true });
});

/* ---------- 视频库 ---------- */
app.get('/api/videos', (req, res) => {
  res.json(listVideos());
});

app.post('/api/upload', upload.single('file'), (req, res) => {
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
  const { type, video, params = {} } = req.body || {};
  const valid = ['clip', 'segments', 'concat', 'audio', 'thumb', 'frame', 'full'];
  if (!valid.includes(type)) return res.status(400).json({ error: '未知任务类型: ' + type });

  /* 本地文件白名单校验：仅允许本地文件库中的文件 */
  try {
    if (type === 'concat') {
      if (!Array.isArray(params.videos) || params.videos.length < 2) return res.status(400).json({ error: '拼接至少需要 2 个本地视频' });
      for (const v of params.videos) localVideoPath(v);
    } else {
      if (!video) return res.status(400).json({ error: '缺少 video 参数' });
      localVideoPath(video);
    }
    if (Array.isArray(params.overlays)) {
      if (params.overlays.length > 40) return res.status(400).json({ error: '叠加层最多 40 个' });
      for (const o of params.overlays) if (o.type === 'image') localAssetPath(o.asset);
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const job = makeJob({ type, video: video || '', params, name: `${type} ⟵ ${video || params.videos.join(' + ')}` });
  runJob(job).catch((e) => console.error('[job] ' + job.id, e.message));
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
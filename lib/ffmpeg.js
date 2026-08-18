'use strict';

/**
 * lib/ffmpeg.js — 底层 ffmpeg/ffprobe 封装
 *
 * 所有命令行参数均以「数组」形式传给 spawn，杜绝 shell 注入。
 * 安全约束：所有输入仅允许来自本地文件库（safeJoin 白名单，拒绝 URL/绝对路径/.. 穿越）。
 * 提供：探针(probe)、通用执行(runFFmpeg/runFFmpegSync)、任务参数构造器(build*)。
 * 叠加层：文字 -> drawtext(textfile)，图片 -> overlay(filter_complex 链式合成)。
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/* ------------------------------------------------------------------ */
/* 路径白名单：仅允许本地文件库中的文件（限制选择本地文件）                */
/* ------------------------------------------------------------------ */

function safeJoin(dir, name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('缺少文件名');
  const base = name.trim();
  if (base !== path.basename(base) || base.includes('..') || /[\\/]/.test(base) || /^[a-z]+:\/\//i.test(base)) {
    throw new Error('非法文件名（仅允许本地文件库中的文件）: ' + base);
  }
  const fp = path.join(dir, base);
  if (!fp.startsWith(dir + path.sep)) throw new Error('路径越界拒绝访问');
  return fp;
}

/* ------------------------------------------------------------------ */
/* 字体解析（drawtext 需要本地字体文件，优先中文字体）                    */
/* ------------------------------------------------------------------ */

const FONT_CANDIDATES = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
];
let _font = null;
function resolveFont() {
  if (_font) return _font;
  for (const f of FONT_CANDIDATES) {
    try { if (fs.existsSync(f)) return (_font = f); } catch { /* ignore */ }
  }
  return null;
}

/** 颜色参数：支持 #RRGGBB / 颜色名 -> ffmpeg 颜色语法 0xRRGGBB@alpha */
function colorArg(color, alpha = 1) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(color || '').trim());
  if (m) return `0x${m[1].toUpperCase()}@${alpha}`;
  return `${color || 'white'}@${alpha}`;
}

/* ------------------------------------------------------------------ */
/* 探针：读取媒体元数据                                                 */
/* ------------------------------------------------------------------ */

function probe(file) {
  const res = spawnSync(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    file,
  ], { encoding: 'utf8', timeout: 30000 });

  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error('ffprobe failed (' + res.status + '): ' + (res.stderr || '').slice(0, 500));
  }
  const json = JSON.parse(res.stdout);
  return normalizeProbe(json);
}

function normalizeProbe(j) {
  const vStream = (j.streams || []).find((s) => s.codec_type === 'video');
  const aStream = (j.streams || []).find((s) => s.codec_type === 'audio');
  const fmt = j.format || {};
  const dur = Math.min(
    ...[j.streams || []].flat().map((s) => parseFloat(s.duration)).filter((d) => Number.isFinite(d) && d >= 0),
    parseFloat(fmt.duration),
  );
  return {
    format: {
      name: fmt.format_name || '',
      duration: Number.isFinite(dur) && dur > 0 ? dur : 0,
      size: parseInt(fmt.size, 10) || 0,
      bit_rate: parseInt(fmt.bit_rate, 10) || 0,
    },
    video: vStream
      ? {
          codec: vStream.codec_name,
          width: vStream.width,
          height: vStream.height,
          pix_fmt: vStream.pix_fmt,
          fps: vStream.avg_frame_rate && vStream.avg_frame_rate !== '0/0'
            ? rateFloat(vStream.avg_frame_rate)
            : 0,
          duration: parseFloat(vStream.duration) || 0,
        }
      : null,
    audio: aStream
      ? {
          codec: aStream.codec_name,
          channels: aStream.channels,
          sample_rate: parseInt(aStream.sample_rate, 10) || 0,
          duration: parseFloat(aStream.duration) || 0,
        }
      : null,
  };
}

function rateFloat(str) {
  const [n, d] = String(str).split('/').map(Number);
  if (!n || !d) return 0;
  return Math.round((n / d) * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* 通用执行：-progress pipe:1 解析进度，支持取消                          */
/* ------------------------------------------------------------------ */

function runFFmpeg(extraArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const { onProgress = () => {}, cancelToken = null, duration } = opts;
    const args = [
      '-hide_banner', '-y', '-nostdin', '-nostats',
      '-progress', 'pipe:1',
      ...extraArgs,
    ];
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const state = { us: 0, ms: 0, done: false, lastStderrTime: 0 };
    let buf = '';
    let log = '';
    let stderrHandle = null;

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        parseProgressLine(line, state);
      }
    });

    if (child.stderr) {
      stderrHandle = child.stderr;
      child.stderr.on('data', (d) => {
        log += d.toString('utf8');
        const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
        if (m && !state.us && !state.ms) state.lastStderrTime = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
      });
    }

    const timer = setInterval(() => {
      if (cancelToken && cancelToken.cancelled && child.exitCode === null) child.kill('SIGKILL');
      const t = state.us / 1e6 || state.ms / 1e3 || state.lastStderrTime || 0;
      if (t > 0 && duration) onProgress(Math.max(0, Math.min(1, t / duration)));
    }, 500);

    child.on('error', (err) => { clearInterval(timer); reject(err); });
    child.on('close', (code, signal) => {
      clearInterval(timer);
      if (cancelToken && cancelToken.cancelled) {
        reject(Object.assign(new Error('cancelled'), { cancelled: true }));
        return;
      }
      if (code === 0) resolve({ log, output: child.stdout });
      else {
        reject(new Error(
          `ffmpeg 退出码 ${code}${signal ? ' (信号 ' + signal + ')' : ''}\n` +
          tail(log, 1600)
        ));
      }
    });
  });
}

function parseProgressLine(line, state) {
  const eq = line.indexOf('=');
  if (eq < 0) return;
  const k = line.slice(0, eq);
  const v = line.slice(eq + 1);
  if (k === 'out_time_us') state.us = parseInt(v, 10) || 0;
  else if (k === 'out_time_ms') state.ms = parseInt(v, 10) || 0;
  else if (k === 'progress') state.done = v === 'end';
}

function tail(s, n) { return s.length > n ? '…' + s.slice(-n) : s; }

/** 同步执行（缩略图等轻量任务） */
function runFFmpegSync(extraArgs, timeoutMs = 60000) {
  const res = spawnSync(FFMPEG, ['-hide_banner', '-y', '-nostdin', '-nostats', ...extraArgs],
    { encoding: 'utf8', timeout: timeoutMs });
  if (res.error && res.error.code === 'ETIMEDOUT') throw new Error('ffmpeg 同步执行超时');
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error('ffmpeg 失败 (' + res.status + '): ' + tail(res.stderr || '', 500));
  return { code: res.status, stderr: res.stderr };
}

/* ------------------------------------------------------------------ */
/* 滤镜常量                                                              */
/* ------------------------------------------------------------------ */

const FILTERS = {
  grayscale: 'eq=saturation=0',
  negative: 'negate',
  mirror: 'hflip',
  blur: 'boxblur=6:1',
  vignette: 'vignette=PI/4',
  sharpen: 'unsharp=5:5:1.0:5:5:0.0',
};

function atempoChain(speed) {
  const out = [];
  let s = speed;
  while (s > 2.0) { out.push('atempo=2.0'); s /= 2; }
  while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; }
  out.push('atempo=' + s.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));
  return out.join(',');
}

/* ------------------------------------------------------------------ */
/* 叠加层滤镜构建                                                        */
/* ------------------------------------------------------------------ */

/**
 * 构造文字 drawtext 滤镜串。
 * o: { text, x, y, size, color, bold, bg, rotation, opacity, start, end }
 * start/end 为输出时间线(秒)，t0 为裁剪起点偏移。
 */
function textFilter(o, t0, tmpDir, tempFiles) {
  const textfile = path.join(tmpDir, 'dt-' + crypto.randomBytes(8).toString('hex') + '.txt');
  fs.writeFileSync(textfile, String(o.text ?? ''));
  tempFiles.push(textfile);

  const fontfile = resolveFont();
  const parts = [];
  if (fontfile) parts.push(`fontfile=${fontfile}`);
  parts.push(`textfile=${textfile}`);
  parts.push(`fontsize=${Math.max(4, Math.round(o.size || 48))}`);
  parts.push(`fontcolor=${colorArg(o.color, o.opacity ?? 1)}`);
  parts.push(`x=${Math.round(o.x || 0)}`);
  parts.push(`y=${Math.round(o.y || 0)}`);
  if (o.bold) parts.push('borderw=2', 'bordercolor=0x000000@0.7');
  if (o.rotation) parts.push(`rotation=${((o.rotation * Math.PI) / 180).toFixed(4)}`);
  if (o.bg) parts.push('box=1', `boxcolor=${colorArg(o.bg, 0.5)}`, 'boxborderw=10');

  const rel = (v) => Math.max(0, parseFloat(v) - (t0 || 0));
  const s0 = rel(o.start ?? 0), s1 = o.end != null ? rel(o.end) : null;
  if (s1 != null && s1 > s0) parts.push(`enable='between(t,${s0.toFixed(3)},${s1.toFixed(3)})'`);
  else if (s0 > 0.001) parts.push(`enable='gte(t,${s0.toFixed(3)})'`);

  return 'drawtext=' + parts.join(':');
}

/**
 * 把叠加层合成进视频滤镜图。
 * 返回 { graphChains, extraInputs, lastLabel }
 */
function overlayGraph(overlays, t0, W, H, tmpDir, tempFiles) {
  const chains = [];
  const extraInputs = [];
  const used = new Set();
  let vlabel = 'vbase';
  let idx = 1; // 0 是主视频

  const sorted = [...overlays].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  for (let i = 0; i < sorted.length; i++) {
    const o = sorted[i];
    if (o.type === 'text') {
      const next = `vx${i}`;
      chains.push(`[${vlabel}]${textFilter(o, t0, tmpDir, tempFiles)}[${next}]`);
      vlabel = next;
    } else if (o.type === 'image' && o.file) {
      if (!used.has(o.file)) { extraInputs.push(o.file); idx++; used.add(o.file); }
      const inputIdx = idx - 1;
      const w = Math.max(4, Math.round((o.w ?? 0.5) * W));
      const h = Math.max(4, Math.round((o.h ?? 0.5) * H));
      const ov = `ov${i}`;
      const vnext = `vx${i}`;
      let chain = `[${inputIdx}:v]scale=${w}:${h}${o.opacity != null && o.opacity < 1 ? ',format=rgba,colorchannelmixer=aa=' + o.opacity : ''}`;
      // 旋转需要扩大背景：用 pad 到对角线后在 overlay 里做旋转
      if (o.rotation) {
        const ang = Math.abs(o.rotation) * Math.PI / 180;
        const diag = Math.ceil(Math.sqrt(w * w + h * h)) + 2;
        chain += `,rotate=${(o.rotation * Math.PI / 180).toFixed(4)}:ow=${diag}:oh=${diag}:c=0x00000000`;
      }
      chains.push(`${chain}[${ov}]`);

      const x = Math.round((o.x ?? 0) * W) - (o.rotation ? (Math.round((o.w ?? 0.5) * W) - w) : 0) ;
      const y = Math.round((o.y ?? 0) * H) - (o.rotation ? (Math.round((o.h ?? 0.5) * H) - h) : 0);
      const rel = (v) => Math.max(0, parseFloat(v) - (t0 || 0));
      const s0 = rel(o.start ?? 0), s1 = o.end != null ? rel(o.end) : null;
      const en = s1 != null && s1 > s0
        ? `:enable='between(t,${s0.toFixed(3)},${s1.toFixed(3)})'`
        : s0 > 0.001 ? `:enable='gte(t,${s0.toFixed(3)})'` : '';
      // 用 rotate 后尺寸将覆盖原位置，重新计算旋转后的实际宽高以保持对齐
      const rw = o.rotation ? Math.round((Math.abs(Math.cos(o.rotation * Math.PI / 180)) * w + Math.abs(Math.sin(o.rotation * Math.PI / 180)) * h)) : w;
      const rh = o.rotation ? Math.round((Math.abs(Math.sin(o.rotation * Math.PI / 180)) * w + Math.abs(Math.cos(o.rotation * Math.PI / 180)) * h)) : h;
      // 校正后的 x/y（左上角对齐不变，只是图形变大）
      const xx = x + (w - rw) / 2;
      const yy = y + (h - rh) / 2;
      chains.push(`[${vlabel}][${ov}]overlay=x=${Math.round(xx)}:y=${Math.round(yy)}${en}[${vnext}]`);
      vlabel = vnext;
    }
  }
  return { chains, extraInputs, lastLabel: vlabel };
}

/* ------------------------------------------------------------------ */
/* 任务参数构造器                                                        */
/* ------------------------------------------------------------------ */

/**
 * 视频导出参数（clip / full / 滤镜 / 分辨率 / 倍速 / gif / 叠加层）
 * p: { start, end, format, height, speed, filters[], overlays[] }
 * overlays 为输出时间线坐标（含裁剪偏移后的相对时间）。
 */
function buildExportArgs(input, output, p) {
  const {
    start = 0, end = null,
    format = 'mp4',
    height = 0,
    speed = 1,
    filters = [],
    overlays = [],
  } = p;

  const vfList = [];
  if (height > 0) vfList.push(`scale=-2:${Math.round(height)}`);
  for (const f of filters) if (FILTERS[f]) vfList.push(FILTERS[f]);
  if (speed && speed !== 1) vfList.push(`setpts=PTS/${speed}`);

  const afList = [];
  if (speed && speed !== 1) afList.push(atempoChain(speed));

  const base = [];
  let duration = 0;

  if (format === 'gif') {
    const gifW = height > 0 ? Math.round(height * 16 / 9) : 480;
    base.push('-ss', String(start), '-i', input);
    if (end) base.push('-t', String(end - start));
    base.push('-filter_complex',
      `fps=12,scale=${gifW}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`);
    base.push(output);
    duration = end ? end - start : 0;
    return { args: base, duration, tempFiles: [] };
  }

  if (start > 0 || end != null) {
    base.push('-ss', String(start), '-i', input);
    if (end != null) base.push('-t', String(Math.max(0, end - start)));
    duration = end != null ? end - start : 0;
  } else {
    base.push('-i', input);
    duration = 0;
  }

  const tempFiles = [];
  let args = [...base];
  const hasOverlays = Array.isArray(overlays) && overlays.length > 0;

  if (hasOverlays) {
    // 需要先获得基准尺寸（若不缩放则取原分辨率）
    let W = 0, H = 0;
    if (!height) {
      const meta = probe(input);
      W = (meta.video && meta.video.width) || 1920;
      H = (meta.video && meta.video.height) || 1080;
    } else {
      W = -2; H = height; // scale 保持比例
    }
    const { chains, extraInputs, lastLabel } = overlayGraph(overlays, start, W, H, os.tmpdir(), tempFiles);
    const graph = [`[0:v]${vfList.length ? vfList.join(',') : (height > 0 ? 'scale=-2:' + height : 'null')}${vfList.length ? '' : ''}[vbase]`];
    graph.push(...chains);
    graph.push(`[${lastLabel}]format=yuv420p[vout]`);
    args.push(...extraInputs.flatMap((f) => ['-i', f]));
    args.push('-filter_complex', graph.join('; '));
    args.push('-map', '[vout]', '-map', '0:a?');
  } else {
    if (vfList.length) args.push('-vf', vfList.join(','));
  }

  if (afList.length) args.push('-af', afList.join(','));

  if (hasOverlays) {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
  } else {
    args.push(...containerArgs(format));
  }
  args.push(output);
  return { args, duration, tempFiles };
}

function containerArgs(format) {
  switch (format) {
    case 'mp4':  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
    case 'webm': return ['-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '128k'];
    case 'mov':  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '192k'];
    case 'mkv':  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k'];
    default:     return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
  }
}

/** 同一文件多区间裁剪合并（filter_complex 拼接） */
function buildSegmentsArgs(input, output, p) {
  const { segments = [], height = 0, speed = 1, filters = [] } = p;
  if (!segments.length) throw new Error('没有可用片段');

  const vfExtra = [];
  if (height > 0) vfExtra.push(`scale=-2:${Math.round(height)}`);
  for (const f of filters) if (FILTERS[f]) vfExtra.push(FILTERS[f]);
  if (speed && speed !== 1) vfExtra.push(`setpts=PTS/${speed}`);

  const chains = [];
  const concatInputs = [];
  const n = segments.length;
  let duration = 0;

  segments.forEach((seg, i) => {
    const s = Math.max(0, seg.start);
    const e = seg.end != null ? Math.max(s, seg.end) : null;
    duration += e != null ? e - s : 0;

    const vtrim = e != null
      ? `trim=start=${s}:end=${e},setpts=PTS-STARTPTS`
      : `trim=start=${s},setpts=PTS-STARTPTS`;
    const atrim = e != null
      ? `atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS`
      : `atrim=start=${s},asetpts=PTS-STARTPTS`;

    chains.push(`[0:v]${vtrim}${vfExtra.length ? ',' + vfExtra.join(',') : ''}[v${i}]`);
    chains.push(`[0:a]${atrim}[a${i}]`);
    concatInputs.push(`[v${i}][a${i}]`);
  });

  chains.push(`${concatInputs.join('')}concat=n=${n}:v=1:a=1[vout][aout]`);

  const args = [
    '-i', input,
    '-filter_complex', chains.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    output,
  ];
  return { args, duration, tempFiles: [] };
}

/** 多文件拼接（自动缩放到首个视频） */
function buildConcatArgs(inputs, output, p = {}) {
  const { height = 0 } = p;
  const n = inputs.length;
  const chains = [];
  const concatInputs = [];
  inputs.forEach((input, i) => {
    const scale = height > 0 ? `scale=-2:${Math.round(height)}` : 'scale=-2:ih';
    chains.push(`[${i}:v]${scale},setpts=PTS-STARTPTS,fps=30[v${i}]`);
    chains.push(`[${i}:a]aresample=48000,asetpts=PTS-STARTPTS[a${i}]`);
    concatInputs.push(`[v${i}][a${i}]`);
  });
  chains.push(`${concatInputs.join('')}concat=n=${n}:v=1:a=1[vout][aout]`);

  const args = [];
  for (const input of inputs) args.push('-i', input);
  args.push(
    '-filter_complex', chains.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    output,
  );
  return { args, duration: 0, tempFiles: [] };
}

/** 音频提取 */
function buildAudioArgs(input, output, p) {
  const { format = 'mp3', start = 0, end = null } = p;
  const table = {
    mp3:  ['libmp3lame', '192k'],
    m4a:  ['aac', '192k'],
    aac:  ['aac', '192k'],
    ogg:  ['libvorbis', '192k'],
    flac: ['flac', null],
    wav:  ['pcm_s16le', null],
  };
  const [codec, bitrate] = table[format] || table.mp3;
  const args = ['-ss', String(start), '-i', input];
  if (end != null) args.push('-t', String(Math.max(0, end - start)));
  args.push('-vn', '-c:a', codec);
  if (bitrate) args.push('-b:a', bitrate);
  if (format === 'wav') args.push('-ar', '48000');
  args.push(output);
  return { args, duration: end != null ? end - start : 0, tempFiles: [] };
}

/** 封面缩略图 */
function buildThumbArgs(input, output, p) {
  const at = Math.max(0, p.at || 0);
  return {
    args: ['-ss', String(at), '-i', input, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '4', output],
    duration: 1,
    tempFiles: [],
  };
}

/** 提取单帧 */
function buildFrameArgs(input, output, p) {
  const at = Math.max(0, p.at || 0);
  const ext = path.extname(output).toLowerCase();
  const args = ['-ss', String(at), '-i', input, '-frames:v', '1'];
  if (ext === '.png') args.push('-c:v', 'png');
  else if (ext === '.jpg' || ext === '.jpeg') args.push('-q:v', '2', '-c:v', 'mjpeg');
  args.push(output);
  return { args, duration: 1, tempFiles: [] };
}

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

function ffmpegVersion() {
  try {
    const r = spawnSync(FFMPEG, ['-version'], { encoding: 'utf8', timeout: 10000 });
    return r.stdout.split('\n')[0] || 'ffmpeg';
  } catch { return 'ffmpeg'; }
}

module.exports = {
  FFMPEG, FFPROBE,
  safeJoin, resolveFont,
  probe, runFFmpeg, runFFmpegSync, ffmpegVersion, md5,
  buildExportArgs, buildSegmentsArgs, buildConcatArgs,
  buildAudioArgs, buildThumbArgs, buildFrameArgs,
  FILTERS,
};
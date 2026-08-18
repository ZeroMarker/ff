'use strict';

/**
 * lib/ffmpeg.js — 底层 ffmpeg/ffprobe 封装
 *
 * 所有命令行参数均以「数组」形式传给 spawn，杜绝 shell 注入。
 * 提供：探针(probe)、通用执行(runFFmpeg)、各编辑任务参数构造器(build*)。
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

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
    ...[j.streams || []]
      .flat()
      .map((s) => parseFloat(s.duration))
      .filter((d) => Number.isFinite(d) && d >= 0),
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
/* 通用执行：-progress pipe:1 解析进度，支持取消                         */
/* ------------------------------------------------------------------ */

/**
 * @param {string[]} extraArgs 追加在基础参数之后
 * @param {object} [opts]
 * @param {(p:number)=>void} [opts.onProgress] 0..1
 * @param {{cancelled:boolean}} [opts.cancelToken] 置 true 即终止进程
 * @param {number} [opts.duration] 媒体时长(秒)，用于换算进度
 */
function runFFmpeg(extraArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const { onProgress = () => {}, cancelToken = null, duration } = opts;
    const args = [
      '-hide_banner', '-y', '-nostdin', '-nostats',
      '-progress', 'pipe:1',
      ...extraArgs,
    ];
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const state = { us: 0, done: false };
    let buf = '';
    let log = '';

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        parseProgressLine(line, state);
      }
    });

    child.stderr && child.stderr.on('data', (d) => {
      log += d.toString('utf8');
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
      if (m && !state.us) state.lastStderrTime = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
    });

    const timer = setInterval(() => {
      if (cancelToken && cancelToken.cancelled && child.exitCode === null) {
        child.kill('SIGKILL');
      }
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
          tail(log, 1200)
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

/** 同步执行（用于缩略图等轻量任务），超时保护，返回 {code, stderr} */
function runFFmpegSync(extraArgs, timeoutMs = 60000) {
  const res = spawnSync(FFMPEG, [
    '-hide_banner', '-y', '-nostdin', '-nostats',
    ...extraArgs,
  ], { encoding: 'utf8', timeout: timeoutMs });
  if (res.error && res.error.code === 'ETIMEDOUT') throw new Error('ffmpeg 同步执行超时');
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error('ffmpeg 失败 (' + res.status + '): ' + tail(res.stderr || '', 500));
  return { code: res.status, stderr: res.stderr };
}

/* ------------------------------------------------------------------ */
/* 任务参数构造器：返回 { args, duration }                                */
/* ------------------------------------------------------------------ */

const FILTERS = {
  grayscale: 'eq=saturation=0',
  negative: 'negate',
  mirror: 'hflip',
  blur: 'boxblur=6:1',
  vignette: 'vignette=PI/4',
  sharpen: 'unsharp=5:5:1.0:5:5:0.0',
};

/** 倍速音频滤镜：atempo 仅支持 0.5~100，超范围需级联 */
function atempoChain(speed) {
  const out = [];
  let s = speed;
  while (s > 2.0) { out.push('atempo=2.0'); s /= 2; }
  while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; }
  out.push('atempo=' + s.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));
  return out.join(',');
}

/** 视频导出参数（clip / full / 滤镜 / 分辨率 / 倍速 / gif） */
function buildExportArgs(input, output, p) {
  const {
    start = 0, end = null,         // clip 区间
    format = 'mp4',
    height = 0,                    // 0 = 原分辨率
    speed = 1,
    filters = [],                  // FILTERS 的键名数组
  } = p;

  const vf = [];
  if (height > 0) vf.push(`scale=-2:${Math.round(height)}`);
  for (const f of filters) if (FILTERS[f]) vf.push(FILTERS[f]);
  if (speed && speed !== 1) vf.push(`setpts=PTS/${speed}`);

  const af = [];
  if (speed && speed !== 1) af.push(atempoChain(speed));

  const args = [];
  let duration = 0;

  if (format === 'gif') {
    const gifW = height > 0 ? Math.round(height * 16 / 9) : 480;
    args.push('-ss', String(start), '-i', input);
    if (end) args.push('-t', String(end - start));
    args.push('-filter_complex',
      `fps=12,scale=${gifW}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`);
    args.push(output);
    duration = end ? end - start : 0;
    return { args, duration };
  }

  if (start > 0 || end != null) {
    args.push('-ss', String(start), '-i', input);
    if (end != null) args.push('-t', String(Math.max(0, end - start)));
    duration = end != null ? end - start : 0;
  } else {
    args.push('-i', input);
    duration = 0; // 未知，由调用方探测
  }

  if (vf.length) args.push('-vf', vf.join(','));
  if (af.length) args.push('-af', af.join(','));

  const codec = containerArgs(format);
  args.push(...codec, output);
  return { args, duration };
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
  return { args, duration };
}

/** 多文件拼接（自动缩放到首个视频分辨率） */
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
  return { args, duration: 0 };
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
  return { args, duration: end != null ? end - start : 0 };
}

/** 封面缩略图 */
function buildThumbArgs(input, output, p) {
  const at = Math.max(0, p.at || 0);
  return {
    args: [
      '-ss', String(at), '-i', input,
      '-frames:v', '1',
      '-vf', 'scale=360:-2',
      '-q:v', '4',
      output,
    ],
    duration: 1,
  };
}

/** 提取单帧（输出 png/jpg） */
function buildFrameArgs(input, output, p) {
  const at = Math.max(0, p.at || 0);
  const ext = path.extname(output).toLowerCase();
  const args = ['-ss', String(at), '-i', input, '-frames:v', '1'];
  if (ext === '.png') args.push('-c:v', 'png');
  else if (ext === '.jpg' || ext === '.jpeg') args.push('-q:v', '2', '-c:v', 'mjpeg');
  args.push(output);
  return { args, duration: 1 };
}

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function ffmpegVersion() {
  try {
    const r = spawnSync(FFMPEG, ['-version'], { encoding: 'utf8', timeout: 10000 });
    return r.stdout.split('\n')[0] || 'ffmpeg';
  } catch { return 'ffmpeg'; }
}

module.exports = {
  FFMPEG, FFPROBE,
  probe, runFFmpeg, runFFmpegSync, ffmpegVersion, md5,
  buildExportArgs, buildSegmentsArgs, buildConcatArgs,
  buildAudioArgs, buildThumbArgs, buildFrameArgs,
  FILTERS,
};
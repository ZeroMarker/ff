import React from 'react';
import { fmtTime, fmtSize } from '../api.js';

const MODES = [
  ['clip', '区间'], ['segs', '片段拼接'], ['full', '整片'], ['audio', '音频'], ['thumb', '封面'],
];
const FILTER_OPTS = [
  ['grayscale', '灰度'], ['negative', '反色'], ['mirror', '镜像'], ['blur', '模糊'], ['vignette', '暗角'], ['sharpen', '锐化'],
];
const RES_OPTS = [['0', '原画'], ['2160', '4K'], ['1440', '2K'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p']];

export default function ExportPanel({
  mode, setMode, format, setFormat, audioFormat, setAudioFormat,
  res, setRes, speed, setSpeed, filters, setFilters,
  overlays, trimStart, trimEnd, segments, segTotal, duration, curTime, onSeek, onExport, disabled,
}) {
  const toggleFilter = (f) => setFilters((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]));
  const segSecs = segments.reduce((s, x) => s + (x.end - x.start), 0);

  const summary = () => {
    if (mode === 'clip') return `区间 ${fmtTime(trimStart)} → ${fmtTime(trimEnd)}（${fmtTime(Math.max(0, trimEnd - trimStart))}）`;
    if (mode === 'segs') return segments.length ? `拼接 ${segments.length} 段，总时长 ${fmtTime(segTotal)}` : '请先添加片段';
    if (mode === 'full') return `整片（${fmtTime(duration)}）${overlays.length ? ` + ${overlays.length} 个叠加层` : ''}`;
    if (mode === 'audio') return `提取 ${audioFormat.toUpperCase()} 音频`;
    if (mode === 'thumb') return `生成封面帧 @ ${fmtTime(trimStart)}`;
    return '';
  };

  const canExport = disabled
    || (mode === 'segs' && !segments.length)
    || (mode === 'clip' && trimEnd - trimStart < 0.05);

  return (
    <section className="card">
      <div className="card-head"><h2>✂️ 导出</h2></div>
      <div className="field">
        <label className="field-label">模式</label>
        <div className="seg">
          {MODES.map(([v, label]) => (
            <label key={v} className="seg-item">
              <input type="radio" name="mode" checked={mode === v} onChange={() => setMode(v)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </div>

      {mode !== 'audio' && mode !== 'thumb' && (
        <div className="field">
          <label className="field-label">格式</label>
          <select className="select" value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="mp4">MP4 (H.264+AAC)</option>
            <option value="webm">WebM (VP9+Opus)</option>
            <option value="mov">MOV</option>
            <option value="mkv">MKV</option>
            <option value="gif">GIF 动图</option>
          </select>
        </div>
      )}
      {mode === 'audio' && (
        <div className="field">
          <label className="field-label">音频格式</label>
          <select className="select" value={audioFormat} onChange={(e) => setAudioFormat(e.target.value)}>
            <option value="mp3">MP3 (192k)</option><option value="m4a">M4A (AAC)</option>
            <option value="aac">AAC</option><option value="ogg">OGG (Vorbis)</option>
            <option value="flac">FLAC (无损)</option><option value="wav">WAV (PCM 48k)</option>
          </select>
        </div>
      )}

      {mode !== 'audio' && mode !== 'thumb' && (
        <div className="field">
          <label className="field-label">分辨率</label>
          <select className="select" value={String(res)} onChange={(e) => setRes(e.target.value)}>
            {RES_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      )}

      {mode !== 'audio' && mode !== 'thumb' && (
        <div className="field">
          <label className="field-label">倍速 <b>{speed}x</b>
            <input type="range" min="0.25" max="4" step="0.25" value={speed} onChange={(e) => setSpeed(parseFloat(e.target.value))} />
          </label>
        </div>
      )}

      {mode !== 'audio' && mode !== 'thumb' && (
        <div className="field">
          <label className="field-label">滤镜</label>
          <div className="chips">
            {FILTER_OPTS.map(([v, label]) => (
              <label key={v} className="chip-item">
                <input type="checkbox" checked={filters.includes(v)} onChange={() => toggleFilter(v)} />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <button className="btn primary block" disabled={canExport} onClick={onExport}>开始导出</button>
      <p className="dim center" style={{ fontSize: 12 }}>{summary()}</p>
      {mode !== 'audio' && mode !== 'thumb' && overlays.length > 0 && (
        <p className="dim center" style={{ fontSize: 12 }}>叠加层将在导出时合成（时间轴按输出时间线）</p>
      )}
    </section>
  );
}
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState, useCallback } from 'react';
import videojs from 'video.js';
import OverlayStage from './OverlayStage.jsx';
import { fmtTime } from '../api.js';

const VideoStage = forwardRef(function VideoStage(props, ref) {
  const {
    videoUrl, meta, duration,
    trimStart, trimEnd, onTrimStart, onTrimEnd,
    curTime, onTime,
    overlays, onOverlaysChange, selectedId, onSelect,
    editing, setEditing, addSegment, addTextOverlay, onOpenPaint,
    stageRefEl,
  } = props;

  const wrapRef = useRef(null);
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const [stageSize, setStageSize] = useState({ w: 16, h: 9 });
  const [ready, setReady] = useState(false);
  const playheadRef = useRef(null);
  const rafRef = useRef(0);
  const lastTimeRef = useRef(0);

  useImperativeHandle(ref, () => ({
    get player() { return playerRef.current; },
    get el() { return videoRef.current; },
    getTime: () => playerRef.current ? playerRef.current.currentTime() : 0,
    seek: (t) => { if (playerRef.current) playerRef.current.currentTime(Math.max(0, t)); },
    play: () => playerRef.current && playerRef.current.play(),
    pause: () => playerRef.current && playerRef.current.pause(),
  }), []);

  /* 初始化 video.js */
  useEffect(() => {
    if (!videoRef.current || playerRef.current) return;
    const player = videojs(videoRef.current, {
      controls: true, fluid: false, preload: 'auto', playsinline: true,
      html5: { vhs: { overrideNative: true } },
    });
    playerRef.current = player;
    player.on('loadedmetadata', () => {
      setReady(true);
      onTime(0);
    });
    player.on('timeupdate', () => onTime(player.currentTime()));
    return () => { player.dispose(); playerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 切换视频源 */
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !videoUrl) return;
    p.src({ src: videoUrl, type: 'video/mp4' });
    p.currentTime(0);
    setReady(false);
    lastTimeRef.current = 0;
    onTime(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl]);

  /* 播放头平滑跟随 */
  useEffect(() => {
    const tick = () => {
      const p = playerRef.current;
      if (p && !p.paused() && playheadRef.current && duration > 0) {
        const t = p.currentTime();
        playheadRef.current.style.transform = `translateX(${(t / duration) * 100}%)`;
        if (Math.abs(t - lastTimeRef.current) > 0.05) { lastTimeRef.current = t; onTimeRef.current(t); }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  const onTimeRef = useRef(onTime);
  useEffect(() => { onTimeRef.current = onTime; }, [onTime]);

  /* 视框尺寸（与视频同比例，铺满播放区；竖屏/横屏均适用） */
  useEffect(() => {
    const vw = meta?.video?.width || 16, vh = meta?.video?.height || 9;
    const parent = wrapRef.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      const availW = parent.clientWidth;
      const availH = parent.clientHeight;
      if (availW <= 0 || availH <= 0) return;
      // 等比缩放：s 为限制维度下的尺寸，另一维按视频比例换算
      const s = Math.min(availW, availH * (vw / vh));
      setStageSize({
        w: Math.max(160, Math.round(s)),
        h: Math.max(90, Math.round(s * vh / vw)),
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [meta, videoUrl, stageRefEl]);

  /* 时间轴约束 */
  const onStartInput = (v) => {
    const val = Math.min(Math.max(0, parseFloat(v)), parseFloat(trimEnd) - 0.01);
    onTrimStart(Math.round(val * 1000) / 1000);
  };
  const onEndInput = (v) => {
    const val = Math.max(Math.min(parseFloat(duration) || 0, parseFloat(v)), parseFloat(trimStart) + 0.01);
    onTrimEnd(Math.round(val * 1000) / 1000);
  };

  const step = (target, delta) => {
    if (target === 'start') onStartInput((parseFloat(trimStart) + delta).toFixed(3));
    else onEndInput((parseFloat(trimEnd) + delta).toFixed(3));
  };

  const seek = (t) => playerRef.current && playerRef.current.currentTime(t);
  const preview = () => { seek(trimStart); playerRef.current && playerRef.current.play(); };

  return (
    <section className="card stage-card">
      <div className="stage-head">
        <div className="stage-info dim">
          {meta ? `${meta.video?.width}×${meta.video?.height} · ${meta.video?.codec || ''} · 音频 ${meta.audio?.codec || '无'} · ${fmtTime(duration)}` : '等待载入本地视频…'}
        </div>
        <div className="stage-actions">
          {currentTimeLabel(curTime)}
          {videoUrl && <button className="btn ghost small" onClick={addTextOverlay} disabled={!meta}>＋文字</button>}
          {videoUrl && <button className="btn ghost small" onClick={onOpenPaint} disabled={!meta}>🎨 画笔</button>}
          <button className={`btn small ${editing ? 'primary' : 'ghost'}`} onClick={() => setEditing(!editing)}
            disabled={!meta || overlays.length === 0} title="拖动/缩放/旋转叠加层">
            {editing ? '✓ 编辑叠加' : '🖱 编辑叠加'}
          </button>
        </div>
      </div>

      <div className="player-holder" ref={stageRefEl}>
        <div className="video-mount" ref={wrapRef}
          style={{ width: stageSize.w, height: stageSize.h }}>
          <video ref={videoRef} className="video-js vjs-big-play-centered" playsInline />
          {ready && videoUrl && (
            <OverlayStage
              stageSize={stageSize} overlays={overlays} onOverlaysChange={onOverlaysChange}
              selectedId={selectedId} onSelect={onSelect} editing={editing}
              currentTime={curTime} />
          )}
        </div>
      </div>

      <div className="timeline" hidden={!videoUrl}>
        <div className="tl-row">
          <span className="tl-label">开始</span>
          <span className="tl-btns">
            <button className="btn tiny" onClick={() => step('start', -0.2)}>−0.2s</button>
            <button className="btn tiny" onClick={() => step('start', 0.2)}>+0.2s</button>
          </span>
          <input type="range" className="tl-slider" min={0} max={duration || 1} step={0.01}
            value={Math.min(trimStart, (trimEnd || 0) - 0.01)} onChange={(e) => onStartInput(e.target.value)} />
          <span className="tl-time">{fmtTime(trimStart)}</span>
        </div>
        <div className="tl-row">
          <span className="tl-label">结束</span>
          <span className="tl-btns">
            <button className="btn tiny" onClick={() => step('end', -0.2)}>−0.2s</button>
            <button className="btn tiny" onClick={() => step('end', 0.2)}>+0.2s</button>
          </span>
          <input type="range" className="tl-slider accent" min={0} max={duration || 1} step={0.01}
            value={Math.min(trimEnd || duration || 1, duration || 1)} onChange={(e) => onEndInput(e.target.value)} />
          <span className="tl-time">{fmtTime(trimEnd)}</span>
        </div>
        <div className="tl-bar">
          <div className="tl-fill" style={{
            left: `${(trimStart / (duration || 1)) * 100}%`,
            width: `${Math.max(0, ((trimEnd - trimStart) / (duration || 1)) * 100)}%`,
          }} />
          <div className="tl-playhead" ref={playheadRef}
            style={{ transform: `translateX(${(curTime / (duration || 1)) * 100}%)` }} />
        </div>
        <div className="tl-row tl-tools">
          <button className="btn small" onClick={addSegment} disabled={!meta}>＋ 添加到片段列表</button>
          <button className="btn small ghost" onClick={preview} disabled={!meta}>预览选区 ▶</button>
          <span className="spacer" />
          <span className="dim">选区 {fmtTime(Math.max(0, trimEnd - trimStart))}</span>
          <button className="btn small ghost" onClick={() => setEditing(!editing)} disabled={!meta || !overlays.length}>
            叠加层 {overlays.length} 项
          </button>
        </div>
      </div>
    </section>
  );
});

function currentTimeLabel(t) {
  return <span className="chip">{fmtTime(t)}</span>;
}

export default VideoStage;
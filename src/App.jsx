import React, { useEffect, useRef, useState, useCallback } from 'react';
import { api, uploadFile, toast, uid, fmtTime, rel, getToken, setToken } from './api.js';
import VideoStage from './components/VideoStage.jsx';
import Library from './components/Library.jsx';
import ExportPanel from './components/ExportPanel.jsx';
import OverlayPanel from './components/OverlayPanel.jsx';
import SegmentsPanel from './components/SegmentsPanel.jsx';
import JobsPanel from './components/JobsPanel.jsx';
import FabricDrawModal from './components/FabricDrawModal.jsx';
import FilePickerModal from './components/FilePickerModal.jsx';

export default function App() {
  const [health, setHealth] = useState(null);
  const [config, setConfig] = useState(null);
  const [videos, setVideos] = useState([]);
  const [outputs, setOutputs] = useState([]);
  const [assets, setAssets] = useState([]);
  const [jobs, setJobs] = useState([]);

  const [current, setCurrent] = useState(null);   // {path, name}
  const [meta, setMeta] = useState(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [concatList, setConcatList] = useState([]);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [curTime, setCurTime] = useState(0);

  const [overlays, setOverlays] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [segments, setSegments] = useState([]);

  const [mode, setMode] = useState('clip');
  const [format, setFormat] = useState('mp4');
  const [audioFormat, setAudioFormat] = useState('mp3');
  const [res, setRes] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [filters, setFilters] = useState([]);

  const [editing, setEditing] = useState(false);
  const [paintOpen, setPaintOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const playerRef = useRef(null);
  const stageRef = useRef(null);

  const reload = useCallback(async () => {
    const [v, o, a, j] = await Promise.all([
      api('/api/videos').catch(() => []),
      api('/api/outputs').catch(() => []),
      api('/api/assets').catch(() => []),
      api('/api/jobs').catch(() => []),
    ]);
    setVideos(v); setOutputs(o); setAssets(a); setJobs(j);
  }, []);

  useEffect(() => {
    api('/api/config').then((cfg) => {
      setConfig(cfg);
      if (cfg.needAuth && !getToken()) {
        const input = window.prompt('请输入访问口令 (AUTH_TOKEN):');
        if (input) setToken(input);
      }
    }).catch(() => null);
    api('/api/health').then(setHealth).catch(() => setHealth({ ok: false, ffmpeg: '离线' }));
    reload();
    const iv = setInterval(() => {
      api('/api/jobs').then(setJobs).catch(() => {});
      api('/api/outputs').then(setOutputs).catch(() => {});
    }, 1500);
    return () => clearInterval(iv);
  }, [reload]);

  /* ---------- 视频选择（任意白名单路径） ---------- */
  const selectVideo = useCallback(async (path) => {
    const name = path.split(/[\\/]/).pop();
    setCurrent({ path, name });
    setSegments([]);
    setOverlays([]);
    setSelectedId(null);
    setEditing(false);
    setTrimStart(0);
    // 结束时间必须随新视频的元数据初始化，否则开始滑块会被
    // trimEnd - 0.01 约束到负数，两个受控滑块都会表现为无法调整。
    setTrimEnd(0);
    try {
      const info = await api(`/api/fs/info?path=${encodeURIComponent(path)}`);
      setMeta(info);
      setTrimEnd(Math.max(0, Number(info?.format?.duration) || 0));
      setVideoUrl(rel(`/api/fs/video?path=${encodeURIComponent(path)}&t=${Date.now()}`));
      toast(`已选择: ${path}`, 'ok');
    } catch (e) {
      toast('读取元数据失败: ' + e.message, 'err');
    }
  }, []);

  const duration = meta ? meta.format.duration || 0 : 0;
  const vw = meta?.video?.width || 1920;
  const vh = meta?.video?.height || 1080;

  /* ---------- 叠加层 ---------- */
  const upsertOverlay = useCallback((patch) => {
    setOverlays((prev) => {
      const i = prev.findIndex((o) => o.id === patch.id);
      if (i < 0) return [...prev, patch];
      const next = [...prev];
      next[i] = { ...prev[i], ...patch };
      return next;
    });
  }, []);
  const removeOverlay = useCallback((id) => {
    setOverlays((p) => p.filter((o) => o.id !== id));
    setSelectedId((s) => (s === id ? null : s));
  }, []);

  const addTextOverlay = () => {
    const o = {
      id: uid(), type: 'text', text: '示例文字', x: 0.1, y: 0.1,
      size: 0.06, color: '#ffffff', bg: '', bold: false,
      rotation: 0, opacity: 1, start: 0, end: null, z: Date.now(),
    };
    setOverlays((p) => [...p, o]);
    setSelectedId(o.id);
    setEditing(true);
  };

  const addImageOverlay = (asset) => {
    const o = {
      id: uid(), type: 'image', asset: asset.name,
      x: 0.15, y: 0.15, w: 0.25, h: 0.25, rotation: 0,
      opacity: 1, start: 0, end: null, z: Date.now(),
    };
    setOverlays((p) => [...p, o]);
    setSelectedId(o.id);
    setEditing(true);
  };

  /* ---------- 片段 ---------- */
  const addSegment = () => {
    if (trimEnd - trimStart < 0.05) return toast('片段太短', 'err');
    setSegments((p) => [...p, { start: Math.round(trimStart * 1000) / 1000, end: Math.round(trimEnd * 1000) / 1000 }]);
    toast('已添加片段', 'ok');
  };

  /* ---------- 导出 ---------- */
  const startExport = async () => {
    const hasOverlays = overlays.length > 0 && (mode === 'clip' || mode === 'full');
    const params = {
      format, height: Number(res) || 0, speed, filters,
      overlays: hasOverlays
        ? overlays.map((o) => o.type === 'text'
            ? {
                type: 'text', text: o.text, x: Math.round(o.x * vw), y: Math.round(o.y * vh),
                size: Math.round(o.size * vh), color: o.color, bg: o.bg, bold: o.bold,
                rotation: o.rotation, opacity: o.opacity, start: o.start, end: o.end, z: o.z,
              }
            : {
                type: 'image', asset: o.asset, x: o.x, y: o.y, w: o.w, h: o.h,
                rotation: o.rotation, opacity: o.opacity, start: o.start, end: o.end, z: o.z,
              } )
        : [],
    };
    try {
      let type = mode;
      const body = { type, params };
      if (mode === 'clip' || mode === 'segs' || mode === 'full' || mode === 'audio' || mode === 'thumb') {
        body.src = current.path;
      }
      if (mode === 'clip') { params.start = trimStart; params.end = trimEnd; }
      else if (mode === 'segs') { type = 'segments'; body.type = type; params.segments = segments.map((s) => ({ ...s })); }
      else if (mode === 'audio') { type = 'audio'; params.format = audioFormat; params.start = 0; }
      else if (mode === 'thumb') { type = 'thumb'; params.at = trimStart; }
      else if (mode === 'full') { type = 'full'; params.start = 0; params.end = 0; }
      if (mode === 'concat') { body.type = 'concat'; params.paths = concatList.map((x) => x.path); }
      await api('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      toast('任务已创建，排队执行中', 'ok');
      setTimeout(() => api('/api/jobs').then(setJobs).catch(() => {}), 500);
    } catch (e) {
      toast('创建任务失败: ' + e.message, 'err');
    }
  };

  /* ---------- 画笔成果 -> 叠加图片 ---------- */
  const publishPaint = async (dataUrl) => {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const asset = await uploadFile(rel('/api/assets'), 'file', new File([blob], `paint-${Date.now()}.png`, { type: 'image/png' }));
      addImageOverlay(asset);
      setAssets((p) => [{ ...asset, url: rel(`/api/assets/` + encodeURIComponent(asset.name)), size: blob.size, mtime: Date.now() }, ...p]);
      toast('画笔作品已作为叠加层添加', 'ok');
    } catch (e) {
      toast('发布失败: ' + e.message, 'err');
    }
  };

  const segTotal = segments.reduce((s, x) => s + (x.end - x.start), 0);

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="logo">🎬</span>
          <div>
            <h1>FF Web Editor <span className="ver">v2 · React</span></h1>
            <p className="sub">Video.js 播放 · Konva 叠加 · Fabric 画笔 · ffmpeg 渲染 · systemd 服务 · Caddy 反代</p>
          </div>
        </div>
        <div className="topbar-right">
          <span className="chip">{health?.ffmpeg || 'ffmpeg …'}</span>
          <span className={`status-dot ${health?.ok ? 'ok' : 'bad'}`} title="服务状态" />
        </div>
      </header>

      <main className="layout">
        <aside className="col col-left">
          <Library current={current} onSelect={selectVideo} reload={reload} config={config}
            outputs={outputs} setOutputs={setOutputs}
            concatList={concatList} setConcatList={setConcatList} />
        </aside>

        <section className="col col-mid">
          <VideoStage
            ref={playerRef} stageRefEl={stageRef}
            videoUrl={videoUrl} meta={meta} duration={duration}
            trimStart={trimStart} trimEnd={trimEnd}
            onTrimStart={setTrimStart} onTrimEnd={setTrimEnd}
            curTime={curTime} onTime={setCurTime}
            overlays={overlays} onOverlaysChange={setOverlays}
            selectedId={selectedId} onSelect={setSelectedId}
            editing={editing} setEditing={setEditing}
            addSegment={addSegment} addTextOverlay={addTextOverlay}
            onOpenPaint={() => { playerRef.current?.pause(); setPaintOpen(true); }} />

          <div className="quickbar">
            <button className="btn primary" onClick={() => setPickerOpen(true)}>🎬 选择视频…（弹窗）</button>
            <span className="dim">当前: {current ? current.name : '未选择'} {duration ? `· ${fmtTime(duration)}` : ''}</span>
            <span className="spacer" />
            <button className="btn small ghost" disabled={!segments.length} onClick={() => setSegments([])}>清空片段</button>
            <button className="btn small" disabled={!current} onClick={() => playerRef.current?.seek(trimStart) || playerRef.current?.play()}>预览选区 ▶</button>
          </div>
        </section>

        <aside className="col col-right">
          <ExportPanel
            mode={mode} setMode={setMode} format={format} setFormat={setFormat}
            audioFormat={audioFormat} setAudioFormat={setAudioFormat}
            res={res} setRes={setRes} speed={speed} setSpeed={setSpeed}
            filters={filters} setFilters={setFilters}
            overlays={overlays} trimStart={trimStart} trimEnd={trimEnd}
            segments={segments} segTotal={segTotal} duration={duration}
            curTime={curTime} onSeek={(t) => playerRef.current?.seek(t)}
            onExport={startExport} disabled={!current}
            concatList={concatList} />

          <OverlayPanel
            overlays={overlays} selectedId={selectedId} setSelectedId={setSelectedId}
            upsertOverlay={upsertOverlay} removeOverlay={removeOverlay}
            addTextOverlay={addTextOverlay} assets={assets} setAssets={setAssets}
            addImageOverlay={addImageOverlay} editing={editing} setEditing={setEditing}
            currentTime={curTime}
          />

          <SegmentsPanel segments={segments} setSegments={setSegments}
            trimStart={trimStart} trimEnd={trimEnd}
            onSeek={(t) => playerRef.current?.seek(t)} />

          <JobsPanel jobs={jobs} setJobs={setJobs} reload={reload} />
        </aside>
      </main>

      {paintOpen && (
        <FabricDrawModal
          videoEl={playerRef.current?.el}
          meta={meta} duration={duration} curTime={curTime}
          onClose={() => setPaintOpen(false)} onPublish={publishPaint} />
      )}
      <FilePickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(path, name) => { selectVideo(path); }}
        current={current} />
      <div id="toasts" className="toast-wrap" />
    </>
  );
}

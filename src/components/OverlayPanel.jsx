import React from 'react';
import { uploadFile, toast, fmtTime } from '../api.js';

export default function OverlayPanel({
  overlays, selectedId, setSelectedId, upsertOverlay, removeOverlay,
  addTextOverlay, assets, setAssets, addImageOverlay, editing, setEditing, currentTime,
}) {
  const imgInput = React.useRef(null);

  const pickAsset = (asset) => addImageOverlay(asset);
  const uploadAsset = (files) => {
    const f = files[0];
    if (!f) return;
    uploadFile('/api/assets', 'file', f)
      .then((a) => {
        const rec = { ...a, size: f.size, mtime: Date.now(), url: '/api/assets/' + encodeURIComponent(a.name) };
        setAssets((p) => [rec, ...p]);
        addImageOverlay(rec);
        toast('素材已上传并添加', 'ok');
      })
      .catch((e) => toast(e.message, 'err'));
  };

  const sel = overlays.find((o) => o.id === selectedId);

  return (
    <section className="card">
      <div className="card-head">
        <h2>🎞️ 叠加层 <span className="badge">{overlays.length}</span></h2>
        <div className="card-tools">
          <button className="btn ghost small" onClick={() => setEditing(!editing)}
            disabled={!overlays.length}>{editing ? '✓ 完成编辑' : '🖱 编辑'}</button>
          <button className="btn small" onClick={addTextOverlay}>＋文字</button>
          <button className="btn small" onClick={() => imgInput.current.click()}>🖼 图片</button>
        </div>
      </div>
      <input ref={imgInput} type="file" accept="image/*" hidden
        onChange={(e) => { uploadAsset([...e.target.files]); e.target.value = ''; }} />

      <div className="overlay-list">
        {overlays.length === 0 && <p className="dim center" style={{ fontSize: 12 }}>
          添加文字/图片叠加层，在画面上拖动、缩放、旋转
          <br /><button className="btn tiny ghost" onClick={addTextOverlay}>＋ 添加第一个文字</button>
        </p>}
        {overlays.map((o) => (
          <div key={o.id} className={`ov-item ${selectedId === o.id ? 'active' : ''}`} onClick={() => setSelectedId(o.id)}>
            <span className="ov-icon">{o.type === 'text' ? 'T' : '🖼'}</span>
            <span className="ov-name">{o.type === 'text' ? (o.text || '文字') : (o.asset || '图片')}</span>
            <span className="ov-time dim">
              {fmtTime(o.start ?? 0)}–{o.end != null ? fmtTime(o.end) : '∞'}
            </span>
            <button className="seg-del" onClick={(e) => { e.stopPropagation(); removeOverlay(o.id); }}>✕</button>
          </div>
        ))}
      </div>

      {sel && (
        <div className="ov-editor">
          {sel.type === 'text' && (
            <>
              <label className="frow"><span>内容</span>
                <input className="input" value={sel.text} onChange={(e) => upsertOverlay({ id: sel.id, text: e.target.value })} />
              </label>
              <label className="frow"><span>字号</span>
                <input type="range" min={0.02} max={0.3} step={0.005} value={sel.size}
                  onChange={(e) => upsertOverlay({ id: sel.id, size: parseFloat(e.target.value) })} />
              </label>
              <div className="frow"><span>颜色</span>
                <input type="color" value={sel.color} onChange={(e) => upsertOverlay({ id: sel.id, color: e.target.value })} />
              </div>
              <div className="frow"><span>背景</span>
                <label className="chip-item"><input type="checkbox" checked={!!sel.bg} onChange={(e) => upsertOverlay({ id: sel.id, bg: e.target.checked ? '#000000' : '' })} /><span>黑底</span></label>
                <label className="chip-item"><input type="checkbox" checked={!!sel.bold} onChange={(e) => upsertOverlay({ id: sel.id, bold: e.target.checked })} /><span>描边</span></label>
              </div>
            </>
          )}
          {sel.type === 'image' && (
            <div className="frow"><span>不透明度</span>
              <input type="range" min={0.05} max={1} step={0.05} value={sel.opacity}
                onChange={(e) => upsertOverlay({ id: sel.id, opacity: parseFloat(e.target.value) })} />
            </div>
          )}
          <div className="frow"><span>出现</span>
            <input className="input" type="number" min={0} step={0.1} value={sel.start ?? 0}
              onChange={(e) => upsertOverlay({ id: sel.id, start: parseFloat(e.target.value) || 0 })} />
          </div>
          <div className="frow"><span>消失</span>
            <input className="input" type="number" min={0} step={0.1} placeholder="留空=至结束" value={sel.end ?? ''}
              onChange={(e) => upsertOverlay({ id: sel.id, end: e.target.value === '' ? null : parseFloat(e.target.value) })} />
          </div>
          <div className="frow"><span>旋转°</span>
            <input className="input" type="number" step={1} value={sel.rotation || 0}
              onChange={(e) => upsertOverlay({ id: sel.id, rotation: parseFloat(e.target.value) || 0 })} />
          </div>
        </div>
      )}

      <p className="dim" style={{ fontSize: 11.5 }}>
        目前时间 <b>{fmtTime(currentTime)}</b> · 叠加层在导出时由 ffmpeg 合成（drawtext / overlay）
      </p>
    </section>
  );
}
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { api, fmtSize, rel, fmtTime } from '../api.js';

/* 网页弹窗选择本地视频：在服务器白名单根目录内浏览任意路径 */
export default function FilePickerModal({ open, onClose, onPick, current }) {
  const [dir, setDir] = useState(null);
  const [sel, setSel] = useState(null);   // 当前选中的视频 {path, name, size}
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState(null); // 预览信息 {meta, path}
  const navigateRequestRef = useRef(0);
  const previewRequestRef = useRef(0);

  const navigate = useCallback(async (p) => {
    const requestId = ++navigateRequestRef.current;
    setLoading(true); setErr('');
    try {
      const d = await api(`/api/fs?path=${encodeURIComponent(p || '')}`);
      if (requestId !== navigateRequestRef.current) return;
      setDir(d);
    } catch (e) {
      if (requestId === navigateRequestRef.current) setErr(e.message);
    } finally {
      if (requestId === navigateRequestRef.current) setLoading(false);
    }
  }, []);

  /* 打开时定位到当前视频所在目录 */
  const dirnameAccessible = (p) => p.split('/').slice(0, -1).join('/') || '/';

  useEffect(() => {
    if (!open) return;
    const start = current?.path ? dirnameAccessible(current.path) : '';
    navigate(start);
    setSel(current ? { path: current.path, name: current.name } : null);
    setPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const confirmPick = () => {
    if (!sel) return;
    onPick(sel.path, sel.name);
    onClose();
  };
  /* 双击快捷选择：直接使用当前条目（避免 setState 异步导致的空 sel） */
  const confirmPickItem = (item) => {
    onPick(item.path, item.name);
    onClose();
  };

  const pickVideo = (item) => {
    const requestId = ++previewRequestRef.current;
    setSel({ path: item.path, name: item.name, size: item.size });
    api(`/api/fs/info?path=${encodeURIComponent(item.path)}`)
      .then((info) => {
        if (requestId === previewRequestRef.current) setPreview(info);
      }).catch(() => {
        if (requestId === previewRequestRef.current) setPreview(null);
      });
  };

  const previewUrl = sel ? rel(`/api/fs/video?path=${encodeURIComponent(sel.path)}`) : '';

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="picker-modal">
        <div className="picker-head">
          <h3>🎬 选择本地视频</h3>
          <span className="dim" style={{ fontSize: 12 }}>浏览服务器本地目录（白名单 FS_ROOTS 内任意路径）</span>
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>

        <div className="fs-pathbar mono">📂 {dir?.path || '加载中…'}</div>
        <div className="fs-roots">
          {dir?.roots.map((r) => (
            <button key={r} className={`btn tiny ghost ${dir?.path === r ? 'primary' : ''}`} onClick={() => navigate(r)}>{r}</button>
          ))}
        </div>

        {err && <p className="j-err">{err}</p>}
        <div className="picker-body">
          {/* 左侧：目录/文件列表 */}
          <div className="fs-list">
            {dir?.parent && (
              <div className="fs-item fs-dir" onClick={() => navigate(dir.parent)}>
                <span className="fi-icon">📂</span><span className="fi-name">.. (上级目录)</span>
              </div>
            )}
            {dir?.items.map((it) => {
              if (it.type === 'dir') return (
                <div key={it.path} className="fs-item fs-dir" onClick={() => navigate(it.path)} title={it.path}>
                  <span className="fi-icon">📁</span><span className="fi-name">{it.name}{it.isSymlink ? ' ⇢' : ''}</span>
                </div>
              );
              if (it.type === 'video') {
                const active = sel?.path === it.path;
                return (
                  <div key={it.path} className={`fs-item fs-video ${active ? 'active' : ''}`}
                    onClick={() => pickVideo(it)} onDoubleClick={() => { pickVideo(it); confirmPickItem(it); }} title={it.path}>
                    <span className="fi-thumb"><img loading="lazy"
                      src={rel(`/api/fs/thumbnail?path=${encodeURIComponent(it.path)}&t=${Math.round(it.mtime)}`)} alt="" /></span>
                    <span className="fi-name">{it.name}</span>
                    <span className="fi-size">{fmtSize(it.size)}</span>
                    {active && <span className="fi-check">✓</span>}
                  </div>
                );
              }
              return (
                <div key={it.path} className="fs-item fs-file" title={it.path}>
                  <span className="fi-icon">📄</span><span className="fi-name">{it.name}</span>
                  <span className="fi-size">{fmtSize(it.size)}</span>
                </div>
              );
            })}
            {loading && <div className="empty-note">加载中…</div>}
          </div>

          {/* 右侧：选中视频预览 */}
          <div className="picker-preview">
            {sel ? (
              <>
                <video key={sel.path} src={previewUrl} controls autoPlay={false} preload="metadata"
                  style={{ width: '100%', borderRadius: 8, background: '#000', maxHeight: 200 }} />
                <div className="pp-name" title={sel.path}>{sel.name}</div>
                <div className="pp-meta dim">
                  {preview ? `${preview.video?.width}×${preview.video?.height} · ${fmtTime(preview.format.duration)} · ${preview.video?.codec || ''}` : '读取元数据…'}
                </div>
              </>
            ) : <div className="empty-note">👆 点击左侧视频文件进行预览与选择</div>}
          </div>
        </div>

        <div className="picker-foot">
          <div className="picker-cur dim" title={sel?.path}>
            已选择：<b style={{ color: 'var(--accent)' }}>{sel ? sel.name : '未选择'}</b>
          </div>
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!sel} onClick={confirmPick}>确定选择</button>
        </div>
      </div>
    </div>
  );
}

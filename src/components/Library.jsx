import React, { useEffect, useRef, useState, useCallback } from 'react';
import { api, fmtSize, rel } from '../api.js';

/* 本地文件浏览器：在服务器白名单根目录内选择任意路径的视频 */
export default function Library({ current, onSelect, config, reload, outputs, setOutputs, concatList, setConcatList }) {
  const [dir, setDir] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const navigate = useCallback(async (p) => {
    setLoading(true); setErr('');
    try {
      const d = await api(`/api/fs?path=${encodeURIComponent(p || '')}`);
      setDir(d);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { navigate(config?.fsRoots?.[0] || '/'); }, [config, navigate]);

  const inConcat = (path) => concatList.some((x) => x.path === path);
  const toggleConcat = (item) => {
    if (inConcat(item.path)) setConcatList((p) => p.filter((x) => x.path !== item.path));
    else setConcatList((p) => [...p, item]);
  };

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>📁 本地文件 <span className="dim" style={{ fontWeight: 400 }}>(白名单内任意路径)</span></h2>
          <div className="card-tools">
            <button className="btn ghost small" title="刷新目录" onClick={() => navigate(dir?.path)}>⟳</button>
          </div>
        </div>
        <div className="fs-pathbar mono" title={dir?.path}>📂 {dir?.path || '加载中…'}</div>
        <div className="fs-roots">
          {(config?.fsRoots || []).map((r) => (
            <button key={r} className={`btn tiny ghost ${dir?.path === r ? 'primary' : ''}`}
              onClick={() => navigate(r)} title={r}>{r}</button>
          ))}
        </div>
        {err && <p className="j-err" style={{ color: 'var(--danger)' }}>{err}</p>}
        <div className="fs-list" onDoubleClick={() => {}}>
          {dir?.parent && (
            <div className="fs-item fs-dir" onClick={() => navigate(dir.parent)}>
              <span className="fi-icon">📂</span><span className="fi-name">.. (上级目录)</span>
            </div>
          )}
          {dir?.items.map((it) => {
            if (it.type === 'dir') {
              return (
                <div key={it.path} className="fs-item fs-dir" onClick={() => navigate(it.path)} title={it.path}>
                  <span className="fi-icon">📁</span>
                  <span className="fi-name">{it.name}{it.isSymlink ? ' ⇢' : ''}</span>
                </div>
              );
            }
            if (it.type === 'video') {
              const active = current?.path === it.path;
              const inList = inConcat(it.path);
              return (
                <div key={it.path} className={`fs-item fs-video ${active ? 'active' : ''}`} onClick={() => onSelect(it.path)} title={it.path}>
                  <span className="fi-thumb"><img loading="lazy"
                    src={rel(`/api/fs/thumbnail?path=${encodeURIComponent(it.path)}&t=${Math.round(it.mtime)}`)} alt="" /></span>
                  <span className="fi-name">{it.name}</span>
                  <span className="fi-size">{fmtSize(it.size)}</span>
                  <button className={`btn tiny ${inList ? 'primary' : 'ghost'}`} title={inList ? '已加入拼接清单，再点移除' : '加入拼接清单'}
                    onClick={(e) => { e.stopPropagation(); toggleConcat(it); }}>{inList ? '✓' : '+'}</button>
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
        <p className="tip" style={{ fontSize: 11.5 }}>
          点击视频即选择·点击 ＋ 加入拼接清单 · 白名单根目录由服务器 FS_ROOTS 控制
        </p>
      </section>

      {/* 拼接清单 */}
      <section className="card">
        <div className="card-head">
          <h2>🧩 拼接清单 <span className="badge">{concatList.length}</span></h2>
          <button className="btn ghost small" disabled={!concatList.length} onClick={() => setConcatList([])}>清空</button>
        </div>
        <div className="concat-list">
          {!concatList.length && <p className="dim center" style={{ fontSize: 12 }}>在上方文件列表点 ＋ 添加，导出面板选「片段拼接」为多文件拼接</p>}
          {concatList.map((it, i) => (
            <div key={it.path} className="concat-item">
              <span className="ci-idx">{i + 1}</span>
              <span className="ci-name" title={it.path}>{it.name}</span>
              <button className="seg-del" onClick={() => setConcatList((p) => p.filter((x) => x.path !== it.path))}>✕</button>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>🗂️ 输出文件</h2>
          <button className="btn ghost small" onClick={() => reload()}>⟳</button>
        </div>
        <div className="out-list">
          {outputs.length === 0 && <p className="dim center">暂无输出</p>}
          {outputs.map((o) => (
            <div key={o.url || o.name} className="out-item">
              <span className="nm" title={o.name}>{o.name}</span>
              <span className="sz">{fmtSize(o.size)}</span>
              <a className="a" href={rel(o.url || `/api/output/${encodeURIComponent(o.name)}`)} download title="下载">⬇</a>
              <button className="del" title="删除"
                onClick={async () => {
                  try {
                    await fetch(rel(o.deleteUrl || `/api/output/${encodeURIComponent(o.name)}`), { method: 'DELETE' });
                    reload();
                  } catch {}
                }}>🗑</button>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

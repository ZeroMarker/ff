import React from 'react';
import { uploadFile, toast, fmtSize } from '../api.js';

export default function Library({ videos, uploads, setUploads, current, onSelect, reload, outputs, setOutputs }) {
  const fileInput = React.useRef(null);

  const handleFiles = (files) => {
    for (const f of files) {
      const key = Math.random().toString(36).slice(2);
      setUploads((p) => [...p, { key, name: f.name, pct: 0 }]);
      uploadFile(rel('/api/upload'), 'file', f, (r) =>
        setUploads((p) => p.map((u) => (u.key === key ? { ...u, pct: Math.round(r * 100) } : u))))
        .then(() => { setUploads((p) => p.filter((u) => u.key !== key)); toast(`已导入 ${f.name}`, 'ok'); reload(); })
        .catch((e) => { setUploads((p) => p.filter((u) => u.key !== key)); toast('导入失败: ' + e.message, 'err'); });
    }
  };

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>📁 视频库（本地）</h2>
          <div className="card-tools">
            <button className="btn ghost small" onClick={reload} title="刷新">⟳</button>
            <button className="btn primary small" onClick={() => fileInput.current.click()}>上传</button>
          </div>
        </div>
        <div className="stats dim">
          {videos.length} 个本地视频 · 共 {fmtSize(videos.reduce((s, v) => s + v.size, 0))}
        </div>
        <input ref={fileInput} type="file" accept="video/*" multiple hidden
          onChange={(e) => { handleFiles([...e.target.files]); e.target.value = ''; }} />
        <div className="file-grid">
          {videos.length === 0 && !uploads.length && <div className="empty-note">视频库为空<br />点击「上传」导入本地文件</div>}
          {videos.map((v) => (
            <div key={v.name} className={`file-tile ${current?.name === v.name ? 'active' : ''}`}
              onClick={() => onSelect(v.name)}>
              <img loading="lazy" src={rel(`/api/videos/${encodeURIComponent(v.name)}/thumbnail?t=${Math.round(v.mtime)}`)} alt={v.name} />
              <div className="ft-name">{v.name}</div>
              <div className="ft-size">{fmtSize(v.size)}</div>
            </div>
          ))}
          {uploads.map((u) => (
            <div key={u.key} className="file-tile uploading">
              <div className="ft-name">{u.name}</div>
              <div className="up-bar"><div className="up-fill" style={{ width: u.pct + '%' }} /></div>
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
            <div key={o.name} className="out-item">
              <span className="nm" title={o.name}>{o.name}</span>
              <span className="sz">{fmtSize(o.size)}</span>
              <a className="a" href={rel(`/api/output/${encodeURIComponent(o.name)}`)} download title="下载">⬇</a>
              <button className="del" title="删除"
                onClick={async () => {
                  try {
                    const r = await fetch(rel(`/api/output/${encodeURIComponent(o.name)}`), { method: 'DELETE' });
                    if (!r.ok) throw new Error('删除失败');
                    setOutputs((p) => p.filter((x) => x.name !== o.name));
                  } catch (e) { toast(e.message, 'err'); }
                }}>🗑</button>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
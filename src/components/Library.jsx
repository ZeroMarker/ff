import React from 'react';
import { fmtSize, rel } from '../api.js';

/* 视频库：不提供上传。视频由运维直接放入服务器 videos/ 目录，网页仅负责选择本地视频。 */
export default function Library({ videos, current, onSelect, reload, outputs, setOutputs, config }) {
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>📁 视频库 <span className="dim" style={{ fontWeight: 400 }}>(本地目录)</span></h2>
          <div className="card-tools">
            <button className="btn ghost small" onClick={reload} title="刷新列表">⟳</button>
          </div>
        </div>
        <div className="stats dim" style={{ fontSize: 12 }}>
          {videos.length} 个本地视频 · 共 {fmtSize(videos.reduce((s, v) => s + v.size, 0))}
        </div>
        <p className="tip">
          📌 无需上传：将视频文件放入服务器<br />
          <code className="mono">{config?.videosDir || 'videos/'}</code><br />
          后点 ⟳ 刷新即可在此选择
        </p>
        <div className="file-grid">
          {videos.length === 0 && <div className="empty-note">目录为空<br />请先放置视频到 videos/ 目录</div>}
          {videos.map((v) => (
            <div key={v.name} className={`file-tile ${current?.name === v.name ? 'active' : ''}`}
              onClick={() => onSelect(v.name)}>
              <img loading="lazy" src={rel(`/api/videos/${encodeURIComponent(v.name)}/thumbnail?t=${Math.round(v.mtime)}`)} alt={v.name} />
              <div className="ft-name">{v.name}</div>
              <div className="ft-size">{fmtSize(v.size)}</div>
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
                  } catch (e) { /* toast 不在此组件内，忽略 */ }
                }}>🗑</button>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
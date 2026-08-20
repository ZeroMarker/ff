import React from 'react';
import { api, fmtSize, rel } from '../api.js';

export default function JobsPanel({ jobs, setJobs, reload }) {
  const act = (u, opts) => api(u, opts);

  const del = async (j) => {
    try { await act(`/api/jobs/${j.id}`, { method: 'DELETE' }); setJobs((p) => p.filter((x) => x.id !== j.id)); reload(); }
    catch (e) { console.error(e); }
  };
  const cancel = async (j) => {
    try { await act(`/api/jobs/${j.id}/cancel`, { method: 'POST' }); reload(); } catch (e) { console.error(e); }
  };
  const clearDone = async () => {
    for (const j of jobs) if (['done', 'failed', 'cancelled'].includes(j.status)) await del(j);
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>⚙️ 任务 <span className="badge">{jobs.length}</span></h2>
        <button className="btn ghost small" onClick={clearDone} disabled={!jobs.length}>清除已完成</button>
      </div>
      <div className="jobs-list">
        {jobs.length === 0 && <p className="dim center" style={{ fontSize: 12 }}>暂无任务</p>}
        {jobs.map((j) => (
          <div key={j.id} className="job">
            <div className="j-top">
              <span className={`j-status ${j.status}`}>{j.status}</span>
              <span className="j-name" title={j.name}>{j.name}</span>
            </div>
            <div className="j-bar">
              <div className="j-fill" style={{ width: `${j.progress || 0}%` }} />
            </div>
            <div className="j-actions">
              {j.status === 'done' && j.outputUrl && <a href={rel(j.outputUrl)} download>⬇ 下载（{fmtSize(j.outputSize)}）</a>}
              {(j.status === 'queued' || j.status === 'running') && <button className="j-cancel" onClick={() => cancel(j)}>✕ 取消</button>}
              <button className="j-del" onClick={() => del(j)}>删除</button>
            </div>
            {j.status === 'failed' && <div className="j-err">{j.error?.slice(0, 300)}</div>}
            {j.status === 'cancelled' && <div className="j-err">已取消（已清理残留文件）</div>}
            <div className="j-meta">
              <span>{new Date(j.createdAt).toLocaleTimeString()}</span>
              {j.endedAt && <span>{((j.endedAt - (j.startedAt || j.createdAt)) / 1000).toFixed(1)}s</span>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

import React from 'react';
import { fmtTime } from '../api.js';

export default function SegmentsPanel({ segments, setSegments, trimStart, trimEnd, onSeek }) {
  const total = segments.reduce((s, x) => s + (x.end - x.start), 0);
  return (
    <section className="card">
      <div className="card-head">
        <h2>📋 片段列表 <span className="badge">{segments.length}</span></h2>
        <div className="card-tools">
          <button className="btn ghost small" disabled={!segments.length} onClick={() => setSegments([])}>清空</button>
        </div>
      </div>
      {segments.length === 0 && <p className="dim center" style={{ fontSize: 12 }}>
        用上方时间轴选好区间后点「＋ 添加到片段列表」
      </p>}
      <table className="seg-table">
        <thead><tr><th>#</th><th>开始</th><th>结束</th><th>时长</th><th></th></tr></thead>
        <tbody>
          {segments.map((s, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td className="seg-preview" title="跳转预览" onClick={() => onSeek(s.start)}>{fmtTime(s.start)}</td>
              <td className="seg-preview" title="跳转预览" onClick={() => onSeek(s.end)}>{fmtTime(s.end)}</td>
              <td>{fmtTime(s.end - s.start)}</td>
              <td><button className="seg-del" onClick={() => setSegments((p) => p.filter((_, j) => j !== i))}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {segments.length > 0 && <p className="dim" style={{ fontSize: 12 }}>总时长 {fmtTime(total)} · 在导出面板选「片段拼接」</p>}
    </section>
  );
}
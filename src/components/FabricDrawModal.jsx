import React, { useEffect, useRef, useState } from 'react';
import { fabric } from 'fabric';

/* 橡皮笔刷：destination-out 擦除背景帧 */
class EraserBrush extends fabric.PencilBrush {
  constructor(canvas) {
    super(canvas);
    this.color = '#000000';
    this.width = 24;
  }
  _finalizeAndAddPath() {
    const ctx = this.canvas.contextTop;
    ctx.globalCompositeOperation = 'destination-out';
    this.callSuper('_finalizeAndAddPath');
    ctx.globalCompositeOperation = 'source-over';
    const objs = this.canvas.getObjects();
    const last = objs[objs.length - 1];
    if (last) last.globalCompositeOperation = 'destination-out';
  }
}

export default function FabricDrawModal({ videoEl, meta, curTime, onClose, onPublish }) {
  const canvasEl = useRef(null);
  const fabricCanvas = useRef(null);
  const [tool, setTool] = useState('brush');
  const [color, setColor] = useState('#ff4444');
  const [size, setSize] = useState(8);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);

  const vw = meta?.video?.width || 1280;
  const vh = meta?.video?.height || 720;
  const scale = Math.min(1, 900 / vw, 620 / vh);
  const cw = Math.round(vw * scale);
  const ch = Math.round(vh * scale);

  useEffect(() => {
    if (!canvasEl.current) return;
    const fc = new fabric.Canvas(canvasEl.current, {
      width: cw, height: ch, backgroundColor: '#000',
      selection: false, isDrawingMode: true, preserveObjectStacking: true,
    });
    fabricCanvas.current = fc;
    fc.freeDrawingBrush = new fabric.PencilBrush(fc);
    fc.freeDrawingBrush.color = color;
    fc.freeDrawingBrush.width = size;

    /* 背景 = 当前视频帧（本地文件，无跨域问题） */
    const v = videoEl;
    if (v) {
      try {
        const off = document.createElement('canvas');
        off.width = vw; off.height = vh;
        const ctx = off.getContext('2d');
        ctx.drawImage(v, 0, 0, vw, vh);
        const dataUrl = off.toDataURL('image/jpeg', 0.9);
        fabric.Image.fromURL(dataUrl, (img) => {
          img.set({ left: 0, top: 0, scaleX: cw / vw, scaleY: ch / vh, selectable: false, evented: false });
          fc.setBackgroundImage(img, fc.renderAll.bind(fc), { crossOrigin: 'anonymous' });
          fc.renderAll();
          setSaved(null);
          setTimeout(() => fc.renderAll(), 50);
        });
      } catch (e) { console.error(e); }
    }
    return () => fc.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyTool = (t) => {
    setTool(t);
    const fc = fabricCanvas.current;
    if (!fc) return;
    fc.isDrawingMode = t === 'brush' || t === 'eraser';
    fc.selection = t === 'select';
    fc.skipTargetFind = t !== 'select';
    if (t === 'brush') fc.freeDrawingBrush = new fabric.PencilBrush(fc);
    else if (t === 'eraser') fc.freeDrawingBrush = new EraserBrush(fc);
    fc.freeDrawingBrush.color = t === 'eraser' ? '#000000' : color;
    fc.freeDrawingBrush.width = size;
    if (t === 'select') fc.discardActiveObject();
    fc.renderAll();
  };

  useEffect(() => {
    const fc = fabricCanvas.current;
    if (!fc || !fc.freeDrawingBrush) return;
    fc.freeDrawingBrush.color = tool === 'eraser' ? '#000000' : color;
    fc.freeDrawingBrush.width = size;
  }, [color, size, tool]);

  useEffect(() => {
    const c = fabricCanvas.current;
    if (!c || !['rect', 'circle', 'line'].includes(tool)) return;
    let origin = null;
    let shape = null;
    const down = ({ e }) => {
      origin = c.getPointer(e);
      const options = { left: origin.x, top: origin.y, fill: 'rgba(255,68,68,0.35)', stroke: color, strokeWidth: 2, selectable: false, evented: false };
      if (tool === 'rect') shape = new fabric.Rect({ ...options, width: 1, height: 1 });
      else if (tool === 'circle') shape = new fabric.Ellipse({ ...options, rx: 1, ry: 1 });
      else shape = new fabric.Line([origin.x, origin.y, origin.x, origin.y], { stroke: color, strokeWidth: size, strokeLineCap: 'round', selectable: false, evented: false });
      c.add(shape);
    };
    const move = ({ e }) => {
      if (!shape || !origin) return;
      const point = c.getPointer(e);
      if (tool === 'line') shape.set({ x2: point.x, y2: point.y });
      else {
        const width = Math.abs(point.x - origin.x);
        const height = Math.abs(point.y - origin.y);
        shape.set({ left: Math.min(origin.x, point.x), top: Math.min(origin.y, point.y) });
        if (tool === 'rect') shape.set({ width, height });
        else shape.set({ rx: width / 2, ry: height / 2 });
      }
      c.requestRenderAll();
    };
    const up = () => {
      if (shape) {
        shape.set({ selectable: true, evented: true });
        shape.setCoords();
      }
      origin = null;
      shape = null;
    };
    c.on('mouse:down', down);
    c.on('mouse:move', move);
    c.on('mouse:up', up);
    return () => {
      up();
      c.off('mouse:down', down);
      c.off('mouse:move', move);
      c.off('mouse:up', up);
    };
  }, [tool, color, size]);

  const undo = () => {
    const c = fabricCanvas.current;
    const objs = c.getObjects();
    if (objs.length) { c.remove(objs[objs.length - 1]); c.renderAll(); }
    else if (c.backgroundImage) { c.setBackgroundImage(null); c.renderAll(); }
  };
  const clear = () => {
    const c = fabricCanvas.current;
    c.clear();
    c.backgroundColor = '#000';
    c.renderAll();
  };
  const publish = () => {
    const c = fabricCanvas.current;
    if (busy) return;
    setBusy(true);
    const dataUrl = c.toDataURL({ format: 'png', multiplier: vw / cw });
    setSaved(dataUrl);
    onPublish(dataUrl);
    setBusy(false);
  };

  return (
    <div className="modal-backdrop">
      <div className="paint-modal">
        <div className="paint-toolbar">
          {[
            ['brush', '✏️ 画笔'], ['eraser', '🧽 橡皮'], ['rect', '▭ 方框'],
            ['circle', '◯ 圆形'], ['line', '/ 直线'], ['select', '🖱 选择'],
          ].map(([t, label]) => (
            <button key={t} className={`btn small ${tool === t ? 'primary' : 'ghost'}`} onClick={() => applyTool(t)}>{label}</button>
          ))}
          <span className="paint-sep" />
          <label className="paint-field">颜色 <input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>
          <label className="paint-field">粗细 <input type="range" min={2} max={60} value={size} onChange={(e) => setSize(parseInt(e.target.value))} /></label>
          <span className="paint-sep" />
          <button className="btn small ghost" onClick={undo} title="撤销">↶ 撤销</button>
          <button className="btn small ghost" onClick={clear} title="清空">🗑 清空</button>
          <span className="spacer" />
          <span className="dim" style={{ fontSize: 12 }}>帧 @ {curTime.toFixed(1)}s · 仅本地视频帧</span>
          <button className="btn small ghost" onClick={onClose}>关闭</button>
          <button className="btn primary small" onClick={publish}>发布为叠加层 ➔</button>
        </div>
        <div className="paint-canvas-wrap">
          <canvas ref={canvasEl} />
        </div>
        <p className="dim center" style={{ fontSize: 11.5, margin: '6px 0 0' }}>
          在当前帧上自由绘制/标注，发布后成为可拖动的叠加图片层（由 ffmpeg 合成进视频）
        </p>
      </div>
    </div>
  );
}
import React, { useEffect, useRef, useCallback } from 'react';
import { Stage, Layer, Rect, Text, Image as KImage, Transformer } from 'react-konva';

/* 加载图片资源 Hook */
function useImage(src) {
  const [img, setImg] = React.useState(null);
  useEffect(() => {
    if (!src) return setImg(null);
    const im = new window.Image();
    im.onload = () => setImg(im);
    im.onerror = () => setImg(null);
    im.src = src;
  }, [src]);
  return img;
}

function ImageNode({ o, common, stageW, stageH, refCb, onCommit }) {
  const img = useImage(o.url || (o.asset ? `/api/assets/${encodeURIComponent(o.asset)}` : ''));
  if (!img) {
    return (
      <Rect ref={refCb} {...common} width={o.w * stageW} height={o.h * stageH} fill="#1c2430" stroke="#2dd4bf" dash={[4, 4]} listening={false} />
    );
  }
  return (
    <KImage
      ref={refCb} {...common} image={img}
      width={o.w * stageW} height={o.h * stageH}
      onDragEnd={(e) => onCommit(e.target)}
      onTransformEnd={(e) => onCommit(e.target)}
    />
  );
}

export default function OverlayStage({
  stageSize, overlays, onOverlaysChange, selectedId, onSelect, editing, currentTime,
}) {
  const { w: stageW, h: stageH } = stageSize;
  const trRef = useRef(null);
  const nodeRefs = useRef({});

  /* 选中项绑定 Transformer */
  useEffect(() => {
    const tr = trRef.current;
    const node = nodeRefs.current[selectedId];
    if (tr && node) {
      tr.nodes([node]);
      tr.getLayer().batchDraw();
    } else if (tr) {
      tr.nodes([]);
    }
  }, [selectedId, overlays.length, editing, stageW, stageH]);

  const visible = (o) => {
    if (o.start != null && currentTime < o.start) return false;
    if (o.end != null && currentTime > o.end) return false;
    return true;
  };

  const commit = useCallback((o, node) => {
    const next = {
      ...o,
      x: Math.round((node.x() / stageW) * 1000) / 1000,
      y: Math.round((node.y() / stageH) * 1000) / 1000,
      rotation: Math.round(node.rotation() * 10) / 10,
    };
    if (node.width && node.height) {
      next.w = Math.round((node.width() / stageW) * 1000) / 1000;
      next.h = Math.round((node.height() / stageH) * 1000) / 1000;
    }
    onOverlaysChange((prev) => prev.map((it) => (it.id === next.id ? next : it)));
  }, [stageW, stageH, onOverlaysChange]);

  return (
    <div className="konva-overlay" style={{ pointerEvents: editing ? 'auto' : 'none' }}>
      <Stage width={stageW} height={stageH} listening={editing}>
        <Layer>
          {overlays.map((o) => {
            const show = visible(o);
            const common = {
              x: o.x * stageW,
              y: o.y * stageH,
              rotation: o.rotation,
              opacity: (show ? 1 : 0.15) * (o.opacity ?? 1),
              draggable: editing && show,
              onClick: () => editing && onSelect(o.id),
              onTap: () => editing && onSelect(o.id),
            };
            if (o.type === 'text') {
              return (
                <Text
                  key={o.id}
                  ref={(n) => { nodeRefs.current[o.id] = n; }}
                  {...common}
                  text={o.text}
                  fontSize={Math.max(8, o.size * stageH)}
                  fill={o.color || '#ffffff'}
                  stroke={o.bold ? 'rgba(0,0,0,0.7)' : undefined}
                  strokeWidth={o.bold ? 2 : 0}
                  fillAfterStrokeEnabled={o.bold}
                  onDragEnd={(e) => commit(o, e.target)}
                  onTransformEnd={(e) => commit(o, e.target)}
                />
              );
            }
            return (
              <ImageNode key={o.id} o={o} common={common} stageW={stageW} stageH={stageH}
                refCb={(n) => { nodeRefs.current[o.id] = n; }}
                onCommit={(n) => commit(o, n)} />
            );
          })}
          {selectedId && (
            <Transformer
              ref={trRef}
              rotateEnabled={editing}
              enabledAnchors={editing ? ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right'] : []}
              keepRatio={false}
              boundBoxFunc={(oldBox, newBox) => (newBox.width > 8 && newBox.height > 8 ? newBox : oldBox)}
              borderStroke="#2dd4bf" anchorStroke="#2dd4bf" anchorFill="#10312c"
            />
          )}
        </Layer>
      </Stage>
    </div>
  );
}
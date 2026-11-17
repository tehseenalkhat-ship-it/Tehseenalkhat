import type { AnnotationPin, AnnotationStroke } from '../contracts';

/**
 * Annotation vectors are stored normalised 0..1 (x across the image width, y down the height).
 * Stroke `width` is in "per-mille of the image width": lineWidth(px) = width × imageWidth / 1000.
 * That keeps strokes the same visual weight on any resolution (thumbnail, flattened PNG, screen).
 */
export const PEN_COLOURS = [
  { value: '#d62828', label: 'Red' },
  { value: '#1d5fd1', label: 'Blue' },
  { value: '#1f8a4c', label: 'Green' },
  { value: '#1b1b1b', label: 'Black' },
] as const;
export const PEN_WIDTHS = [
  { value: 2.5, label: 'Fine' },
  { value: 5, label: 'Medium' },
  { value: 9, label: 'Bold' },
] as const;
export const HIGHLIGHT_FACTOR = 4;

export function lineWidthPx(width: number, w: number): number {
  return Math.max(1, (width * w) / 1000);
}

function polyline(ctx: CanvasRenderingContext2D, pts: [number, number][], w: number, h: number) {
  ctx.beginPath();
  if (pts.length === 1) {
    const [x, y] = pts[0];
    ctx.moveTo(x * w, y * h);
    ctx.lineTo(x * w + 0.01, y * h + 0.01);
    return;
  }
  ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
  for (let i = 1; i < pts.length - 1; i += 1) {
    const mx = ((pts[i][0] + pts[i + 1][0]) / 2) * w;
    const my = ((pts[i][1] + pts[i + 1][1]) / 2) * h;
    ctx.quadraticCurveTo(pts[i][0] * w, pts[i][1] * h, mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0] * w, last[1] * h);
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: AnnotationStroke, w: number, h: number) {
  if (!s.points.length || s.tool === 'eraser') return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = lineWidthPx(s.width, w);
  if (s.tool === 'highlighter') {
    ctx.globalAlpha = 0.34;
    ctx.globalCompositeOperation = 'multiply';
    ctx.lineCap = 'square';
  }
  if (s.tool === 'pen' || s.tool === 'highlighter') {
    polyline(ctx, s.points, w, h);
    ctx.stroke();
  } else if (s.tool === 'circle') {
    const [a, b] = [s.points[0], s.points[s.points.length - 1]];
    const cx = ((a[0] + b[0]) / 2) * w, cy = ((a[1] + b[1]) / 2) * h;
    const rx = Math.max(2, (Math.abs(b[0] - a[0]) * w) / 2), ry = Math.max(2, (Math.abs(b[1] - a[1]) * h) / 2);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.tool === 'arrow') {
    const [a, b] = [s.points[0], s.points[s.points.length - 1]];
    const ax = a[0] * w, ay = a[1] * h, bx = b[0] * w, by = b[1] * h;
    const ang = Math.atan2(by - ay, bx - ax);
    const head = Math.max(ctx.lineWidth * 3.2, 12);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx - Math.cos(ang) * head * 0.6, by - Math.sin(ang) * head * 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - head * Math.cos(ang - 0.45), by - head * Math.sin(ang - 0.45));
    ctx.lineTo(bx - head * Math.cos(ang + 0.45), by - head * Math.sin(ang + 0.45));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

export function pinRadiusPx(w: number, h: number): number {
  return Math.max(10, Math.min(w, h) * 0.022);
}

export function drawPin(ctx: CanvasRenderingContext2D, p: AnnotationPin, w: number, h: number) {
  const r = pinRadiusPx(w, h);
  const x = p.x * w, y = p.y * h;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.28)';
  ctx.shadowBlur = r * 0.35;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#d62828';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(2, r * 0.16);
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.round(r * 1.1)}px "DM Sans", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(p.n), x, y + r * 0.05);
  ctx.restore();
}

export function drawAll(ctx: CanvasRenderingContext2D, strokes: AnnotationStroke[], pins: AnnotationPin[], w: number, h: number) {
  for (const s of strokes) drawStroke(ctx, s, w, h);
  for (const p of pins) drawPin(ctx, p, w, h);
}

/** Distance (in normalised-width units, aspect corrected) from a point to a stroke. */
export function strokeDistance(s: AnnotationStroke, x: number, y: number, aspect: number): number {
  // aspect = h / w; scale y so distances are isotropic
  const pts: [number, number][] = s.tool === 'circle'
    ? (() => {
        const [a, b] = [s.points[0], s.points[s.points.length - 1]];
        const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
        return Array.from({ length: 33 }, (_, i) => [cx + rx * Math.cos((i / 32) * Math.PI * 2), cy + ry * Math.sin((i / 32) * Math.PI * 2)] as [number, number]);
      })()
    : s.tool === 'arrow' ? [s.points[0], s.points[s.points.length - 1]] : s.points;
  let best = Infinity;
  const py = y * aspect;
  for (let i = 0; i < pts.length; i += 1) {
    const [x1, y1r] = pts[i];
    const y1 = y1r * aspect;
    if (i === 0 && pts.length === 1) { best = Math.min(best, Math.hypot(x - x1, py - y1)); continue; }
    if (i === 0) continue;
    const [x0, y0r] = pts[i - 1];
    const y0 = y0r * aspect;
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (py - y0) * dy) / len2));
    best = Math.min(best, Math.hypot(x - (x0 + t * dx), py - (y0 + t * dy)));
  }
  return best;
}

/** Thins points that are closer than `minDist` (normalised) to keep payloads small. */
export function simplify(points: [number, number][], minDist = 0.0015): [number, number][] {
  if (points.length < 3) return points.map(([x, y]) => [round(x), round(y)]);
  const out: [number, number][] = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const [lx, ly] = out[out.length - 1];
    if (Math.hypot(points[i][0] - lx, points[i][1] - ly) >= minDist) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out.map(([x, y]) => [round(x), round(y)]);
}
function round(v: number): number { return Math.round(v * 10000) / 10000; }

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Pan + zoom maths for a "fitted" content box inside a viewport.
 * The content box is laid out centred at its fit size (w×h) at offset (ox, oy);
 * a transform `translate(x,y) scale(s)` (origin 0 0) is applied on top.
 * Transforms are written straight to the DOM (no React render per frame).
 */
export class PanZoom {
  s = 1; x = 0; y = 0;
  vw = 0; vh = 0; w = 0; h = 0; ox = 0; oy = 0;
  minS = 1; maxS = 6;
  private listeners = new Set<() => void>();
  constructor(private el: () => HTMLElement | null) {}

  layout(vw: number, vh: number, w: number, h: number) {
    this.vw = vw; this.vh = vh; this.w = w; this.h = h;
    this.ox = (vw - w) / 2; this.oy = (vh - h) / 2;
    this.clamp(); this.apply();
  }
  onChange(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  /** viewport point → content-box point in fit pixels */
  toContent(px: number, py: number): [number, number] {
    return [(px - this.ox - this.x) / this.s, (py - this.oy - this.y) / this.s];
  }
  zoomAt(factor: number, px: number, py: number) {
    const s = Math.min(this.maxS, Math.max(this.minS, this.s * factor));
    const [lx, ly] = this.toContent(px, py);
    this.s = s;
    this.x = px - this.ox - lx * s;
    this.y = py - this.oy - ly * s;
    this.clamp(); this.apply();
  }
  panBy(dx: number, dy: number) { this.x += dx; this.y += dy; this.clamp(); this.apply(); }
  reset() { this.s = 1; this.x = 0; this.y = 0; this.apply(); }

  // pinch
  private p0: { s: number; lx: number; ly: number; d: number } | null = null;
  pinchStart(a: [number, number], b: [number, number]) {
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const [lx, ly] = this.toContent(mx, my);
    this.p0 = { s: this.s, lx, ly, d: Math.max(10, Math.hypot(a[0] - b[0], a[1] - b[1])) };
  }
  pinchMove(a: [number, number], b: [number, number]) {
    if (!this.p0) return;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const d = Math.max(10, Math.hypot(a[0] - b[0], a[1] - b[1]));
    const s = Math.min(this.maxS, Math.max(this.minS * 0.85, this.p0.s * (d / this.p0.d)));
    this.s = s;
    this.x = mx - this.ox - this.p0.lx * s;
    this.y = my - this.oy - this.p0.ly * s;
    this.clamp(true); this.apply();
  }
  pinchEnd() {
    this.p0 = null;
    if (this.s < this.minS) this.s = this.minS;
    this.clamp(); this.apply();
  }

  private clamp(loose = false) {
    const fit = (size: number, view: number, off: number, t: number) => {
      const scaled = size * this.s;
      if (scaled <= view) return loose ? t : (size - scaled) / 2;
      const min = view - off - scaled, max = -off;
      const slack = loose ? 60 : 0;
      return Math.min(max + slack, Math.max(min - slack, t));
    };
    this.x = fit(this.w, this.vw, this.ox, this.x);
    this.y = fit(this.h, this.vh, this.oy, this.y);
  }
  apply() {
    const el = this.el();
    if (el) {
      el.style.transform = `translate3d(${this.ox + this.x}px, ${this.oy + this.y}px, 0) scale(${this.s})`;
      el.style.setProperty('--v2-zoom', String(this.s));
    }
    this.listeners.forEach(fn => fn());
  }
}

/** Fit a w×h box into vw×vh keeping aspect (contain). */
export function fitBox(vw: number, vh: number, w: number, h: number, pad = 0): { w: number; h: number } {
  if (!w || !h || vw <= 0 || vh <= 0) return { w: 0, h: 0 };
  const s = Math.min((vw - pad * 2) / w, (vh - pad * 2) / h);
  return { w: Math.max(1, Math.floor(w * s)), h: Math.max(1, Math.floor(h * s)) };
}

/**
 * Simple viewer gestures for a fitted element: pinch, drag-to-pan when zoomed,
 * double-tap / double-click to zoom, ctrl/⌘ + wheel to zoom.
 */
export function usePinchViewer(natural: { w: number; h: number } | null) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const pzRef = useRef<PanZoom | null>(null);
  if (!pzRef.current) pzRef.current = new PanZoom(() => layerRef.current);
  const pz = pzRef.current;
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [zoomed, setZoomed] = useState(false);
  const pointers = useRef(new Map<number, [number, number]>());
  const lastTap = useRef(0);
  const dragFrom = useRef<[number, number] | null>(null);

  useEffect(() => pz.onChange(() => setZoomed(pz.s > 1.02)), [pz]);

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || !natural) return;
    const update = () => {
      const r = vp.getBoundingClientRect();
      const b = fitBox(r.width, r.height, natural.w, natural.h, 8);
      setBox(b);
      pz.layout(r.width, r.height, b.w, b.h);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(vp);
    return () => ro.disconnect();
  }, [natural, pz]);

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = viewportRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    if (e.isPrimary) pointers.current.clear();
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pz.pinchStart(a, b);
      dragFrom.current = null;
    } else if (pointers.current.size === 1) {
      dragFrom.current = local(e);
      const now = Date.now();
      if (now - lastTap.current < 280) {
        const [px, py] = local(e);
        if (pz.s > 1.05) pz.reset(); else pz.zoomAt(2.5, px, py);
        lastTap.current = 0;
      } else lastTap.current = now;
    }
  }, [pz]);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      pz.pinchMove(a, b);
    } else if (dragFrom.current && pz.s > 1.02) {
      pz.panBy(p[0] - dragFrom.current[0], p[1] - dragFrom.current[1]);
      dragFrom.current = p;
    }
  }, [pz]);
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pz.pinchEnd();
    if (pointers.current.size === 1) dragFrom.current = [...pointers.current.values()][0];
    if (!pointers.current.size) dragFrom.current = null;
  }, [pz]);

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const wheel = (e: WheelEvent) => {
      const r = vp.getBoundingClientRect();
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) pz.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else if (pz.s > 1.02) pz.panBy(-e.deltaX, -e.deltaY);
      else pz.zoomAt(Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top);
    };
    vp.addEventListener('wheel', wheel, { passive: false });
    return () => vp.removeEventListener('wheel', wheel);
  }, [pz]);

  return {
    viewportRef, layerRef, box, pz, zoomed,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onLostPointerCapture: onPointerUp },
    zoomIn: () => pz.zoomAt(1.5, pz.vw / 2, pz.vh / 2),
    zoomOut: () => pz.zoomAt(1 / 1.5, pz.vw / 2, pz.vh / 2),
    reset: () => pz.reset(),
  };
}

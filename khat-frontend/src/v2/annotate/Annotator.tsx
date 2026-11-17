import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Circle, Eraser, Hand, Highlighter, Loader2, Maximize2, MessageSquarePlus, Minus, PenLine, Plus, Redo2, Save, Undo2 } from 'lucide-react';
import { apiFetch, uploadFile } from '@/api';
import type { Annotation, AnnotationPin, AnnotationStroke, Attachment } from '../contracts';
import { isImage, isPdf, safeName } from '../chat/media';
import { canvasToBlob } from '../chat/pdf';
import { PanZoom, fitBox } from './panzoom';
import { HIGHLIGHT_FACTOR, PEN_COLOURS, PEN_WIDTHS, drawAll, drawStroke, lineWidthPx, simplify, strokeDistance } from './draw';
import { loadPageBitmap, pageKey, pdfPageCount, type PageBitmap } from './pages';
import { PinEditor } from './PinEditor';
import './annotate.css';

export type AnnotatorTool = 'pen' | 'highlighter' | 'circle' | 'arrow' | 'eraser' | 'move';
export type AnnotatorHandle = {
  /** Saves every changed page (flattened image + vectors). Resolves with the saved annotations. */
  save: () => Promise<Annotation[]>;
  isDirty: () => boolean;
  /** Export mode: flattens every drawn page (or the page on screen) into JPEG files, nothing is saved. */
  exportFiles: () => Promise<File[]>;
};
export type AnnotatorProps = {
  submissionId: string;
  files: Attachment[];
  annotations?: Annotation[];
  /** Label for a file tab, e.g. "S01 worksheet". */
  fileLabel?: (file: Attachment, index: number) => string;
  /** Rendered on top of the photo, bottom edge (e.g. the quick marks bar). */
  overlay?: ReactNode;
  /** Hide the Save button (the parent saves through the ref, e.g. before sending a mark). */
  hideSave?: boolean;
  onSaved?: (saved: Annotation[]) => void;
  onDirtyChange?: (dirty: boolean) => void;
  className?: string;
  /** Open on this file first (e.g. the photo the teacher tapped in the chat). */
  startStorageKey?: string | null;
  /** Draw-and-send mode for photos that are not part of a submission: no saving, no numbered notes. */
  exportOnly?: boolean;
};

type Snapshot = { strokes: AnnotationStroke[]; pins: AnnotationPin[] };
type PageState = Snapshot & { past: Snapshot[]; future: Snapshot[]; dirty: boolean };
type Active = { tool: AnnotatorTool; pointerId: number; points: [number, number][]; startLocal: [number, number]; erased: boolean };

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE = 10;

const TOOLS: { id: AnnotatorTool; label: string; icon: typeof PenLine; key: string }[] = [
  { id: 'pen', label: 'Pen', icon: PenLine, key: 'p' },
  { id: 'highlighter', label: 'Highlighter', icon: Highlighter, key: 'h' },
  { id: 'circle', label: 'Circle', icon: Circle, key: 'c' },
  { id: 'arrow', label: 'Arrow', icon: ArrowUpRight, key: 'a' },
  { id: 'eraser', label: 'Eraser', icon: Eraser, key: 'e' },
  { id: 'move', label: 'Move', icon: Hand, key: 'm' },
];

export const Annotator = forwardRef<AnnotatorHandle, AnnotatorProps>(function Annotator(
  { submissionId, files, annotations = [], fileLabel, overlay, hideSave = false, onSaved, onDirtyChange, className = '', startStorageKey = null, exportOnly = false },
  ref,
) {
  const usable = useMemo(() => files.filter(f => isImage(f) || isPdf(f)), [files]);
  const [fileIdx, setFileIdx] = useState(() => Math.max(0, startStorageKey ? usable.findIndex(f => f.storageKey === startStorageKey) : 0));
  const [pageIdx, setPageIdx] = useState(0);
  const [pageCounts, setPageCounts] = useState<Record<string, number>>({});
  const [bitmap, setBitmap] = useState<PageBitmap | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [tool, setTool] = useState<AnnotatorTool>('pen');
  const [color, setColor] = useState<string>(PEN_COLOURS[0].value);
  const [width, setWidth] = useState<number>(PEN_WIDTHS[1].value);
  const [penSeen, setPenSeen] = useState(false);
  const [editingPin, setEditingPin] = useState<number | null>(null);
  const [rev, setRev] = useState(0);
  const [zoomPct, setZoomPct] = useState(100);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const inkRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const pzRef = useRef<PanZoom | null>(null);
  if (!pzRef.current) pzRef.current = new PanZoom(() => layerRef.current);
  const pz = pzRef.current;
  const pagesRef = useRef(new Map<string, PageState>());
  const pointers = useRef(new Map<number, { p: [number, number]; type: string }>());
  const activeRef = useRef<Active | null>(null);
  const panFrom = useRef<[number, number] | null>(null);
  const pinching = useRef(false);
  const longPress = useRef<number | null>(null);
  const raf = useRef<number | null>(null);
  const penSeenRef = useRef(false);
  const pinUploads = useRef(new Set<Promise<unknown>>());

  const file = usable[Math.min(fileIdx, Math.max(0, usable.length - 1))] ?? null;
  const key = file ? pageKey(file.storageKey, pageIdx) : '';
  const pageCount = file ? pageCounts[file.storageKey] ?? 1 : 1;

  // Seed page states from existing annotations (once per annotation id/updatedAt).
  const seededRef = useRef(new Set<string>());
  useEffect(() => {
    for (const a of annotations) {
      const k = pageKey(a.fileStorageKey, a.pageIndex);
      const tag = `${a.id}:${a.updatedAt}`;
      if (seededRef.current.has(tag)) continue;
      const existing = pagesRef.current.get(k);
      if (existing?.dirty) continue;
      seededRef.current.add(tag);
      pagesRef.current.set(k, { strokes: a.strokes ?? [], pins: a.pins ?? [], past: [], future: [], dirty: false });
    }
    setRev(r => r + 1);
  }, [annotations]);

  const page = (k = key): PageState => {
    let st = pagesRef.current.get(k);
    if (!st) { st = { strokes: [], pins: [], past: [], future: [], dirty: false }; pagesRef.current.set(k, st); }
    return st;
  };
  const anyDirty = () => [...pagesRef.current.values()].some(p => p.dirty);
  const lastDirty = useRef(false);
  const touch = () => {
    setRev(r => r + 1);
    const d = anyDirty();
    if (d !== lastDirty.current) { lastDirty.current = d; onDirtyChange?.(d); }
  };

  // Page counts for PDFs
  useEffect(() => {
    let alive = true;
    for (const f of usable) {
      if (!isPdf(f) || pageCounts[f.storageKey]) continue;
      pdfPageCount(f).then(n => { if (alive) setPageCounts(c => ({ ...c, [f.storageKey]: n })); }).catch(() => undefined);
    }
    return () => { alive = false; };
  }, [usable, pageCounts]);

  // Load bitmap for the current page
  useEffect(() => {
    if (!file) return;
    let alive = true;
    setBitmap(null);
    setLoadError(null);
    setEditingPin(null);
    loadPageBitmap(file, pageIdx)
      .then(b => { if (alive) setBitmap(b); })
      .catch(() => { if (alive) setLoadError('This page could not be opened. Check your connection and try again.'); });
    return () => { alive = false; };
  }, [file, pageIdx]);

  // Layout: fit the page into the viewport
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || !bitmap) return;
    const update = () => {
      const r = vp.getBoundingClientRect();
      const b = fitBox(r.width, r.height, bitmap.w, bitmap.h, 10);
      setBox(prev => (prev.w === b.w && prev.h === b.h ? prev : b));
      pz.layout(r.width, r.height, b.w, b.h);
    };
    pz.reset();
    update();
    const ro = new ResizeObserver(update);
    ro.observe(vp);
    return () => ro.disconnect();
  }, [bitmap, pz]);

  useEffect(() => pz.onChange(() => setZoomPct(Math.round(pz.s * 100))), [pz]);

  // Paint base + ink when the page or its strokes change
  useEffect(() => {
    if (!bitmap) return;
    for (const c of [baseRef.current, inkRef.current, liveRef.current]) {
      if (c && (c.width !== bitmap.w || c.height !== bitmap.h)) { c.width = bitmap.w; c.height = bitmap.h; }
    }
    const base = baseRef.current?.getContext('2d');
    if (base) { base.clearRect(0, 0, bitmap.w, bitmap.h); base.drawImage(bitmap.canvas, 0, 0); }
  }, [bitmap]);

  const redrawInk = useCallback(() => {
    const c = inkRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || !bitmap) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const st = pagesRef.current.get(key);
    if (st) drawAll(ctx, st.strokes, [], c.width, c.height);
  }, [bitmap, key]);
  useEffect(() => { redrawInk(); }, [redrawInk, rev]);

  /* ---------- history ---------- */
  const commit = (mutate: (s: Snapshot) => Snapshot) => {
    const st = page();
    st.past.push({ strokes: st.strokes, pins: st.pins });
    if (st.past.length > 80) st.past.shift();
    st.future = [];
    const next = mutate({ strokes: st.strokes, pins: st.pins });
    st.strokes = next.strokes; st.pins = next.pins; st.dirty = true;
    touch();
  };
  const undo = () => {
    const st = page();
    const prev = st.past.pop();
    if (!prev) return;
    st.future.push({ strokes: st.strokes, pins: st.pins });
    st.strokes = prev.strokes; st.pins = prev.pins; st.dirty = true;
    setEditingPin(null);
    touch();
  };
  const redo = () => {
    const st = page();
    const next = st.future.pop();
    if (!next) return;
    st.past.push({ strokes: st.strokes, pins: st.pins });
    st.strokes = next.strokes; st.pins = next.pins; st.dirty = true;
    touch();
  };

  /* ---------- pins ---------- */
  const addPin = (nx: number, ny: number) => {
    if (exportOnly) return;
    const st = page();
    const n = st.pins.reduce((m, p) => Math.max(m, p.n), 0) + 1;
    commit(s => ({ ...s, pins: [...s.pins, { n, x: round4(nx), y: round4(ny), text: null, voiceStorageKey: null, durationSec: null }] }));
    setEditingPin(n);
    if (navigator.vibrate) navigator.vibrate(15);
  };
  const updatePin = (n: number, patch: Partial<AnnotationPin>) => {
    const st = page();
    st.pins = st.pins.map(p => (p.n === n ? { ...p, ...patch } : p));
    st.dirty = true;
    touch();
  };
  const deletePin = (n: number) => {
    commit(s => ({ ...s, pins: s.pins.filter(p => p.n !== n) }));
    setEditingPin(null);
  };

  /* ---------- pointer handling ---------- */
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = viewportRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const norm = (p: [number, number]): [number, number] => {
    const [cx, cy] = pz.toContent(p[0], p[1]);
    return [clamp01(cx / Math.max(1, box.w)), clamp01(cy / Math.max(1, box.h))];
  };
  const clearLongPress = () => { if (longPress.current) { window.clearTimeout(longPress.current); longPress.current = null; } };
  const clearLive = () => {
    const c = liveRef.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
  };
  const paintLive = () => {
    raf.current = null;
    const a = activeRef.current;
    const c = liveRef.current;
    const ctx = c?.getContext('2d');
    if (!a || !c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (a.tool === 'eraser' || a.tool === 'move') return;
    drawStroke(ctx, toStroke(a), c.width, c.height);
  };
  const toStroke = (a: Active): AnnotationStroke => ({
    tool: a.tool as AnnotationStroke['tool'],
    color,
    width: a.tool === 'highlighter' ? width * HIGHLIGHT_FACTOR : width,
    points: a.tool === 'circle' || a.tool === 'arrow' ? [a.points[0], a.points[a.points.length - 1]] : a.points,
  });
  const eraseAt = (p: [number, number]) => {
    const a = activeRef.current;
    if (!bitmap || !a) return;
    const st = page();
    const radius = 14 / Math.max(1, box.w * pz.s);
    const aspect = bitmap.h / bitmap.w;
    const keep = st.strokes.filter(s => strokeDistance(s, p[0], p[1], aspect) > radius + lineWidthPx(s.width, 1) / 2);
    if (keep.length === st.strokes.length) return;
    if (!a.erased) { a.erased = true; commit(s => ({ ...s, strokes: keep })); }
    else { st.strokes = keep; touch(); }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!bitmap) return;
    if ((e.target as HTMLElement).closest('.v2-ann-overlay, .v2-ann-zoom')) return;
    // A finger on a pin is a pin tap — unless another finger is already down (then it is a pinch).
    if ((e.target as HTMLElement).closest('.v2-ann-pin') && !(e.pointerType === 'touch' && pointers.current.size > 0)) return;
    const p = local(e);
    if (e.pointerType === 'mouse' && e.button === 2) { e.preventDefault(); addPin(...norm(p)); return; }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'pen' && !penSeenRef.current) { penSeenRef.current = true; setPenSeen(true); }
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    // A new primary pointer means nothing else is down: drop any entry whose "up" we never saw.
    if (e.isPrimary) { pointers.current.clear(); pinching.current = false; }
    pointers.current.set(e.pointerId, { p, type: e.pointerType });
    setEditingPin(null);

    const touches = [...pointers.current.values()].filter(v => v.type === 'touch');
    if (e.pointerType === 'touch' && touches.length >= 2) {
      // Second finger: this is a pinch/pan, not drawing. Drop the stroke the first finger started.
      clearLongPress();
      if (activeRef.current) { activeRef.current = null; clearLive(); }
      pinching.current = true;
      panFrom.current = null;
      pz.pinchStart(touches[0].p, touches[1].p);
      return;
    }
    if (pointers.current.size > 1) return;
    const palm = e.pointerType === 'touch' && penSeenRef.current; // Pencil in use → fingers only move the page
    if (tool === 'move' || palm) { panFrom.current = p; startLongPress(p); return; }
    const n = norm(p);
    activeRef.current = { tool, pointerId: e.pointerId, points: [n], startLocal: p, erased: false };
    if (tool === 'eraser') eraseAt(n);
    else if (raf.current == null) raf.current = requestAnimationFrame(paintLive);
    startLongPress(p);
  };
  const startLongPress = (p: [number, number]) => {
    clearLongPress();
    longPress.current = window.setTimeout(() => {
      longPress.current = null;
      if (pointers.current.size !== 1 || pinching.current) return;
      const a = activeRef.current;
      if (a && a.erased) return;
      activeRef.current = null;
      panFrom.current = null;
      clearLive();
      addPin(...norm(p));
    }, LONG_PRESS_MS);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const entry = pointers.current.get(e.pointerId);
    if (!entry) return;
    const p = local(e);
    entry.p = p;
    if (pinching.current) {
      const touches = [...pointers.current.values()].filter(v => v.type === 'touch');
      if (touches.length >= 2) pz.pinchMove(touches[0].p, touches[1].p);
      return;
    }
    if (panFrom.current) {
      if (Math.hypot(p[0] - panFrom.current[0], p[1] - panFrom.current[1]) > MOVE_TOLERANCE) clearLongPress();
      if (!longPress.current) { pz.panBy(p[0] - panFrom.current[0], p[1] - panFrom.current[1]); panFrom.current = p; }
      return;
    }
    const a = activeRef.current;
    if (!a || a.pointerId !== e.pointerId) return;
    if (longPress.current && Math.hypot(p[0] - a.startLocal[0], p[1] - a.startLocal[1]) > MOVE_TOLERANCE) clearLongPress();
    const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
    const list = events.length ? events.map(ev => norm(local(ev))) : [norm(p)];
    if (a.tool === 'eraser') { list.forEach(eraseAt); return; }
    if (a.tool === 'circle' || a.tool === 'arrow') a.points = [a.points[0], list[list.length - 1]];
    else a.points.push(...list);
    if (raf.current == null) raf.current = requestAnimationFrame(paintLive);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    clearLongPress();
    if (pinching.current) {
      if ([...pointers.current.values()].filter(v => v.type === 'touch').length < 2) {
        pz.pinchEnd();
        if (!pointers.current.size) pinching.current = false;
      }
      return;
    }
    panFrom.current = null;
    const a = activeRef.current;
    if (!a || a.pointerId !== e.pointerId) return;
    activeRef.current = null;
    if (raf.current != null) { cancelAnimationFrame(raf.current); raf.current = null; }
    clearLive();
    if (a.tool === 'eraser' || a.tool === 'move') return;
    const s = toStroke(a);
    if (s.tool === 'circle' || s.tool === 'arrow') {
      const [p0, p1] = s.points;
      if (!p1 || Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 0.008) return;
    }
    s.points = simplify(s.points);
    commit(snap => ({ ...snap, strokes: [...snap.strokes, s] }));
  };

  // Wheel: ctrl/⌘ + wheel (trackpad pinch) zooms; plain wheel pans when zoomed in.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const wheel = (e: WheelEvent) => {
      const r = vp.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); pz.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top); }
      else if (pz.s > 1.02) { e.preventDefault(); pz.panBy(-e.deltaX, -e.deltaY); }
    };
    vp.addEventListener('wheel', wheel, { passive: false });
    return () => vp.removeEventListener('wheel', wheel);
  }, [pz]);

  // Keyboard: ⌘Z / ⇧⌘Z, tool letters. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t2 = TOOLS.find(x => x.key === e.key.toLowerCase());
      if (t2) setTool(t2.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /* ---------- save ---------- */
  const save = useCallback(async (): Promise<Annotation[]> => {
    const dirty = [...pagesRef.current.entries()].filter(([, st]) => st.dirty);
    if (!dirty.length) return [];
    setSaving(true);
    setSaveError(null);
    try {
      if (pinUploads.current.size) await Promise.allSettled([...pinUploads.current]);
      const saved: Annotation[] = [];
      for (const [k, st] of dirty) {
        const hash = k.lastIndexOf('#');
        const storageKey = k.slice(0, hash);
        const pageIndex = Number(k.slice(hash + 1));
        const att = usable.find(f => f.storageKey === storageKey);
        if (!att) continue;
        const bmp = await loadPageBitmap(att, pageIndex);
        const flat = document.createElement('canvas');
        flat.width = bmp.w; flat.height = bmp.h;
        const ctx = flat.getContext('2d');
        if (!ctx) throw new Error('Canvas is not available.');
        ctx.drawImage(bmp.canvas, 0, 0);
        drawAll(ctx, st.strokes, st.pins, bmp.w, bmp.h);
        const blob = await canvasToBlob(flat, 'image/jpeg', 0.9);
        const base = safeName(att.originalFilename.replace(/\.[^.]+$/, ''));
        const up = await uploadFile('annotations', new File([blob], `${base}-annotated-p${pageIndex + 1}.jpg`, { type: 'image/jpeg' }));
        const ann = await apiFetch<Annotation>('/v2/annotations', {
          method: 'PUT',
          body: { submissionId, fileStorageKey: storageKey, pageIndex, strokes: st.strokes, pins: st.pins, flattenedStorageKey: up.storageKey },
        });
        st.dirty = false;
        if (ann?.id) seededRef.current.add(`${ann.id}:${ann.updatedAt}`);
        saved.push(ann);
      }
      touch();
      onSaved?.(saved);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1800);
      return saved;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save the drawing.';
      setSaveError(message);
      throw err;
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissionId, usable, onSaved]);

  const exportFiles = useCallback(async (): Promise<File[]> => {
    let entries = [...pagesRef.current.entries()].filter(([, st]) => st.dirty || st.strokes.length > 0);
    if (!entries.length && key) entries = [[key, page(key)]];
    const out: File[] = [];
    for (const [k, st] of entries) {
      const hash = k.lastIndexOf('#');
      const storageKey = k.slice(0, hash);
      const pageIndex = Number(k.slice(hash + 1));
      const att = usable.find(f => f.storageKey === storageKey);
      if (!att) continue;
      const bmp = await loadPageBitmap(att, pageIndex);
      const flat = document.createElement('canvas');
      flat.width = bmp.w; flat.height = bmp.h;
      const ctx = flat.getContext('2d');
      if (!ctx) throw new Error('Canvas is not available.');
      ctx.drawImage(bmp.canvas, 0, 0);
      drawAll(ctx, st.strokes, st.pins, bmp.w, bmp.h);
      const blob = await canvasToBlob(flat, 'image/jpeg', 0.9);
      const base = safeName(att.originalFilename.replace(/\.[^.]+$/, ''));
      out.push(new File([blob], `${base}-marked-p${pageIndex + 1}.jpg`, { type: 'image/jpeg' }));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usable, key]);

  useImperativeHandle(ref, () => ({ save, isDirty: anyDirty, exportFiles }), [save, exportFiles]);

  /* ---------- render ---------- */
  const st = pagesRef.current.get(key);
  const pins = st?.pins ?? [];
  const canUndo = !!st?.past.length;
  const canRedo = !!st?.future.length;
  const editing = editingPin != null ? pins.find(p => p.n === editingPin) ?? null : null;
  const dirtyCount = [...pagesRef.current.values()].filter(p => p.dirty).length;
  void rev;

  if (!usable.length) {
    return <div className={`v2-ann is-empty ${className}`}><p className="muted">There is no photo or PDF in this submission to mark.</p></div>;
  }

  const pageTabs: { fi: number; pi: number; label: string }[] = [];
  usable.forEach((f, fi) => {
    const count = pageCounts[f.storageKey] ?? 1;
    for (let pi = 0; pi < count; pi += 1) {
      const base = fileLabel ? fileLabel(f, fi) : `File ${fi + 1}`;
      pageTabs.push({ fi, pi, label: count > 1 ? `${base} · p${pi + 1}` : base });
    }
  });

  return (
    <section className={`v2-ann ${className}`} aria-label="Mark the student's sheet">
      <div className="v2-ann-toolbar" role="toolbar" aria-label="Marking tools">
        <div className="v2-ann-group">
          {TOOLS.map(t => (
            <button key={t.id} type="button" className={`v2-ann-tool${tool === t.id ? ' is-active' : ''}`} aria-pressed={tool === t.id} onClick={() => setTool(t.id)} title={`${t.label} (${t.key.toUpperCase()})`}>
              <t.icon size={18} /><span>{t.label}</span>
            </button>
          ))}
        </div>
        <div className="v2-ann-group" aria-label="Colour">
          {PEN_COLOURS.map(c => (
            <button key={c.value} type="button" className={`v2-ann-swatch${color === c.value ? ' is-active' : ''}`} style={{ '--swatch': c.value } as React.CSSProperties} aria-label={`${c.label} ink`} aria-pressed={color === c.value} onClick={() => { setColor(c.value); if (tool === 'eraser' || tool === 'move') setTool('pen'); }} />
          ))}
        </div>
        <div className="v2-ann-group" aria-label="Line width">
          {PEN_WIDTHS.map(w => (
            <button key={w.value} type="button" className={`v2-ann-width${width === w.value ? ' is-active' : ''}`} aria-label={`${w.label} line`} aria-pressed={width === w.value} onClick={() => setWidth(w.value)}>
              <i style={{ width: 4 + w.value * 1.4, height: 4 + w.value * 1.4, background: color }} />
            </button>
          ))}
        </div>
        <div className="v2-ann-group">
          <button type="button" className="v2-ann-icon" onClick={undo} disabled={!canUndo} aria-label="Undo" title="Undo (⌘Z)"><Undo2 size={18} /></button>
          <button type="button" className="v2-ann-icon" onClick={redo} disabled={!canRedo} aria-label="Redo" title="Redo (⇧⌘Z)"><Redo2 size={18} /></button>
        </div>
        {!hideSave && !exportOnly && (
          <button type="button" className="btn btn-primary v2-ann-save" onClick={() => void save().catch(() => undefined)} disabled={saving || !dirtyCount}>
            {saving ? <Loader2 size={15} className="v2-spin" /> : <Save size={15} />} {saving ? 'Saving…' : savedFlash ? 'Saved' : 'Save drawing'}
          </button>
        )}
      </div>

      {pageTabs.length > 1 && (
        <div className="v2-ann-pages" role="tablist" aria-label="Pages of this submission">
          {pageTabs.map(t => {
            const k = pageKey(usable[t.fi].storageKey, t.pi);
            const ps = pagesRef.current.get(k);
            const marked = !!ps && (ps.strokes.length > 0 || ps.pins.length > 0);
            const active = t.fi === fileIdx && t.pi === pageIdx;
            return (
              <button key={k} type="button" role="tab" aria-selected={active} className={`v2-ann-page${active ? ' is-active' : ''}`} onClick={() => { setFileIdx(t.fi); setPageIdx(t.pi); }}>
                {marked && <i className="v2-ann-page-dot" aria-label="has drawing" />}{t.label}
              </button>
            );
          })}
        </div>
      )}

      <div
        className={`v2-ann-stage tool-${tool}${penSeen ? ' pen-mode' : ''}`}
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
        onContextMenu={e => e.preventDefault()}
        data-testid="annotator-stage"
      >
        {!bitmap && <div className="v2-ann-loading">{loadError ?? <><Loader2 size={20} className="v2-spin" /> Opening the sheet…</>}</div>}
        <div className="v2-ann-layer" ref={layerRef} style={{ width: box.w, height: box.h, visibility: bitmap ? 'visible' : 'hidden' }}>
          <canvas ref={baseRef} className="v2-ann-canvas" aria-hidden="true" />
          <canvas ref={inkRef} className="v2-ann-canvas" aria-hidden="true" />
          <canvas ref={liveRef} className="v2-ann-canvas" aria-hidden="true" />
          {pins.map(p => (
            <button
              key={p.n}
              type="button"
              className={`v2-ann-pin${editingPin === p.n ? ' is-editing' : ''}${p.voiceStorageKey ? ' has-voice' : ''}`}
              style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
              onClick={() => { if (!pinching.current) setEditingPin(p.n); }}
              aria-label={`Note ${p.n}${p.text ? `: ${p.text}` : ''}${p.voiceStorageKey ? ' (voice)' : ''}`}
            >{p.n}</button>
          ))}
        </div>
        <div className="v2-ann-zoom" role="group" aria-label="Zoom">
          <button type="button" onClick={() => pz.zoomAt(1 / 1.4, pz.vw / 2, pz.vh / 2)} aria-label="Zoom out"><Minus size={16} /></button>
          <span>{zoomPct}%</span>
          <button type="button" onClick={() => pz.zoomAt(1.4, pz.vw / 2, pz.vh / 2)} aria-label="Zoom in"><Plus size={16} /></button>
          <button type="button" onClick={() => pz.reset()} aria-label="Fit to screen"><Maximize2 size={15} /></button>
        </div>
        {overlay && <div className="v2-ann-overlay">{overlay}</div>}
      </div>

      {editing ? (
        <PinEditor
          key={`${key}-${editing.n}`}
          pin={editing}
          onChange={patch => updatePin(editing.n, patch)}
          onDelete={() => deletePin(editing.n)}
          onClose={() => setEditingPin(null)}
          trackUpload={pr => { pinUploads.current.add(pr); void pr.finally(() => pinUploads.current.delete(pr)); }}
        />
      ) : (
        <p className="v2-ann-hint">
          <MessageSquarePlus size={14} />
          <span>{exportOnly ? <>Draw on the photo, then press <b>Send</b>.</> : <><b>Hold a spot</b> (or right-click) to add a numbered note with your voice or text.</>}{penSeen ? ' Pencil mode: fingers move the page, Pencil draws.' : ' Two fingers zoom and move.'}</span>
          {saveError && <span className="v2-ann-error" role="alert">{saveError}</span>}
          {!saveError && dirtyCount > 0 && hideSave && !exportOnly && <span className="v2-ann-unsaved">Your drawing will be sent with your review</span>}
        </p>
      )}
    </section>
  );
});

function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }
function round4(v: number): number { return Math.round(v * 10000) / 10000; }

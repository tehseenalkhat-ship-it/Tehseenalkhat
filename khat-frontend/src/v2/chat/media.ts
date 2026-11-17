import { useEffect, useState } from 'react';
import { API_BASE_URL, getFileObjectUrl, getToken, getViewUrl } from '@/api';
import type { Attachment, MarkBand } from '../contracts';
import './base.css';

/* ---------------- file kinds ---------------- */
export function isImage(a: Pick<Attachment, 'contentType' | 'originalFilename'>): boolean {
  return (a.contentType ?? '').startsWith('image/') || /\.(jpe?g|png|webp|gif|heic)$/i.test(a.originalFilename ?? '');
}
export function isPdf(a: Pick<Attachment, 'contentType' | 'originalFilename'>): boolean {
  return (a.contentType ?? '').includes('pdf') || /\.pdf$/i.test(a.originalFilename ?? '');
}
export function isAudio(a: Pick<Attachment, 'contentType' | 'originalFilename'>): boolean {
  return (a.contentType ?? '').startsWith('audio/') || /\.(webm|m4a|mp3|ogg|wav|aac)$/i.test(a.originalFilename ?? '');
}
export function extOf(name: string, contentType?: string | null): string {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name);
  if (m) return m[1].toLowerCase();
  if (contentType?.includes('pdf')) return 'pdf';
  if (contentType?.includes('png')) return 'png';
  if (contentType?.includes('webm')) return 'webm';
  return 'jpg';
}

/* ---------------- URL caches ----------------
 * View URLs (signed, for <img>/<audio>) are cached ~40 minutes.
 * Object URLs (blob: via the backend, safe for <canvas> and pdf.js) are kept in a small LRU. */
const viewCache = new Map<string, { at: number; promise: Promise<string> }>();
export function viewUrl(storageKey: string): Promise<string> {
  const hit = viewCache.get(storageKey);
  if (hit && Date.now() - hit.at < 40 * 60_000) return hit.promise;
  const promise = getViewUrl(storageKey);
  viewCache.set(storageKey, { at: Date.now(), promise });
  promise.catch(() => viewCache.delete(storageKey));
  return promise;
}

const objectCache = new Map<string, Promise<string>>();
export function objectUrl(storageKey: string): Promise<string> {
  const hit = objectCache.get(storageKey);
  if (hit) {
    objectCache.delete(storageKey);
    objectCache.set(storageKey, hit);
    return hit;
  }
  const promise = getFileObjectUrl(storageKey).catch(async () => {
    // Fallback: signed URL fetched into a blob (works when storage allows CORS).
    const url = await viewUrl(storageKey);
    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not load this file.');
    return URL.createObjectURL(await res.blob());
  });
  objectCache.set(storageKey, promise);
  promise.catch(() => objectCache.delete(storageKey));
  while (objectCache.size > 48) {
    const oldestKey = objectCache.keys().next().value as string;
    const oldest = objectCache.get(oldestKey);
    objectCache.delete(oldestKey);
    void oldest?.then(u => URL.revokeObjectURL(u)).catch(() => undefined);
  }
  return promise;
}

export async function fileBlob(storageKey: string): Promise<Blob> {
  const url = await objectUrl(storageKey);
  const res = await fetch(url);
  return res.blob();
}

/** Resolves a storage key to a URL. `canvasSafe` uses a same-origin blob URL. */
export function useFileUrl(storageKey: string | null | undefined, canvasSafe = false): { url: string | null; error: boolean } {
  const [state, setState] = useState<{ url: string | null; error: boolean }>({ url: null, error: false });
  useEffect(() => {
    if (!storageKey) { setState({ url: null, error: false }); return; }
    let alive = true;
    setState({ url: null, error: false });
    (canvasSafe ? objectUrl(storageKey) : viewUrl(storageKey))
      .then(url => { if (alive) setState({ url, error: false }); })
      .catch(() => { if (alive) setState({ url: null, error: true }); });
    return () => { alive = false; };
  }, [storageKey, canvasSafe]);
  return state;
}

/** POST that returns a binary body (e.g. the print pack PDF). */
export async function apiFetchBlob(path: string, body: unknown): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? 'Something went wrong. Please try again.');
  }
  return res.blob();
}

/* ---------------- formatting ---------------- */
export function timeLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
export function duration(sec: number | null | undefined): string {
  const s = Math.max(0, Math.round(sec ?? 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map(p => p[0]).slice(0, 2).join('').toUpperCase() || '?';
}
export function waitingLabel(hours: number): string {
  if (hours < 1) return 'just now';
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.floor(hours / 24)} days`;
}
export function waitTone(hours: number): 'ok' | 'soon' | 'late' | 'over' {
  if (hours < 24) return 'ok';
  if (hours < 48) return 'soon';
  if (hours < 72) return 'late';
  return 'over';
}
export function bandLabel(band: MarkBand | null | undefined): string {
  return band === 'distinction' ? 'Distinction' : band === 'pass' ? 'Pass' : band === 'revision' ? 'Try again' : '';
}
export function bandTone(band: MarkBand | null | undefined): 'green' | 'blue' | 'amber' | 'gold' {
  return band === 'distinction' ? 'green' : band === 'pass' ? 'blue' : band === 'revision' ? 'amber' : 'gold';
}
export function safeName(s: string): string {
  return s.normalize('NFKD').replace(/[^\w\-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'file';
}
export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

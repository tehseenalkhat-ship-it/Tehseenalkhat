import { useEffect, useRef, useState } from 'react';
import { Mic, Pause, Play, Trash2 } from 'lucide-react';
import { duration, viewUrl } from './media';

const BARS = 40;
function fallbackBars(seed: string): number[] {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return Array.from({ length: BARS }, (_, i) => {
    h = (h * 1103515245 + 12345) >>> 0;
    const wave = 0.3 + 0.35 * Math.abs(Math.sin(i * 0.55 + (h % 7)));
    return Math.min(1, wave + ((h >>> 8) % 100) / 400);
  });
}
const SPEEDS = [1, 1.5, 2];

/**
 * WhatsApp-style voice note: play/pause, real waveform (from the recording) that fills as it plays,
 * drag/tap to seek, 1× / 1.5× / 2× speed, and the sender's initials with a mic badge.
 */
export function VoicePlayer({ storageKey, src, durationSec, waveform, label = 'Voice note', compact = false, autoPlay = false, initials, mine = false }: {
  storageKey?: string | null; src?: string | null; durationSec?: number | null; waveform?: number[] | null;
  label?: string; compact?: boolean; autoPlay?: boolean; initials?: string | null; mine?: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [url, setUrl] = useState<string | null>(src ?? null);
  const [playing, setPlaying] = useState(false);
  const [played, setPlayed] = useState(false);
  const [pos, setPos] = useState(0);
  const [total, setTotal] = useState(durationSec ?? 0);
  const [speed, setSpeed] = useState(1);
  const [failed, setFailed] = useState(false);
  const bars = waveform && waveform.length >= 8 ? resample(waveform, BARS) : fallbackBars(storageKey ?? src ?? 'voice');

  useEffect(() => { if (src) setUrl(src); }, [src]);
  useEffect(() => { if (durationSec) setTotal(durationSec); }, [durationSec]);
  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = speed; }, [speed, url]);

  const ensureUrl = async (): Promise<string | null> => {
    if (url) return url;
    if (!storageKey) return null;
    try { const u = await viewUrl(storageKey); setUrl(u); return u; } catch { setFailed(true); return null; }
  };

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); return; }
    // only one voice note plays at a time, like WhatsApp
    document.querySelectorAll('audio').forEach(a => { if (a !== audio) a.pause(); });
    const u = await ensureUrl();
    if (!u) return;
    if (audio.src !== u) audio.src = u;
    audio.playbackRate = speed;
    try { await audio.play(); setPlayed(true); } catch { setFailed(true); }
  };

  useEffect(() => { if (autoPlay) void toggle(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [autoPlay]);

  const seekTo = (clientX: number, el: HTMLElement) => {
    const audio = audioRef.current;
    if (!audio || !total) return;
    const r = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    try { audio.currentTime = ratio * total; } catch { /* not loaded yet */ }
    setPos(ratio * total);
  };
  const onBarsDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    seekTo(e.clientX, el);
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const onBarsMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons || e.pointerType === 'touch') { if (e.currentTarget.hasPointerCapture?.(e.pointerId)) seekTo(e.clientX, e.currentTarget); }
  };

  const progress = total ? Math.min(1, pos / total) : 0;
  const nextSpeed = () => setSpeed(s => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]);
  return (
    <div className={`v2-voice v3ch-voice${compact ? ' is-compact' : ''}${playing ? ' is-playing' : ''}${mine ? ' is-mine' : ''}`}>
      {(playing || pos > 0) ? (
        <button type="button" className="v3ch-voice-speed" onClick={nextSpeed} aria-label={`Playback speed ${speed} times. Tap to change.`}>{speed}×</button>
      ) : initials ? (
        <span className="v3ch-voice-avatar" aria-hidden="true">{initials}<i className={played ? 'is-played' : ''}><Mic size={11} /></i></span>
      ) : null}
      <button type="button" className="v2-voice-play" onClick={() => void toggle()} aria-label={playing ? `Pause ${label}` : `Play ${label}`}>
        {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
      </button>
      <div className="v3ch-voice-main">
        <div className="v2-voice-bars" onPointerDown={onBarsDown} onPointerMove={onBarsMove} role="slider" aria-label={`${label} position`} aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(pos)} tabIndex={-1}>
          {bars.map((h, i) => <i key={i} className={i / BARS < progress ? 'played' : ''} style={{ height: `${Math.round(14 + h * 86)}%` }} />)}
          <span className="v3ch-voice-thumb" style={{ left: `${progress * 100}%` }} aria-hidden="true" />
        </div>
        <span className="v2-voice-time">{failed ? 'Could not play' : duration(playing || pos ? pos : total)}</span>
      </div>
      <audio
        ref={audioRef}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setPos(0); }}
        onTimeUpdate={e => setPos(e.currentTarget.currentTime)}
        onLoadedMetadata={e => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setTotal(d); }}
        onError={() => { if (url) setFailed(true); }}
      />
    </div>
  );
}

function resample(values: number[], n: number): number[] {
  return Array.from({ length: n }, (_, i) => values[Math.min(values.length - 1, Math.floor((i * values.length) / n))] ?? 0.2);
}

/** Live recording bar (locked mode, like WhatsApp): delete · timer · live waveform · pause/resume · send. */
export function RecordingBar({ seconds, levels, onCancel, onSend, sendLabel = 'Send voice note', paused = false, onPause, onResume }: {
  seconds: number; levels: number[]; onCancel: () => void; onSend: () => void; sendLabel?: string;
  paused?: boolean; onPause?: () => void; onResume?: () => void;
}) {
  const padded = [...Array(Math.max(0, 48 - levels.length)).fill(0.05), ...levels.slice(-48)];
  return (
    <div className="v2-recbar v3ch-recbar" role="status" aria-live="polite">
      <button type="button" className="v3ch-recbar-trash" onClick={onCancel} aria-label="Delete recording"><Trash2 size={20} /></button>
      <span className={`v2-recbar-dot${paused ? ' is-paused' : ''}`} aria-hidden="true" />
      <span className="v2-recbar-time">{duration(seconds)}</span>
      <div className="v2-recbar-bars" aria-label={paused ? 'Recording paused' : 'Recording'}>
        {padded.map((v, i) => <i key={i} style={{ height: `${Math.round(10 + v * 90)}%` }} />)}
      </div>
      {onPause && onResume && (
        <button type="button" className="v3ch-recbar-pause" onClick={paused ? onResume : onPause} aria-label={paused ? 'Continue recording' : 'Pause recording'}>
          {paused ? <Mic size={19} /> : <Pause size={19} fill="currentColor" />}
        </button>
      )}
      <button type="button" className="v2-recbar-send v3ch-send" onClick={onSend} aria-label={sendLabel}><SendIcon /></button>
    </div>
  );
}

export function SendIcon({ size = 22 }: { size?: number }) {
  // WhatsApp's paper-plane send glyph
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M1.101 21.757 23.8 12.028 1.101 2.3l.011 7.912 13.623 1.816-13.623 1.817-.011 7.912z" />
    </svg>
  );
}

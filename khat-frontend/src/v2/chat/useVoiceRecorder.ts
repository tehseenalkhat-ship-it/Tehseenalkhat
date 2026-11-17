import { useCallback, useEffect, useRef, useState } from 'react';

export type VoiceClip = { file: File; durationSec: number; url: string; waveform: number[] };

const MAX_SECONDS = 300;
export const WAVE_BARS = 40;

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg']) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return '';
}

/** Down-samples the level history to `n` bars (peak per bucket), normalised so the loudest bar is ~1. */
export function toWaveform(levels: number[], n = WAVE_BARS): number[] {
  if (!levels.length) return [];
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const from = Math.floor((i * levels.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / n));
    let peak = 0;
    for (let j = from; j < to && j < levels.length; j += 1) peak = Math.max(peak, levels[j]);
    out.push(peak);
  }
  const max = Math.max(0.05, ...out);
  return out.map(v => Math.round(Math.min(1, v / max) * 100) / 100);
}

/**
 * MediaRecorder wrapper with a live level meter (for the waveform bars), pause/resume
 * and a stored waveform for the bubble. start() → recording; stop() resolves the clip; cancel() throws it away.
 */
export function useVoiceRecorder() {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const historyRef = useRef<number[]>([]);
  const elapsedRef = useRef(0);       // seconds recorded before the current run
  const runStartRef = useRef(0);      // Date.now() of the current run (0 when paused)
  const tickRef = useRef<number | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const resolveRef = useRef<((clip: VoiceClip | null) => void) | null>(null);
  const cancelledRef = useRef(false);

  const now = () => elapsedRef.current + (runStartRef.current ? (Date.now() - runStartRef.current) / 1000 : 0);

  const cleanup = useCallback(() => {
    if (tickRef.current) window.clearInterval(tickRef.current);
    tickRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
    setRecording(false);
    setPaused(false);
  }, []);

  useEffect(() => () => {
    cancelledRef.current = true;
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    cleanup();
  }, [cleanup]);

  const start = useCallback(async (): Promise<boolean> => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Voice notes are not supported in this browser.');
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      streamRef.current = stream;
      const mimeType = pickMime();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      historyRef.current = [];
      cancelledRef.current = false;
      recorder.ondataavailable = e => { if (e.data.size) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const durationSec = Math.max(1, Math.round(now()));
        const type = recorder.mimeType || mimeType || 'audio/webm';
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const blob = new Blob(chunksRef.current, { type });
        const waveform = toWaveform(historyRef.current);
        cleanup();
        const resolve = resolveRef.current;
        resolveRef.current = null;
        if (cancelledRef.current || !blob.size) { resolve?.(null); return; }
        const file = new File([blob], `voice-${Date.now()}.${ext}`, { type });
        resolve?.({ file, durationSec, url: URL.createObjectURL(blob), waveform });
      };
      let analyser: AnalyserNode | null = null;
      try {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AC();
        ctxRef.current = ctx;
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(analyser);
      } catch { analyser = null; }
      const data = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
      setLevels([]);
      tickRef.current = window.setInterval(() => {
        if (!runStartRef.current) return; // paused
        let level = 0.08 + Math.random() * 0.1;
        if (analyser && data) {
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
          level = Math.min(1, peak / 64);
        }
        historyRef.current.push(level);
        setLevels(prev => [...prev.slice(-59), level]);
        const s = now();
        setSeconds(s);
        if (s >= MAX_SECONDS && recorder.state === 'recording') recorder.stop();
      }, 100);
      elapsedRef.current = 0;
      runStartRef.current = Date.now();
      setSeconds(0);
      recorder.start(250);
      setRecording(true);
      setPaused(false);
      if (navigator.vibrate) navigator.vibrate(20);
      return true;
    } catch (err) {
      cleanup();
      setError(err instanceof Error && err.name === 'NotAllowedError' ? 'Please allow the microphone to record a voice note.' : 'Could not reach the microphone.');
      return false;
    }
  }, [cleanup]);

  const pause = useCallback(() => {
    const r = recorderRef.current;
    if (!r || r.state !== 'recording' || typeof r.pause !== 'function') return;
    r.pause();
    elapsedRef.current = now();
    runStartRef.current = 0;
    setPaused(true);
  }, []);

  const resume = useCallback(() => {
    const r = recorderRef.current;
    if (!r || r.state !== 'paused') return;
    r.resume();
    runStartRef.current = Date.now();
    setPaused(false);
  }, []);

  const stop = useCallback((): Promise<VoiceClip | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return Promise.resolve(null);
    return new Promise(resolve => {
      resolveRef.current = resolve;
      cancelledRef.current = false;
      if (recorder.state === 'paused') recorder.resume();
      elapsedRef.current = now();
      runStartRef.current = 0;
      recorder.stop();
    });
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const recorder = recorderRef.current;
    runStartRef.current = 0;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else cleanup();
  }, [cleanup]);

  return { recording, paused, seconds, levels, error, setError, start, stop, cancel, pause, resume };
}

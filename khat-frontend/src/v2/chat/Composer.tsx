import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Camera, ChevronLeft, FileText, Image as ImageIcon, Lock, Mic, Paperclip, Smile, X } from 'lucide-react';
import { RecordingBar, SendIcon } from './VoicePlayer';
import { LocalFileThumb } from './Thumbs';
import { EmojiPicker } from './EmojiPicker';
import { useVoiceRecorder, type VoiceClip } from './useVoiceRecorder';
import { acceptable } from './upload';
import { duration } from './media';

const HOLD_MS = 450;        // shorter than this = a tap → hands-free (locked) recording
const CANCEL_DX = -90;      // slide left this far to cancel
const LOCK_DY = -70;        // slide up this far to lock

/**
 * WhatsApp-style composer: [😊 message 📎 📷] (🎤 / ➤).
 * Voice: hold the mic to record and release to send · slide left to cancel · slide up to lock ·
 * or just tap the mic for hands-free recording with pause, delete and send.
 */
export function Composer({ onSendText, onSendFiles, onSendVoice, disabled = false, placeholder = 'Message', maxFiles = 20, text: ctrlText, setText: ctrlSetText, leading }: {
  onSendText: (text: string) => void;
  onSendFiles: (files: File[], caption: string) => void;
  onSendVoice: (clip: VoiceClip) => void;
  disabled?: boolean;
  placeholder?: string;
  maxFiles?: number;
  /** Optional controlled text (the teacher's mark panel and AI helper read/write it). */
  text?: string;
  setText?: (v: string) => void;
  /** Extra round button before the message box (e.g. the AI helper for teachers). */
  leading?: ReactNode;
}) {
  const [ownText, setOwnText] = useState('');
  const text = ctrlText ?? ownText;
  const setText = ctrlSetText ?? setOwnText;
  const [files, setFiles] = useState<File[]>([]);
  const [menu, setMenu] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [hold, setHold] = useState<{ dx: number; dy: number } | null>(null);
  const [locked, setLocked] = useState(false);
  const rec = useVoiceRecorder();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const photosRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; y: number; at: number; id: number; done: boolean } | null>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(140, ta.scrollHeight)}px`;
  }, [text]);

  useEffect(() => {
    if (!menu && !emoji) return;
    const close = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menu && !menuRef.current?.contains(t)) setMenu(false);
      if (emoji && !emojiRef.current?.contains(t) && !(t as HTMLElement).closest?.('.v3ch-emoji-toggle')) setEmoji(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu, emoji]);

  const addFiles = (list: FileList | null) => {
    setMenu(false);
    if (!list?.length) return;
    const ok = [...list].filter(acceptable);
    setNote(ok.length < list.length ? 'Only photos and PDF files can be sent.' : null);
    setFiles(prev => {
      const next = [...prev, ...ok];
      if (next.length > maxFiles) { setNote(`You can send up to ${maxFiles} files at once.`); return next.slice(0, maxFiles); }
      return next;
    });
  };

  const send = () => {
    if (disabled) return;
    const t = text.trim();
    setEmoji(false);
    if (files.length) { onSendFiles(files, t); setFiles([]); setText(''); return; }
    if (t) { onSendText(t); setText(''); }
  };

  const insertEmoji = (e: string) => {
    const ta = taRef.current;
    if (!ta) { setText(text + e); return; }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    const next = text.slice(0, start) + e + text.slice(end);
    setText(next);
    requestAnimationFrame(() => { ta.focus({ preventScroll: true }); ta.setSelectionRange(start + e.length, start + e.length); });
  };

  /* ---------- voice ---------- */
  const finishVoice = async () => {
    setLocked(false);
    setHold(null);
    const clip = await rec.stop();
    if (clip) onSendVoice(clip);
  };
  const cancelVoice = () => { setLocked(false); setHold(null); rec.cancel(); };

  const onMicDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled || rec.recording) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    press.current = { x: e.clientX, y: e.clientY, at: Date.now(), id: e.pointerId, done: false };
    setHold({ dx: 0, dy: 0 });
    void rec.start().then(ok => { if (!ok) { press.current = null; setHold(null); } });
  };
  const onMicMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.done || p.id !== e.pointerId) return;
    const dx = Math.min(0, e.clientX - p.x);
    const dy = Math.min(0, e.clientY - p.y);
    if (dx < CANCEL_DX) { p.done = true; cancelVoice(); press.current = null; if (navigator.vibrate) navigator.vibrate(30); return; }
    if (dy < LOCK_DY) { p.done = true; setLocked(true); setHold(null); press.current = null; return; }
    setHold({ dx, dy });
  };
  const onMicUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    if (p.done) return;
    if (Date.now() - p.at < HOLD_MS) { setLocked(true); setHold(null); return; } // tap → hands-free
    void finishVoice();
  };

  const canSend = !!text.trim() || files.length > 0;

  if (rec.recording && locked) {
    return (
      <div className="v2-composer-wrap v3ch-composer-wrap">
        <div className="v2-composer is-recording">
          <RecordingBar seconds={rec.seconds} levels={rec.levels} paused={rec.paused} onPause={rec.pause} onResume={rec.resume} onCancel={cancelVoice} onSend={() => void finishVoice()} />
        </div>
      </div>
    );
  }

  const holding = rec.recording && !!hold;
  return (
    <div className="v2-composer-wrap v3ch-composer-wrap">
      {emoji && <div ref={emojiRef}><EmojiPicker onPick={insertEmoji} /></div>}
      {files.length > 0 && (
        <div className="v2-tray" aria-label="Files to send">
          {files.map((f, i) => <LocalFileThumb key={`${f.name}-${i}`} file={f} onRemove={() => setFiles(prev => prev.filter((_, j) => j !== i))} />)}
          <button type="button" className="v2-tray-clear" onClick={() => setFiles([])}><X size={14} /> Clear</button>
        </div>
      )}
      {(note || rec.error) && <p className="v2-inline-error" role="alert">{note ?? rec.error}</p>}
      <div className="v2-composer">
        {leading}
        {holding ? (
          <div className="v3ch-hold" aria-live="polite">
            <span className="v2-recbar-dot" aria-hidden="true" />
            <span className="v2-recbar-time">{duration(rec.seconds)}</span>
            <span className="v3ch-hold-cancel" style={{ transform: `translateX(${Math.max(-60, (hold?.dx ?? 0) / 2)}px)`, opacity: 1 + (hold?.dx ?? 0) / 140 }}><ChevronLeft size={16} /> Slide to cancel</span>
          </div>
        ) : (
          <div className="v3ch-pill">
            <button type="button" className="v3ch-pill-btn v3ch-emoji-toggle" onClick={() => setEmoji(v => !v)} aria-label="Emoji" aria-expanded={emoji} disabled={disabled}><Smile size={22} /></button>
            <textarea
              ref={taRef}
              rows={1}
              value={text}
              maxLength={4000}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); send(); } }}
              placeholder={files.length ? 'Add a caption' : placeholder}
              aria-label="Message"
              disabled={disabled}
            />
            <div className="v2-attach" ref={menuRef}>
              <button type="button" className="v3ch-pill-btn" onClick={() => setMenu(m => !m)} aria-label="Attach photos or PDF" aria-expanded={menu} disabled={disabled}><Paperclip size={21} /></button>
              {menu && (
                <div className="v2-attach-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => photosRef.current?.click()}><span className="v2-attach-ico pho"><ImageIcon size={18} /></span>Photos</button>
                  <button type="button" role="menuitem" onClick={() => cameraRef.current?.click()}><span className="v2-attach-ico cam"><Camera size={18} /></span>Camera</button>
                  <button type="button" role="menuitem" onClick={() => pdfRef.current?.click()}><span className="v2-attach-ico pdf"><FileText size={18} /></span>Document (PDF)</button>
                </div>
              )}
            </div>
            {!text && !files.length && <button type="button" className="v3ch-pill-btn" onClick={() => cameraRef.current?.click()} aria-label="Take a photo" disabled={disabled}><Camera size={21} /></button>}
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
            <input ref={photosRef} type="file" accept="image/*" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
            <input ref={pdfRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
          </div>
        )}
        {canSend && !holding ? (
          <button type="button" className="v2-round v3ch-send" onClick={send} aria-label="Send" disabled={disabled}><SendIcon /></button>
        ) : (
          <div className="v3ch-mic-wrap">
            {holding && <span className="v3ch-lock-hint" style={{ transform: `translateY(${Math.max(-30, (hold?.dy ?? 0) / 2)}px)` }} aria-hidden="true"><Lock size={15} /><i /></span>}
            <button
              type="button"
              className={`v2-round v3ch-send v3ch-mic${holding ? ' is-holding' : ''}`}
              onPointerDown={onMicDown}
              onPointerMove={onMicMove}
              onPointerUp={onMicUp}
              onPointerCancel={onMicUp}
              onContextMenu={e => e.preventDefault()}
              onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !rec.recording) { e.preventDefault(); void rec.start().then(ok => { if (ok) setLocked(true); }); } }}
              aria-label="Voice note — hold to record, or tap for hands-free"
              title="Hold to record · tap for hands-free"
              disabled={disabled}
            ><Mic size={22} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

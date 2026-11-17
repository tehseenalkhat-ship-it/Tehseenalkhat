import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { CalendarDays, Link2, Play, Plus, Radio, Youtube } from 'lucide-react';
import { apiFetch, ApiError, getViewUrl } from '@/api';
import { Button, Modal, PenLoader } from '@/components/ui';
import type { LiveKitRoomAccess } from '@/components/LiveKitEventRoom';
import { V3Layer, V3YouTubePlayer, youTubeId } from './contentShared';

const LiveKitEventRoom = lazy(() => import('@/components/LiveKitEventRoom').then(m => ({ default: m.LiveKitEventRoom })));

export type V3Event = {
  id: string; host_teacher_id: string; branch_id: string; title: string; description?: string | null; scheduled_at: string;
  recording_storage_key?: string | null; recording_status?: 'processing' | 'ready' | null; recording_youtube_url?: string | null;
  status: 'scheduled' | 'live' | 'ended'; host_name: string; branch_name: string;
};

const dateLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Note 4.5: events page — live sessions, and recordings that play from YouTube in a window on the site. */
export function V3EventsPage() {
  const [events, setEvents] = useState<V3Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [yt, setYt] = useState<V3Event | null>(null);
  const [player, setPlayer] = useState<{ title: string; videoUrl?: string; room?: LiveKitRoomAccess } | null>(null);

  useEffect(() => {
    let mounted = true;
    const refresh = () => apiFetch<V3Event[]>('/events', { silent: true })
      .then(d => { if (mounted) { setEvents(d); setError(null); } })
      .catch(err => { if (mounted) setError(err instanceof ApiError ? err.message : 'Could not load events.'); })
      .finally(() => { if (mounted) setLoading(false); });
    void refresh();
    const t = window.setInterval(refresh, 20_000);
    return () => { mounted = false; window.clearInterval(t); };
  }, []);

  const upcoming = events.filter(e => e.status === 'scheduled' || e.status === 'live').sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  const recordings = events.filter(e => e.status === 'ended');

  const join = async (ev: V3Event) => {
    try { setPlayer({ title: ev.title, room: await apiFetch<LiveKitRoomAccess>(`/events/${ev.id}/join`, { method: 'POST' }) }); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not join the event.'); }
  };
  const watch = async (ev: V3Event) => {
    void apiFetch(`/events/${ev.id}/watched-recording`, { method: 'POST', silent: true }).catch(() => {});
    if (youTubeId(ev.recording_youtube_url)) { setYt(ev); return; }
    if (ev.recording_storage_key) {
      try { setPlayer({ title: ev.title, videoUrl: await getViewUrl(ev.recording_storage_key) }); }
      catch (err) { setError(err instanceof ApiError ? err.message : 'Could not load the recording.'); }
    }
  };

  return (
    <main className="page portal-page v3c-content-page">
      <header className="v3c-page-head">
        <div>
          <p className="eyebrow">Events</p>
          <h1>Live classes and recordings</h1>
          <p className="v3c-lede">Join a live class when it starts, or watch a recording any time.</p>
        </div>
      </header>
      {error && <p className="error-text" role="alert">{error}</p>}
      <h2 className="v3c-h2">Coming up</h2>
      {loading ? <PenLoader label="Loading events…" compact /> : upcoming.length === 0 ? (
        <div className="v3c-empty"><CalendarDays size={20} /><div><strong>No live classes planned yet</strong><p>When a teacher plans one, it will appear here.</p></div></div>
      ) : (
        <div className="v3c-event-list">
          {upcoming.map(ev => (
            <article className={`v3c-event-row${ev.status === 'live' ? ' is-live' : ''}`} key={ev.id}>
              <span className="v3c-event-date"><b>{new Date(ev.scheduled_at).getDate()}</b><small>{new Date(ev.scheduled_at).toLocaleString('en', { month: 'short' })}</small></span>
              <div className="v3c-event-copy"><strong>{ev.title}</strong><small>{ev.host_name} · {ev.branch_name} · {new Date(ev.scheduled_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</small></div>
              {ev.status === 'live'
                ? <Button onClick={() => void join(ev)}><Radio size={15} /> Join now</Button>
                : <span className="v3c-status is-pending">Not started yet</span>}
            </article>
          ))}
        </div>
      )}

      <h2 className="v3c-h2">Recordings</h2>
      {loading ? null : recordings.length === 0 ? (
        <div className="v3c-empty"><Play size={20} /><div><strong>No recordings yet</strong><p>Recordings of past classes will appear here.</p></div></div>
      ) : (
        <div className="v3c-rec-grid">
          {recordings.map(ev => {
            const vid = youTubeId(ev.recording_youtube_url);
            const playable = !!vid || !!ev.recording_storage_key;
            return (
              <button type="button" className="v3c-rec-card" key={ev.id} disabled={!playable} onClick={() => void watch(ev)}>
                <span className="v3c-rec-thumb">
                  {vid ? <img src={`https://i.ytimg.com/vi/${vid}/hqdefault.jpg`} alt="" loading="lazy" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} /> : null}
                  <span className="v3c-rec-play">{playable ? <Play size={22} fill="currentColor" /> : <Youtube size={22} />}</span>
                </span>
                <span className="v3c-rec-copy">
                  <strong>{ev.title}</strong>
                  <small>{ev.host_name} · {dateLabel(ev.scheduled_at)}</small>
                  {!playable && <small className="v3c-muted">{ev.recording_status === 'processing' ? 'The recording is being prepared' : 'Recording not added yet'}</small>}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {yt && youTubeId(yt.recording_youtube_url) && (
        <V3YouTubePlayer videoId={youTubeId(yt.recording_youtube_url)!} title={yt.title} subtitle={`${yt.host_name} · ${dateLabel(yt.scheduled_at)}`} description={yt.description} onClose={() => setYt(null)} />
      )}
      {player && (
        <Modal onClose={() => setPlayer(null)}>
          <p className="eyebrow">{player.room ? 'Live class' : 'Recording'}</p>
          <h2>{player.title}</h2>
          {player.room ? (
            <Suspense fallback={<div className="live-video-waiting">Joining the live class…</div>}>
              <LiveKitEventRoom access={player.room} publishMedia={false} onDisconnected={() => setPlayer(null)} onError={err => setError(err.message || 'Could not connect to the live class.')} />
            </Suspense>
          ) : (
            <div className="live-video-frame"><video src={player.videoUrl} controls autoPlay style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
          )}
        </Modal>
      )}
    </main>
  );
}

/**
 * For teachers and admins (Host events page): add a past class as a YouTube recording, or put a
 * YouTube link on an event that already happened.
 */
export function V3RecordingsManager() {
  const [events, setEvents] = useState<V3Event[]>([]);
  const [adding, setAdding] = useState(false);
  const [linkFor, setLinkFor] = useState<V3Event | null>(null);
  const [yt, setYt] = useState<V3Event | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(() => apiFetch<V3Event[]>('/events', { silent: true }).then(setEvents).catch(() => {}), []);
  useEffect(() => { void load(); }, [load]);
  const past = events.filter(e => e.status === 'ended');

  return (
    <section className="v3c-recman" aria-label="Recordings">
      <div className="v3c-recman-head">
        <div><h2>Recordings on YouTube</h2><p className="v3c-lede">Upload the class to YouTube (unlisted is fine), then paste the link here. Students watch it inside the site.</p></div>
        <Button onClick={() => setAdding(true)}><Plus size={15} /> Add a recording</Button>
      </div>
      {message && <p className="v3c-success" role="status">{message}</p>}
      {past.length === 0 ? <p className="v3c-muted">No past classes yet.</p> : (
        <div className="v3c-recman-list">
          {past.map(ev => {
            const vid = youTubeId(ev.recording_youtube_url);
            return (
              <article className="v3c-recman-row" key={ev.id}>
                <div><strong>{ev.title}</strong><small>{ev.branch_name} · {dateLabel(ev.scheduled_at)}</small></div>
                {vid ? <button type="button" className="v3c-ghost-btn" onClick={() => setYt(ev)}><Play size={14} /> Watch</button> : <span className="v3c-status is-pending">No link yet</span>}
                <button type="button" className="v3c-ghost-btn" onClick={() => setLinkFor(ev)}><Link2 size={14} /> {vid ? 'Change link' : 'Add YouTube link'}</button>
              </article>
            );
          })}
        </div>
      )}
      {adding && <RecordingDialog onClose={() => setAdding(false)} onSaved={() => { setAdding(false); setMessage('Recording added. Students can watch it now.'); void load(); }} />}
      {linkFor && <RecordingDialog event={linkFor} onClose={() => setLinkFor(null)} onSaved={() => { setLinkFor(null); setMessage('Link saved.'); void load(); }} />}
      {yt && youTubeId(yt.recording_youtube_url) && <V3YouTubePlayer videoId={youTubeId(yt.recording_youtube_url)!} title={yt.title} onClose={() => setYt(null)} />}
    </section>
  );
}

function RecordingDialog({ event, onClose, onSaved }: { event?: V3Event; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(event?.title ?? '');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [link, setLink] = useState(event?.recording_youtube_url ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const vid = youTubeId(link);
  const save = async () => {
    setError(null);
    if (!vid) { setError('Please paste a YouTube link, for example https://youtu.be/…'); return; }
    if (!event && !title.trim()) { setError('Please give the recording a title.'); return; }
    setSaving(true);
    try {
      if (event) await apiFetch(`/v2/events/${event.id}/recording`, { method: 'PUT', body: { youtubeUrl: link } });
      else await apiFetch('/v2/events/recordings', { method: 'POST', body: { title, description, recordedOn: date, youtubeUrl: link } });
      onSaved();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not save.'); }
    finally { setSaving(false); }
  };
  return (
    <V3Layer onClose={onClose} label={event ? 'YouTube link' : 'Add a recording'}>
      <div className="v3c-form">
        <h2>{event ? `YouTube link for “${event.title}”` : 'Add a recording'}</h2>
        {!event && <>
          <label className="field-label">Title<input className="field" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Naskh class — joining baa and alif" /></label>
          <label className="field-label">Date of the class<input className="field" type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
          <label className="field-label">About this class (optional)<textarea className="field textarea" value={description} onChange={e => setDescription(e.target.value)} /></label>
        </>}
        <label className="field-label">YouTube link<input className="field" value={link} onChange={e => setLink(e.target.value)} placeholder="https://youtu.be/…" inputMode="url" /></label>
        {link && <small className={vid ? 'v3c-hint is-ok' : 'v3c-hint is-bad'}>{vid ? 'Link looks good.' : 'This does not look like a YouTube link yet.'}</small>}
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="v3c-form-actions"><button type="button" className="v3c-ghost-btn" onClick={onClose}>Cancel</button><Button onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button></div>
      </div>
    </V3Layer>
  );
}

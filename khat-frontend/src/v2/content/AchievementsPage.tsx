import { useEffect, useState } from 'react';
import { Award, Download, ExternalLink, FileText, Images, Medal, Trophy } from 'lucide-react';
import { apiFetch, ApiError, getViewUrl } from '@/api';
import { openApiFile } from '@/v2/admin/builderTypes';
import { PenLoader, navigate } from '@/components/ui';
import { V3ImageViewer, cleanLabel, downloadStorageKey, useViewUrls } from './contentShared';
import type { ShowcaseItem } from './contentTypes';

type Certificate = { id: string; title: string; file_storage_key: string; issued_at: string; khat_type_id: string | null };
type MyBadge = { id: string; kind: 'level' | 'course' | 'competition'; label: string; awardedAt: string; artworkUrl: string | null; downloadUrl: string; title?: string; subtitle?: string };
type LegacyBadge = { id: string; khat_type_id: string; tier: string; awarded_at: string; khat_type_name: string };
type Artwork = { key: string; mediaType: 'image' | 'pdf'; url: string | null };
type CompAward = { rank: number; awarded_at: string; competition_id: string; competition_title: string; image_storage_key: string | null };

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_');

/** Codes are internal (owner rule): "FNK-C101 LV03 — حروف" → "Level 3 · حروف". */
export function friendlyBadgeLabel(label: string): string {
  const m = label.match(/^[A-Z]{2,5}-[A-Z]\d{3}\s+LV0*(\d+)\s*[—–-]?\s*(.*)$/);
  if (m) return `Level ${m[1]}${m[2] ? ` · ${m[2]}` : ''}`;
  return label.replace(/^[A-Z]{2,5}-[A-Z]\d{3}\s*/, '').replace(/^Selected for decoration/i, 'Selected');
}

/** Printable fallback for older badges that have no PDF on the server. */
function printBadge(title: string, subtitle: string, date: string, artwork?: string | null) {
  const w = window.open('', '_blank', 'noopener=no,width=820,height=1000');
  if (!w) return;
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  w.document.write(`<!doctype html><title>${esc(title)}</title><style>body{font-family:Georgia,serif;text-align:center;padding:60px;color:#1d1a16}h1{font-size:34px;margin:24px 0 6px}p{color:#555}img{max-width:60%;max-height:420px}.f{margin-top:40px;font-size:13px;color:#777}</style>
  ${artwork ? `<img src="${esc(artwork)}" alt="">` : '<div style="font-size:90px">✦</div>'}<h1>${esc(title)}</h1><p>${esc(subtitle)}</p><p>Awarded ${esc(date)}</p><p class="f">Funun al-Quran · Tehseen al-Khat</p><script>window.onload=()=>setTimeout(()=>window.print(),300)</script>`);
  w.document.close();
}

/** Note 4.3: no "Approved" wording; every certificate and badge has a Download button. */
export function V3AchievementsPage() {
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [badges, setBadges] = useState<MyBadge[]>([]);
  const [legacy, setLegacy] = useState<LegacyBadge[]>([]);
  const [art, setArt] = useState<Artwork[]>([]);
  const [awards, setAwards] = useState<CompAward[]>([]);
  const [shown, setShown] = useState<ShowcaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<{ src: string; title: string; key?: string } | null>(null);
  const urls = useViewUrls([...certs.map(c => c.file_storage_key), ...awards.map(a => a.image_storage_key), ...shown.map(s => s.imageStorageKey)]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [c, b, lb, a, w, s] = await Promise.allSettled([
        apiFetch<Certificate[]>('/certificates/mine', { silent: true }),
        apiFetch<MyBadge[]>('/v2/badges/mine', { silent: true }).catch(() => apiFetch<MyBadge[]>('/v2/badges/me', { silent: true }).then(list => list.map(x => ({ ...x, artworkUrl: null, downloadUrl: `/v2/badges/${x.id}/download` })))),
        apiFetch<LegacyBadge[]>('/badges', { silent: true }),
        apiFetch<Artwork[]>('/badges/assets', { silent: true }),
        apiFetch<CompAward[]>('/competitions/mine/achievements', { silent: true }),
        apiFetch<ShowcaseItem[]>('/v2/showcase/mine', { silent: true }),
      ]);
      if (cancelled) return;
      if (c.status === 'fulfilled') setCerts(c.value);
      if (b.status === 'fulfilled') setBadges(b.value);
      if (lb.status === 'fulfilled') setLegacy(lb.value);
      if (a.status === 'fulfilled') setArt(a.value);
      if (w.status === 'fulfilled') setAwards(w.value);
      if (s.status === 'fulfilled') setShown(s.value.filter(p => p.status === 'approved'));
      if ([c, b, lb, w].every(r => r.status === 'rejected')) setError('Could not load your achievements. Please try again.');
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const run = async (fn: () => Promise<void>, what: string) => { setError(null); try { await fn(); } catch (err) { setError(err instanceof ApiError && err.message ? err.message : `Could not download ${what}.`); } };
  const certExt = (k: string) => k.match(/\.(pdf|png|jpe?g|webp)$/i)?.[0] ?? '.pdf';
  const badgeCount = badges.length + legacy.length;

  return (
    <main className="page portal-page v3c-content-page">
      <header className="v3c-page-head">
        <div><p className="eyebrow">Achievements</p><h1>My certificates and badges</h1><p className="v3c-lede">Everything you have earned. Download any of them to print or to upload to JHS.</p></div>
      </header>
      <div className="v3c-ach-strip">
        <span><FileText size={17} /><b>{certs.length}</b> {certs.length === 1 ? 'certificate' : 'certificates'}</span>
        <span><Award size={17} /><b>{badgeCount}</b> {badgeCount === 1 ? 'badge' : 'badges'}</span>
        <span><Trophy size={17} /><b>{awards.length}</b> competition {awards.length === 1 ? 'award' : 'awards'}</span>
        <span><Images size={17} /><b>{shown.length}</b> in the showcase</span>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {loading ? <PenLoader label="Gathering your achievements…" /> : <>
        <h2 className="v3c-h2">Certificates</h2>
        {certs.length === 0 ? <div className="v3c-empty"><FileText size={20} /><div><strong>No certificates yet</strong><p>When you complete a certification course, your certificate will be here.</p></div></div> : (
          <div className="v3c-ach-grid">
            {certs.map(c => (
              <article className="v3c-ach-card" key={c.id}>
                <span className="v3c-ach-art is-cert">{urls[c.file_storage_key] && !/\.pdf$/i.test(c.file_storage_key) ? <img src={urls[c.file_storage_key]} alt="" /> : <FileText size={30} />}</span>
                <div className="v3c-ach-copy"><small>Certificate</small><strong>{c.title}</strong><span>Earned {day(c.issued_at)}</span></div>
                <div className="v3c-ach-actions">
                  <button type="button" className="v3c-ghost-btn" onClick={() => void run(async () => { window.open(await getViewUrl(c.file_storage_key), '_blank', 'noopener'); }, 'this certificate')}><ExternalLink size={14} /> Open</button>
                  <button type="button" className="v3c-ghost-btn is-strong" onClick={() => void run(() => downloadStorageKey(c.file_storage_key, safeName(c.title) + certExt(c.file_storage_key)), 'this certificate')}><Download size={14} /> Download</button>
                </div>
              </article>
            ))}
          </div>
        )}

        <h2 className="v3c-h2">Badges</h2>
        {badgeCount === 0 ? <div className="v3c-empty"><Award size={20} /><div><strong>No badges yet</strong><p>You earn a badge each time you complete a level.</p></div></div> : (
          <div className="v3c-ach-grid">
            {badges.map(b => {
              const title = b.title || friendlyBadgeLabel(b.label);
              return (
                <article className="v3c-ach-card" key={b.id}>
                  <button type="button" className="v3c-ach-art" onClick={() => b.artworkUrl && setView({ src: b.artworkUrl, title })} aria-label={`Open ${title}`}>{b.artworkUrl ? <img src={b.artworkUrl} alt="" /> : b.kind === 'competition' ? <Trophy size={30} /> : <Medal size={30} />}</button>
                  <div className="v3c-ach-copy"><small>{b.kind === 'course' ? 'Course badge' : b.kind === 'competition' ? 'Competition badge' : 'Level badge'}</small><strong>{title}</strong>{b.subtitle && <span>{b.subtitle}</span>}<span>Earned {day(b.awardedAt)}</span></div>
                  <div className="v3c-ach-actions">
                    <button type="button" className="v3c-ghost-btn is-strong" onClick={() => void run(() => openApiFile(b.downloadUrl, { download: `${safeName(title)}.pdf` }), 'this badge')}><Download size={14} /> Download</button>
                  </div>
                </article>
              );
            })}
            {legacy.map(b => {
              const artwork = art.find(x => x.key === `${b.khat_type_id}:${b.tier}`);
              const title = `${b.khat_type_name} — ${b.tier[0].toUpperCase()}${b.tier.slice(1)} badge`;
              return (
                <article className="v3c-ach-card" key={b.id}>
                  <button type="button" className="v3c-ach-art" onClick={() => artwork?.url && artwork.mediaType === 'image' && setView({ src: artwork.url, title })} aria-label={`Open ${title}`}>{artwork?.url && artwork.mediaType === 'image' ? <img src={artwork.url} alt="" /> : <Medal size={30} />}</button>
                  <div className="v3c-ach-copy"><small>Badge</small><strong>{title}</strong><span>Earned {day(b.awarded_at)}</span></div>
                  <div className="v3c-ach-actions">
                    <button type="button" className="v3c-ghost-btn is-strong" onClick={() => artwork?.url && artwork.mediaType === 'pdf' ? window.open(artwork.url, '_blank', 'noopener') : printBadge(title, b.khat_type_name, day(b.awarded_at), artwork?.url)}><Download size={14} /> Download</button>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <h2 className="v3c-h2">Competition awards</h2>
        {awards.length === 0 ? <div className="v3c-empty"><Trophy size={20} /><div><strong>No competition awards yet</strong><p>Results of competitions you enter will be added here.</p></div></div> : (
          <div className="v3c-ach-grid">
            {awards.map(a => (
              <article className="v3c-ach-card" key={`${a.competition_id}-${a.rank}`}>
                <button type="button" className="v3c-ach-art" onClick={() => a.image_storage_key && urls[a.image_storage_key] && setView({ src: urls[a.image_storage_key], title: a.competition_title, key: a.image_storage_key })}>{a.image_storage_key && urls[a.image_storage_key] ? <img src={urls[a.image_storage_key]} alt="" /> : <Trophy size={30} />}</button>
                <div className="v3c-ach-copy"><small>{a.rank === 1 ? 'Winner' : `Place ${a.rank}`}</small><strong>{a.competition_title}</strong><span>{day(a.awarded_at)}</span></div>
                {a.image_storage_key && <div className="v3c-ach-actions"><button type="button" className="v3c-ghost-btn is-strong" onClick={() => void run(() => downloadStorageKey(a.image_storage_key!, `${safeName(a.competition_title)}.jpg`), 'your entry')}><Download size={14} /> Download</button></div>}
              </article>
            ))}
          </div>
        )}

        <h2 className="v3c-h2">My work in the showcase</h2>
        {shown.length === 0 ? <div className="v3c-empty"><Images size={20} /><div><strong>Nothing in the showcase yet</strong><p>Share a finished piece — when it is accepted it will be listed here.</p></div><button type="button" className="v3c-ghost-btn" onClick={() => navigate('showcase')}>Share a piece</button></div> : (
          <div className="v3c-ach-grid">
            {shown.map(s => (
              <article className="v3c-ach-card" key={s.id}>
                <button type="button" className="v3c-ach-art" onClick={() => urls[s.imageStorageKey] && setView({ src: urls[s.imageStorageKey], title: s.caption ?? 'My piece', key: s.imageStorageKey })}>{urls[s.imageStorageKey] ? <img src={urls[s.imageStorageKey]} alt="" /> : <Images size={30} />}</button>
                <div className="v3c-ach-copy"><small>{cleanLabel(s.awardLabel) ?? 'In the showcase'}</small><strong>{s.caption ?? 'My piece'}</strong><span>{day(s.createdAt)}</span></div>
              </article>
            ))}
          </div>
        )}
      </>}
      {view && <V3ImageViewer src={view.src} title={view.title} storageKey={view.key} onClose={() => setView(null)} />}
    </main>
  );
}

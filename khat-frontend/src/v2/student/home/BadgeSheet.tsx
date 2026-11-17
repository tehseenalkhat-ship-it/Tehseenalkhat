// owner: student-dash (v3). One badge, opened big: the admin's artwork, download as PDF, print.
import { useState } from 'react';
import { Award, Download, Medal, Printer, RefreshCw, Trophy } from 'lucide-react';
import { errorMessage, fetchPdf, formatDate, openBlob, saveBlob, Sheet } from '../shared';
import type { BadgeWithArt } from './studentText';

export function BadgeMedal({ badge, size = 'md' }: { badge: Pick<BadgeWithArt, 'kind' | 'artworkUrl'>; size?: 'sm' | 'md' | 'lg' }) {
  const [broken, setBroken] = useState(false);
  const icon = badge.kind === 'course' ? <Medal /> : badge.kind === 'competition' ? <Trophy /> : <Award />;
  return (
    <span className={`v3-sd-medal is-${size} is-${badge.kind}`} aria-hidden="true">
      {badge.artworkUrl && !broken ? <img src={badge.artworkUrl} alt="" onError={() => setBroken(true)} /> : icon}
    </span>
  );
}

export function BadgeSheet({ badge, title, sub, subIsArabic, onClose }: { badge: BadgeWithArt; title: string; sub: string | null; subIsArabic?: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState<'save' | 'print' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const safeName = title.replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').slice(0, 60) || 'badge';

  const get = async (mode: 'save' | 'print') => {
    setBusy(mode); setError(null);
    try {
      const { blob, filename } = await fetchPdf(`/v2/badges/${badge.id}/download`, { fallbackName: `${safeName}.pdf` });
      if (mode === 'save') saveBlob(blob, filename); else openBlob(blob);
    } catch (err) {
      setError(errorMessage(err, 'Your badge could not be prepared just now. Please try again in a little while.'));
    } finally { setBusy(null); }
  };

  return (
    <Sheet title="Your badge" onClose={onClose}>
      <div className="v3-sd-badge-view">
        <div className="v3-sd-badge-frame"><BadgeMedal badge={badge} size="lg" /></div>
        <p className="v3-sd-badge-view-kind">{badge.kind === 'course' ? 'Course badge' : badge.kind === 'competition' ? 'Competition award' : 'Level badge'}</p>
        <h3 className="v3-sd-badge-view-title">{title}</h3>
        {sub && <p className={`v3-sd-badge-view-sub${subIsArabic ? ' v3-sd-ar' : ''}`} lang={subIsArabic ? 'ar' : undefined} dir="auto">{sub}</p>}
        <p className="v3-sd-badge-view-date">Earned on {formatDate(badge.awardedAt, { day: 'numeric', month: 'long', year: 'numeric' })}</p>
        <p className="v3-sd-badge-view-note">Download your badge to keep it, print it, or upload it to your profile on the Jamea portal (JHS).</p>
        {error && <p className="v3-sd-soft-error" role="alert">{error}</p>}
        <div className="v3-sd-badge-view-actions">
          <button type="button" className="v3-sd-btn is-outline" onClick={() => void get('save')} disabled={busy !== null}>
            {busy === 'save' ? <RefreshCw size={16} className="v2s-spin" /> : <Download size={16} />} Download
          </button>
          <button type="button" className="v3-sd-btn is-outline" onClick={() => void get('print')} disabled={busy !== null}>
            {busy === 'print' ? <RefreshCw size={16} className="v2s-spin" /> : <Printer size={16} />} Print
          </button>
        </div>
      </div>
    </Sheet>
  );
}

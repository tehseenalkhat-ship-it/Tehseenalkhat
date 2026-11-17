import { useEffect, useState } from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import { apiFetch, getSessionUser } from '@/api';
import { navigate } from '@/components/ui';
import type { DashboardHighlight } from '../contracts';
import { firstName, SignedImage } from '../student/shared';
import '../student/student-v2.css';
import './competitions-v2.css';

type Props = { branchId?: string | null };

function sentence(h: DashboardHighlight): string {
  const who = `${firstName(h.studentName)}${h.branchName ? ` from ${h.branchName}` : ''}`;
  const label = h.label.trim();
  const title = h.competitionTitle.trim();
  const the = /^the\s/i.test(title) ? '' : 'the ';
  if (/^selected/i.test(label) || h.kind === 'call') return `${who} was selected for ${the}${title}`;
  if (/^winner$/i.test(label)) return `${who} won ${the}${title}`;
  return `${who} received ${label.toLowerCase()} in ${the}${title}`;
}

/** A warm strip of recent selections, embedded on dashboards. Renders nothing when there is nothing to celebrate. */
export function V2DashboardHighlights({ branchId }: Props) {
  const [items, setItems] = useState<DashboardHighlight[] | null>(null);
  const branch = branchId ?? getSessionUser()?.branchId ?? null;

  useEffect(() => {
    let cancelled = false;
    apiFetch<DashboardHighlight[]>(`/v2/highlights${branch ? `?branchId=${encodeURIComponent(branch)}` : ''}`, { silent: true })
      .then(data => { if (!cancelled) setItems(Array.isArray(data) ? data.slice(0, 10) : []); })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [branch]);

  if (items === null) return <div className="v2s-highlights is-loading" aria-hidden="true"><span /><span /><span /></div>;
  if (items.length === 0) return null;

  return (
    <section className="v2s-highlights" aria-labelledby="v2s-highlights-title">
      <div className="v2s-highlights-head">
        <h2 id="v2s-highlights-title"><Sparkles size={16} aria-hidden="true" /> Celebrating our calligraphers</h2>
        <button type="button" className="v2s-link-button" onClick={() => navigate('v2-competitions')}>See all <ArrowRight size={14} /></button>
      </div>
      <ul className="v2s-highlights-strip">
        {items.map(item => (
          <li key={item.id} className="v2s-highlight">
            <SignedImage storageKey={item.imageStorageKey} alt={`Work by ${item.studentName}`} className="v2s-highlight-image" />
            <div>
              <span className="v2s-chip is-green">{item.label}</span>
              <p>{sentence(item)}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

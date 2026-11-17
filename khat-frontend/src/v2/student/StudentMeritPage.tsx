// owner: student-dash (v3). "My badges" (route v2-my-merit). Merit points are staff-only now, so none here.
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Award, Download, Lock } from 'lucide-react';
import { PenLoader } from '@/components/ui';
import type { StudentCourse } from '../contracts';
import { EmptyState, ensureAmiri, formatDate } from './shared';
import { BadgeMedal, BadgeSheet } from './home/BadgeSheet';
import { openCourse } from './home/CourseCard';
import { badgeTitle, courseName, hasArabic, type BadgeWithArt } from './home/studentText';
import { loadMyBadges, useStudentCourses } from './home/useStudentCourses';
import './student-v2.css';
import './home/v3-student.css';

type Props = Record<string, never>;
type Upcoming = { key: string; title: string; sub: string | null; courseId: string; certificate: boolean };

export function V2StudentMeritPage(_props: Props) {
  const [badges, setBadges] = useState<BadgeWithArt[] | null>(null);
  const [openBadge, setOpenBadge] = useState<BadgeWithArt | null>(null);
  const { entries } = useStudentCourses();

  useEffect(() => { ensureAmiri(); loadMyBadges().then(setBadges).catch(() => setBadges([])); }, []);

  const courseMap = useMemo(() => new Map((entries ?? []).filter(e => e.state).map(e => [e.summary.id, e.state!.course] as [string, StudentCourse])), [entries]);
  const sorted = useMemo(() => [...(badges ?? [])].sort((a, b) => b.awardedAt.localeCompare(a.awardedAt)), [badges]);

  // Badges still ahead in the courses the student has started.
  const upcoming = useMemo(() => {
    if (!badges || !entries) return [] as Upcoming[];
    const earnedLevels = new Set(badges.map(b => b.levelId).filter(Boolean));
    const earnedCodes = new Set(badges.map(b => b.badgeCode.toUpperCase()));
    const earnedCourses = new Set(badges.filter(b => b.kind === 'course').map(b => b.courseId));
    const list: Upcoming[] = [];
    entries.filter(e => e.state?.course.enrolled).forEach(({ state }) => {
      const s = state!;
      const name = courseName(s.course);
      s.levels.forEach(info => {
        if (!info.awardsBadge || !info.hasAssessment) return;
        if (earnedLevels.has(info.level.id) || (info.level.badgeCode && earnedCodes.has(info.level.badgeCode.toUpperCase()))) return;
        list.push({ key: info.level.id, title: s.flat ? name : `${name} · Level ${info.number}`, sub: info.level.description, courseId: s.course.id, certificate: false });
      });
      if ((s.kind === 'certification' || s.hasFinal) && !earnedCourses.has(s.course.id)) {
        list.push({ key: `${s.course.id}-c`, title: name, sub: s.kind === 'certification' ? 'Certificate — pass every level' : 'Course badge — send your final work', courseId: s.course.id, certificate: true });
      }
    });
    return list.slice(0, 12);
  }, [badges, entries]);

  return (
    <main className="page portal-page v3-sd-page v3-sd-badges-page">
      <header className="v3-sd-progress-head">
        <p className="v3-sd-eyebrow">My badges</p>
        <h1>Every badge is a step you have mastered</h1>
        <p>Tap a badge to open it. You can download it, print it, or upload it to your profile on the Jamea portal (JHS).</p>
      </header>

      {!badges && <PenLoader label="Loading your badges…" />}

      {badges && (
        <section className="v3-sd-section" aria-labelledby="v3-sd-earned-title">
          <h2 id="v3-sd-earned-title" className="v3-sd-mini-head">Earned · {sorted.length}</h2>
          {sorted.length === 0 ? (
            <EmptyState icon={<Award size={22} />} title="Your first badge is close" text="Pass a level assessment and your first badge will appear here." />
          ) : (
            <div className="v3-sd-badge-grid">
              {sorted.map(badge => {
                const t = badgeTitle(badge, courseMap);
                return (
                  <article key={badge.id} className="v3-sd-badge-card">
                    <button type="button" onClick={() => setOpenBadge(badge)} aria-label={`Open badge: ${t.title}`}><BadgeMedal badge={badge} /></button>
                    <strong>{t.title}</strong>
                    {t.sub && <small className={t.subIsArabic ? 'v3-sd-ar' : ''} dir="auto">{t.sub}</small>}
                    <small>{formatDate(badge.awardedAt)}</small>
                    <div className="v3-sd-badge-card-actions">
                      <button type="button" className="v3-sd-btn is-outline" onClick={() => setOpenBadge(badge)}><Download size={15} /> Open & download</button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {badges && upcoming.length > 0 && (
        <section className="v3-sd-section" aria-labelledby="v3-sd-ahead-title">
          <h2 id="v3-sd-ahead-title" className="v3-sd-mini-head">Still ahead · {upcoming.length}</h2>
          <div className="v3-sd-badge-grid">
            {upcoming.map(item => (
              <article key={item.key} className="v3-sd-badge-card is-locked">
                <span className="v3-sd-medal is-md is-locked" aria-hidden="true"><Lock /></span>
                <strong>{item.title}</strong>
                {item.sub && <small className={hasArabic(item.sub) ? 'v3-sd-ar' : ''} dir="auto">{item.sub}</small>}
                <button type="button" className="v3-sd-btn is-ghost" onClick={() => openCourse(item.courseId)}>Go to the course <ArrowRight size={15} /></button>
              </article>
            ))}
          </div>
        </section>
      )}

      {openBadge && (() => { const t = badgeTitle(openBadge, courseMap); return <BadgeSheet badge={openBadge} title={t.title} sub={t.sub} subIsArabic={t.subIsArabic} onClose={() => setOpenBadge(null)} />; })()}
    </main>
  );
}

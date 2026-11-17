// owner: student-dash (v3). Loads the student's courses with full detail (enrolment, progress, steps).
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/api';
import type { CourseSummary, StudentBadge, StudentCourse } from '../../contracts';
import { buildCourseState, type BadgeWithArt, type CourseState } from './studentText';

export type CourseEntry = { summary: CourseSummary; state: CourseState | null };

export function useStudentCourses() {
  const [entries, setEntries] = useState<CourseEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await apiFetch<CourseSummary[]>('/v2/student/courses');
      const details: Record<string, StudentCourse | null> = {};
      const queue = [...list];
      const worker = async () => {
        while (queue.length) {
          const course = queue.shift()!;
          details[course.id] = await apiFetch<StudentCourse>(`/v2/student/courses/${course.id}`, { silent: true }).catch(() => null);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
      const next = list
        .map(summary => ({ summary, state: details[summary.id] ? buildCourseState(details[summary.id]!) : null }))
        .filter(entry => entry.summary.status === 'published' || (entry.summary.status === 'held' && entry.state?.course.enrolled));
      setEntries(next);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Your courses could not be loaded right now.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  return { entries, error, reload: load };
}

/** Badges with the admin's artwork when the server has it (GET /v2/badges/mine), else the plain list. */
export async function loadMyBadges(): Promise<BadgeWithArt[]> {
  try {
    const list = await apiFetch<BadgeWithArt[]>('/v2/badges/mine', { silent: true });
    if (Array.isArray(list)) return list;
  } catch { /* older server: fall back below */ }
  const plain = await apiFetch<StudentBadge[]>('/v2/badges/me', { silent: true }).catch(() => [] as StudentBadge[]);
  return Array.isArray(plain) ? plain : [];
}

export type MyShowcasePost = { id: string; image_storage_key: string | null; caption: string | null; status: string; created_at: string; source?: string | null; award_label?: string | null };

/** The student's own showcase posts that were approved — shown as a personal achievement. */
export async function loadMyShowcase(): Promise<MyShowcasePost[]> {
  const rows = await apiFetch<MyShowcasePost[]>('/showcase/mine', { silent: true }).catch(() => [] as MyShowcasePost[]);
  return (Array.isArray(rows) ? rows : []).filter(row => row.status === 'approved' && row.image_storage_key);
}

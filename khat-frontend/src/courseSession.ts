import { useEffect, useState } from 'react';

type CourseSession = { courseId: string; levelId: string } | null;

let session: CourseSession = null;
const listeners = new Set<() => void>();

export function openCourseLevel(courseId: string, levelId: string): void {
  session = { courseId, levelId };
  listeners.forEach((l) => l());
}

export function useCourseSession(): CourseSession {
  const [, forceRender] = useState(0);
  useEffect(() => {
    const listener = () => forceRender((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return session;
}

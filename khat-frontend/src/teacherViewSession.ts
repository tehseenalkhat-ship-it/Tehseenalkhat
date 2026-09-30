import { useEffect, useState } from 'react';

let viewedTeacherId: string | null = null;
const listeners = new Set<() => void>();

export function viewTeacherProfile(teacherId: string): void {
  viewedTeacherId = teacherId;
  listeners.forEach((l) => l());
}

export function clearViewedTeacher(): void {
  viewedTeacherId = null;
}

export function useViewedTeacherId(): string | null {
  const [, forceRender] = useState(0);
  useEffect(() => {
    const listener = () => forceRender((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return viewedTeacherId;
}

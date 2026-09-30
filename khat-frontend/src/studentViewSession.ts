import { useEffect, useState } from 'react';

let activeStudentId: string | null = null;
const listeners = new Set<() => void>();

export function viewStudentProfile(studentId: string): void {
  activeStudentId = studentId;
  listeners.forEach((l) => l());
}

export function useActiveStudentId(): string | null {
  const [, forceRender] = useState(0);
  useEffect(() => {
    const listener = () => forceRender((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return activeStudentId;
}

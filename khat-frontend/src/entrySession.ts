import { useEffect, useState } from 'react';

let activeEntryId: string | null = null;
const listeners = new Set<() => void>();

export function openEntry(entryId: string): void {
  activeEntryId = entryId;
  listeners.forEach((l) => l());
}

export function useActiveEntryId(): string | null {
  const [, forceRender] = useState(0);
  useEffect(() => {
    const listener = () => forceRender((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return activeEntryId;
}

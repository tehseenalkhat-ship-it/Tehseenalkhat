import { navigate } from '@/components/ui';

/**
 * v2 pages are plain hash routes. Their details travel IN the address, e.g.
 * `#v2-task?courseId=…&stepId=…`, so email links, refresh and new tabs all work.
 * A copy is also kept in sessionStorage (older code and the notification pop-ups read it).
 */
const PREFIX = 'khat.v2.param.';

function hashParams(): URLSearchParams {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const q = hash.indexOf('?');
  return new URLSearchParams(q >= 0 ? hash.slice(q + 1) : '');
}

/** `v2-task` + {courseId, stepId} → `v2-task?courseId=…&stepId=…` (empty values left out). */
export function v2Href(page: string, params: Record<string, string | null | undefined> = {}): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value != null && value !== '') qs.set(key, value);
  const s = qs.toString();
  return s ? `${page}?${s}` : page;
}

function remember(params: Record<string, string | null | undefined>): void {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) sessionStorage.removeItem(PREFIX + key);
    else sessionStorage.setItem(PREFIX + key, value);
  }
}

export function openV2(page: string, params: Record<string, string | null | undefined> = {}): void {
  remember(params);
  navigate(v2Href(page, params));
}

/** Update the details in the address bar without reloading the page (e.g. Next step on the task page). */
export function replaceV2Params(params: Record<string, string | null | undefined>): void {
  remember(params);
  const hash = window.location.hash.replace(/^#\/?/, '');
  const page = hash.split('?')[0];
  const merged: Record<string, string | null | undefined> = Object.fromEntries(hashParams().entries());
  Object.assign(merged, params);
  const next = `#${v2Href(page, merged)}`;
  if (next !== window.location.hash) window.history.replaceState(window.history.state, '', next);
}

/** The address bar wins; otherwise the copy kept for this tab. */
export function readV2Param(key: string): string | null {
  const fromHash = hashParams().get(key);
  if (fromHash) {
    sessionStorage.setItem(PREFIX + key, fromHash);
    return fromHash;
  }
  return sessionStorage.getItem(PREFIX + key);
}

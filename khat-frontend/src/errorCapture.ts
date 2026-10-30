import { API_BASE_URL, getToken } from './api';

// Catches browser errors: keeps the last few for "Report a problem" and sends each one to
// /api/clientlog (the server also rate-limits and drops repeats).

export type CapturedError = { message: string; stack?: string; time: string; url: string };

const MAX_KEPT = 10;
const RESEND_AFTER_MS = 60_000;
const recent: CapturedError[] = [];
const lastSent = new Map<string, number>();

export function getRecentErrors(): CapturedError[] {
  return [...recent];
}

function remember(message: string, stack?: string, send = true) {
  const entry: CapturedError = { message: message.slice(0, 1000), stack: stack?.slice(0, 4000), time: new Date().toISOString(), url: location.href };
  recent.push(entry);
  if (recent.length > MAX_KEPT) recent.shift();
  if (!send) return;

  const now = Date.now();
  if (now - (lastSent.get(entry.message) ?? 0) < RESEND_AFTER_MS) return;
  lastSent.set(entry.message, now);
  const token = getToken();
  void fetch(`${API_BASE_URL}/api/clientlog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ message: entry.message, stack: entry.stack, url: entry.url }),
    keepalive: true,
  }).catch(() => {
    /* never let error reporting cause more errors */
  });
}

let installed = false;

export function installErrorCapture() {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (event) => {
    // Resource load failures (broken <img> etc.) have no message; only real script errors are logged.
    if (!event.message) return;
    remember(event.message, event.error instanceof Error ? event.error.stack : `${event.filename}:${event.lineno}:${event.colno}`);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    remember(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`, reason instanceof Error ? reason.stack : undefined);
  });

  // console.error calls are kept for reports (they often explain a problem) but not sent on their own.
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      const message = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      remember(`console.error: ${message}`, args.find((a): a is Error => a instanceof Error)?.stack, false);
    } catch {
      /* ignore unserialisable arguments */
    }
    originalError(...args);
  };
}

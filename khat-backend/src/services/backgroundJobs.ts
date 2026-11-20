/**
 * Background jobs without an outside scheduler. The hosting (Passenger) may put the app to sleep
 * when nobody visits, which stops plain setInterval timers. So jobs are checked at startup, on every
 * request and once a minute while awake; each job runs when its interval has passed and never twice
 * at the same time. After a quiet night the jobs catch up with the first visit (they work from the
 * real waiting times stored in the database).
 */
export type BackgroundJob = { name: string; everyMs: number; run: () => Promise<unknown> };

export function createJobRunner(
  jobs: BackgroundJob[],
  onResult: (name: string, result: unknown) => void,
  onError: (name: string, error: unknown) => void,
) {
  const state = jobs.map(job => ({ job, last: -Infinity, running: false }));
  /** Starts every job that is due. Never waits for them and never throws. */
  return function tick(now = Date.now()): void {
    for (const s of state) {
      if (s.running || now - s.last < s.job.everyMs) continue;
      s.last = now;
      s.running = true;
      Promise.resolve()
        .then(() => s.job.run())
        .then(result => onResult(s.job.name, result), error => onError(s.job.name, error))
        .finally(() => { s.running = false; });
    }
  };
}

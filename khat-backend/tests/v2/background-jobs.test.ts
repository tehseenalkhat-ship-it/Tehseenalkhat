import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobRunner } from '../../src/services/backgroundJobs.js';

const flush = () => new Promise(r => setImmediate(r));

test('job runner: runs at once, then only when the interval has passed, never twice at the same time', async () => {
  let runs = 0;
  let release: () => void = () => {};
  const errors: string[] = [];
  const tick = createJobRunner(
    [{ name: 'slow', everyMs: 1000, run: () => { runs++; return new Promise<void>(r => { release = r; }); } }],
    () => {},
    name => errors.push(name),
  );
  tick(0); await flush(); // first visit / startup: runs
  assert.equal(runs, 1);
  tick(5000); await flush(); // due again, but the first run is still busy: skipped
  assert.equal(runs, 1);
  release(); await flush();
  tick(500); await flush(); // finished, but interval (from 0) not passed: skipped
  assert.equal(runs, 1);
  tick(1000); await flush(); // due: runs
  assert.equal(runs, 2);
  release(); await flush();
  assert.deepEqual(errors, []);
});

test('job runner: a failing job is reported and does not stop the next run', async () => {
  let runs = 0;
  const errors: string[] = [];
  const tick = createJobRunner(
    [{ name: 'broken', everyMs: 10, run: async () => { runs++; throw new Error('boom'); } }],
    () => {},
    name => errors.push(name),
  );
  tick(0); await flush();
  tick(10); await flush();
  assert.equal(runs, 2);
  assert.deepEqual(errors, ['broken', 'broken']);
});

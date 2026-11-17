import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { ADDITIVE_KEYS, combineAdditive } from '../../src/v2/lib/policies.js';
import { pool } from '../../src/db.js';

after(async () => { await pool.end().catch(() => undefined); });

test('v3 audit 7: the download message is fixed; a branch only adds a line', () => {
  assert.ok(ADDITIVE_KEYS.includes('print.instructions'));
  const master = 'Print on art paper only. Contact Funun al-Quran.';
  assert.equal(combineAdditive(master, 'Art paper is at the branch office.'), `${master}\nArt paper is at the branch office.`);
  assert.equal(combineAdditive(master, '  '), master);
  assert.equal(combineAdditive(master, master), master);
  assert.equal(combineAdditive(master, null), master);
});

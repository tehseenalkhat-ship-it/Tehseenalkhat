import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canEditGalleryWork, cleanAwardLabel, cleanCaption, effortLabel, normaliseLanguage, normaliseMinutes, olderCourseVisible,
  youTubeEmbedUrl, youTubeId, youTubeWatchUrl,
} from '../../src/v2/lib/contentLogic.ts';

test('youTubeId reads every common YouTube link form', () => {
  const id = 'AbC_dEf-123';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`, `https://youtube.com/watch?v=${id}&t=30s`, `https://m.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`, `https://youtu.be/${id}?si=xyz`, `youtu.be/${id}`, `https://www.youtube.com/embed/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`, `https://www.youtube.com/shorts/${id}`, `https://www.youtube.com/live/${id}`, id,
  ]) assert.equal(youTubeId(url), id, url);
});

test('youTubeId rejects non-YouTube or broken links', () => {
  for (const bad of ['', '   ', 'https://vimeo.com/12345', 'https://www.youtube.com/watch?v=short', 'https://evil.com/watch?v=AbC_dEf-123', 'not a url', null, 42]) {
    assert.equal(youTubeId(bad), null, String(bad));
  }
});

test('watch / embed urls', () => {
  assert.equal(youTubeWatchUrl('AbC_dEf-123'), 'https://www.youtube.com/watch?v=AbC_dEf-123');
  assert.match(youTubeEmbedUrl('AbC_dEf-123'), /^https:\/\/www\.youtube-nocookie\.com\/embed\/AbC_dEf-123/);
});

test('time taken: minutes and effort label', () => {
  assert.equal(normaliseMinutes('90'), 90);
  assert.equal(normaliseMinutes(45.4), 45);
  assert.equal(normaliseMinutes(0), null);
  assert.equal(normaliseMinutes(-5), null);
  assert.equal(normaliseMinutes(7000), null);
  assert.equal(normaliseMinutes('abc'), null);
  assert.equal(effortLabel(45), '45 min');
  assert.equal(effortLabel(60), '1 hour');
  assert.equal(effortLabel(120), '2 hours');
  assert.equal(effortLabel(95), '1 h 35 min');
  assert.equal(effortLabel(null), null);
});

test('"Selected for decoration" is never shown', () => {
  assert.equal(cleanAwardLabel('Selected for decoration'), 'Selected');
  assert.equal(cleanAwardLabel('Winner'), 'Winner');
  assert.equal(cleanAwardLabel('  '), null);
  assert.equal(cleanCaption('Selected for decoration — Call for calligraphers: Ashara 1448 hall'), 'Call for calligraphers: Ashara 1448 hall');
  assert.equal(cleanCaption('My piece'), 'My piece');
});

test('book language is one of the known list', () => {
  assert.equal(normaliseLanguage('arabic'), 'Arabic');
  assert.equal(normaliseLanguage('Lisan ud-Dawat'), 'Lisan ud-Dawat');
  assert.equal(normaliseLanguage('Klingon'), null);
});

test('older courses: published, old system, with levels, for the branch', () => {
  const base = { status: 'published', structureVersion: 1, levelCount: 3, branchIds: [] as string[] };
  assert.equal(olderCourseVisible(base, 'b1'), true);
  assert.equal(olderCourseVisible({ ...base, status: 'draft' }, 'b1'), false);
  assert.equal(olderCourseVisible({ ...base, structureVersion: 2 }, 'b1'), false);
  assert.equal(olderCourseVisible({ ...base, levelCount: 0 }, 'b1'), false);
  assert.equal(olderCourseVisible({ ...base, branchIds: ['b2'] }, 'b1'), false);
  assert.equal(olderCourseVisible({ ...base, branchIds: ['b1', 'b2'] }, 'b1'), true);
});

test('gallery edit rights', () => {
  assert.equal(canEditGalleryWork({ isMaster: true, isStaff: true, branchId: 'b1' }, null), true);
  assert.equal(canEditGalleryWork({ isMaster: false, isStaff: true, branchId: 'b1' }, 'b1'), true);
  assert.equal(canEditGalleryWork({ isMaster: false, isStaff: true, branchId: 'b1' }, 'b2'), false);
  assert.equal(canEditGalleryWork({ isMaster: false, isStaff: true, branchId: 'b1' }, null), false);
  assert.equal(canEditGalleryWork({ isMaster: false, isStaff: false, branchId: 'b1' }, 'b1'), false);
});

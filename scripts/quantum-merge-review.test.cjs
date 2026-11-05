const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { canonical, recordId } = require('../dist/electron/sync-format.js');
const { emptySyncDesktop, emptySyncStore, mergeOperation, projectSnapshot, recordTitle, snapshotRecords } = require('../dist/electron/sync-model.js');

const operation = (record, overrides = {}) => ({ ...record, id: randomUUID(), base: null, time: 100, device: randomUUID(), generation: randomUUID(), ...overrides });
const favorite = title => ({ kind: 'link', id: randomUUID(), title, url: 'https://merge-review.example/favorite', createdAt: 10 });
const favoriteRecord = (profile, entry, position = 0) => ({ item: 'favorites', profile, key: entry.id, value: { parent: 'bar', position, entry } });

test('merge compares equivalent nested favorite values independently of JSON key order', () => {
  const entry = favorite('Unchanged favorite'), record = favoriteRecord(randomUUID(), entry), first = operation(record), second = operation({ ...record, value: JSON.parse(canonical(record.value)) }, { time: 200 });
  assert.notEqual(JSON.stringify(first.value), JSON.stringify(second.value));
  for (const [left, right] of [[first, second], [second, first]]) {
    const records = new Map([[recordId(left), left]]), conflicts = new Map();
    mergeOperation(records, right, conflicts);
    assert.equal(conflicts.size, 0);
    assert.equal(records.get(recordId(first)).id, second.id);
  }
});

test('merge compares equivalent received profile values across writer generations without conflicts', () => {
  const record = { item: 'profiles', profile: null, key: randomUUID(), value: { name: 'Personal', color: 'amber', createdAt: 10 } }, received = operation({ ...record, value: JSON.parse(canonical(record.value)) }), rewritten = operation(record, { time: 200, device: received.device });
  assert.notEqual(received.generation, rewritten.generation);
  const records = new Map([[recordId(received), received]]), conflicts = new Map();
  mergeOperation(records, rewritten, conflicts);
  assert.equal(conflicts.size, 0);
  assert.equal(records.get(recordId(received)).id, rewritten.id);
});

test('concurrent favorites-bar inserts at position zero preserve both inserts without conflicts titled after untouched favorites', () => {
  const profile = randomUUID(), syncProfile = randomUUID(), device = randomUUID(), mapping = { [profile]: syncProfile }, switches = { profiles: true, favorites: true, history: false, tabs: true, desktop: true, siteSettings: true, settings: true };
  const untouched = [favorite('Untouched first'), favorite('Untouched second')], inserted = [favorite('Inserted on A'), favorite('Inserted on B')];
  const snapshot = { settings: { theme: 'system', contrast: 'standard', darkPages: 'off', darkStrength: 'standard', darkTone: 'neutral', searchEngine: 'bing', language: 'system', onStart: 'restore', askWhereToSave: false, blockAds: true, blockThirdPartyCookies: true, quickAccess: [], showCapture: true }, profiles: [{ id: profile, name: 'Personal', color: 'amber', createdAt: 10, store: { ...emptySyncStore(), favorites: { bar: untouched, other: [] } }, desktop: emptySyncDesktop(), windows: [] }] };
  const capture = value => snapshotRecords(value, mapping, device, () => { throw new Error('No images'); }, 'Synthetic computer').filter(record => record.item === 'favorites');
  const baseline = new Map(capture(snapshot).map(record => [recordId(record), operation(record)]));
  const changes = inserted.map((entry, index) => {
    const next = structuredClone(snapshot); next.profiles[0].store.favorites.bar.unshift(entry);
    return capture(next).map(record => operation(record, { base: baseline.get(recordId(record))?.id ?? null, time: 200 + index }));
  });
  for (const [local, remote] of [[changes[0], changes[1]], [changes[1], changes[0]]]) {
    const records = new Map(baseline), conflicts = new Map();
    for (const change of local) mergeOperation(records, change, conflicts);
    // The sealed package decoder parses canonical JSON, unlike a local snapshot.
    for (const change of remote) mergeOperation(records, JSON.parse(canonical(change)), conflicts);
    assert.deepEqual([...conflicts.values()].map(recordTitle), []);
    const projected = projectSnapshot(snapshot, { ...mapping }, [...records.values()], switches);
    assert.deepEqual(new Set(projected.profiles[0].store.favorites.bar.map(entry => entry.id)), new Set([...untouched, ...inserted].map(entry => entry.id)));
  }
});

test('a real favorite conflict keeps the losing record title and preserves unrelated favorites', () => {
  const profile = randomUUID(), unrelated = operation(favoriteRecord(profile, favorite('Unrelated favorite'))), original = operation(favoriteRecord(profile, favorite('Original favorite')));
  const first = operation({ ...original, value: { ...original.value, entry: { ...original.value.entry, title: 'Losing rename' } } }, { base: original.id, time: 200 });
  const second = operation({ ...original, value: { ...original.value, entry: { ...original.value.entry, title: 'Winning rename' } } }, { base: original.id, time: 300 });
  const records = new Map([[recordId(unrelated), unrelated], [recordId(original), first]]), conflicts = new Map();
  mergeOperation(records, JSON.parse(canonical(second)), conflicts);
  assert.deepEqual([...conflicts.values()].map(record => [record.key, recordTitle(record)]), [[original.key, 'Losing rename']]);
  assert.equal(recordTitle(records.get(recordId(unrelated))), 'Unrelated favorite');
});

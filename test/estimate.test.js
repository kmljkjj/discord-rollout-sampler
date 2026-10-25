'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const est = require('../src/estimate');

// ---- wilsonInterval ----

test('wilsonInterval(50, 100) ≈ 50 % ± ~10 points', () => {
  const ci = est.wilsonInterval(50, 100);
  assert.equal(ci.valid, true);
  assert.equal(ci.mid, 0.5);
  assert.ok(ci.low > 0.4 && ci.low < 0.41, 'low=' + ci.low);
  assert.ok(ci.high > 0.59 && ci.high < 0.6, 'high=' + ci.high);
});

test('wilsonInterval(0, 100) → mid=0, low=0', () => {
  const ci = est.wilsonInterval(0, 100);
  assert.equal(ci.valid, true);
  assert.equal(ci.mid, 0);
  assert.ok(ci.low < 1e-12);
  assert.ok(ci.high > 0);
});

test('wilsonInterval : plus d’échantillons = intervalle plus étroit', () => {
  const small = est.wilsonInterval(500, 1000);
  const big = est.wilsonInterval(5000, 10000);
  assert.ok(big.high - big.low < small.high - small.low);
});

test('wilsonInterval(5, 0) invalide', () => {
  const ci = est.wilsonInterval(5, 0);
  assert.equal(ci.valid, false);
});

// ---- tLabel ----

test('tLabel : -1 → None, 0 → Control, 2 → Variant 2', () => {
  assert.equal(est.tLabel(-1), 'None');
  assert.equal(est.tLabel(0), 'Control');
  assert.equal(est.tLabel(2), 'Variant 2');
});

// ---- aggregateRun ----

test('aggregateRun agrège hash/bucket/positions et ignore les entrées invalides', () => {
  const byHash = est.aggregateRun([
    [111, 1, 0, null, null, 1234],
    [111, 1, 2, null, null, 500],
    [222, 3, 1, null, null, 42],
    [111, 1, 0, null, null, 900],
    [333, 1],
    'pas un tableau',
  ]);
  assert.equal(byHash.size, 2);
  const h111 = byHash.get(111);
  assert.equal(h111.total, 3);
  const b0 = h111.buckets.get(0);
  assert.equal(b0.n, 2);
  assert.equal(b0.posMin, 900);
  assert.equal(b0.posMax, 1234);
  const b2 = h111.buckets.get(2);
  assert.equal(b2.n, 1);
  assert.equal(byHash.get(222).total, 1);
  assert.equal(byHash.has(333), false);
});

// ---- mergeWindow ----

test('mergeWindow : fenêtre glissante des k derniers runs', () => {
  const mk = (total, buckets) => ({ total, buckets });
  const runRecords = [
    mk(10, { 0: { n: 10, posMin: 5, posMax: 50 }, 1: { n: 0, posMin: null, posMax: null } }),
    mk(10, { 0: { n: 7, posMin: 1, posMax: 99 } }),
    mk(10, { 0: { n: 10, posMin: 2, posMax: 40 }, 1: { n: 3, posMin: 7, posMax: 70 } }),
  ];
  const w = est.mergeWindow(runRecords, 2);
  assert.equal(w.total, 20);
  assert.equal(w.buckets.length, 2);
  const b0 = w.buckets[0];
  assert.equal(b0.bucket, 0);
  assert.equal(b0.n, 17);
  assert.equal(b0.posMin, 1);
  assert.equal(b0.posMax, 99);
  const b1 = w.buckets[1];
  assert.equal(b1.n, 3);
  assert.equal(b1.posMax, 70);
});

// ---- estimatePcts ----

test('estimatePcts : % par bucket + marge, [] si données insuffisantes', () => {
  const window = { total: 20, buckets: [{ bucket: 0, n: 17 }, { bucket: 1, n: 3 }] };
  const pcts = est.estimatePcts(window, 10);
  assert.equal(pcts.length, 2);
  assert.equal(pcts[0].bucket, 0);
  assert.equal(pcts[0].label, 'Control');
  assert.equal(pcts[0].pct, 85);
  assert.equal(pcts[0].n, 17);
  assert.ok(pcts[0].ciPct > 0);
  assert.equal(pcts[1].bucket, 1);
  assert.equal(pcts[1].label, 'Variant 1');
  assert.equal(pcts[1].pct, 15);
  assert.deepEqual(est.estimatePcts(window, 50), []);
});

// ---- classifyChange ----

test('classifyChange : premier mesurage → kind=new', () => {
  const pcts = [
    { bucket: 0, label: 'Control', pct: 88.9, ciPct: 2.1 },
    { bucket: 1, label: 'Variant 1', pct: 11.1, ciPct: 2.1 },
  ];
  const cls = est.classifyChange(null, pcts, 2);
  assert.equal(cls.kind, 'new');
  assert.equal(cls.deltas.length, 1);
  assert.equal(cls.deltas[0].bucket, 1);
  assert.equal(cls.deltas[0].from, 0);
  assert.equal(cls.deltas[0].to, 11.1);
});

test('classifyChange : premier mesurage sans variant (Control seul) → none', () => {
  const pcts = [{ bucket: 0, label: 'Control', pct: 100, ciPct: 0.4 }];
  const cls = est.classifyChange(null, pcts, 2);
  assert.equal(cls.kind, 'none');
  assert.equal(cls.deltas.length, 0);
});

test('classifyChange : delta ≥ minDelta seulement', () => {
  const announced = { 0: 10, 1: 5 };
  const pcts = [
    { bucket: 0, label: 'Control', pct: 10.5, ciPct: 1 },
    { bucket: 1, label: 'Variant 1', pct: 9.1, ciPct: 1 },
  ];
  const cls = est.classifyChange(announced, pcts, 2);
  assert.equal(cls.kind, 'pct');
  assert.equal(cls.deltas.length, 1);
  assert.equal(cls.deltas[0].bucket, 1);
  assert.equal(cls.deltas[0].from, 5);
  assert.equal(cls.deltas[0].to, 9.1);
});

test('classifyChange : rien de significatif → none', () => {
  const announced = { 0: 10 };
  const pcts = [{ bucket: 0, label: 'Control', pct: 10.5, ciPct: 1 }];
  const cls = est.classifyChange(announced, pcts, 2);
  assert.equal(cls.kind, 'none');
  assert.equal(cls.deltas.length, 0);
});

test('classifyChange : bucket qui apparaît compte comme delta', () => {
  const announced = { 0: 100 };
  const pcts = [
    { bucket: 0, label: 'Control', pct: 92.1, ciPct: 1 },
    { bucket: 1, label: 'Variant 1', pct: 7.9, ciPct: 1 },
  ];
  const cls = est.classifyChange(announced, pcts, 2);
  assert.equal(cls.kind, 'pct');
  assert.equal(cls.deltas.length, 2);
  const d1 = cls.deltas.find((d) => d.bucket === 1);
  assert.equal(d1.from, 0);
  assert.equal(d1.to, 7.9);
});

// ---- nameFor ----

test('nameFor : map connue sinon hash:<hash>', () => {
  const names = { '2026_abc': 'Test Experiment' };
  assert.equal(est.nameFor('2026_abc', names), 'Test Experiment');
  assert.equal(est.nameFor(999, names), 'hash:999');
});

// ---- computeSegments / mergeSegments / segmentsPct (reconstruction de ranges) ----

test('computeSegments : positions triées -> segments fusionnés (tolérance 150)', () => {
  assert.deepEqual(est.computeSegments([200, 0, 5, 10, 5000, 205], 150), [
    [0, 10],
    [200, 205],
    [5000, 5000],
  ]);
  assert.deepEqual(est.computeSegments([], 150), []);
  assert.deepEqual(est.computeSegments([42], 150), [[42, 42]]);
  // écart > tolérance -> deux segments distincts
  assert.deepEqual(est.computeSegments([0, 10, 200], 150), [
    [0, 10],
    [200, 200],
  ]);
});

test('mergeSegments : union de segments multi-runs avec fusion', () => {
  const merged = est.mergeSegments([
    [[0, 100], [400, 500]],
    [[150, 200]],
  ], 150);
  assert.deepEqual(merged, [
    [0, 200],
    [400, 500],
  ]);
  assert.deepEqual(est.mergeSegments([], 150), []);
});

test('segmentsPct : % couvert par les segments (échelle 10000)', () => {
  assert.equal(est.segmentsPct([[0, 4999]]), 50);
  assert.equal(est.segmentsPct([[0, 999], [8000, 8999]]), 20);
  assert.equal(est.segmentsPct([]), 0);
});

test('mergeWindow : union des segments de ranges sur la fenêtre', () => {
  const runRecords = [
    { total: 10, buckets: { 1: { n: 5, posMin: 100, posMax: 400, segments: [[100, 400]] } } },
    { total: 10, buckets: { 1: { n: 5, posMin: 350, posMax: 700, segments: [[350, 700]] } } },
    { total: 10, buckets: { 1: { n: 5, posMin: 900, posMax: 950, segments: [[900, 950]] } } },
  ];
  const w = est.mergeWindow(runRecords, 3);
  const b1 = w.buckets[0];
  assert.equal(b1.bucket, 1);
  assert.equal(b1.n, 15);
  assert.deepEqual(b1.segments, [
    [100, 700],
    [900, 950],
  ]);
});

test('mergeWindow : records sans segments (ancien état) -> segments=[]', () => {
  const w = est.mergeWindow([{ total: 5, buckets: { 0: { n: 5, posMin: 1, posMax: 2 } } }], 3);
  assert.deepEqual(w.buckets[0].segments, []);
});

test('estimatePcts : inclut segments + segPct reconstruits', () => {
  const window = {
    total: 20,
    buckets: [{ bucket: 1, n: 3, segments: [[8000, 8999]] }],
  };
  const pcts = est.estimatePcts(window, 10);
  assert.equal(pcts[0].bucket, 1);
  assert.equal(pcts[0].pct, 15);
  assert.deepEqual(pcts[0].segments, [[8000, 8999]]);
  assert.equal(pcts[0].segPct, 10);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const sampler = require('../src/sampler');

// ---- Fakes ----

function okResponse(assignments) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ fingerprint: 'fp', assignments }),
    text: async () => '',
  };
}

function rateLimitedResponse() {
  return {
    ok: false,
    status: 429,
    headers: { get: (n) => (n === 'retry-after' ? '1' : null) },
    json: async () => ({}),
    text: async () => '429',
  };
}

const ASSIGNMENTS = [
  [111, 1, 0, null, null, 9500],
  [111, 1, 2, null, null, 200],
  [222, 3, 1, null, null, 7000],
];

const BASE_OPTS = {
  fetchImpl: async () => okResponse(ASSIGNMENTS),
  sleepImpl: async () => {},
  ridImpl: () => 'test-rid',
  concurrency: 1,
  delayMs: 0,
  maxMs: 60000,
  log: () => {},
};

// ---- sampleLoop ----

test('sampleLoop : agrège les fingerprints sondés', async () => {
  const r = await sampler.sampleLoop({ ...BASE_OPTS, target: 3 });
  assert.equal(r.ok, 3);
  assert.equal(r.fail, 0);
  assert.equal(r.stopReason, null);
  const h111 = r.byHash.get(111);
  assert.equal(h111.total, 6); // 2 entrées hash 111 × 3 réponses
  assert.equal(h111.buckets.get(0).n, 3);
  assert.equal(h111.buckets.get(0).posMin, 9500);
  assert.equal(h111.buckets.get(2).n, 3);
  const h222 = r.byHash.get(222);
  assert.equal(h222.total, 3);
});

test('sampleLoop : un 429 compte comme échec, les suivants passent', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls === 1 ? rateLimitedResponse() : okResponse(ASSIGNMENTS);
  };
  const r = await sampler.sampleLoop({ ...BASE_OPTS, fetchImpl, target: 3, now: () => 0 });
  assert.equal(calls, 3);
  assert.equal(r.ok, 2);
  assert.equal(r.fail, 1);
  assert.equal(r.stopReason, null);
});

test('sampleLoop : arrêt sur budget expiré', async () => {
  let t = 1000;
  const r = await sampler.sampleLoop({
    ...BASE_OPTS,
    target: 3,
    now: () => (t += 100),
    maxMs: 200,
  });
  assert.equal(r.ok, 1);
  assert.equal(r.stopReason, 'budget');
});

// ---- toRunRecord ----

test('toRunRecord : Maps → objets sérialisables', () => {
  const run = {
    total: 2,
    buckets: new Map([
      [0, { n: 1, posMin: 10, posMax: 20 }],
      [1, { n: 1, posMin: 30, posMax: 40 }],
    ]),
  };
  const rec = sampler.toRunRecord(run);
  assert.deepEqual(rec, {
    total: 2,
    buckets: {
      0: { n: 1, posMin: 10, posMax: 20 },
      1: { n: 1, posMin: 30, posMax: 40 },
    },
  });
});

// ---- buildChangeEmbeds ----

test('buildChangeEmbeds : lignes de deltas + footer indépendant', () => {
  const embeds = sampler.buildChangeEmbeds([
    {
      name: '2026-test-exp',
      kind: 'pct',
      deltas: [{ label: 'Variant 1', from: 3.2, to: 8.8, ciPct: 0.9 }],
      windowTotal: 3600,
    },
  ]);
  assert.equal(embeds.length, 1);
  assert.equal(embeds[0].title, '2026-test-exp (user · sampled)');
  assert.equal(embeds[0].description, 'Variant 1 3.2% -> 8.8% (±0.9)');
  assert.ok(embeds[0].footer.text.includes('n=3600'));
  assert.ok(embeds[0].footer.text.includes('mesure indépendante'));
});

// ---- labReportEmbed ----

test('labReportEmbed : rapport de run, source = API Discord uniquement', () => {
  const e = sampler.labReportEmbed({
    ok: 1198,
    fail: 2,
    hashes: 42,
    measured: 30,
    changes: 1,
    elapsed: 210,
    stopReason: null,
    isFirst: false,
  });
  assert.ok(e.description.includes('Fingerprints sondés'));
  assert.ok(e.description.includes('API Discord uniquement'));
  assert.ok(e.description.includes('**1198**'));
});

// ---- postWebhook ----

test('postWebhook : POST JSON avec username + embeds', async () => {
  let got = null;
  const fetchImpl = async (url, opts) => {
    got = { url, body: JSON.parse(opts.body) };
    return { ok: true, status: 204, text: async () => '' };
  };
  const embeds = [{ title: 'x', description: 'y', color: 1, footer: { text: 'f' } }];
  const r = await sampler.postWebhook('https://discord.example/hook', embeds, fetchImpl);
  assert.equal(r.ok, true);
  assert.equal(r.status, 204);
  assert.equal(got.url, 'https://discord.example/hook');
  assert.equal(got.body.username, 'Rollouts Sampler');
  assert.deepEqual(got.body.embeds, embeds);
});

test('postWebhook : erreur réseau → ok=false', async () => {
  const fetchImpl = async () => {
    throw new Error('boom');
  };
  const r = await sampler.postWebhook('https://discord.example/hook', [], fetchImpl);
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.equal(r.text, 'boom');
});

test('labReportEmbed : liste les expériences mesurées avec nom et %', () => {
  const e = sampler.labReportEmbed({
    ok: 496, fail: 4, hashes: 5, measured: 5, changes: 0, elapsed: 420, stopReason: null, isFirst: false,
    experiments: [
      { name: '2023-09_iar_user_reporting', summary: 'Variant 1 100%' },
      { name: 'hash:704914099', summary: 'Variant 1 6%' },
    ],
  });
  assert.ok(e.description.includes('2023-09_iar_user_reporting : Variant 1 100%'));
  assert.ok(e.description.includes('hash:704914099 : Variant 1 6%'));
});

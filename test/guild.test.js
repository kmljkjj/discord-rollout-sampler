'use strict';

const test = require('node:test');
const assert = require('node:assert');
const g = require('../src/guild');

test('mergedWidth / rangesToPct : intervalles, fusion, cas limites', () => {
  assert.strictEqual(g.rangesToPct([[0, 5000]]), 50);
  assert.strictEqual(g.rangesToPct([{ s: 0, e: 3000 }, { s: 2000, e: 5000 }]), 50);
  assert.strictEqual(g.rangesToPct([[0, 10000]]), 100);
  assert.strictEqual(g.rangesToPct([]), 0);
  assert.strictEqual(g.rangesToPct([[6000, 5000]]), 0);
  assert.strictEqual(g.rangesToPct([[0, 3000], [4000, 5000]]), 40);
  assert.strictEqual(g.mergedWidth([[0, 4000], [3000, 6000]]), 6000);
});

test('decodeGuildWire : tuple complet avec clé', () => {
  const positions = [
    [0, [[0, 10000]]],
    [1, [[0, 6000]]],
  ];
  const tuple = [123456789, '2024-01_test_guild', 3, [[positions]], []];
  const e = g.decodeGuildWire(tuple, () => null);
  assert.strictEqual(e.id, '2024-01_test_guild');
  assert.strictEqual(e.hash, 123456789);
  const control = e.treatments.find((t) => t.bucket === 0);
  const v1 = e.treatments.find((t) => t.bucket === 1);
  assert.strictEqual(control.pct, 100);
  assert.strictEqual(v1.pct, 60);
  assert.strictEqual(v1.label, 'Variant 1');
  assert.ok(e.fingerprint.includes('0:100.0'));
});

test('decodeGuildWire : sans clé -> nom connu puis hash:', () => {
  const tuple = [999, null, 1, [[[[0, [[0, 2500]]]]]], []];
  const e = g.decodeGuildWire(tuple, (h) => (String(h) === '999' ? 'nom_connu' : null));
  assert.strictEqual(e.id, 'nom_connu');
  const e2 = g.decodeGuildWire(tuple, () => null);
  assert.strictEqual(e2.id, 'hash:999');
  assert.strictEqual(e2.treatments[0].label, 'Control');
  assert.strictEqual(e2.treatments[0].pct, 25);
});

test('decodeGuildWire : tuples invalides -> null', () => {
  assert.strictEqual(g.decodeGuildWire(null, () => null), null);
  assert.strictEqual(g.decodeGuildWire([1, 2], () => null), null);
  assert.strictEqual(g.decodeGuildWire([1, 'x', 0, [], []], () => null), null);
});

test('diffGuildExperiments : delta >= seuil uniquement, seed et hash silencieux', () => {
  const prev = [
    { id: 'a', treatments: [{ bucket: 1, pct: 50 }] },
    { id: 'hash:7', treatments: [{ bucket: 1, pct: 10 }] },
  ];
  const next = [
    { id: 'a', treatments: [{ bucket: 1, pct: 55 }] },
    { id: 'hash:7', treatments: [{ bucket: 1, pct: 40 }] },
    { id: 'b', treatments: [{ bucket: 1, pct: 10 }] },
  ];
  const ch = g.diffGuildExperiments(prev, next, 2);
  assert.strictEqual(ch.length, 1);
  assert.strictEqual(ch[0].id, 'a');
  assert.strictEqual(ch[0].deltas[0].from, 50);
  assert.strictEqual(ch[0].deltas[0].to, 55);
  const none = g.diffGuildExperiments(prev, [{ id: 'a', treatments: [{ bucket: 1, pct: 51 }] }], 2);
  assert.strictEqual(none.length, 0);
});

test('fetchGuildExperiments : ok, vide, erreur', async () => {
  const okRes = {
    ok: true,
    status: 200,
    json: async () => ({ guild_experiments: [[42, 'x_test', 1, [[[[0, [[0, 10000]]]]]], []]] }),
  };
  const r = await g.fetchGuildExperiments(async () => okRes, () => null);
  assert.strictEqual(r.list.length, 1);
  assert.strictEqual(r.source, 'canary');

  const emptyRes = { ok: true, status: 200, json: async () => ({ guild_experiments: [] }) };
  assert.strictEqual(await g.fetchGuildExperiments(async () => emptyRes, () => null), null);

  assert.strictEqual(
    await g.fetchGuildExperiments(async () => {
      throw new Error('boom');
    }, () => null),
    null
  );
});

test('guildChangeEmbed : forme de l embed', () => {
  const e = g.guildChangeEmbed({ id: 'a', deltas: [{ label: 'Variant 1', from: 50, to: 60, delta: 10 }] });
  assert.ok(e.title.includes('guild'));
  assert.ok(e.description.includes('Variant 1 50% -> 60%'));
  assert.ok(e.footer.text.includes('EXACT'));
});

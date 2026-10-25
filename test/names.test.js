'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const names = require('../src/names');

// ---- Fonctions pures ----

test('extractAssetUrls : assets JS du HTML (relatifs, absolus, query), pas le CSS', () => {
  const html = [
    '<script src="/assets/web.abc123.js"></script>',
    '<script src="https://canary.discord.com/assets/123.def456.js?v=2"></script>',
    '<link rel="stylesheet" href="/assets/styles.aaa.css">',
    '<script src="/assets/sentry.xyz789.js"></script>',
  ].join('\n');
  const urls = names.extractAssetUrls(html, 'https://canary.discord.com');
  assert.deepEqual(urls.sort(), [
    'https://canary.discord.com/assets/123.def456.js',
    'https://canary.discord.com/assets/sentry.xyz789.js',
    'https://canary.discord.com/assets/web.abc123.js',
  ]);
  assert.deepEqual(names.extractAssetUrls('', 'https://x.example'), []);
});

test('parseBuildNumber : GLOBAL_ENV du shell', () => {
  const html = 'window.GLOBAL_ENV={"BUILD_NUMBER":"650180","RELEASE_CHANNEL":"canary"}';
  assert.equal(names.parseBuildNumber(html), '650180');
  assert.equal(names.parseBuildNumber('rien a voir'), null);
});

test('extractChunkMap : paires chunkId -> hash, ignore les gros nombres (snowflakes)', () => {
  const js = 'n={123:"abcdef",45:"0123abcd",9999999999999999999:"abcdef",7:"9x8y7z"}';
  const m = names.extractChunkMap(js, 0);
  assert.equal(m.get('123'), 'abcdef');
  assert.equal(m.get('45'), '0123abcd');
  assert.equal(m.get('7'), '9x8y7z');
  assert.ok(!m.has('9999999999999999999'));
  // seuil minChars : les petits fichiers ne sont pas scannés pour la table
  assert.equal(names.extractChunkMap(js, 1000).size, 0);
  assert.equal(names.extractChunkMap(js).size, 0); // défaut : 100000 chars
});

test('extractExperimentIds : ids cités (guillemets simples/doubles/backticks), bruit ignoré', () => {
  const js = [
    'a("2026-10-macaron")',
    "b('2023-09_iar_user_reporting')",
    'c(`2025-08_default_invite_expiration_guild`)',
    'd("2026-10-25")', // une date : nom trop court -> ignoré
    'e("2026-10-25T12")', // commence par un chiffre -> ignoré
    'f(2026-10-pas_quoted)',
    'g("2026_10_badseparator")', // année_mois : pas un id d expérience
  ].join(';');
  const ids = names.extractExperimentIds(js);
  assert.deepEqual(ids.sort(), [
    '2023-09_iar_user_reporting',
    '2025-08_default_invite_expiration_guild',
    '2026-10-macaron',
  ]);
});

test('buildNamesMap : murmur3 de chaque id -> map hash', () => {
  const map = names.buildNamesMap(['2023-09_iar_user_reporting', '', '  ']);
  assert.deepEqual(map, { '2180379513': '2023-09_iar_user_reporting' });
});

test('isFresh : TTL par canal (scannedAt de chaque channel)', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  const cache = {
    channels: {
      canary: { scannedAt: '2026-10-25T08:00:00Z' },
      stable: { scrapedAt: null }, // pas de scannedAt -> périmé
    },
  };
  assert.equal(names.isFresh(cache, now, 12, ['canary']), true);
  assert.equal(names.isFresh(cache, now, 12, ['canary', 'stable']), false);
  assert.equal(names.isFresh({ channels: { canary: { scrapedAt: '2026-10-25T08:00:00Z' } } }, now, 12, ['canary']), false);
  assert.equal(names.isFresh(null, now, 12, ['canary']), false);
  assert.equal(names.isFresh({ channels: {} }, now, 12, []), false);
});

// ---- scanChannel (fetchImpl mocké) ----

function okText(t) {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => t };
}

test('scanChannel : HTML -> assets -> table des chunks -> ids', async () => {
  const html =
    '<script src="/assets/web.aaa111.js"></script>' +
    '<script>window.GLOBAL_ENV={"BUILD_NUMBER":"650180"}</script>';
  const webJs = 'n={777:"abc123"};e("2026-10-macaron")';
  const chunkJs = 'e("2023-09_iar_user_reporting")';
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/app')) return okText(html);
    if (url.endsWith('/assets/web.aaa111.js')) return okText(webJs);
    if (url.endsWith('/assets/777.abc123.js')) return okText(chunkJs);
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  };
  const r = await names.scanChannel(fetchImpl, 'canary', {
    now: () => 0,
    deadline: 1000,
    conc: 2,
    chunkMapMinChars: 0,
  });
  assert.equal(r.ok, true);
  assert.equal(r.buildNumber, '650180');
  assert.equal(r.assets, 1);
  assert.equal(r.chunks, 1);
  assert.equal(r.fetched, 2);
  assert.equal(r.failed, 0);
  assert.deepEqual(r.ids.sort(), ['2023-09_iar_user_reporting', '2026-10-macaron']);
  assert.ok(calls.includes('https://canary.discord.com/assets/777.abc123.js'));
});

test('scanChannel : /app injoignable -> ok=false, ids vides', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => '' });
  const r = await names.scanChannel(fetchImpl, 'ptb', { now: () => 0, conc: 1 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.ids, []);
});

// ---- loadNames (intégration, fetchImpl mocké) ----

test('loadNames : tous les canaux frais -> aucun réseau', async () => {
  const recent = new Date(Date.now() - 3600000).toISOString();
  const state = {
    names: {
      version: 1,
      channels: { canary: { scrapedAt: null, scannedAt: recent, buildNumber: '650180', ids: 3 } },
      lastSeen: { '2026-10-macaron': recent },
    },
  };
  const res = await names.loadNames({
    fetchImpl: async () => {
      throw new Error('le cache frais ne doit declencher aucun fetch');
    },
    state,
    ttlH: 12,
    channels: ['canary'],
  });
  assert.equal(res.info.source, 'cache');
  assert.equal(res.map['2368433424'], '2026-10-macaron'); // murmur3("2026-10-macaron")
  assert.ok(res.labLine.includes('cache'));
});

test('loadNames : canal périmé -> rescan, fallback liste, ids anciens conservés', async () => {
  const html =
    '<script src="/assets/web.aaa111.js"></script>' +
    '<script>window.GLOBAL_ENV={"BUILD_NUMBER":"650180"}</script>';
  const fetchImpl = async (url) => {
    if (url.endsWith('/app')) return okText(html);
    if (url.endsWith('/assets/web.aaa111.js')) return okText('e("2026-10-macaron")');
    if (url === 'https://list.example/ids.json') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ['2025-11_tida_webform'],
        text: async () => '',
      };
    }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  };
  const state = {
    names: {
      version: 1,
      channels: { canary: { scannedAt: '2026-10-01T00:00:00Z' } }, // périmé -> rescan
      lastSeen: { '2023-09_iar_user_reporting': '2026-10-24T00:00:00Z' }, // récent -> conservé
    },
  };
  const now = Date.parse('2026-10-25T12:00:00Z');
  const res = await names.loadNames({
    fetchImpl,
    state,
    now: () => now,
    ttlH: 12,
    channels: ['canary'],
    keepDays: 30,
    fallbackUrl: 'https://list.example/ids.json',
  });
  assert.equal(res.info.source, 'scan');
  assert.equal(res.map['2368433424'], '2026-10-macaron'); // scan
  assert.equal(res.map['4055210228'], '2025-11_tida_webform'); // fallback
  assert.equal(res.map['2180379513'], '2023-09_iar_user_reporting'); // conservé (30 j)
  assert.ok(res.labLine.includes('scan auto'));
  // canal rescanné -> marqué frais pour le prochain run
  assert.equal(state.names.channels.canary.scannedAt, '2026-10-25T12:00:00.000Z');
  assert.equal(state.names.channels.canary.buildNumber, '650180');
  assert.ok(state.names.lastSeen['2026-10-macaron']);
  assert.ok(state.names.lastSeen['2025-11_tida_webform']);
});

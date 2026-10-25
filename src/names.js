'use strict';

/**
 * Recherche de noms — le sampler scanne LUI-MÊME les builds publics du
 * client web Discord (canary / ptb / stable) pour y trouver les ids
 * d'expériences, puis construit la map hash -> nom (murmur3 de l'id).
 *
 * Méthode (identique à celle des trackers, mais 100 % autonome — aucune
 * source communautaire, uniquement les builds publics de Discord) :
 *   1. GET https://<canary|ptb>.discord.com/app (ou https://discord.com/app)
 *      -> HTML du shell : URLs d'entrée /assets/*.js
 *   2. ces JS contiennent la table des chunks webpack { chunkId: "hash" }
 *      -> URLs /assets/{chunkId}.{hash}.js
 *   3. on scanne tous ces fichiers et on en extrait les ids d'expériences
 *      ("2026-10-macaron", "2023-09_iar_user_reporting", ...)
 *   4. map : murmur3(id) -> id. Un hash observé dans l'API mais absent du
 *      build = expérience sans code client : personne ne peut la nommer,
 *      hash:NNNN reste l'affichage honnête (cf. README, « Nommage des hash »).
 *
 * Le résultat est mis en cache dans l'état (state.names), canal par canal :
 * chaque canal (canary/ptb/stable) est rescanné au plus toutes les TTL_H
 * heures. Les ids déjà vus restent KEEP_DAYS jours — une expérience retirée
 * du build garde son nom le temps de la fin de son rollout. Fallback : la
 * liste d'ids du dépôt (SAMPLER_NAMES_URL) — jamais une source communautaire.
 *
 * Env :
 *   SAMPLER_NAMES_TTL_H (12), SAMPLER_NAMES_MAX_MS (300000),
 *   SAMPLER_NAMES_CONCURRENCY (8), SAMPLER_NAMES_CHANNELS ('canary,stable,ptb'),
 *   SAMPLER_NAMES_KEEP_DAYS (30), SAMPLER_NAMES_MAX_CHUNKS (2500),
 *   SAMPLER_NAMES_MAX_BYTES (67108864), SAMPLER_NAMES_URL (fallback),
 *   SAMPLER_UA
 */

const { murmur3 } = require('./murmur3');

function envNum(name, dflt, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

const DEFAULTS = {
  ttlH: envNum('SAMPLER_NAMES_TTL_H', 12, 0.5, 168),
  maxMs: envNum('SAMPLER_NAMES_MAX_MS', 300000, 30000, 900000),
  conc: envNum('SAMPLER_NAMES_CONCURRENCY', 8, 1, 16),
  keepDays: envNum('SAMPLER_NAMES_KEEP_DAYS', 30, 1, 365),
  maxChunks: envNum('SAMPLER_NAMES_MAX_CHUNKS', 2500, 50, 20000),
  // Le bundle principal du client fait 10-30 Mo : la garde doit être LARGE,
  // sinon on rejette précisément le fichier qui contient les ids
  // d'expériences et la table des chunks (bug du 1er scan : 0 id, 8 chunks).
  maxBytes: envNum('SAMPLER_NAMES_MAX_BYTES', 64 * 1024 * 1024, 1024 * 1024, 512 * 1024 * 1024),
  channels: String(process.env.SAMPLER_NAMES_CHANNELS || 'canary,stable,ptb')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  fallbackUrl:
    process.env.SAMPLER_NAMES_URL ||
    'https://raw.githubusercontent.com/kmljkjj/discord-rollout-sampler/main/data/known_experiment_ids.json',
  ua:
    process.env.SAMPLER_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

/**
 * Version du cache state.names : un bump invalide les caches existants
 * (rescan complet au run suivant) — utilisé quand le comportement du scan
 * change (ex. garde de taille corrigée : 16 Mo -> 64 Mo).
 */
const CACHE_VERSION = 2;

// ---- Fonctions pures (testables) ----

/** URLs des JS d'entrée listés dans le HTML du shell (/app). */
function extractAssetUrls(html, base) {
  const urls = new Set();
  const re = /(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const clean = m[1].split('?')[0].split('#')[0];
    if (!clean.endsWith('.js')) continue; // CSS et autres exclus ici
    urls.add(clean.startsWith('http') ? clean : base + (clean.startsWith('/') ? clean : '/' + clean));
  }
  return [...urls];
}

/** BUILD_NUMBER du GLOBAL_ENV du HTML du shell. */
function parseBuildNumber(html) {
  const m = String(html || '').match(/"BUILD_NUMBER"\s*:\s*"?(\d{4,12})"?/);
  return m ? m[1] : null;
}

/**
 * Table des chunks webpack { chunkId: "hash" } extraite d'un JS d'entrée.
 * Clés de plus de 5 chiffres (snowflakes Discord, etc.) ignorées — seuls de
 * vrais chunkIds donnent des URLs qui existent, les faux font un 404 bon marché.
 */
function extractChunkMap(jsText, minChars) {
  const out = new Map();
  const text = String(jsText || '');
  const min = minChars == null ? 100000 : minChars;
  if (text.length < min) return out;
  const re = /[{,](\d{1,5})\s*:\s*"([a-z0-9]{6,16})"/g;
  let m;
  while ((m = re.exec(text))) out.set(m[1], m[2]);
  return out;
}

/** Ids d'expériences cités dans du JS client (chaînes quotées, nom en lettres). */
function extractExperimentIds(text) {
  const out = new Set();
  const re = /["'`]((?:19|20)\d{2}-\d{1,2}[-_][A-Za-z][A-Za-z0-9_-]{2,79})["'`]/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.add(m[1]);
  return [...out];
}

/** Map hash -> nom : murmur3 de chaque id. */
function buildNamesMap(ids) {
  const map = {};
  for (const id of ids || []) {
    const clean = String(id).trim();
    if (!clean) continue;
    map[String(murmur3(clean))] = clean;
  }
  return map;
}

/**
 * Cache frais ? Chaque canal listé doit avoir été scanné il y a moins de
 * ttlH heures (state.names.channels[ch].scannedAt).
 */
function isFresh(cache, nowMs, ttlH, channels) {
  if (!cache || !cache.channels || typeof cache.channels !== 'object') return false;
  const list = (channels || []).length ? channels : Object.keys(cache.channels);
  if (!list.length) return false;
  for (const ch of list) {
    const t = Date.parse(cache.channels[ch] && cache.channels[ch].scannedAt);
    if (!Number.isFinite(t) || nowMs - t >= ttlH * 3600 * 1000) return false;
  }
  return true;
}

// ---- Réseau (fetchImpl injectable -> testable) ----

function channelHost(channel) {
  if (channel === 'stable') return 'https://discord.com';
  return 'https://' + String(channel) + '.discord.com';
}

async function fetchText(fetchImpl, url, opts) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': opts.ua, Accept: '*/*' },
    timeout: opts.timeoutMs || 20000,
  });
  if (!res || !res.ok) return null;
  const cl = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0);
  if (cl > opts.maxBytes) return null;
  const text = await res.text();
  if (!text || text.length < 16) return null;
  if (!opts.allowHtml && text.slice(0, 80).match(/^\s*</)) return null; // du HTML au lieu du JS
  if (text.length * 2 > opts.maxBytes) return null;
  return text;
}

/**
 * Scanne UN canal (canary/ptb/stable) : HTML /app -> assets d'entrée ->
 * table des chunks -> tous les chunks. Budget temps partagé (deadline) :
 * un scan coupé n'est pas marqué frais, il sera refait au run suivant et
 * les ids déjà vus restent (union via lastSeen).
 */
async function scanChannel(fetchImpl, channel, opts) {
  const o = opts || {};
  const cfg = {
    now: o.now || (() => Date.now()),
    ua: o.ua || DEFAULTS.ua,
    conc: o.conc || DEFAULTS.conc,
    deadline: o.deadline,
    maxBytes: o.maxBytes || DEFAULTS.maxBytes,
    maxChunks: o.maxChunks || DEFAULTS.maxChunks,
    chunkMapMinChars: o.chunkMapMinChars != null ? o.chunkMapMinChars : 100000,
  };
  const out = {
    channel,
    ok: false,
    cut: false,
    buildNumber: null,
    assets: 0,
    chunks: 0,
    fetched: 0,
    failed: 0,
    ids: [],
  };
  const ids = new Set();
  const seen = new Set();
  const queue = [];
  const chunkMap = new Map();

  let html = null;
  try {
    html = await fetchText(fetchImpl, channelHost(channel) + '/app', {
      ...cfg,
      allowHtml: true,
      maxBytes: 4 * 1024 * 1024,
    });
  } catch (e) {
    html = null;
  }
  if (!html) return out;
  out.buildNumber = parseBuildNumber(html);
  for (const u of extractAssetUrls(html, channelHost(channel))) {
    if (!seen.has(u)) {
      seen.add(u);
      queue.push(u);
    }
  }
  out.assets = queue.length;

  async function worker() {
    while (queue.length) {
      if (cfg.deadline != null && cfg.now() > cfg.deadline) {
        out.cut = true;
        return;
      }
      const url = queue.shift();
      let text = null;
      try {
        text = await fetchText(fetchImpl, url, cfg);
      } catch (e) {
        text = null;
      }
      if (text == null) {
        out.failed++;
        continue;
      }
      out.fetched++;
      for (const id of extractExperimentIds(text)) ids.add(id);
      for (const [id, hash] of extractChunkMap(text, cfg.chunkMapMinChars)) {
        if (!chunkMap.has(id)) chunkMap.set(id, hash);
      }
    }
  }

  // Vague 1 : assets du HTML ; vague 2 : chunks découverts dans le JS
  await Promise.all(Array.from({ length: cfg.conc }, () => worker()));
  const chunkUrls = [];
  for (const [id, hash] of chunkMap) {
    if (chunkUrls.length >= cfg.maxChunks) break;
    const u = channelHost(channel) + '/assets/' + id + '.' + hash + '.js';
    if (!seen.has(u)) {
      seen.add(u);
      chunkUrls.push(u);
    }
  }
  out.chunks = chunkUrls.length;
  queue.push(...chunkUrls);
  await Promise.all(Array.from({ length: cfg.conc }, () => worker()));

  out.ok = out.fetched > 0;
  out.ids = [...ids];
  return out;
}

/** Ids de la liste du dépôt (fallback — jamais une source communautaire). */
async function fetchKnownListIds(fetchImpl, url) {
  const res = await fetchImpl(url || DEFAULTS.fallbackUrl, {
    headers: { Accept: 'application/json' },
    timeout: 20000,
  });
  if (!res || !res.ok) return [];
  const data = await res.json();
  const list = Array.isArray(data)
    ? data
    : (data && (data.experiments || data.ids)) || (data && typeof data === 'object' ? Object.keys(data) : []);
  const out = [];
  for (const item of list || []) {
    const id = typeof item === 'string' ? item : String((item && (item.id || item.name)) || '');
    const clean = id && id.trim();
    if (!clean || clean.startsWith('hash:')) continue;
    out.push(clean);
  }
  return [...new Set(out)];
}

function channelsSummary(channels) {
  return Object.entries(channels || {})
    .map(([k, v]) => k + ' b' + (v.buildNumber || '?') + ' (' + (v.ids || 0) + ')')
    .join(' · ');
}

function channelsAges(channels, nowMs) {
  return Object.entries(channels || {})
    .map(([k, v]) => {
      const t = Date.parse(v.scannedAt);
      const ageH = Number.isFinite(t) ? Math.round(((nowMs - t) / 3600000) * 10) / 10 : '?';
      return k + ' ' + ageH + ' h';
    })
    .join(' · ');
}

/**
 * Charge la map hash -> nom. Priorité :
 *   1. cache frais de l'état (tous les canaux < TTL) : aucun réseau
 *   2. scan des canaux périmés (un par un jusqu'au budget) + fallback liste
 * Le cache est écrit dans state.names (objet muté — le sampler le committe
 * avec le reste de l'état). Retourne { map, labLine, info }.
 */
async function loadNames(arg) {
  const opts = arg || {};
  const fetchImpl = opts.fetchImpl;
  if (typeof fetchImpl !== 'function') throw new Error('loadNames: fetchImpl requis');
  const state = opts.state || {};
  const now = opts.now || (() => Date.now());
  const log = opts.log || (() => {});
  const ttlH = opts.ttlH != null ? opts.ttlH : DEFAULTS.ttlH;
  const maxMs = opts.maxMs != null ? opts.maxMs : DEFAULTS.maxMs;
  const channels = (opts.channels && opts.channels.length ? opts.channels : DEFAULTS.channels).slice();
  const keepDays = opts.keepDays != null ? opts.keepDays : DEFAULTS.keepDays;
  const conc = opts.conc != null ? opts.conc : DEFAULTS.conc;
  const ua = opts.ua || DEFAULTS.ua;

  const cache = state.names && typeof state.names === 'object' && !Array.isArray(state.names) ? state.names : null;
  const prevChannels = (cache && cache.channels) || {};

  const cacheOk = cache && Number(cache.version) === CACHE_VERSION;

  // 1. Tous les canaux frais : zéro réseau
  if (cacheOk && isFresh(cache, now(), ttlH, channels)) {
    const ids = Object.keys((cache && cache.lastSeen) || {});
    log('Noms : cache frais — ' + ids.length + ' ids (' + channelsAges(prevChannels, now()) + ')');
    return {
      map: buildNamesMap(ids),
      info: { source: 'cache', ids: ids.length, channels: prevChannels },
      labLine: 'cache (' + channelsAges(prevChannels, now()) + ') — ' + ids.length + ' ids',
    };
  }

  // 2. Scan des canaux périmés (dans l'ordre, budget partagé)
  const stale = channels.filter((ch) => {
    if (!cacheOk) return true; // cache d'un ancien format -> rescan complet
    const t = Date.parse(prevChannels[ch] && prevChannels[ch].scannedAt);
    return !(now() - t < ttlH * 3600 * 1000);
  });
  const deadline = now() + maxMs;
  const results = [];
  for (const ch of stale) {
    if (now() > deadline) break;
    const r = await scanChannel(fetchImpl, ch, { now, deadline, conc, ua });
    log(
      'Noms : scan ' +
        ch +
        ' = ' +
        r.ids.length +
        ' ids (' +
        r.fetched +
        ' fichiers, ' +
        r.failed +
        ' échecs' +
        (r.cut ? ', budget coupé' : '') +
        ')'
    );
    results.push(r);
  }

  const scannedIds = new Set();
  const newChannels = {};
  for (const ch of Object.keys(prevChannels)) newChannels[ch] = prevChannels[ch];
  for (const r of results) {
    if (r.ok && !r.cut) {
      // Canal complètement scanné -> frais pour TTL_H heures
      newChannels[r.channel] = {
        scannedAt: new Date(now()).toISOString(),
        buildNumber: r.buildNumber,
        assets: r.assets,
        chunks: r.chunks,
        fetched: r.fetched,
        failed: r.failed,
        ids: r.ids.length,
      };
    }
    for (const id of r.ids) scannedIds.add(id);
  }

  // 3. Fallback : liste d'ids du dépôt (continuité des anciens noms)
  let fallbackIds = [];
  try {
    fallbackIds = await fetchKnownListIds(fetchImpl, opts.fallbackUrl);
  } catch (e) {
    log('Noms : liste fallback indisponible (' + e.message + ')');
  }

  // 4. Fusion + cache (les ids déjà vus gardent leur nom KEEP_DAYS jours)
  const nowIso = new Date(now()).toISOString();
  const lastSeen = {};
  for (const id of scannedIds) lastSeen[id] = nowIso;
  for (const id of fallbackIds) if (!(id in lastSeen)) lastSeen[id] = nowIso;
  const prevSeen = (cache && cache.lastSeen) || {};
  const keepMs = keepDays * 86400000;
  for (const id of Object.keys(prevSeen)) {
    if (id in lastSeen) continue;
    const t = Date.parse(prevSeen[id]);
    if (!Number.isFinite(t) || now() - t > keepMs) continue;
    lastSeen[id] = prevSeen[id];
  }

  const totalIds = Object.keys(lastSeen).length;
  if (totalIds) {
    state.names = {
      version: CACHE_VERSION,
      channels: newChannels,
      lastSeen,
    };
  }

  const map = buildNamesMap(Object.keys(lastSeen));
  const source = scannedIds.size ? 'scan' : fallbackIds.length || totalIds ? 'fallback' : 'aucun';
  const labLine =
    (scannedIds.size
      ? 'scan auto ' + scannedIds.size + ' ids (' + channelsSummary(newChannels) + ')'
      : 'scan échoué') +
    (fallbackIds.length ? ' + liste ' + fallbackIds.length : '') +
    ' — total ' + totalIds;
  log('Noms : ' + source + ' — ' + totalIds + ' ids au total');
  return {
    map,
    info: { source, ids: totalIds, scanned: scannedIds.size, fallback: fallbackIds.length, channels: newChannels },
    labLine,
  };
}

module.exports = {
  DEFAULTS,
  extractAssetUrls,
  parseBuildNumber,
  extractChunkMap,
  extractExperimentIds,
  buildNamesMap,
  isFresh,
  channelHost,
  fetchKnownListIds,
  scanChannel,
  loadNames,
};

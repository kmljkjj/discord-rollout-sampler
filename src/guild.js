'use strict';

/**
 * Guild experiments — pourcentages EXACTS lus dans le wire Discord.
 *
 * GET /api/vXX/experiments?with_guild_experiments=true (sans token) :
 * la réponse contient guild_experiments, une liste de tuples compacts
 * [hash, clé, revision, populations, overrides]. Pour chaque population,
 * pop[0] = positions [[bucket, ranges]] ; les ranges ({s,e} ou [a,b]) sont des
 * intervalles sur une échelle 0-10000. Le % d'un bucket = largeur fusionnée
 * de ses intervalles / 10000 : composition du rollout PUBLIÉE par Discord —
 * EXACT, pas une estimation.
 *
 * Décodage adapté de notre dépôt principal (src/apex_rollouts.js — notre
 * propre code). Lecture directe de l'API Discord : aucune donnée communautaire.
 */

const SCALE = 10000;
const UA =
  process.env.SAMPLER_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const GUILD_ENDPOINTS = [
  process.env.SAMPLER_GUILD_ENDPOINT_CANARY ||
    'https://canary.discord.com/api/v10/experiments?with_guild_experiments=true',
  process.env.SAMPLER_GUILD_ENDPOINT_STABLE ||
    'https://discord.com/api/v10/experiments?with_guild_experiments=true',
  'https://discord.com/api/v9/experiments?with_guild_experiments=true',
].filter(Boolean);

function tLabel(bucket) {
  const b = Number(bucket);
  if (b === -1) return 'None';
  if (b === 0) return 'Control';
  return 'Variant ' + b;
}

/** Largeur totale d'intervalles fusionnés ([a,b] ou {s,e}, échelle 0-10000). */
function mergedWidth(intervals) {
  const iv = [];
  for (const r of intervals || []) {
    let a;
    let b;
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      a = Number(r.s != null ? r.s : r.start);
      b = Number(r.e != null ? r.e : r.end);
    } else if (Array.isArray(r) && r.length >= 2) {
      a = Number(r[0]);
      b = Number(r[1]);
    } else continue;
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
    iv.push([a, b]);
  }
  if (!iv.length) return 0;
  iv.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let total = 0;
  let cs = iv[0][0];
  let ce = iv[0][1];
  for (let i = 1; i < iv.length; i++) {
    const a = iv[i][0];
    const b = iv[i][1];
    if (a <= ce) ce = Math.max(ce, b);
    else {
      total += ce - cs;
      cs = a;
      ce = b;
    }
  }
  total += ce - cs;
  return total;
}

/** % d'un bucket : largeur fusionnée / 10000, arrondi au dixième, plafonné à 100. */
function rangesToPct(ranges) {
  return Math.min(100, Math.round((mergedWidth(ranges) / SCALE) * 1000) / 10);
}

/**
 * Décode un tuple guild du wire Discord.
 * nameFor(hash) : résolution de nom optionnelle (known_experiment_ids).
 * Retourne { id, hash, revision, treatments: [{bucket, label, pct}], fingerprint }.
 */
function decodeGuildWire(tuple, nameFor) {
  if (!Array.isArray(tuple) || tuple.length < 4) return null;
  const hash = tuple[0];
  const key = tuple[1];
  const revision = tuple[2];
  const pops = tuple[3] || [];
  const byBucket = new Map();
  for (const pop of pops) {
    if (!Array.isArray(pop)) continue;
    const positions = pop[0] || [];
    for (const pos of positions) {
      if (!Array.isArray(pos)) continue;
      const bucket = pos[0];
      const ranges = pos[1] || [];
      if (!byBucket.has(bucket)) byBucket.set(bucket, []);
      const iv = byBucket.get(bucket);
      for (const r of ranges) {
        if (r && typeof r === 'object' && !Array.isArray(r)) {
          iv.push([Number(r.s != null ? r.s : r.start), Number(r.e != null ? r.e : r.end)]);
        } else if (Array.isArray(r) && r.length >= 2) {
          iv.push([Number(r[0]), Number(r[1])]);
        }
      }
    }
  }
  const treatments = [...byBucket.entries()]
    .map((pair) => ({ bucket: Number(pair[0]), label: tLabel(pair[0]), pct: rangesToPct(pair[1]) }))
    .filter((t) => Number.isFinite(t.bucket))
    .sort((a, b) => a.bucket - b.bucket);
  if (!treatments.length) return null;
  const id =
    (typeof key === 'string' && key.trim() && key) ||
    (nameFor ? nameFor(hash) : null) ||
    'hash:' + hash;
  return {
    id: String(id),
    hash: Number(hash),
    revision,
    treatments,
    fingerprint: treatments.map((t) => t.bucket + ':' + Number(t.pct).toFixed(1)).join('|'),
  };
}

/**
 * Récupère les guild experiments (exact). Essaie chaque endpoint dans l'ordre ;
 * retourne null si aucun ne répond avec des données exploitables.
 */
async function fetchGuildExperiments(fetchImpl, nameFor) {
  for (const url of GUILD_ENDPOINTS) {
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, timeout: 25000 });
      if (!res.ok) continue;
      const data = await res.json();
      const raw = (data && Array.isArray(data.guild_experiments) && data.guild_experiments) || [];
      if (!raw.length) continue;
      const list = raw.map((t) => decodeGuildWire(t, nameFor)).filter((e) => e && e.treatments.length);
      if (!list.length) continue;
      return { list, source: url.includes('canary') ? 'canary' : 'stable', status: res.status };
    } catch (_) {
      // endpoint suivant
    }
  }
  return null;
}

/** Changements de % guild vs snapshot précédent (deltas >= minDelta points).
 *  Nouvelles expériences et hash sans nom : silencieux (seed). */
function diffGuildExperiments(prev, next, minDelta) {
  const pMap = new Map((prev || []).map((e) => [e.id, e]));
  const out = [];
  for (const n of next || []) {
    const p = pMap.get(n.id);
    if (!p) continue;
    if (String(n.id).indexOf('hash:') === 0) continue;
    const prevT = new Map((p.treatments || []).map((t) => [String(t.bucket), t]));
    const deltas = [];
    for (const t of n.treatments || []) {
      const old = prevT.get(String(t.bucket));
      const from = old && old.pct != null ? Number(old.pct) : 0;
      const to = Number(t.pct);
      const d = Math.round((to - from) * 10) / 10;
      if (Math.abs(d) >= minDelta) deltas.push({ label: t.label, bucket: t.bucket, from, to, delta: d });
    }
    if (deltas.length) out.push({ id: n.id, deltas });
  }
  out.sort(
    (a, b) =>
      Math.max(...b.deltas.map((d) => Math.abs(d.delta))) - Math.max(...a.deltas.map((d) => Math.abs(d.delta)))
  );
  return out;
}

function guildChangeEmbed(c) {
  const lines = c.deltas.slice(0, 8).map(
    (d) => d.label + ' ' + d.from + '% -> ' + d.to + '% (' + (d.delta > 0 ? '+' : '') + d.delta + ' pts)'
  );
  return {
    title: (c.id + ' (guild · exact)').slice(0, 256),
    description: lines.join('\n').slice(0, 4000),
    color: 0xe67e22,
    footer: { text: 'Rollouts Sampler · mesure indépendante · EXACT discord' },
  };
}

module.exports = {
  fetchGuildExperiments,
  decodeGuildWire,
  rangesToPct,
  mergedWidth,
  diffGuildExperiments,
  guildChangeEmbed,
  tLabel,
};

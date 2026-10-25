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
// Token utilisateur optionnel : sans lui, Discord n expose qu un petit sous-ensemble
// des guild experiments aux invités anonymes. Avec, la liste complète est lue.
// Jusqu'à 5 tokens utilisateur optionnels (SAMPLER_TOKEN, SAMPLER_TOKEN_2..5) —
// comme les DISCORD_USER_TOKEN_1..5 du dépôt principal. Chaque compte ajoute
// les guild experiments de SON contexte (serveurs) ; les réponses sont
// fusionnées par hash (union des ranges par bucket). Sans token : anonyme.
const TOKENS = [
  process.env.SAMPLER_TOKEN,
  process.env.SAMPLER_TOKEN_2,
  process.env.SAMPLER_TOKEN_3,
  process.env.SAMPLER_TOKEN_4,
  process.env.SAMPLER_TOKEN_5,
]
  .map((t) => (t || '').trim())
  .filter(Boolean)
  .filter((t, i, a) => a.indexOf(t) === i); // dédoublonnage
const UA =
  process.env.SAMPLER_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const GUILD_ENDPOINTS_ANON = [
  process.env.SAMPLER_GUILD_ENDPOINT_CANARY ||
    'https://canary.discord.com/api/v10/experiments?with_guild_experiments=true',
  process.env.SAMPLER_GUILD_ENDPOINT_STABLE ||
    'https://discord.com/api/v10/experiments?with_guild_experiments=true',
  'https://discord.com/api/v9/experiments?with_guild_experiments=true',
].filter(Boolean);
// Avec token : endpoints v9 du dépôt principal d'abord (stable puis canary).
// Constat run 02:27 : v10 renvoie 200 mais seulement le sous-ensemble anonyme
// (raw=5) MÊME avec un Authorization valide ; v9+token est la combinaison
// qui expose la liste complète des guild experiments. v10 reste en secours.
const GUILD_ENDPOINTS_AUTH = [
  'https://discord.com/api/v9/experiments?with_guild_experiments=true',
  'https://canary.discord.com/api/v9/experiments?with_guild_experiments=true',
  ...GUILD_ENDPOINTS_ANON,
];

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
    intervals: [...byBucket.entries()].map((pair) => ({ bucket: Number(pair[0]), iv: pair[1] })),
    fingerprint: treatments.map((t) => t.bucket + ':' + Number(t.pct).toFixed(1)).join('|'),
  };
}

/**
 * Récupère les guild experiments (exact), en fusionnant jusqu'à 5 tokens :
 * chaque token interroge la chaîne d'endpoints (v9 d'abord, cf. constat du
 * 02:36 : v10 ne renvoie que le sous-ensemble même authentifié), et toutes les
 * réponses sont fusionnées par hash — union des ranges par bucket, % recalculés.
 * Sans aucun token : une passe anonyme. Si tous les tokens sont refusés
 * (401...), une passe anonyme évite de perdre le suivi des % exacts.
 *
 * Diagnostic (sans jamais divulguer les valeurs) : tokenEnv (tokens présents
 * dans l'env), tokens (tokens acceptés par Discord), rawCount (max d'entrées
 * brutes vues en un appel), attempts (host/version/statut/token par essai).
 */
async function fetchGuildExperiments(fetchImpl, nameFor) {
  const attempts = [];
  // hash -> { hash, id, revision, byBucket: Map(bucket -> [[a, b], ...]) }
  const seen = new Map();
  const note = (decoded) => {
    if (!decoded) return;
    let st = seen.get(decoded.hash);
    if (!st) {
      st = { hash: decoded.hash, id: decoded.id, revision: decoded.revision, byBucket: new Map() };
      seen.set(decoded.hash, st);
    }
    if (String(decoded.id).indexOf('hash:') !== 0) st.id = decoded.id; // nom > hash brut
    for (const item of decoded.intervals || []) {
      const iv = st.byBucket.get(item.bucket) || [];
      st.byBucket.set(item.bucket, iv.concat(item.iv || []));
    }
  };
  const tryChain = async (token, idx) => {
    const urls = token ? GUILD_ENDPOINTS_AUTH : GUILD_ENDPOINTS_ANON;
    let maxRaw = 0;
    for (const url of urls) {
      const host = url.includes('canary') ? 'canary' : 'stable';
      const ver = (url.match(/\/v(\d+)\//) || [])[1] || '';
      const authed = !!token;
      try {
        const headers = { 'User-Agent': UA, Accept: '*/*' };
        if (authed) {
          headers.Authorization = token;
          headers['X-Discord-Locale'] = 'en-US';
          try {
            headers['X-Super-Properties'] = Buffer.from(
              JSON.stringify({
                os: 'Windows',
                browser: 'Chrome',
                device: '',
                system_locale: 'en-US',
                browser_user_agent: UA,
                browser_version: '131.0.0.0',
                os_version: '10',
                release_channel: 'stable',
                client_build_number: 360000,
              })
            ).toString('base64');
          } catch (_) {}
        }
        const res = await fetchImpl(url, { headers, timeout: 25000 });
        attempts.push({ host, v: ver, status: res.status, auth: authed, token: idx });
        if (!res.ok) continue;
        const data = await res.json();
        const raw = (data && Array.isArray(data.guild_experiments) && data.guild_experiments) || [];
        if (!raw.length) continue;
        maxRaw = Math.max(maxRaw, raw.length);
        const list = raw.map((t) => decodeGuildWire(t, nameFor)).filter((e) => e && e.treatments.length);
        for (const e of list) note(e);
        return { host, status: res.status, maxRaw, token: idx };
      } catch (_) {
        attempts.push({ host, v: ver, status: 0, auth: !!token, token: idx });
      }
    }
    return null;
  };
  const ok = [];
  for (let i = 0; i < TOKENS.length; i++) {
    const r = await tryChain(TOKENS[i], i + 1);
    if (r) ok.push(r);
  }
  let anon = null;
  if (!ok.length) anon = await tryChain(null, 0);
  if (!ok.length && TOKENS.length) {
    console.warn(TOKENS.length + ' token(s) refusé(s) par tous les endpoints — nouvelle tentative anonyme');
  }
  const list = [];
  for (const st of seen.values()) {
    const treatments = [...st.byBucket.entries()]
      .map((pair) => ({
        bucket: Number(pair[0]),
        label: tLabel(pair[0]),
        pct: rangesToPct(pair[1]),
      }))
      .filter((t) => Number.isFinite(t.bucket))
      .sort((a, b) => a.bucket - b.bucket);
    if (!treatments.length) continue;
    list.push({
      id: String(st.id),
      hash: Number(st.hash),
      revision: st.revision,
      treatments,
      fingerprint: treatments.map((t) => t.bucket + ':' + Number(t.pct).toFixed(1)).join('|'),
    });
  }
  if (!list.length) return null;
  const first = ok[0] || anon;
  return {
    list,
    source: first && first.host === 'canary' ? 'canary' : 'stable',
    status: first ? first.status : 0,
    rawCount: Math.max(0, ...ok.concat(anon ? [anon] : []).map((r) => r.maxRaw || 0)),
    authSent: ok.length > 0,
    tokenEnv: TOKENS.length > 0,
    tokens: ok.length,
    attempts,
  };
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

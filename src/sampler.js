'use strict';

/**
 * Rollouts Sampler v1 — NOTRE PROPRE SYSTÈME DE POURCENTAGES (user rollouts).
 *
 * Principe : on mesure les rollouts DIRECTEMENT sur l'API Discord, par
 * échantillonnage de fingerprints (sondage statistique). Aucune donnée
 * communautaire, aucun gist, aucun worker tiers : chaque pourcentage publié
 * est calculé à partir des échantillons que nous collectons nous-mêmes.
 *
 *   - GET https://canary.discord.com/api/v10/experiments (sans token) :
 *     chaque requête reçoit un fingerprint aléatoire côté Discord et renvoie
 *     les buckets assignés → un « utilisateur sondé » de plus.
 *   - N fingerprints par run (~1200) → fréquence observée par bucket = % mesuré
 *   - Intervalle de confiance de Wilson (95 %) : on publie la marge d'erreur
 *     et on n'annonce que les deltas significatifs (≥ SAMPLER_MIN_DELTA points)
 *   - Fenêtre glissante sur les SAMPLER_WINDOW_RUNS derniers runs
 *   - État cumulatif dans data/sampler_state.json, committé par le workflow —
 *     le diff se calcule au run suivant
 *
 * Footer des embeds : « Rollouts Sampler · mesure indépendante » — aucune
 * source tierce, parce qu'il n'y en a pas.
 *
 * Env (cf. README.md pour le détail) :
 *   SAMPLER_WEBHOOK_URL, SAMPLER_TARGET (1200), SAMPLER_CONCURRENCY (3),
 *   SAMPLER_DELAY_MS (250), SAMPLER_MAX_MS (240000), SAMPLER_WINDOW_RUNS (3),
 *   SAMPLER_MIN_N (500), SAMPLER_MIN_DELTA (2), SAMPLER_LAB (1),
 *   SAMPLER_STATE, SAMPLER_NAMES_URL, SAMPLER_UA, SAMPLER_PROFILES,
 *   SAMPLER_BUILD (451408), SAMPLER_FP_REUSE (1)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { murmur3 } = require('./murmur3');
const est = require('./estimate');
const guild = require('./guild');

// ---- Config ----
const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = process.env.SAMPLER_STATE || path.join(DATA_DIR, 'sampler_state.json');
const NAMES_URL =
  process.env.SAMPLER_NAMES_URL ||
  'https://raw.githubusercontent.com/kmljkjj/discord-canary-scraper/main/data/known_experiment_ids.json';
const WEBHOOK = process.env.SAMPLER_WEBHOOK_URL || null;
const TARGET = clampInt(process.env.SAMPLER_TARGET, 1200, 200, 4000);
const CONC = clampInt(process.env.SAMPLER_CONCURRENCY, 3, 1, 6);
const DELAY_MS = clampInt(process.env.SAMPLER_DELAY_MS, 250, 0, 5000);
const MAX_MS = clampInt(process.env.SAMPLER_MAX_MS, 240000, 30000, 600000);
const WINDOW_RUNS = clampInt(process.env.SAMPLER_WINDOW_RUNS, 3, 1, 48);
const MIN_N = clampInt(process.env.SAMPLER_MIN_N, 500, 50, 10000);
const MIN_DELTA = Number(process.env.SAMPLER_MIN_DELTA || '2');
const LAB = String(process.env.SAMPLER_LAB ?? '1') === '1';
const REMOVED_AFTER = clampInt(process.env.SAMPLER_REMOVED_AFTER, 6, 2, 50);
const UA =
  process.env.SAMPLER_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ENDPOINTS = [
  process.env.SAMPLER_ENDPOINT_CANARY || 'https://canary.discord.com/api/v10/experiments',
  process.env.SAMPLER_ENDPOINT_STABLE || 'https://discord.com/api/v10/experiments',
].filter(Boolean);

// ---- Profils client (élargir la population d'expériences user visible) ----
// Discord filtre les user experiments par contexte client (plateforme, canal
// de release, build), pas seulement par fingerprint : un invité web « nu »
// n'expose qu'une poignée d'expériences. En variant X-Super-Properties on
// sonde plusieurs populations ; un profil non éligible pour une expérience ne
// renvoie AUCUNE observation pour son hash, donc le pooling par hash reste
// sans biais (on n'observe que les populations où l'expérience est visible).
const BUILD = String(process.env.SAMPLER_BUILD || '451408');
const FP_REUSE = String(process.env.SAMPLER_FP_REUSE ?? '1') === '1';

function b64sp(o) {
  return Buffer.from(JSON.stringify(o)).toString('base64');
}

function webSp(channel) {
  return b64sp({
    os: 'Windows',
    browser: 'Chrome',
    device: '',
    system_locale: 'fr-FR',
    has_client_mods: false,
    browser_user_agent: UA,
    browser_version: '131.0.0.0',
    os_version: '10',
    referrer: '',
    referrer_current: '',
    referring_domain_current: '',
    release_channel: channel,
    client_build_number: Number(BUILD),
    client_event_source: null,
  });
}

const ALL_PROFILES = [
  { name: 'web-stable', sp: webSp('stable') },
  { name: 'web-canary', sp: webSp('canary') },
  { name: 'web-ptb', sp: webSp('ptb') },
  {
    name: 'android',
    sp: b64sp({
      os: 'Android',
      browser: 'Chrome',
      device: 'Pixel 8',
      system_locale: 'fr-FR',
      has_client_mods: false,
      browser_user_agent:
        'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      browser_version: '131.0.0.0',
      os_version: '15',
      referrer: '',
      referrer_current: '',
      referring_domain_current: '',
      release_channel: 'googlePlay',
      client_build_number: 251009,
      client_event_source: null,
    }),
  },
  {
    name: 'ios',
    sp: b64sp({
      os: 'iOS',
      browser: 'Safari',
      device: 'iPhone15,3',
      system_locale: 'fr-FR',
      has_client_mods: false,
      browser_user_agent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1',
      browser_version: '18.2',
      os_version: '18.2',
      referrer: '',
      referrer_current: '',
      referring_domain_current: '',
      release_channel: 'appleAppStore',
      client_build_number: 251009,
      client_event_source: null,
    }),
  },
];

function loadProfiles() {
  const raw = process.env.SAMPLER_PROFILES;
  if (!raw) return ALL_PROFILES;
  try {
    const names = JSON.parse(raw);
    const sel = ALL_PROFILES.filter((p) => names.includes(p.name));
    return sel.length ? sel : ALL_PROFILES;
  } catch (e) {
    console.warn('SAMPLER_PROFILES illisible — tous les profils seront utilisés');
    return ALL_PROFILES;
  }
}

const PROFILES = loadProfiles();

function clampInt(v, dflt, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// ---- Échantillonnage ----

/**
 * Boucle d'échantillonnage : effectue `target` requêtes (1 requête = 1
 * fingerprint sondé), agrège les assignments par hash/bucket.
 * Toutes les dépendances (fetch, sleep, now, rid) sont injectables → testable.
 */
async function sampleLoop(opts) {
  const {
    fetchImpl,
    sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    ridImpl = () => crypto.randomBytes(16).toString('hex'),
    target = TARGET,
    concurrency = CONC,
    delayMs = DELAY_MS,
    maxMs = MAX_MS,
    endpoints = ENDPOINTS,
    profiles = PROFILES,
    fpReuse = FP_REUSE,
    timeoutMs = 15000,
    log = () => {},
  } = opts;

  const profileOk = {};
  let followupNew = 0;
  let followupFail = 0;
  const rl = { blockUntil: 0, consecutive429: 0, dynamicDelayMs: delayMs };
  const byHash = new Map();
  let ok = 0;
  let fail = 0;
  let next = 0;
  let stopReason = null;
  const deadline = now() + maxMs;

  function addAssignments(assignments) {
    for (const a of assignments || []) {
      if (!Array.isArray(a) || a.length < 3) continue;
      const hash = Number(a[0]);
      const bucket = Number(a[2]);
      if (!Number.isFinite(hash) || !Number.isFinite(bucket)) continue;
      const pos = Number(a[5]);
      if (!byHash.has(hash)) byHash.set(hash, { total: 0, buckets: new Map() });
      const h = byHash.get(hash);
      h.total++;
      if (!h.buckets.has(bucket)) h.buckets.set(bucket, { n: 0, posMin: null, posMax: null, positions: [] });
      const b = h.buckets.get(bucket);
      b.n++;
      if (Number.isFinite(pos)) {
        b.positions.push(pos);
        b.posMin = b.posMin == null ? pos : Math.min(b.posMin, pos);
        b.posMax = b.posMax == null ? pos : Math.max(b.posMax, pos);
      }
    }
  }

  async function oneSample(profile, fingerprint) {
    const waitMs = Math.max(0, rl.blockUntil - now());
    if (waitMs > 0) await sleepImpl(waitMs);
    await sleepImpl(rl.dynamicDelayMs + Math.floor(Math.random() * 150));

    let lastErr = null;
    let rateLimited = false;
    for (const url of endpoints) {
      try {
        const res = await fetchImpl(url, {
          headers: {
            'User-Agent': UA,
            Accept: '*/*',
            'Cache-Control': 'no-cache',
            'X-Request-Id': ridImpl(),
            ...(profile && profile.sp ? { 'X-Super-Properties': profile.sp } : {}),
            ...(fingerprint ? { 'X-Fingerprint': fingerprint } : {}),
          },
          timeout: timeoutMs,
        });
        const hget = (n) =>
          res.headers && typeof res.headers.get === 'function' ? res.headers.get(n) : null;
        const remaining = Number(hget('x-ratelimit-remaining'));
        const resetAfter = Number(hget('x-ratelimit-reset-after'));
        if (Number.isFinite(remaining)) {
          if (remaining <= 1 && Number.isFinite(resetAfter) && resetAfter > 0) {
            rl.dynamicDelayMs = Math.min(3000, rl.dynamicDelayMs + 200);
          } else if (remaining >= 3) {
            rl.dynamicDelayMs = Math.max(delayMs, rl.dynamicDelayMs - 50);
          }
        }
        if (res.status === 429) {
          rl.consecutive429++;
          const ra = Number(hget('retry-after') || hget('x-ratelimit-reset-after') || 2);
          rl.blockUntil = now() + Math.min(30, Math.max(1, ra || 2)) * 1000;
          rl.dynamicDelayMs = Math.min(5000, rl.dynamicDelayMs + 500);
          rateLimited = true;
          break; // 429 = global, inutile d'essayer l'autre endpoint
        }
        if (!res.ok) {
          lastErr = new Error('HTTP ' + res.status);
          continue;
        }
        const data = await res.json();
        if (!data || !Array.isArray(data.assignments)) {
          lastErr = new Error('format inattendu');
          continue;
        }
        rl.consecutive429 = 0;
        return { assignments: data.assignments, fingerprint: data.fingerprint || null };
      } catch (e) {
        lastErr = e;
      }
    }
    if (rateLimited) throw new Error('429 rate-limited');
    throw lastErr || new Error('échec requête');
  }

  async function worker() {
    while (true) {
      const my = next++;
      if (my >= target) return;
      if (stopReason) return;
      if (now() > deadline) {
        stopReason = 'budget';
        return;
      }
      const profile = profiles.length ? profiles[my % profiles.length] : null;
      try {
        const first = await oneSample(profile);
        addAssignments(first.assignments);
        ok++;
        if (profile) profileOk[profile.name] = (profileOk[profile.name] || 0) + 1;
        // Re-test du même fingerprint : X-Fingerprint donne accès aux
        // portions « API-locked » des expériences (doc discord-userdoccers).
        // Seuls les hashes ABSENTS de la 1re réponse sont comptés → pas de
        // double comptage d'observation.
        if (fpReuse && first.fingerprint && now() < deadline - 5000) {
          const seen = new Set((first.assignments || []).map((a) => String(a[0])));
          try {
            const second = await oneSample(profile, first.fingerprint);
            for (const a of second.assignments || []) {
              if (!Array.isArray(a) || a.length < 3) continue;
              if (seen.has(String(a[0]))) continue;
              seen.add(String(a[0]));
              addAssignments([a]);
              followupNew++;
            }
          } catch (e) {
            followupFail++;
          }
        }
        if (ok % 200 === 0) {
          log('  échantillons ok=' + ok + '/' + target + ' fail=' + fail + ' delay=' + rl.dynamicDelayMs + 'ms hashes=' + byHash.size);
        }
      } catch (e) {
        fail++;
        if (String(e && e.message).startsWith('429')) {
          if (rl.consecutive429 > 12) {
            stopReason = 'rate-limit';
            return;
          }
        } else if (fail >= 20 && ok === 0) {
          stopReason = 'erreurs-réseau';
          return;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { byHash, ok, fail, stopReason, profileOk, followupNew, followupFail };
}

// ---- Noms d'expériences (optionnels) ----

async function loadNames(fetchImpl) {
  try {
    const res = await fetchImpl(NAMES_URL, {
      headers: { Accept: 'application/json' },
      timeout: 20000,
    });
    if (!res.ok) return {};
    const data = await res.json();
    const list = Array.isArray(data)
      ? data
      : data.experiments || data.ids || (typeof data === 'object' ? Object.keys(data) : []);
    const map = {};
    let n = 0;
    for (const item of list) {
      const id =
        typeof item === 'string'
          ? item
          : String((item && (item.id || item.name)) || '');
      const clean = id && id.trim();
      if (!clean || clean.startsWith('hash:')) continue;
      map[String(murmur3(clean))] = clean;
      n++;
    }
    console.log('Noms chargés:', n);
    return map;
  } catch (e) {
    console.warn('Noms indisponibles (hash:… seront utilisés):', e.message);
    return {};
  }
}

// ---- État ----

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.warn('État illisible, repart de zéro:', e.message);
  }
  return { version: 1, runs: [], experiments: {}, lastChanges: [] };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

/** Convertit un run agrégé (Maps) en enregistrement sérialisable (objets simples). */
function toRunRecord(run) {
  const buckets = {};
  for (const [bucket, b] of run.buckets) {
    buckets[String(bucket)] = {
      n: b.n,
      posMin: b.posMin,
      posMax: b.posMax,
      segments: est.computeSegments(b.positions || []),
    };
  }
  return { total: run.total, buckets };
}

// ---- Embeds ----

function buildChangeEmbeds(changes) {
  return changes.map((c) => {
    const lines = [];
    for (const d of (c.deltas || []).slice(0, 12)) {
      lines.push(d.label + ' ' + d.from + '% -> ' + d.to + '% (±' + d.ciPct + ')');
    }
    return {
      title: (c.name + ' (user · sampled)').slice(0, 256),
      description: lines.join('\n').slice(0, 4000),
      color: c.kind === 'new' ? 0x57f287 : 0xe67e22,
      footer: { text: 'Rollouts Sampler · mesure indépendante · n=' + c.windowTotal },
    };
  });
}

function labReportEmbed(s) {
  const lines = [
    '**Système de % par échantillonnage** — run terminé',
    '• Fingerprints sondés : **' + s.ok + '** (' + s.fail + ' échecs, ' + s.elapsed + 's' + (s.stopReason ? ' · arrêt ' + s.stopReason : '') + ')',
    '• Expériences suivies : **' + s.hashes + '** · mesurées : **' + s.measured + '**',
    '• Profils client : **' + (s.profiles || '-') + '** · API-locked (X-Fingerprint) : **+' + (s.followupNew || 0) + '** obs.',
    '• Changements détectés : **' + s.changes + '**' + (s.isFirst ? ' (seed initial — pas de notif de changement)' : ''),
    '• Guild experiments (exact) : **' +
      (s.guild ? s.guild.count : 'indisponibles') +
      '**' +
      (s.guild && s.guild.source ? ' · ' + s.guild.source : '') +
      (s.guild && s.guild.auth ? ' · ' + s.guild.auth : '') +
      (s.guild && s.guildChanges != null ? ' · Δ: ' + s.guildChanges : ''),
    '• Source : **API Discord uniquement** — aucune donnée communautaire',
  ];
  for (const e of (s.experiments || []).slice(0, 12)) {
    lines.push('  – ' + e.name + ' : ' + e.summary);
  }
  return {
    title: 'Sampler — run report',
    description: lines.join('\n').slice(0, 4000),
    color: 0x5865f2,
    footer: { text: 'Rollouts Sampler · LAB' },
  };
}

// ---- Webhook ----

async function postWebhook(url, embeds, fetchImpl) {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Rollouts Sampler', embeds }),
      timeout: 15000,
    });
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, text: ok ? 'envoyé' : String(await res.text()).slice(0, 120) };
  } catch (e) {
    return { ok: false, status: 0, text: e.message };
  }
}

// ---- Main ----

async function main(opts = {}) {
  const fetchImpl = opts.fetchImpl || require('node-fetch');
  const nowIso = () => new Date().toISOString();

  console.log('🧪 Rollouts Sampler v1 — mesure indépendante par échantillonnage');
  console.log('Cible:', TARGET, 'fingerprints · concurrence:', CONC, '· webhook:', WEBHOOK ? 'configuré' : 'ABSENT');
  console.log("Source : API Discord uniquement — aucune donnée communautaire, c'est NOTRE mesure.");

  const names = await loadNames(fetchImpl);
  const state = loadState();
  const isFirst = !(state.experiments && Object.keys(state.experiments).length);

  const t0 = Date.now();
  const { byHash, ok, fail, stopReason, profileOk, followupNew, followupFail } = await sampleLoop({
    fetchImpl,
    log: (m) => console.log(m),
  });
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(
    'Échantillonnage:', ok, 'ok,', fail, 'échecs,', elapsed + 's,', byHash.size, 'hashes' + (stopReason ? ' · arrêt: ' + stopReason : '')
  );
  console.log(
    'Profils client:',
    Object.entries(profileOk || {})
      .map(([k, v]) => k + '=' + v)
      .join(' ') || 'aucun'
  );
  console.log(
    'X-Fingerprint (API-locked): +' + (followupNew || 0) + ' observations' +
      (followupFail ? ' (' + followupFail + ' échecs)' : '')
  );

  // ---- Guild experiments : % exacts lus dans le wire Discord ----
  // cf. src/guild.js — lecture directe (aucune donnée communautaire)
  const guildRes = await guild.fetchGuildExperiments(fetchImpl, (h) => est.nameFor(String(h), names));
  const guildPrev =
    state.guild && Array.isArray(state.guild.experiments) ? state.guild.experiments : [];
  const guildIsFirst = guildPrev.length === 0;
  let guildInfo = null;
  let guildChanges = [];
  if (guildRes && guildRes.list.length) {
    const degraded =
      guildPrev.length >= 20 && guildRes.list.length < Math.max(5, Math.floor(guildPrev.length * 0.4));
    if (degraded) {
      console.warn('Guild : collection suspecte (' + guildRes.list.length + ' vs ' + guildPrev.length + ') — état conservé');
      guildInfo = guildPrev.length
        ? { count: guildPrev.length, source: 'état précédent (collection suspecte)' }
        : null;
    } else {
      if (!guildIsFirst) guildChanges = guild.diffGuildExperiments(guildPrev, guildRes.list, MIN_DELTA);
      const guildAuth = !guildRes.tokenEnv
        ? 'anonyme'
        : guildRes.tokens > 0
          ? guildRes.tokens > 1
            ? 'token ×' + guildRes.tokens
            : 'token'
          : 'token refusé (fallback anonyme)';
      state.guild = {
        ts: nowIso(),
        source: guildRes.source,
        auth: guildAuth,
        attempts: guildRes.attempts || [],
        raw: guildRes.rawCount,
        count: guildRes.list.length,
        experiments: guildRes.list.map((e) => ({
          id: e.id,
          hash: e.hash,
          treatments: e.treatments.map((t) => ({ bucket: t.bucket, pct: t.pct })),
        })),
      };
      guildInfo = { count: guildRes.list.length, source: guildRes.source, auth: guildAuth };
    }
  } else if (guildPrev.length) {
    console.warn('Guild experiments indisponibles — état précédent conservé');
    guildInfo = { count: guildPrev.length, source: 'état précédent (endpoint muet)' };
  } else {
    console.warn('Guild experiments indisponibles (réponse vide ou refusée)');
  }
  console.log(
    'Guild experiments:',
    guildInfo ? guildInfo.count + ' (' + guildInfo.source + ')' : 'INDISPONIBLES',
    guildInfo && guildInfo.auth ? '· auth: ' + guildInfo.auth : '',
    '· changements:',
    guildChanges.length,
    guildIsFirst ? '(seed)' : ''
  );

  // Mise à jour de l'état par expérience
  const seenNow = new Set();
  for (const [hash, run] of byHash) {
    const key = String(hash);
    seenNow.add(key);
    let st = state.experiments[key];
    if (!st) st = state.experiments[key] = { runs: [], announced: {}, missed: 0 };
    st.runs.push(toRunRecord(run));
    if (st.runs.length > WINDOW_RUNS + 1) st.runs = st.runs.slice(-(WINDOW_RUNS + 1));
    st.missed = 0;
  }
  for (const [key, st] of Object.entries(state.experiments)) {
    if (!seenNow.has(key)) {
      st.missed = (st.missed || 0) + 1;
      if (st.missed > REMOVED_AFTER) delete state.experiments[key];
    }
  }
  state.runs = [
    ...(state.runs || []),
    {
      ts: nowIso(),
      ok,
      fail,
      hashes: byHash.size,
      stopReason: stopReason || null,
      profiles: profileOk || {},
      followupNew: followupNew || 0,
    },
  ].slice(-40);

  // Estimations + diff (premier run = seed silencieux, pas de flood)
  const changes = [];
  let measured = 0;
  const measuredExperiments = [];
  for (const [key, st] of Object.entries(state.experiments)) {
    const window = est.mergeWindow(st.runs, WINDOW_RUNS);
    if (!window.total) continue;
    const pcts = est.estimatePcts(window, MIN_N);
    if (!pcts.length) continue;
    measured++;
    measuredExperiments.push({
      name: est.nameFor(key, names),
      summary: pcts
        .map((t) => {
          let line = t.label + ' ' + t.pct + '%';
          if (Array.isArray(t.segments) && t.segments.length) {
            line += ' [' + t.segments.map((g) => g[0] + '-' + g[1]).join(', ') + ']';
          }
          return line;
        })
        .join(', '),
    });
    if (isFirst) continue;
    const hadAnnounced = st.announced && Object.keys(st.announced).length > 0;
    const cls = est.classifyChange(hadAnnounced ? st.announced : null, pcts, MIN_DELTA);
    if (cls.kind === 'none') continue;
    const ciMax = Math.max(...cls.deltas.map((d) => d.ciPct || 0));
    changes.push({
      hash: key,
      name: est.nameFor(key, names),
      kind: cls.kind,
      deltas: cls.deltas,
      windowTotal: window.total,
      ciPct: ciMax,
    });
  }
  changes.sort(
    (a, b) =>
      Math.max(...b.deltas.map((d) => Math.abs(d.delta ?? d.to))) - Math.max(...a.deltas.map((d) => Math.abs(d.delta ?? d.to)))
  );
  console.log('Mesurées (n≥' + MIN_N + '):', measured, '· changements:', changes.length, isFirst ? '(seed)' : '');

  // Embeds : changements user (max 6) + changements guild (max 3) + rapport LAB (<= 10 embeds)
  const embeds = [];
  if (!isFirst && changes.length) embeds.push(...buildChangeEmbeds(changes.slice(0, 6)));
  if (!guildIsFirst && guildChanges.length) {
    embeds.push(...guildChanges.slice(0, 3).map((c) => guild.guildChangeEmbed(c)));
  }
  if (LAB && WEBHOOK) {
    embeds.push(
      labReportEmbed({
        ok,
        fail,
        hashes: byHash.size,
        measured,
        changes: changes.length,
        elapsed,
        stopReason,
        isFirst,
        profiles: Object.entries(profileOk || {})
          .map(([k, v]) => k + ' ' + v)
          .join(' · '),
        followupNew: followupNew || 0,
        experiments: measuredExperiments,
        guild: guildInfo,
        guildChanges: guildIsFirst ? 0 : guildChanges.length,
      })
    );
  }

  let sent = { ok: !embeds.length, status: 0, skipped: true };
  if (embeds.length && WEBHOOK) {
    sent = await postWebhook(WEBHOOK, embeds.slice(0, 10), fetchImpl);
    console.log('Webhook:', sent.status, sent.ok ? 'OK' : sent.text);
  } else if (embeds.length && !WEBHOOK) {
    console.log('Webhook absent — état sauvegardé, les changements seront détectés au prochain run');
  }

  // On avance announced uniquement si envoyé (ou rien à envoyer) :
  // en cas d'échec webhook, le prochain run réessaie les mêmes deltas.
  if (!WEBHOOK || sent.ok) {
    const targets = isFirst ? Object.keys(state.experiments) : changes.map((c) => c.hash);
    for (const key of targets) {
      const st = state.experiments[key];
      if (!st) continue;
      const window = est.mergeWindow(st.runs, WINDOW_RUNS);
      const pcts = est.estimatePcts(window, MIN_N);
      const announced = {};
      for (const t of pcts) announced[String(t.bucket)] = t.pct;
      st.announced = announced;
    }
  }

  state.scrapedAt = nowIso();
  state.version = 1;
  state.lastChanges = changes.slice(0, 10).map((c) => ({
    name: c.name,
    kind: c.kind,
    deltas: c.deltas,
  }));
  saveState(state);
  console.log('État sauvegardé (' + Object.keys(state.experiments).length + ' expériences)');

  if (!sent.ok && embeds.length && WEBHOOK) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  main,
  sampleLoop,
  buildChangeEmbeds,
  labReportEmbed,
  postWebhook,
  loadNames,
  loadState,
  saveState,
  toRunRecord,
};

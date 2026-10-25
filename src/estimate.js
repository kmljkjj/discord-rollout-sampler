'use strict';

/**
 * Statistiques du Rollouts Sampler — 100 % pur JS, aucune dépendance.
 *
 * Chaque fonction est testable isolément (cf. test/estimate.test.js) :
 *  - wilsonInterval : intervalle de confiance de Wilson (95 %) d'une proportion
 *  - aggregateRun   : agrège les assignments d'un run (hash → buckets)
 *  - mergeWindow    : fusionne les k derniers runs d'une expérience (fenêtre)
 *  - estimatePcts   : % par bucket + marge d'erreur, ou [] si données insuffisantes
 *  - classifyChange : deltas significatifs entre % annoncés et % mesurés
 *  - computeSegments : reconstruction de ranges depuis les positions échantillonnées
 *  - mergeSegments  : union de segments de plusieurs runs (fusion si écart faible)
 *  - segmentsPct     : % de l'échelle de rollout couvert par des segments
 *
 * Aucune source de données externe : tout part d'échantillons que NOUS
 * collectons nous-mêmes sur l'API Discord (cf. src/sampler.js).
 */

const Z_95 = 1.959963984540054;
const DEFAULT_SCALE = 10000;

/** Label de bucket au format Discord : None / Control / Variant N. */
function tLabel(bucket) {
  const b = Number(bucket);
  if (b === -1) return 'None';
  if (b === 0) return 'Control';
  return 'Variant ' + b;
}

/**
 * Intervalle de confiance de Wilson (par défaut 95 %) pour ok/n.
 * Retourne { low, high, mid, valid } en échelle [0, 1].
 */
function wilsonInterval(ok, n, z = Z_95) {
  if (!Number.isFinite(ok) || !Number.isFinite(n) || n <= 0 || ok < 0 || ok > n) {
    return { low: 0, high: 0, mid: 0, valid: false };
  }
  const p = ok / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const marge = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return { low: Math.max(0, centre - marge), high: Math.min(1, centre + marge), mid: p, valid: true };
}

/**
 * Agrège les assignments d'UN run.
 * Format Discord (api/v10/experiments) : [hash, revision, bucket, ..., hash_result]
 * Retourne Map<hash, { total, buckets: Map<bucket, { n, posMin, posMax }> }>.
 */
function aggregateRun(assignments) {
  const byHash = new Map();
  for (const a of assignments || []) {
    if (!Array.isArray(a) || a.length < 3) continue;
    const hash = Number(a[0]);
    const bucket = Number(a[2]);
    if (!Number.isFinite(hash) || !Number.isFinite(bucket)) continue;
    const pos = Number(a[5]);
    if (!byHash.has(hash)) byHash.set(hash, { total: 0, buckets: new Map() });
    const h = byHash.get(hash);
    h.total++;
    if (!h.buckets.has(bucket)) h.buckets.set(bucket, { n: 0, posMin: null, posMax: null });
    const b = h.buckets.get(bucket);
    b.n++;
    if (Number.isFinite(pos)) {
      b.posMin = b.posMin == null ? pos : Math.min(b.posMin, pos);
      b.posMax = b.posMax == null ? pos : Math.max(b.posMax, pos);
    }
  }
  return byHash;
}

/**
 * Reconstruction de ranges (méthode des trackers, vérifiée dans leur code) :
 * chaque assignment porte hash_result = la position du fingerprint dans
 * l'échelle de rollout 0-9999. En regroupant les positions observées d'un
 * bucket puis en fusionnant les positions voisines (écart <= gap), on
 * reconstitue les segments de rollout — exactement ce que font les trackers
 * communautaires (~100k fingerprints anonymes), mais ici sur nos propres
 * échantillons.
 */
function computeSegments(positions, gap = 150) {
  const pts = (positions || [])
    .filter((p) => Number.isFinite(p))
    .map(Number)
    .sort((a, b) => a - b);
  const segs = [];
  let s = null;
  let e = null;
  for (const p of pts) {
    if (s === null) {
      s = p;
      e = p;
      continue;
    }
    if (p - e <= gap) {
      e = p;
      continue;
    }
    segs.push([s, e]);
    s = p;
    e = p;
  }
  if (s !== null) segs.push([s, e]);
  return segs;
}

/** Union de listes de segments (multi-runs) : fusion si l'écart <= gap. */
function mergeSegments(lists, gap = 150) {
  const pts = [];
  for (const segs of lists || []) {
    if (!Array.isArray(segs)) continue;
    for (const sg of segs) {
      if (!Array.isArray(sg) || sg.length < 2) continue;
      const s = Number(sg[0]);
      const e = Number(sg[1]);
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      pts.push([s, e]);
    }
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [s, e] of pts) {
    const last = out[out.length - 1];
    if (last && s - last[1] <= gap) {
      last[1] = Math.max(last[1], e);
      continue;
    }
    out.push([s, e]);
  }
  return out;
}

/** % de l'échelle (défaut 10000) couvert par des segments [[s, e], ...]. */
function segmentsPct(segments, scale = DEFAULT_SCALE) {
  let total = 0;
  for (const sg of segments || []) {
    if (!Array.isArray(sg) || sg.length < 2) continue;
    total += Math.max(0, Number(sg[1]) - Number(sg[0]) + 1);
  }
  return Math.round((total / scale) * 1000) / 10;
}

/**
 * Fusionne les k derniers runs (fenêtre glissante) d'une expérience.
 * runRecords : [{ total, buckets: { bucket: { n, posMin, posMax, segments } } }]
 * Les segments de ranges sont unionnés sur la fenêtre (records anciens sans
 * segments contribuent pour rien). Retourne { total, buckets: [{ bucket, n,
 * posMin, posMax, segments }] } trié par bucket.
 */
function mergeWindow(runRecords, k = 3) {
  const use = (runRecords || []).slice(-Math.max(1, k));
  const total = use.reduce((s, r) => s + (Number(r.total) || 0), 0);
  const acc = new Map();
  for (const r of use) {
    for (const [bucketStr, b] of Object.entries((r && r.buckets) || {})) {
      const bucket = Number(bucketStr);
      if (!Number.isFinite(bucket)) continue;
      if (!acc.has(bucket)) acc.set(bucket, { bucket, n: 0, posMin: null, posMax: null, segLists: [] });
      const t = acc.get(bucket);
      t.n += Number(b.n) || 0;
      if (b.posMin != null) t.posMin = t.posMin == null ? b.posMin : Math.min(t.posMin, b.posMin);
      if (b.posMax != null) t.posMax = t.posMax == null ? b.posMax : Math.max(t.posMax, b.posMax);
      if (Array.isArray(b.segments)) t.segLists.push(b.segments);
    }
  }
  const buckets = [...acc.values()]
    .sort((a, b) => a.bucket - b.bucket)
    .map((t) => ({
      bucket: t.bucket,
      n: t.n,
      posMin: t.posMin,
      posMax: t.posMax,
      segments: mergeSegments(t.segLists),
    }));
  return { total, buckets };
}

/**
 * % par bucket depuis une fenêtre fusionnée + intervalle de Wilson.
 * Retourne [] si la fenêtre n'a pas assez d'échantillons (total < minN) —
 * on ne publie JAMAIS de pourcentage non mesuré.
 * Sinon [{ bucket, label, pct, ciLow, ciHigh, ciPct, n }] trié par bucket.
 */
function estimatePcts(window, minN = 500) {
  if (!window || !window.total || window.total < minN) return [];
  const out = [];
  for (const b of window.buckets || []) {
    const ci = wilsonInterval(b.n, window.total);
    const pct = Math.round(ci.mid * 1000) / 10;
    const ciPct = Math.round(((ci.high - ci.low) / 2) * 1000) / 10;
    const segments = Array.isArray(b.segments) ? b.segments : [];
    out.push({
      bucket: b.bucket,
      label: tLabel(b.bucket),
      pct,
      ciLow: ci.low,
      ciHigh: ci.high,
      ciPct,
      n: b.n,
      segments,
      segPct: segments.length ? segmentsPct(segments) : null,
    });
  }
  return out;
}

/**
 * Classifie les changements entre les derniers % annoncés et les nouveaux.
 * announced : { bucket: pct } (derniers % publiés) ou null (jamais mesuré).
 * newPcts   : sortie de estimatePcts.
 * Retourne { kind: 'none' | 'new' | 'pct', deltas: [...] } — seuls les deltas
 * ≥ minDelta points (ou les buckets qui apparaissent) sont retenus.
 */
function classifyChange(announced, newPcts, minDelta = 2) {
  if (!newPcts || !newPcts.length) return { kind: 'none', deltas: [] };
  const hasAnnounced =
    announced && typeof announced === 'object' && Object.keys(announced).length > 0;
  if (!hasAnnounced) {
    // Premier mesurage : on n'annonce que les VRAIS variants (bucket > 0).
    // Le Control est la ligne de base — l'annoncer serait du bruit, et une
    // expérience sans rollout (Control 100 %) ne doit rien publier.
    const active = newPcts.filter((t) => Number(t.bucket) > 0 && Number(t.pct) > 0);
    if (!active.length) return { kind: 'none', deltas: [] };
    return {
      kind: 'new',
      deltas: active.map((t) => ({
        bucket: t.bucket,
        label: t.label,
        from: 0,
        to: t.pct,
        delta: t.pct,
        ciPct: t.ciPct,
      })),
    };
  }
  const deltas = [];
  for (const t of newPcts) {
    const old = announced[String(t.bucket)];
    if (old == null) {
      if (Number(t.pct) > 0) {
        deltas.push({ bucket: t.bucket, label: t.label, from: 0, to: t.pct, delta: t.pct, ciPct: t.ciPct });
      }
      continue;
    }
    const from = Number(old);
    const d = Math.round((Number(t.pct) - from) * 10) / 10;
    if (Math.abs(d) >= minDelta) {
      deltas.push({ bucket: t.bucket, label: t.label, from, to: Number(t.pct), delta: d, ciPct: t.ciPct });
    }
  }
  return { kind: deltas.length ? 'pct' : 'none', deltas };
}

/** Nom lisible d'une expérience : map hash→nom, sinon hash:<hash>. */
function nameFor(hash, names) {
  const n = names && names[String(hash)];
  return typeof n === 'string' && n.trim() ? n : 'hash:' + hash;
}

module.exports = {
  Z_95,
  DEFAULT_SCALE,
  tLabel,
  wilsonInterval,
  aggregateRun,
  computeSegments,
  mergeSegments,
  segmentsPct,
  mergeWindow,
  estimatePcts,
  classifyChange,
  nameFor,
};

# discord-rollout-sampler

**Notre propre système de pourcentages de rollouts Discord** — mesuré directement sur l'API Discord, indépendant de tout tracker communautaire.

## Pourquoi

Les pourcentages user étaient lus dans le gist communautaire (également collecté et publié par Wumpus Central). Ce dépôt démontre une alternative 100 % autonome : on ne « prend » rien à personne, on **mesure nous-mêmes**.

## Comment ça marche

1. **Sondage de fingerprints** : chaque appel (sans token) à `api/v10/experiments` renvoie un fingerprint aléatoire côté Discord et les buckets d'expériences qui lui sont assignés. En sondant ~1 200 fingerprints par run, on mesure la répartition par bucket.
2. **Statistiques honnêtes** : % = fréquence observée + **intervalle de confiance de Wilson (95 %)** affiché (±X). Pas de faux pourcentages : tant que la fenêtre n'a pas assez d'échantillons (≥ `SAMPLER_MIN_N`), rien n'est publié.
3. **Fenêtre glissante** : l'estimation porte sur les `SAMPLER_WINDOW_RUNS` derniers runs (3 × ~1 200 ≈ 3 600 échantillons → ±0,5 à ±1 point).
4. **Détection de changements** : on annonce uniquement les deltas ≥ `SAMPLER_MIN_DELTA` points (défaut 2) entre la fenêtre courante et le dernier état annoncé.
5. **État cumulatif** : `data/sampler_state.json` est committé à chaque run — le diff se calcule au run suivant, l'historique reste auditable.

## Sources de données

- **API Discord uniquement** (canary → stable en fallback). Aucun gist communautaire, aucun worker tiers, aucune donnée Wumpus Central.
- Les noms d'expériences (optionnels) proviennent de `known_experiment_ids.json` du dépôt discord-canary-scraper (nos propres données scrapées), hashés via murmur3.

## Setup webhook

1. Créer un webhook Discord.
2. Repo → *Settings → Secrets and variables → Actions → New repository secret* :
   - Name : `SAMPLER_WEBHOOK_URL`
   - Value : l'URL du webhook

Aucun token Discord n'est nécessaire (le sampling est anonyme).

## Workflows

- `ci.yml` : `node --check` + tests unitaires à chaque push.
- `sampler.yml` : run du sampler à chaque push (hors `data/**`) + toutes les 30 min + `workflow_dispatch`. Committe l'état après chaque run.

En mode LAB (`SAMPLER_LAB=1`, défaut), chaque run envoie un rapport au webhook — idéal pour valider le système. Passer à `0` pour ne notifier que les changements réels.

## Env

| Variable | Défaut | Rôle |
|---|---|---|
| SAMPLER_WEBHOOK_URL | — | webhook Discord |
| SAMPLER_TARGET | 1200 | fingerprints par run |
| SAMPLER_CONCURRENCY | 3 | requêtes en parallèle |
| SAMPLER_DELAY_MS | 250 | délai entre requêtes (+ jitter) |
| SAMPLER_MAX_MS | 240000 | budget temps d'un run |
| SAMPLER_WINDOW_RUNS | 3 | runs dans la fenêtre d'estimation |
| SAMPLER_MIN_N | 500 | échantillons min. pour publier un % |
| SAMPLER_MIN_DELTA | 2 | delta min. (points) pour annoncer |
| SAMPLER_LAB | 1 | rapport de run à chaque passage |
| SAMPLER_REMOVED_AFTER | 6 | runs d'absence avant purge d'une expérience |
| SAMPLER_NAMES_URL | (dépôt principal) | liste d'IDs pour nommer les hash |

## Tests

`npm test` — statistiques (Wilson, agrégation, fenêtre, classification), boucle de sampling (fausse API, 429), embeds, webhook.

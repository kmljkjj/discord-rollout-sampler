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
- Les noms d'expériences (optionnels) proviennent de `data/known_experiment_ids.json` — **copie embarquée dans ce dépôt** de nos propres données scrapées depuis le build public du client Discord (hashées via murmur3). Le dépôt principal étant privé, son URL raw est inaccessible : le sampler charge donc cette copie locale, publique. Pour rafraîchir les noms, mettre à jour ce fichier depuis `discord-canary-scraper`. Les expériences absentes de cette liste s'affichent sous la forme `hash:NNNN`.

## Guild experiments (exact)

Le sampler lit aussi les **rollouts guild** (expériences de serveurs) : `GET /experiments?with_guild_experiments=true` expose le wire brut de Discord — pour chaque expérience, les intervalles de rollout de chaque bucket sur une échelle 0-10000. Le % est donc **exact** (composition publiée par Discord), pas une estimation. Lecture directe de l'API, aucune donnée communautaire ; décodage adapté de notre dépôt principal.

Deux catégories cohabitent :

- **user** : estimation par échantillonnage de fingerprints (invités anonymes — ~5 expériences visibles avec un seul profil web ; les profils client ci-dessous élargissent la population) ;
- **guild** : % exacts lus dans le wire, deltas ≥ `SAMPLER_MIN_DELTA` annoncés. Anonymement, Discord n\u2019expose qu\u2019un petit sous-ensemble (~5) ; avec le secret `SAMPLER_TOKEN`, quelques expériences du contexte du compte s'ajoutent (vérifié : 5 → 6) — mais Discord ne publie **pas** la liste complète (~500) sur cette API, même authentifié. Les ~500 visibles ailleurs viennent de sources communautaires (gist/worker), hors périmètre de ce dépôt.

Les % guild sont par nature identiques pour tout lecteur de cette API : c'est une donnée publiée par Discord elle-même, pas une copie de qui que ce soit.

## Profils client & X-Fingerprint (user)

Recherche vérifiée (doc discord-userdoccers + dépôt principal) : pour les **user experiments**, l'API `/experiments` ne renvoie que le **bucket assigné** (hash, bucket, population…) — jamais les ranges de rollout. Il n'existe donc **pas de % exact user dans l'API Discord** ; les ~500 % affichés par les trackers communautaires viennent du gist/worker, pas de l'API. La seule voie 100 % API = l'estimation par échantillonnage — et c'est **exactement ce que font les trackers** (vérifié dans leur code, cf. section suivante).

Ce que l'API montre dépend aussi du **contexte client** : Discord filtre les expériences par plateforme, canal de release et build. Un invité web « nu » n'expose que ~5 expériences. Le sampler élargit donc la population sondée, toujours sans biais :

- **Multi-profils `X-Super-Properties`** : web stable / canary / ptb + Android + iOS, en round-robin (la cible est répartie entre profils). Un profil non éligible pour une expérience ne renvoie **aucune observation** pour son hash → le pooling par hash reste valide (on n'observe que les populations où l'expérience est visible).
- **Re-test `X-Fingerprint`** (`SAMPLER_FP_REUSE`, défaut 1) : la doc indique que renvoyer le fingerprint du premier appel permet d'accéder aux portions **API-locked** des expériences. Chaque fingerprint sondé est ré-interrogé une 2e fois ; seuls les hashes absents de la 1re réponse sont comptés — pas de double comptage. Le rapport LAB affiche « API-locked (X-Fingerprint) : +N obs. ».

Env associées : `SAMPLER_PROFILES` (JSON, ex. `["web-canary","android"]` — sous-ensemble des profils), `SAMPLER_BUILD` (client_build_number web, ex. 451408), `SAMPLER_FP_REUSE` (1/0).

## Reconstruction de ranges — la méthode des trackers, vérifiée dans leur code

Comment Wumpus Central / Discord Experiment Hub obtiennent leurs « vrais » % user — vérifié dans le code de [discordexperimenthub/experimentAPI](https://github.com/discordexperimenthub/experimentAPI) (co-créé par Discord Experiment Hub **et Wumpus Central**) :

1. `run.js` lance 10 processus `rollout-calculation.js` en parallèle, chacun fait **10 000 requêtes anonymes** à `/api/v10/experiments` (sans token, 700 ms d'intervalle) → ~100 000 fingerprints sondés par mise à jour.
2. Chaque assignment contient `hash_result` : la **position du fingerprint** dans l'échelle de rollout 0-9999 (la même donnée que notre `posMin`/`posMax`).
3. Positions regroupées par (hash, bucket) → min/max → range (arrondi à 500 dans la version publique 2023 ; le worker/gist actuel publie des ranges multi-segments fins).

**Conclusion : leurs % user ne sont pas « reçus » de Discord.** Ils sont reconstruits par échantillonnage massif de la même API publique anonyme — aucune donnée privilégiée n'existe (la doc userdoccers confirme que l'API ne publie pas de ranges user). Les noms, eux, viennent du build du client (leur `discrapper-canary` ↔ notre `known_experiment_ids.json` du dépôt principal).

Le sampler implémente la même reconstruction, intégrée au pipeline :

- les positions `hash_result` de chaque bucket sont collectées à chaque run, compressées en **segments** (`computeSegments`, tolérance de fusion 150) puis unionnées sur la fenêtre (`mergeWindow`) ;
- le LAB affiche les ranges reconstruits : « Variant 1 6% [9510-9999] » — la résolution s'affine à mesure que la fenêtre cumule des échantillons (~500/run → ~6 000 sur la fenêtre de 12 runs ; les trackers font ~100 000 par mise à jour) ;
- le % Wilson reste la valeur publiée de référence (non biaisée même si des trous subsistent) ; `segPct` sert de contre-vérification croisée.

## Nommage des hash - pourquoi certains restent anonymes

L'API `/experiments` ne renvoie **que le hash** : `hash = murmur3(experiment_id)` (seed 0). Le nom n'est jamais transmis ; pour l'afficher, le sampler calcule le murmur3 de chaque id connu (`data/known_experiment_ids.json`, ids scrapés du build public du client par le dépôt principal) et matche les hash. C'est le mécanisme inverse du dépôt principal, et celui de tous les trackers.

**Diagnostic du 2026-10-25** : sur les 7 expériences suivies, 2 sont nommées ; les 5 autres n'apparaissent dans **aucune** liste publique de noms - vérifié en diagnostic uniquement (aucune donnée consommée par le sampler) :

- gist agnonotdev `rollouts.json` : 53 rollouts actifs, champ `hash` = murmur3(id) (vérifié sur échantillon) - aucun des 5 ;
- Wumpus Central `discrapper-canary` : `data/experiments.json` (28 noms) + `data/apex_experiments.json` (102 noms) - aucun des 5 ;
- API advaith (guild, nommée) - aucun des 5 ;
- notre propre scrape du build canary 650180 (547 ids) - aucun des 5.

Conclusion : ces expériences n'ont **pas de code client** dans le build public (serveur seul, ou id jamais embarquée dans le JS). Personne ne peut les nommer - les trackers ont exactement la même limite, leur nommage vient aussi du scrape du client. `hash:NNNN` est donc l'affichage honnête ; le nom apparaîtra si Discord livre un jour le code correspondant (rafraîchissement de `known_experiment_ids.json` depuis le dépôt principal).

## Setup webhook

1. Créer un webhook Discord.
2. Repo → *Settings → Secrets and variables → Actions → New repository secret* :
   - Name : `SAMPLER_WEBHOOK_URL`
   - Value : l'URL du webhook

Aucun token Discord n'est nécessaire (le sampling est anonyme).

**Optionnel** : le secret `SAMPLER_TOKEN` (un token utilisateur, comme ceux du dépôt principal) enrichit la liste guild de quelques expériences du contexte du compte — vérifié en run réel : 5 → 6, dont un rollout partiel à 95 %. Sans ce secret, le sampler reste 100 % anonyme. Jusqu'à 5 comptes : `SAMPLER_TOKEN` puis `SAMPLER_TOKEN_2` … `_5` (équivalents des `DISCORD_USER_TOKEN_1..5` du dépôt principal) — chaque compte ajoute les expériences de son contexte, les réponses sont fusionnées par hash et les % recalculés sur l'union des ranges ; le rapport LAB affiche `token ×N`. NB : la liste « complète » (~500) des trackers communautaires ne vient **pas** de cette API — le dépôt principal la lit dans un gist/worker communautaire.

## Workflows

- `ci.yml` : `node --check` + tests unitaires à chaque push.
- `sampler.yml` : run du sampler à chaque push (hors `data/**`) + toutes les 30 min + `workflow_dispatch`. Committe l'état après chaque run — le run part toujours du `main` à jour (checkout `ref: main`) et le push d'état est protégé par un `pull --rebase` avec retry : un commit sur `main` pendant un run ne fait plus perdre l'état.

En mode LAB (`SAMPLER_LAB=1`, défaut), chaque run envoie un rapport au webhook — idéal pour valider le système. Passer à `0` pour ne notifier que les changements réels.

Le workflow `sampler.yml` utilise des valeurs ajustées après les premiers runs réels : `SAMPLER_TARGET=500`, `SAMPLER_CONCURRENCY=4`, `SAMPLER_MAX_MS=420000` (7 min), `SAMPLER_WINDOW_RUNS=12` (6 h de mesures), `SAMPLER_MIN_N=250`. Fenêtre large nécessaire pour les rollouts partiels : une expérience à 5 % ne récolte que ~25 échantillons par run — il faut plusieurs heures de mesures pour publier son % (au seuil : ~300 échantillons, marge Wilson ±2,4 points).

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
| SAMPLER_PROFILES | (tous) | sous-ensemble de profils client (JSON) |
| SAMPLER_BUILD | 451408 | client_build_number des super-props web |
| SAMPLER_FP_REUSE | 1 | re-tester chaque fingerprint avec X-Fingerprint |

## Tests

`npm test` — statistiques (Wilson, agrégation, fenêtre, classification), boucle de sampling (fausse API, 429), guild wire (décodage, diff, fetch), embeds, webhook.

## Première validation (2026-10-24)

- Run 1 : 231 fingerprints sondés, 5 expériences suivies — workflow + CI verts.
- Run 2 : 407 fingerprints (budget 7 min), fenêtre de 638 échantillons → 3 expériences mesurées (Variant 1/11 à 100 %, ±0,3).
- 23h00 : premier run **cron** (déclenché en retard par GitHub, comme souvent sur un workflow récent) — rapport LAB reçu. Constat : le push d'état était rejeté quand `main` bougeait pendant un run (checkout figé au SHA du push déclencheur, pas de rebase) → correctif : checkout `ref: main` + `pull --rebase` avec retry.
- Extension **guild experiments** — % exacts lus dans le wire Discord (`src/guild.js`), en plus des % user estimés par échantillonnage.
- `data/sampler_state.json` committé automatiquement par le workflow après chaque run.

- 02:11 → 02:36 : `SAMPLER_TOKEN` ajouté et diagnostiqué en runs réels (l'état archive `auth`, `raw` et chaque tentative host/version/statut). Verdict : le secret arrive bien (200 auth) ; v10 renvoie 5 guild experiments même authentifié, v9 en renvoie 6 — dont `2025-08_default_invite_expiration_guild` (Variant 2 à 95 %), invisible en anonyme. Conclusion vérifiée dans le dépôt principal : ses ~499 % user viennent du gist communautaire (agnonotdev) et du worker `experiments.dscrd.workers.dev` — PAS de l'API Discord seule. Le sampler mesure donc **tout ce que Discord nous montre** : c'est la limite de la mesure 100 % indépendante, pas un bug.
- 02:44 : support **multi-tokens** (`SAMPLER_TOKEN_2..5`) — chaque token interroge la chaîne v9, fusion des réponses par hash (union des ranges par bucket, % recalculés), le LAB affiche `token ×N`. Un seul token = contexte d'un seul compte ; les autres tokens élargissent la collecte.

- **Profils client + X-Fingerprint** : le sampling teste désormais 5 contextes client (web stable/canary/ptb, Android, iOS) en round-robin via `X-Super-Properties`, et ré-interroge chaque fingerprint (`X-Fingerprint`) pour révéler les hashes API-locked — objectif : dépasser les ~5 user experiments visibles avec un profil web seul.
- 03:01 → **run de validation** (#17) : 5 → **7 expériences suivies**. Deux nouvelles découvertes (`hash:2582794089`, `hash:3948141150`, absentes de la liste des noms connus) ne sont visibles **que sur les profils web** : 123 observations = web-stable 42 + web-canary 41 + web-ptb 40, **zéro** sur Android/iOS — preuve directe du filtrage par contexte client. Re-test X-Fingerprint : **+23 observations API-locked**. Trade-off : 204 fingerprints/run (vs ~496 avant) car 2 requêtes par fingerprint → arrêt propre sur budget (`SAMPLER_MAX_MS`) ; désactivable via `SAMPLER_FP_REUSE`.

- **Reconstruction de ranges** (méthode des trackers, vérifiée) : le sampler collecte désormais les positions `hash_result` par bucket et reconstruit les ranges en segments cumulés sur la fenêtre — les % user « exacts » des trackers sont eux-mêmes estimés ainsi depuis l'API publique, rien ne nous est inaccessible.
- **Nommage** (2026-10-25) : pourquoi des `hash:NNNN` ? L'API ne renvoie que le hash (= murmur3 du nom) ; les 5 hash non nommés du run courant n'existent dans aucune liste publique (gist, Wumpus, advaith, notre scrape 547 ids) - expériences sans code client, non nommables par quiconque, trackers inclus. Cf. section "Nommage des hash".

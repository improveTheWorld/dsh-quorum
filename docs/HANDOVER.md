# Passation — mode Boost DSH

Document autoportant. Il est écrit pour une session qui **n'a aucun souvenir** de celle qui l'a
précédé. Lis-le en entier avant d'agir, puis applique la procédure de coupure du §11 : c'est elle qui met le dépôt consolidé et le profil vivant d'accord.

Les règles de méthode permanentes sont chargées automatiquement depuis `~/.dsh/AGENTS.md` (dix règles :
le fond jamais le pansement, des tests toujours, instrumenter avant de conclure, revérifier l'état sur
lequel on raisonne à chaque changement de code, ne jamais placer un diagnostic en aval de la panne,
un contrôle qui devine est pire qu'un contrôle qui s'abstient, compter les enregistrements et non les
occurrences de texte, etc.). **Elles ne sont pas répétées ici** et elles s'appliquent.

---

## 1. Où en est le travail, en une ligne

Le mode Boost est **implémenté et vérifié** ; le relais de jobs **fonctionne** ; l'outil `run_detached`
— qui supprime la cause de fond au lieu d'en signaler le symptôme — est **monté, actif et vérifié de
bout en bout** : un job lancé par un worker lui a survécu 40 s, et la session racine a lu sa sortie.
Les quatre causes de son échec de montage, plus une cinquième trouvée par le test lui-même, sont
mesurées et corrigées (§3).

## 2. Ce qui est acquis et vérifié (ne pas refaire)

| Élément | État | Preuve |
|---|---|---|
| Preset `preset-boost` (mode Boost) | actif | 1700 lignes composées, `Config.listConfigs` |
| `@local/dsh-boost-relay` — relais des jobs d'enfants | **fonctionne**, 14 tests verts | une session Boost a reçu l'avis de teardown de `pwsh-7`, résolution par en-têtes durables comprise ; `node --test test/notice.test.mjs` (5 cas) et `test/journal.test.mjs` (9 cas) |
| Journal du relais | **borné et sans bruit** — commité `8873f5f` | les événements `output`/`progress` ne sont plus tracés : ils faisaient **50,8 %** d'un fichier de 43 Mio qui grandissait sans borne ; rotation à 8 Mio, disque plafonné à 16 Mio. A/B **sur le vrai registre de jobs**, 82 abonnements montés : avis **identiques au byte près** (4 = 4, même texte, même ordre, même canal) pendant que le journal passe de **1895 à 107 enregistrements**. Les chiffres 94 → 19 du premier tour n'étaient pas reproductibles faute de fixture versionnée ; ceux-ci le sont |
| Filtre d'abonnement du relais | **corrigé** — mesuré, pas supposé | le plugin souscrivait `{ owners: { owner } }`, forme **absente** de l'union `JobEventFilter` (`dsh-jobs/lib/types/types.d.ts:211-222`), alors que le hub ne filtre que sur `owner` **singulier** (`dsh-jobs-local/lib/index.js:75`) : **82 abonnements** par process, 82 enregistrements identiques pour un seul règlement, 78 770 lignes `skip` pour 1 924 règlements. Le global `{ owners: 'all' }` est **conservé** : `ctx.agents.list()` a rendu `[]` à l'installation dans un process où trois agents vivaient, donc un propriétaire jamais énuméré serait invisible |
| `@local/dsh-detached-jobs` — `run_detached` | **actif et vérifié** | un job lancé par un worker a survécu (`cause=producer` 40,3 s plus tard, **aucun** `teardown`) et la racine a lu `DETACHED-OK` — §5, test 2 |
| Outillage d'analyse (`tools/`) | 22 tests unitaires verts | `node --test tools/tests.test.mjs` |
| Résolution de propriété (`rootOf`) | 10 tests unitaires verts | `node --test test/root.test.mjs` |
| Activation (`apply`, contexte strict) | 15 tests unitaires verts, dont la racine du texte rendu, la source muette et le `pwshPath` configuré | `node --test test/apply.test.mjs` |
| Résolution du shell du producteur | 8 tests unitaires verts, dont un spawn réel | `node --test test/shell.test.mjs` |
| Déversement, annonce et livraison unique (`spill`) | 9 tests unitaires verts | `node --test test/spill.test.mjs` |
| Purge du store (`purge`) | 10 tests unitaires verts | `node --test test/purge.test.mjs` |
| Suite complète | **52 tests verts** | `node --test` — sans argument, cwd du projet (`node --test test/` échoue en MODULE_NOT_FOUND) |
| Annonce par le vrai registre | sonde verte, contrôle négatif rouge (exit 1) | `node tools/probe-spill-announce.mjs` |
| Résolution par la jonction du profil | sonde verte | `node tools/probe-profile-import.mjs` |

### Découverte structurante, déjà payée

**Un job d'arrière-plan lancé par un worker jetable est détruit avec lui.** Mesuré :

```
19:32:57  registered job=pwsh-1   ← un worker lance un job de 60 s
19:33:00  stopping   job=pwsh-1   ← le worker rend la main
19:33:00  settled    job=pwsh-1   cause=teardown
19:33:00  removed    job=pwsh-1
```

Conséquences : le travail n'a pas eu lieu, sa sortie est perdue, et l'orchestrateur — qui croit une
campagne en cours — n'est informé de rien et **ne peut même pas lire le job** (`job_output` est filtré
par le propriétaire).

**La cause n'est pas le teardown** — cette garantie est délibérée et correcte : elle évite les
processus orphelins (`JobSettleCause = 'producer' | 'kill' | 'teardown'`). **La cause est le choix du
propriétaire** : `pwsh` passe `owner: exec.agent.id`, l'agent appelant
(`dsh-tool-pwsh/lib/index.js:366-369`), alors que le propriétaire est un **paramètre** de
`jobs.start({ owner })`, et qu'un job destiné à survivre doit être confié à la session qui sera encore
là (`dsh-jobs/lib/types/types.d.ts:122-128`).

## 3. Résolu — quatre causes en cascade, toutes mesurées

Le montage échouait depuis six tours, et il y avait **quatre** défauts : chacun masquait le suivant, et
c'est la remise en état de l'instrumentation qui les a fait apparaître l'un après l'autre.

| # | Message mesuré | Ce qui était faux |
|---|---|---|
| 1 | `ReferenceError: trace is not defined` (`lib/index.js:324`, **dans le `catch`**) | le helper `trace` n'existait nulle part : le premier appel levait, le `catch` levait à son tour, `apply()` ne rendait jamais la main. **Le diagnostic était la panne.** |
| 2 | `register-failed: detachedTool is not defined` | l'objet outil était déclaré dans `apply()` alors que l'installeur de portée module s'en servait : aucun agent n'aurait reçu l'outil |
| 3 | `apply-failed: cannot get property "agents" without inject` (`:375`) | lecture d'un service non déclaré ; le chaînage optionnel ne l'adoucit pas, cordis lève sur le *get* |
| 4 | `register-failed: tool "run_detached" must declare output { schema, render, presentationMeta? }` | le registre refuse un outil sans `output` : la ligne reste `active` et l'outil est absent de **toutes** les surfaces (`dsh-tools/lib/types/index.js:459-466`) |

Et un cinquième, trouvé par le test 2 lui-même — le premier job détaché a échoué alors que tout le
reste venait d'être prouvé correct :

| # | Message mesuré | Ce qui était faux |
|---|---|---|
| 5 | `spawn pwsh ENOENT` | le producteur **nommait** son exécutable. PowerShell 7 n'est pas installé ici ; la résolution reprend désormais celle du harnais (`dsh-pwsh-local/lib/types/resolve.js:23-65`) |

**Le fil commun** : quatre de ces cinq défauts sont *statiques* — une fonction absente, une portée, un
service non déclaré, un champ obligatoire manquant — donc invisibles tant que rien n'appelle `apply()`
et que personne ne lit le journal. Deux leçons, qui valent au-delà de ce plugin : **un banc de test qui
n'appelle jamais `apply()` ne prouve rien du montage**, et un contexte de test permissif (un objet
simple au lieu d'un contexte strict qui lève sur un service non injecté) laisse passer exactement le
défaut qui casse en production.

L'état vérifié est dans §5.

## 4. Les trois contrôles — faits, et comment les refaire

**A. La ligne s'est-elle activée ?** Le journal du plugin répond mieux que l'inventaire, et il ne
dépend d'aucun outil de la session. **Mais il faut lire les deux fichiers**, et la raison est mesurée.

**Pourquoi la recette d'origine rendait un faux négatif par construction.** Le relais **tourne** son
journal à chaque démarrage : `decisions.jsonl` ne contient que les enregistrements du process vivant
depuis son démarrage, et les enregistrements de cycle de vie de ce démarrage partent dans
`decisions.jsonl.1`. Mesure du 2026-09-30 (process `dsh web` pid **4248**, démarré à 20:17:31) :

| fichier | `"step":"mount"` | `capture` | `apply-complete` | `agents-ready` | `"via":"first-mount"` |
|---|---|---|---|---|---|
| `decisions.jsonl` (courant) | **0** | 0 | 0 | 0 | 0 |
| `decisions.jsonl.1` (tourné) | 9 | 9 | 8 | 8 | 9 |

L'activation du process vivant était aux **lignes 677744-677748** de `.1` :

```
677744 {"at":"2026-09-30T18:17:34.761Z","step":"mount","first":true,"pid":4248}
677745 {"at":"2026-09-30T18:17:34.762Z","step":"capture","via":"first-mount","pid":4248,"share":false}
677746 {"at":"2026-09-30T18:17:34.763Z","step":"agents-inject-requested"}
677747 {"at":"2026-09-30T18:17:34.763Z","step":"apply-complete"}
677748 {"at":"2026-09-30T18:17:34.896Z","step":"agents-ready","count":0}
```

La recette d'origine — `Get-Content decisions.jsonl | Select-String -Pattern 'mount|capture|…'` — ne
lisait que le fichier **courant**, où ces motifs sont à **0** : elle n'y rendait plus que des
`registered`, qui sont des enregistrements de **jobs** (28 `"step":"registered"` d'agents et 910
`"type":"registered"` de jobs mesurés dans le courant), pas des montages. Et dans `.1`, **9 `mount`
pour 8 `apply-complete`** : un démarrage a échoué (`apply-failed`, pid 22180, « cannot get property
"agents" without inject » — la cause n°3 du §3). La lecture se fait donc par **`pid`**, jamais par « le
dernier du fichier ».

Recette corrigée — elle ne dépend d'aucun fichier courant :

```powershell
$dir = "$env:USERPROFILE\.dsh\plugin-data\dsh-boost-relay"
Get-ChildItem "$dir\decisions.jsonl*" |
  Select-String -Pattern '"step":"(mount|capture|agents-inject-requested|apply-complete|apply-failed|agents-ready)"'
```
Sortie brute du 2026-09-30 (extrait, les neuf démarrages) : `decisions.jsonl.1:677744 … :677748` pour le
pid 4248 (montage complet), et `decisions.jsonl.1:12256-12258` pour le pid 22180
(`mount` → `capture` → `apply-failed`). Attendu pour le pid visé : `mount` (`first:true`) et
`capture` (`via:"first-mount"`), puis `agents-inject-requested`, `apply-complete`, `agents-ready`.
**Un seul `mount` par process** : la composition ne porte qu'une déclaration qui monte (§6).

**B. L'outil est-il dans MA surface ?** C'est le contrôle décisif, et il est direct. `plugin_manager` et
`cordis_inspect_query` **ne sont pas dans la surface PTC** de cette session (mesuré : `undefined`) ; on
lit donc la source — `run_detached` figure dans le SDK généré, et
`typeof tools.run_detached === "function"` le confirme depuis un programme.

**C. Un agent neuf reçoit-il l'outil ?** L'installation est **par agent** (`agent/created`), donc la
seule preuve est un worker réel : c'est le test 2, avec un worker qui rapporte l'identifiant du job au
lieu de le simuler.

## 5. Les tests à exécuter

### Test 1 — l'outil existe (30 secondes)

L'inventaire de §4.C contient `run_detached`. **Si oui, la correction du montage est prouvée**,
indépendamment de tout comportement.
Si non : passer à §6.

### Test 2 — un job détaché survit à son worker (2 minutes)

À faire **depuis cette session Boost** (l'orchestrateur est dans la portée du preset). Déléguer à un
worker avec cette consigne **littérale** :

```
TEST D'OUTILLAGE — but : vérifier qu'un job lancé par un worker lui survit.
Ce n'est pas une tâche de développement : exécute et rends la main, sans reconnaissance,
sans plan, sans vérification.

Appelle l'outil run_detached (en PTC : tools.run_detached) avec :
  command: "Start-Sleep -Seconds 40; Write-Output 'DETACHED-OK'"
  label: "test-detached"
puis écris ton rapport contenant l'identifiant du job et ARRÊTE-TOI IMMÉDIATEMENT.
N'attends pas, ne lis pas la sortie, ne tue pas le job, ne lance rien d'autre.
```

**Critères, dans l'ordre — et ils sont binaires :**

1. le worker rend un identifiant de job (sinon : l'outil est absent de *sa* surface aussi) ;
2. dans `decisions.jsonl`, **aucun** `settled cause=teardown` pour cet identifiant quand le worker se
   termine → **le job a survécu** (c'est la preuve qui manquait à tous les essais précédents) ;
3. ~40 s plus tard, le job se termine, et **cette session (la racine) lit `DETACHED-OK`** avec
   `job_output` → la propriété est bien passée au père, ce qui répare du même coup la lecture refusée
   (`unknown job`) ;
4. dans `decisions.jsonl`, la ligne `capture via first-mount` → la portée non scopée a été capturée
   par le bon montage.

**Résultat — 2026-09-29 23:14, pid 3664. Les quatre critères, dans l'ordre :**

```
21:14:13.598  registered  job=pwsh-3                            ← le worker appelle run_detached
              job_list    → pwsh-3 [pwsh] running — test-detached  ← le worker est déjà parti
              job_output  → "DETACHED-OK\r\nDETACHED-OK\r\n"  (completed, exit code: 0)
21:14:53.944  settled     job=pwsh-3 owner=018354d9 cause=producer ← 40,3 s après, aucun teardown
21:14:53.948  resolve     liveCount=1                            ← seule la racine est vivante
```

Pendant toute la vie du worker, le registre n'a écrit qu'un `registered` pour `pwsh-3` : ni `stopping`,
ni `cause=teardown`. Le job a survécu à son worker et sa sortie est remontée à la racine — la lecture
refusée (`unknown job`) a disparu du même coup.

### Test 3 — non-régression de l'outillage

```
cd C:\CodeSource\dsh-boost
node --test tools/tests.test.mjs                          # attendu : 22/22
node --test packages\detached-jobs\test\root.test.mjs   # attendu : 10/10
```

### Test 4 — les deux preuves qui exigent un process neuf (1 minute)

Le code d'un module ne se recharge qu'avec un process neuf : après un redémarrage de `dsh web`, ces
deux commandes doivent rendre ce qui suit. Elles ne modifient rien.

```
cd C:\CodeSource\dsh-boost\packages\detached-jobs
node --test                                  # attendu : 52/52 (sans argument !)
node tools/probe-spill-announce.mjs          # attendu : PROBE-PASS, spillPaths non vide, exit 0
```

Puis, depuis une session Boost, un job détaché lancé **par la racine elle-même** doit rendre le texte
de la racine — « It outlives this turn: read it with job_output » — et non la phrase du worker. Enfin
`job_output` sur un job dont la sortie a dépassé le ring ne doit plus dire
`full output: (unavailable)` mais citer le chemin, et ce chemin doit finir par `-<6 hexa>.log`.

## 6. La composition : une seule déclaration, et la ligne morte qui a été retirée

`run_detached` est déclaré **une fois** : par le bundle `@local/dsh-detached-jobs` (entrée de
`dsh.profile.bundles` dans `profiles/web/package.json`, plus `insert:` de son propre
`cordis.patch.yml`).

La ligne `run-detached-jobs` qui vivait dans `profiles/web/cordis.patch.yml` a été **retirée** le
2026-09-29. Elle ne montait pas, et elle ne *pouvait* pas monter : dans cette couche, une entrée sans
liste `insert:` ne crée rien — elle remplace des champs d'une ligne **existante**
(`dsh-app-boot/lib/index.js:91-97`). Un id que personne ne déclare n'a donc pas de cible, et
l'avertissement `patch: entry "run-detached-jobs" not found` part dans le terminal de `dsh web`, où
personne ne le lit. C'est la version « composition » du piège des six tours : une ligne morte qui a
l'air vivante.

Mesure à l'appui : **un seul `mount` par process** dans trois process successifs (pids 22180, 8488,
3664), et cette trace arrive **avant** celle du relais — donc une ligne de la couche bundle.

Si un jour il fallait déclarer une ligne dans ce patch, la seule forme qui crée est :

```yaml
- insert:
    - id: une-ligne
      name: "@local/un-plugin"
```

## 7. Inventaire

**Dépôt consolidé `C:\CodeSource\dsh-boost`** (git, commit initial `652ef83`) — c'est lui qui porte le
livrable. Les cinq dépôts d'origine ne sont plus que des cibles de `link:` tant que le profil n'a pas été
repointé (§11).

| Chemin | Rôle |
|---|---|
| `package.json` (racine) | **le livrable** : `@local/dsh-boost`, `dsh.bundle.patch: ./cordis.patch.yml`, cinq dépendances `file:packages/<paquet>` |
| `cordis.patch.yml` (racine) | **UNE** entrée `insert:` portant les cinq lignes, recopiées des cinq patches d'origine |
| `index.js` | entry point du bundle — aucune API runtime |
| `test/aggregate.test.mjs` | le test anti-dérive (4 cas) : ids, `config` en JSON canonique, `name` résolvant vers le même module, aucun id dupliqué |
| `docs/HANDOVER.md` | **ce document — l'état fait foi ici** |
| `docs/PLAN.md` | **document historique** : conception, jalons M0-M5, copie du patch qui a divergé, affirmations périmées marquées comme telles |
| `docs/PROTOCOL.md` | protocole des trois phases + prompt de mission de torture + recevabilité d'une preuve |
| `tools/` | **onze** fichiers (relevé du 2026-09-30) : `session-log.mjs` (décodage zstd multi-frame), `parse.mjs` (helpers purs, testés), `boost-report.mjs` (rapport de run), `audit.mjs` (contrôles de santé), `protocol.mjs` (notation du protocole), `integrity.mjs` (a-t-on lu l'interdit), `find-text.mjs` (où vit une chaîne), `check-notices.mjs` (le père a-t-il entendu ses fils), `diagnose-frames.mjs` (trame zstd sur disque), `dump-records.mjs` (types et formes d'enregistrements), `tests.test.mjs` (22 cas). `find-clock.mjs` a été **retiré du dépôt** pendant la passe du 2026-09-30 (`git status` : ` D tools/find-clock.mjs`) — ne pas le chercher |
| `packages/boost-mode/` | `preset-boost` (`@local/dsh-boost-mode`) : `cordis.patch.yml` (persona orchestrateur + trois rôles + leurs `toolFilter`), `lib/index.js`, `README.md` — **aucune suite de tests** |
| `packages/boost-relay/` | `boost-job-relay` (`@local/dsh-boost-relay`) : `lib/index.js`, `test/notice.test.mjs` (5), `test/journal.test.mjs` (9), `README.md` — **fonctionne** |
| `packages/boost-status/` | `boost-status-command` (`@local/dsh-boost-status`) : commande `/boost-status`, `test/status.test.mjs` (10) — active |
| `packages/detached-jobs/` | `dsh-detached-jobs` (`@local/dsh-detached-jobs`) : `lib/index.js`, `test/root.test.mjs` (10, propriété), `test/apply.test.mjs` (15, activation en contexte strict), `test/shell.test.mjs` (8, résolution du shell), `test/spill.test.mjs` (9, déversement et livraison unique), `test/purge.test.mjs` (10, purge du store), `tools/probe-profile-import.mjs` (résolution par la jonction), `tools/probe-spill-announce.mjs` (annonce par le vrai registre) — **actif et vérifié** |
| `packages/guard-surrogate/` | `dsh-guard-surrogate` (`@local/dsh-guard-surrogate`) : `lib/index.js`, `lib/walker.js`, `test/guard.test.mjs` (26), `README.md` — répare les surrogates isolés sur `tools/post-execute` (§10) |

**Hors du dépôt, mais sur le chemin critique** :

| Chemin | Rôle |
|---|---|
| `C:\Users\bilel\.dsh\profiles\web\package.json` | **le profil réel** : cinq `link:` vers les cinq **dépôts d'origine** (pas vers le dépôt consolidé — c'est ce que règle le §11), plus `@local/dsh-auto-update` |
| `C:\Users\bilel\.dsh\profiles\web\cordis.patch.yml` | patch du profil : configuration de lignes **existantes** — une entrée sans `insert:` ne crée rien. Les trois entrées mortes `time-context` / `schedule` / `ui-schedule` sont aux **lignes 61-66** (§11) |
| `C:\Users\bilel\.dsh\profiles\boost-test\` | le profil de recette : `"@local/dsh-boost": "link:C:/CodeSource/dsh-boost"`, jonction `node_modules\@local\dsh-boost`, et les cinq ids dans `--dump-config` |
| `C:\Users\bilel\.dsh\profiles\local-plugins\dsh-auto-update\` | `@local/dsh-auto-update` — **bundle de profil, hors de ce dépôt** : outil `harness_update` (`status`/`check`/`apply`/`migrate`), commande `/update`, notification de version dans le prompt, `lib/*.js`, `install.ps1`, `test/selftest.mjs` |
| `C:\Users\bilel\.dsh\plugin-data\dsh-boost-relay\decisions.jsonl` (+ `.1`) | journal de décisions des **deux** plugins, **avec rotation** — les enregistrements de cycle de vie du process vivant sont dans `.1` (§4.A) |
| `C:\CodeSource\boost-torture-archive\` | campagnes 1 et 2, **contaminées** — archives uniquement |

## 8. Faits du harnais à ne pas redécouvrir

- **`fiberPhase: failed` ne dit rien.** Aucune erreur n'est écrite dans un fichier accessible. Un
  module dont `apply()` n'est jamais appelé ne peut rien tracer. Vérifier `fiberPhase` **après chaque
  édition**, et importer le module par **le chemin du profil** (jonction), pas par le chemin de travail.
- **`inject = [...]` est une dépendance dure** : un service indisponible dans la portée de la ligne
  fait échouer la fibre **avant `apply()`**, donc sans aucune trace. La forme douce
  `ctx.inject(['x'], cb)` attend sans échouer. `jobs` est disponible au niveau hôte ; `tools` ne l'est
  pas.
- **Lire un service non déclaré lève sur le _get_** : `ctx.agents` sans `agents` dans `inject` donne
  `cannot get property "agents" without inject`, et `?.` n'y change rien.
- **`ctx.tools.register` exige `output: { schema, render }`** : sans lui, `tool "X" must declare output
  { schema, render, presentationMeta? }` — la ligne reste `active` et l'outil est absent de **toutes**
  les surfaces. `execute` renvoie **la valeur** décrite par le schéma, `render` la projette, et un échec
  se **lève** (le pipeline fabrique `{content, isError:true}` lui-même, `dsh-tools/lib/index.js:3616`).
- **Un patch de profil ne crée rien sans `insert:`** : entrée nue = remplacement de champs d'une ligne
  existante ; id inconnu = un avertissement dans le terminal, aucune ligne.
- **`pwsh` n'existe pas sur cette machine** (PowerShell 7 absent) : `spawn('pwsh', …)` donne
  `spawn pwsh ENOENT`. Le harnais **résout** l'exécutable
  (`dsh-pwsh-local/lib/types/resolve.js:23-65` : Program Files → PATH → Windows PowerShell 5.1) et
  passe par `ctx.shell` ; un plugin qui doit lancer son propre process doit reprendre cette résolution.
  Windows PowerShell 5.1 écrit la page de code console : sans le préambule UTF-8 du harnais
  (`dsh-pwsh-local/lib/index.js:100`), les accents sortent garbled.
- **Le code d'un module ne se recharge qu'avec un process neuf** (cache ESM) : après toute édition de
  `lib/index.js`, un redémarrage de `dsh web` est nécessaire — et c'est la seule façon de vérifier.
- **Les réglages d'un plugin sont le `Config` de SA ligne, pas un registre.** Il n'existe aucun
  `ctx.settings.register(namespace, schema)` dans ce build : la surface de réglages projette en
  formulaire le `Config` de chaque ligne **montée**, et persiste les valeurs sous l'id de cette ligne —
  `ns: entry.options.id` (`dsh-settings/lib/index.js:413-436`). Les champs à recharger à chaud portent
  `.volatile()` et se lisent `config.<champ>.get()`. `cordis` traite un `Config` absent **ou
  `undefined`** comme « pas de schéma » (`cordis/lib/index.js:956-958`), ce qui permet d'exporter le
  schéma conditionnellement — sans casser le chargement d'un plugin qui doit survivre à une
  installation à moitié remplacée.
- **Le chargeur déroule `module.default || module`** (`dsh-app-boot/lib/index.js:162`) : un plugin qui
  exporte un objet par défaut doit y mettre aussi son `Config`, sinon le schéma est invisible et la
  ligne n'a pas de formulaire. `dsh --profile web --dump-config` imprime la composition réellement
  composée, ligne par ligne — le seul inventaire lisible sans passer par l'interface.
- **Deux noms d'événements de réglages, un seul émetteur** : `settings/document-updated(ns, revision)`
  est le vrai (`dsh-settings`), catalogué dans `dsh-tool-cordis/lib/types/api-catalog.js:4072`.
  `settings/updated` n'est émis par rien : un écouteur qui a l'air vivant et ne se déclenche jamais.
- **Le relais de jobs : deux mesures que son message ignorait.** Le registre dit lui-même si un
  règlement a été **attendu** — `awaited` (`dsh-jobs/lib/types/types.d.ts:192-202` : « a completion
  reporter treats an awaited settlement as already delivered and reports only the unawaited ones »,
  posé par `dsh-jobs-local/lib/index.js:753`). Un relais qui l'ignore annonce à la racine des jobs que
  le worker a déjà collectés : mesuré, 135 avis au compteur, dont sept en trois minutes pour
  `node --version`, `git status` et `Get-ChildItem`. Et une notice ne doit affirmer que ce qu'elle a
  mesuré : celle du relais affirmait « the subagent had already returned » **sans jamais lire
  `ownerState`**, alors que l'appelant le tenait — réfuté en direct, `list_agents` montrant le
  vérificateur encore en train de tourner au moment où l'avis annonçait son retour.
- **Un job détaché : le tampon retient 256 Kio et évince la TÊTE.** Un producteur qui **pousse**
  (`output: []`) ne peut donc rien annoncer : le registre ne cite un fichier de déversement que si une
  source **tirée** l'a déclaré (`dsh-jobs-local/lib/index.js:483-485`), d'où
  `[some output was dropped from memory; full output: (unavailable)]` sur 1 Mo de sortie. Le remède
  appartient au producteur : écrire la sortie complète sous `$DSH_HOME/plugin-data/<plugin>/<job id>.log`
  et ajouter le chemin au flux **avant** de résoudre `done` — le morceau le plus récent survit à
  l'éviction qui a emporté le reste.
- **Un brief qui énonce des faits devient falsifiable, et c'est là son gain — pas le nombre de
  tokens.** Mesuré le 2026-09-29, deux fils, même tâche, un seul témoin : brief chargé = 7 jobs, brief
  nu = 8 dont deux perdus dans `node --test test/` → `MODULE_NOT_FOUND`, une forme de commande que le
  brief chargé donnait juste. Surtout, le fils chargé a **corrigé une erreur du parent** — un chiffre
  que j'avais écrit de mémoire — là où un brief nu, n'affirmant rien, ne peut jamais être démenti.
- **Rechargement à chaud** : la *configuration* d'une ligne est relue à chaud ; le *code* d'un module
  ne l'est pas (cache ESM) — seuls un process neuf ou une nouvelle identité de bundle le rechargent.
  Ajouter une **ligne** à un patch n'est pas relu à chaud.
- **`agent/created`** reçoit `payload = { agent, source, signal }` — **pas** l'agent.
  `agent.session.header` porte l'identité ; `agent.ctx` est la portée de l'agent.
- **`ctx.agents.list()` est intermittent** (vide dans un process, trois agents dans un autre) et
  **`subagents.listDescendants()` ne voit pas les forks** (`origin` absent, `depth` 0, mais un
  `parentSession`). La source fiable est **l'en-tête durable** de session
  (`$DSH_HOME/sessions/<slug>/<id>/session.v4.jsonl.zstd`, premier frame zstd).
- **Un échec en PTC a trois formes** : `tool/result` marqué, `tool/ptc-dispatch` marqué, et échec
  **enterré** dans un `run_code` réussi. Un collecteur qui n'en lit qu'une sous-compte (mesuré :
  30 annoncées, 44 réelles).
- **`integrity.mjs` avant de croire une campagne** : les deux campagnes de torture ont lu
  l'outillage de notation (16 et 70 appels interdits). Un agent qui connaît les motifs attendus peut
  les imprimer sans que le mode ait échoué.

## 9. Ce qui reste ouvert, sans enjolivement

0. **Les correctifs du 2026-09-29 au soir sont chargés et mesurés en conditions réelles** (redémarrage
   du 30/09 à 00:00). Job de 3000 lignes : `job_output` rend **217 974 caractères** pour un fichier de
   récupération de **217 893 octets** — une copie, plus les 81 caractères du pointeur ; la double
   livraison a disparu. Le relais écrit lui-même le saut : `{"step":"skip","why":"awaited-by-owner",
   "job":"pwsh-11"}` (×4). Vérifié indépendamment : suite **36/36**, et sur une copie hors dépôt où
   l'ancien texte est remis, le cas neuf **échoue seul** (35 pass / 1 fail) — le test est donc
   discriminant.

   **Deuxième passe du 30/09, écrite et vérifiée mais pas dans ce process vivant** — elle attend le
   prochain démarrage, comme tout code de module. Cinq changements : le store est **purgé** au
   démarrage de chaque job (TTL 7 j, plafond 20 fichiers, plancher d'âge 1 h, le fichier du job courant
   épargné) ; le nom du fichier porte un **jeton aléatoire** (`pwsh-1-a8f2e0.log`), parce que les ids
   sont un compteur de process et qu'un nouveau `pwsh-1` tronquait le fichier qu'un ancien journal
   citait encore ; la sortie passe `output: [source]` au lieu de `output: []`, ce qui fait **annoncer
   le chemin par le registre** — `full output: (unavailable)` devient le chemin, prouvé sur le **vrai**
   `LocalJobRegistry` monté dans un process neuf, avec un contrôle négatif qui rend `spillPaths: []` et
   sort en 1 ; un `pwshPath` **configuré** est désormais suivi (inject différé, repli explicite et
   tracé) ; le texte rendu distingue la racine du worker. Suite : **52/52**. Limites restantes, écrites
   dans le module : la purge ne tourne qu'au démarrage d'un job, et un fichier **plafonné** n'est jamais
   annoncé — il garde la tête, pas le flux.

   **Historique.** Ces quatre dossiers n'avaient **aucun dépôt git** jusqu'au 30/09/2026, alors que git
   2.47.1 est installé et que neuf autres projets de `C:\CodeSource` en ont un — c'est ce qui a obligé les
   tests de mutation à reconstruire les états « d'avant » depuis les journaux de session au lieu de les
   lire dans des révisions. Ils sont désormais des dépôts (branche `main`), révision initiale :
   `dsh-detached-jobs` `f8e1a166`, `dsh-boost-mode` `4ed0f549` (avant cette ligne), `dsh-boost-relay`
   `4abd4dec`, `dsh-boost-status` `1b346a24`. Aucun dépôt distant : l'historique protège des mauvaises
   éditions, pas de la perte du disque.

1. **`run_detached` est monté et vérifié** (2026-09-29, §5). La limite écrite ici — « un déploiement qui
   configure `pwshPath` sur `pwsh-local` ne serait pas suivi » — est **levée** : `pwshPath` est lu sur le
   service `shell` en inject différé, avec repli explicite et tracé sur `resolveShell()` quand la ligne
   shell est absente. Ce qui reste vrai, et qui est la raison d'être de l'outil : un job détaché ne peut
   pas emprunter `ctx.shell`, il spawn son propre process — sinon il mourrait avec la portée appelante.
2. **Le taux d'erreur réel du mode** n'a jamais été mesuré sur deux runs comparables — la mesure
   « avant/après Field notes » (21 % → 34 %) est **confondue** par le changement de nature des tâches.
3. **43 % des erreurs tombent dans un bac « autre »** non classé par l'outillage.
4. **La règle de persona** est désormais écrite avec sa justification mécanique — un job appartient à la
   session qui le lance, celui d'un worker meurt avec lui, et `run_detached` est la seule forme qui y
   survit — et non comme une préférence de style. Vérifié dans le prompt composé de l'orchestrateur.

## 10. Le plantage du 30/09 : un demi-caractère UTF-16 tue la session — et ce qui n'est pas corrigé

**Une session est morte sur sept `HTTP 400 INVALID_REQUEST` consécutifs, et la cause est un surrogate
isolé (`U+D83D`) écrit 1,7 s plus tôt par le programme `run_code` de l'agent lui-même.** Mesure sur
**182 journaux de session** (n = 182).

| Fait mesuré | Valeur |
|---|---|
| Session morte | `session-716c3109` — « Point d'entrée et étiquettes de preuve » |
| Forme de la mort | **7** échecs consécutifs `HTTP 400 INVALID_REQUEST` |
| Premier enregistrement refusé | le premier `tool/result` contenant **`U+D83D`**, un demi-caractère UTF-16 (surrogate isolé), écrit **1,7 s** plus tôt |
| D'où venait ce demi-caractère | du programme de l'**agent lui-même** : `x.text.slice(0, 400)` a coupé en deux la paire de substitution d'un emoji |
| Journaux contenant un tel enregistrement | **3 / 182** — et **les 3 sont morts du même 400** |
| Journaux sans un tel enregistrement | **179 / 179** n'ont produit aucun 400 **de cette forme** |

Les **deux mesures décisives** : 3 journaux sur 182 contiennent un surrogate isolé, et les 3 meurent sur
`HTTP 400 INVALID_REQUEST` à la requête suivante ; aucun des 179 autres n'en produit **de cette forme**.
Le qualificatif n'est pas rhétorique : **trois autres sessions ont bien produit un `HTTP 400`**, mais avec le
code `CONTEXT_WINDOW_EXCEEDED`, et le corpus compte 14 sessions à objet d'erreur (`TOOL_TIMEOUT`,
`TRANSPORT`, `AUTH 401`). Sans `INVALID_REQUEST`, l'affirmation est fausse.

Le corpus est **vivant** : `n = 182` était un instantané ; il en comptait 186 au début de la vérification et
**188** à la fin. Les 3 sessions en cause sont toutes antérieures, donc le fond ne change pas — mais un `n`
écrit sans sa date ne veut rien dire ici.

**Éliminé par mesure, pas par raisonnement** : le retour de l'agent fils (il s'est terminé proprement et
son rapport est arrivé **verbatim** — les 4 premiers pas du tour suivant passent), le relais de jobs, la
taille du contexte, et la duplication de session (elle est **postérieure** au plantage).

**Garde absente côté `dsh-llm-deepseek`, mesurée.** Le corps part par `JSON.stringify` + `fetch`
(`dsh-llm-deepseek/lib/index.js:1360`, `:2188`) et ce module ne contient **aucune** occurrence de
`sanitize|surrogate|WellFormed`, alors que la bibliothèque du même harnais sanitise les surrogates
isolés pour anthropic/bedrock/google/mistral (`pi-ai/dist/utils/sanitize-unicode.js`). Le fournisseur
répond 400, et le message enregistré est la formule de repli du module
(`dsh-llm-deepseek/lib/index.js:1746`). **Mesuré sur 0.2.0-rc.2** — le build **installé après** le
plantage ; le plantage, lui, a eu lieu sur **0.1.7-rc.2**, et **c'est encore lui qui tourne** : le process
`dsh web` (pid 4296) a démarré le 30/09 à 00:36, dix-sept heures avant l'installation, et le cache ESM ne
recharge rien — sur disque 0.2.0-rc.2, en mémoire 0.1.7-rc.2. Rien dans ces dépôts ne peut fournir cette
garde : elle appartient au chemin du fournisseur.

**La règle ajoutée** — dans `cordis.patch.yml`, à la persona de l'orchestrateur **et** à celle des trois
rôles (`subagent_investigate`, `subagent_implement`, `subagent_verify`), parce que tous les quatre
écrivent des programmes PTC — texte exact, identique dans les quatre :

```
Never truncate text by a UTF-16 index. `text.slice(0, 400)` cuts a surrogate pair in half when an emoji or any astral character falls on the boundary, and one lone surrogate inside a tool result kills the session: measured, 3 of 182 session logs contain one, all 3 died on `HTTP 400 INVALID_REQUEST` at the next request, and the DeepSeek provider path does not sanitize. Use `Array.from(s).slice(0, n).join('')` — never a raw index.
```

**La duplication est aussi l'expérience qui prouve le diagnostic.** L'utilisateur a dupliqué la session
« à partir d'un point non failed » : la graine du fork s'arrête à `seq=486` (fin du tour 9), donc **avant**
le poison (`seq=583`). Comparaison à process, build, compte, modèle et clé identiques :

| | enregistrements | tours | échecs `INVALID_REQUEST` |
|---|---|---|---|
| mère (avec le poison) | 641 | 17 | **7** |
| fork (sans le poison) | 524 | 10 | **0**, y compris ses 36 enregistrements propres |

**La clé API n'est pas la cause.** L'utilisateur a créé une clé neuve pendant la panne : `.credentials.yaml`
est daté du **30/09 15:31:54Z**, et **deux 400 ont suivi** (15:32:02 et 15:32:19). Le fork, créé à
**15:33:32Z**, tourne avec la même clé et n'échoue pas. L'hypothèse était raisonnable ; l'horodatage la
réfute.

**Correction d'une première lecture : le préfixe du fork n'est pas « périmé » par un défaut de DSH.** Le
sous-enquêteur avait mesuré que la copie s'arrête 11,4 min avant **la dernière écriture de la mère**
(15:32:19Z) et l'avait porté au dossier comme un défaut de `session.fork`. Mais 11,4 min n'est pas l'âge de
la copie : la mère avait terminé son tour 10 à 15:21:57Z, soit **1,1 min** après la fin du préfixe, et
l'écart entre la **création du fork** et cette fin est de **12,66 min**. Trois définitions, trois nombres —
le seul qui reproduise les trois valeurs du corpus (11,4 / 175,6 / 280,0) est « dernière écriture de la mère
moins fin du préfixe ». Le compte rendu de l'utilisateur l'explique :
la duplication a été faite **volontairement « à partir d'un point non failed »** — la borne est son choix,
pas une règle fautive. La seule conséquence réelle, et elle est utile à connaître : la copie ne contient
donc **pas** le rapport de l'agent fils, ce qui a obligé à le redemander. Les deux autres forks du corpus
montrent le même écart (175,6 et 280,0 min) sans que leur raison soit mesurée.

**Deux accroches existent pour empêcher la mort d'une session, et la meilleure n'est pas celle qu'on croyait.**
Mesuré, preuve d'ordonnancement à l'appui :

| | Aval — `llm/stream` | **Amont — `tools/post-execute`** |
|---|---|---|
| Remplacer ce qui part | non : `next()` n'accepte aucun argument et `options` est gelé en profondeur, donc il faut court-circuiter et redispatchser par `ctx.llm.stream(clean)` | **oui** : `next()` par défaut rend `{kind:'accept'}` et un listener peut rendre `{kind:'accept', content}` sans redispatch (`dsh-tools/lib/index.js:3504`, `:3527-3531`) |
| Invariant `request === deriveMessages()` (`dsh-agent-loop/lib/invariant.js:26-27`) | **cassé** : la requête nettoyée diverge du journal | **satisfait** : `await finalize(...)` précède `appendToolResult` (`dsh-agent-loop/lib/index.js:570-571`), donc le journal porte déjà le texte nettoyé |
| Rejeu, latence | `registration` + `prepareCall` rejoués à chaque requête | aucun |
| Précédent in-tree | aucun | `dsh-spill-policy/lib/index.js:237-255` fait exactement ce geste |
| Si la forme change | inerte si forme inconnue | un listener fautif fait lever `postExecute`, attrapé (`dsh-tools/lib/index.js:3370-3372`) : le résultat devient une erreur et **la session survit** |

Le seul avantage de l'aval est la couverture : il voit tout ce qui part. L'amont ne voit que ce qui traverse
`finalize` — **six chemins `final-result` le contournent** (`dsh-tools/lib/index.js:3178`, `:3183`, `:3199`,
`:3219`, `:3269`, `:3346` ; la boucle appelle alors `finish(...)` et non `finalize(...)`). Trois sont
inoffensifs (annulation, `UNKNOWN_TOOL`, abandon). La troisième piste — un outil qui lève avec un texte
empoisonné — a été **mesurée puis écartée** : `dispatchToolBody` contient le `throw` du corps
(`dsh-tools/lib/index.js:3313-3314`), il en sort un `post-result` (l. 3341) et **le waterfall tourne** ; un
outil qui lève a été monté et rend `content0="Error: kaboom \ufffd end"`, `hasLone=false`. Le résidu réel est
plus étroit : les échecs **hors corps d'outil** (matérialisation, refus d'approbation, annulation avant
dispatch, exception d'un listener `pre-execute` ou d'un wrapper `execute`). La borne PTC, elle, est saine — `truncateJsonStringBytes` avance par `character.length` et ne
coupe jamais une paire (`dsh-ptc-runtime-node/lib/process.js:187`) ; le harnais ne fabrique pas le
demi-caractère, il en recopie un qui existait déjà.

**Ce que ces mesures ne peuvent pas prouver, et c'est structurel.** La charge utile réellement envoyée
n'est journalisée **nulle part** : `request/header` n'apparaît qu'une fois par session et ne porte que
`config` / `adapterDefaults` / `tools`, aucun enregistrement ne capture le tableau de messages. Le lien causal
repose donc sur la sémantique d'ajout (`surfaceOp:'append'`, `sourceEventSeqs:[576]`) et sur la chronologie —
**1,715 s** — pas sur une capture de requête, et le fournisseur ne renvoie pas l'offset fautif. Un journal de
session est une concaténation de frames zstd sans somme de contrôle embarquée : une frame tronquée ne lève pas
(vérifié : coupes de 1 % à 90 % rendent 0 octet, coupes de 1 à 4 octets rendent le contenu complet), donc
seuls `skipped = 0` et `emptyTail = 0` sur 188 journaux soutiennent la moitié négative. C'est la limite du
dossier, et elle se dit.

## 11. Procédure de coupure — tout en UNE passe sur le profil, puis un redémarrage

**Ce n'est plus « ce qui se fera au redémarrage » : c'est la procédure de bascule du profil vivant sur
le dépôt consolidé.** État mesuré le 2026-09-30 : le disque porte **0.2.0-rc.2** (`dsh --version` ;
`package.json` du harnais écrit le 30/09 à 17:29:06) et le process vivant **aussi** — `dsh web` est le pid
**4248**, démarré à **20:17:31**, donc **après** l'installation ; le relais en a laissé la trace
(`decisions.jsonl.1:677744`, `{"step":"mount","first":true,"pid":4248}`). Ce qui reste n'est donc **pas**
une montée de version, mais quatre gestes : **repointer les liens**, **purger les trois entrées mortes**,
**faire revenir `/schedule`**, **monter la garde**.

**Pourquoi tout en UNE passe.** `dsh-hmr` ne surveille que **trois** chemins — `<profil>/package.json`,
`<profil>/cordis.patch.yml` et `$DSH_HOME/cordis.patch.yml` (`dsh-hmr/lib/index.js:353-376`) — et compare
leur **contenu** (`:360-368`) : dès que le texte change, il relit **toutes** les couches depuis le disque
(`readProfilePatches` puis `reconcileProfilePatches`, `:369-370`). Éditer le profil en deux fois, c'est
faire vivre au process un état intermédiaire : liens à moitié repointés, bundle déclaré mais jonction
absente. **Écrire tout, puis redémarrer une fois.**

### Étape 0 — le `pnpm` du PATH, avant toute commande

Sur cette machine, le `pnpm` du PATH est le shim nvm et échoue (`No active Node.js version is
configured`). Le `pnpmCommand` du patch de profil (`profiles\web\cordis.patch.yml:23-32`) n'est lu que
par le gestionnaire **composé** : mesuré, `dsh plugin --profile web list` échoue avec le même message.
Pour toute commande `dsh plugin` ou `pnpm` de cette procédure :

```powershell
$env:PATH = 'C:\Program Files\nodejs\node_modules\corepack\shims;' + $env:PATH
```

### Étape 1 — repointer les cinq liens, ou passer au seul agrégateur

Deux formes, **jamais les deux** (l'exclusion mutuelle est expliquée dans le README racine) :

**A. L'agrégateur seul (recommandé).** Une commande fait tout, avec le PATH de l'étape 0 :

```powershell
dsh plugin --profile web add C:\CodeSource\dsh-boost
```

Elle écrit `"@local/dsh-boost": "link:C:/CodeSource/dsh-boost"` dans `dependencies`, crée la jonction
`profiles\web\node_modules\@local\dsh-boost` et ajoute le nom **en queue** de `dsh.profile.bundles`.
**Elle ne retire rien** : il faut, dans la même passe, supprimer les cinq `link:` d'origine de
`dependencies` **et** les noms correspondants de `dsh.profile.bundles` (`@local/dsh-boost-mode`,
`@local/dsh-boost-status`, `@local/dsh-boost-relay`, `@local/dsh-detached-jobs`, et
`@local/dsh-guard-surrogate` s'il y a été ajouté). Les garder *avec* l'agrégateur monterait chaque ligne
**deux fois** (`dsh-app-boot/lib/index.js:87`).

**B. Les cinq liens vers le dépôt consolidé.** Dans `profiles\web\package.json` :

```json
"@local/dsh-boost-mode": "link:C:/CodeSource/dsh-boost/packages/boost-mode",
"@local/dsh-boost-relay": "link:C:/CodeSource/dsh-boost/packages/boost-relay",
"@local/dsh-boost-status": "link:C:/CodeSource/dsh-boost/packages/boost-status",
"@local/dsh-detached-jobs": "link:C:/CodeSource/dsh-boost/packages/detached-jobs",
"@local/dsh-guard-surrogate": "link:C:/CodeSource/dsh-boost/packages/guard-surrogate"
```

et `dsh.profile.bundles` doit lister les cinq noms correspondants — dont
`@local/dsh-guard-surrogate`, qu'il ne porte **pas** aujourd'hui. `@local/dsh-auto-update` reste tel quel
(il vit hors du dépôt, dans `profiles\local-plugins\`). Éditer `dependencies` ne crée **aucune**
jonction : dans cette forme, `pnpm install` (étape 0 pour le PATH) passe **avant** le redémarrage, sinon
les bundles ne se résolvent pas.

### Étape 2 — purger les trois entrées mortes du patch de profil

Elles sont aux **lignes 61-66** de `profiles\web\cordis.patch.yml`, ne visent aucune ligne, et ne
produisent que trois avertissements au démarrage, où personne ne les lit. Mesuré, `dsh --profile web
--dump-config` les imprime **en tête de sa sortie** :

```
dsh: [C:\Users\bilel\.dsh\profiles\web\cordis.patch.yml] patch: entry "time-context" not found
dsh: [C:\Users\bilel\.dsh\profiles\web\cordis.patch.yml] patch: entry "schedule" not found
dsh: [C:\Users\bilel\.dsh\profiles\web\cordis.patch.yml] patch: entry "ui-schedule" not found
```

À supprimer :

```yaml
- id: time-context
  disabled: false
- id: schedule
  disabled: false
- id: ui-schedule
  disabled: false
```

Ces ids existent **0 fois** dans la composition 0.2.0 : leurs seules occurrences dans le `--dump-config`
sont les trois avertissements ci-dessus (les deux autres occurrences de « schedule » sont
`scheduledDelayMillis`, un champ de configuration sans rapport). Même famille que la ligne
`run-detached-jobs` retirée le 29/09 (§6).

### Étape 3 — faire revenir `/schedule` (déjà perdu)

Sous 0.1.7 ces lignes étaient portées par le cœur ; sous 0.2.0, la composition web « n'en porte aucune » —
mot pour mot du patch de `dsh-experimental-schedule-bundle` : « Experimental Schedule over the shipped Web
composition, **which carries none of these rows** ». Il faut donc déclarer ce bundle dans
`dsh.profile.bundles` :

```json
"@deepseek-ai/dsh-experimental-schedule-bundle"
```

**Ce n'est pas une hypothèse, c'est déjà arrivé** : mesuré, le process vit maintenant en 0.2.0-rc.2
(pid 4248, démarré le 30/09 à 20:17:31, **après** l'installation du build) **sans** ces outils — la
composition web ne porte aucune ligne `schedule`/`ui-schedule` et les outils `schedule_*` ont disparu.
Sans cette déclaration, la fonction ne revient pas au redémarrage.

### Étape 4 — monter la garde anti-surrogate (§10)

**L'agrégateur la porte déjà** : sa cinquième ligne est `dsh-guard-surrogate`
(`packages/guard-surrogate/cordis.patch.yml`, `config: { enabled: true }`). Avec la forme **A** de
l'étape 1, il n'y a donc **rien** à ajouter au patch du profil — c'est précisément ce que l'agrégateur
apporte en plus des quatre autres lignes. Avec la forme **B**, reprendre les quatre gestes du README de
`C:\CodeSource\dsh-boost\packages\guard-surrogate` : déclarer
`"@local/dsh-guard-surrogate": "link:C:/CodeSource/dsh-boost/packages/guard-surrogate"` dans
`dependencies` **et** dans `dsh.profile.bundles`, `pnpm install`, puis redémarrer (l'entrée
`- id: dsh-guard-surrogate` / `config: { enabled: true }` au patch du profil est facultative : la ligne
est créée par le patch du bundle). Elle est
**neutre par construction** : `await next()` toujours en premier, décision rendue par identité quand rien ne
change, seuls les blocs de texte touchés — **y compris `kind: 'block'`**, dont le `feedback` traverse le même
marcheur depuis la passe de correction. État mesuré par l'orchestrateur sur la révision `16d88f5` :
`node --test` rend **26/26, 0 échec, 0 sauté, exit 0**, **avec ET sans** `DSH_PROFILE_DIR` — la première
passe laissait `k` *sauter en silence* sans cette variable, ce qui est un échec déguisé et a été corrigé.
Résidus assumés, écrits dans son README : un listener plus externe qui court-circuite sans appeler `next()`
empêche la garde de tourner, et les chemins `final-result` ne couvrent que les échecs hors corps d'outil.

### Étape 5 — matérialiser les jonctions

Forme A : `dsh plugin add` l'a déjà fait. Forme B : `pnpm install` dans `profiles\web` (PATH de l'étape 0).
Rien d'autre à vérifier ici : une jonction absente se voit au démarrage suivant, sous forme de bundle
introuvable.

### Étape 6 — redémarrer une fois, puis vérifier

```powershell
dsh --profile web --dump-config      # AUCUN "patch: entry … not found"
node --test                          # racine du dépôt consolidé : 128/128
cd packages\detached-jobs; node --test             # 52/52
cd ..\guard-surrogate;    node --test             # 26/26
```

Puis les contrôles du §5 (test 4) : `node tools\probe-spill-announce.mjs` doit rendre `PROBE-PASS`, un job
lancé par la racine doit rendre le texte de la racine, et un chemin annoncé doit finir par `-<6 hexa>.log`.
Côté garde, `$DSH_HOME/plugin-data/dsh-guard-surrogate/repairs.jsonl` n'existe **que** si elle a réparé
quelque chose : son absence veut dire « rien à réparer », pas « inerte » — d'où le test `k` de son dépôt,
qui est le seul à pouvoir distinguer les deux. Enfin, `dsh --profile web --dump-config` doit porter les
cinq ids du mode **une fois chacun** : c'est le contrôle qui dit que la bascule est complète.

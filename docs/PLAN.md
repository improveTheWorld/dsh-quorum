# Plan — Mode `quorum` pour DeepSeek Harness

> **Document historique — l'état fait foi dans `docs/HANDOVER.md`.** Ce plan décrit la conception
> d'origine du mode Quorum et ses jalons M0–M5. Il contient une copie du `cordis.patch.yml` (§7) qui a
> **divergé** des patches réellement montés, et des affirmations que les mesures suivantes ont périmées :
> elles sont marquées **périmé** sur place, avec la valeur actuelle. Ne rien en déduire sur l'état courant —
> installer, composer et tester se lisent dans `README.md` (racine) et `docs/HANDOVER.md`.

Équivalent DSH du `/boost` de Google Antigravity : un **mode de raisonnement profond multi-agents**
sélectionnable à côté de `standard`, `ptc`, `minimal` et `cordis` (creator), avec des sous-agents
qui héritent eux aussi de **PTC**.

- Statut : **M0 et M1 réalisés** (voir §0) ; M2–M5 à faire
- Version DSH cible : `0.1.7-rc.2` — **périmé** : le disque et le process vivant portent **`0.2.0-rc.2`** (`dsh --version`, mesuré le 2026-09-30 ; process `dsh web` pid 4248, démarré le 30/09 à 20:17:31). Profil `web`
- Livrable attendu : bundle installable `C:\CodeSource\dsh-boost-mode\` déclarant le preset `quorum`

---

## 0. État d'implémentation

### Fait

| Étape | Résultat |
|---|---|
| M0 — noms d'outils figés | `Tool.listTools` relevé ; `dsh-tool-fs` enregistre `read`, `read_image`, `write`, `edit` (vérifié dans `dsh-tool-fs/lib/index.js:262,975,1168`). Toutes les listes `toolFilter` du preset n'utilisent que des noms constatés présents sur cette plateforme. |
| M0 — runtime PTC | `include:ptc-runtime` (`@deepseek-ai/dsh-ptc-runtime-node`) `active`. |
| M1 — bundle écrit | `package.json`, `cordis.patch.yml`, `lib/index.js`, `README.md`. |
| M1 — installation | `install_bundle` → `application: applied`, `warnings: []`. Le bundle `@local/dsh-boost-mode` est `enabled: true, installed: true`. |
| M1 — déclaration | `Config.listConfigs { name: '@deepseek-ai/dsh-agent-preset' }` → **5 entrées**, dont `include:preset-boost` en `status: schema`. |
| M1 — activation | `list_plugins` → `include:preset-boost` `enabled: true`, `fiberPhase: active`. Un échec de montage serait resté sur le roster avec son diagnostic. |
| M1 — composition | `dsh --profile web --dump-config` : les 34 lignes du preset sont composées, `tool-presentation` → `mode: ptc`, les 3 rôles présents avec leurs `deny`, `workflow-ptc` / `tool-workflow` / `tool-ralph` / `tool-plugin-manager` désactivés. |

### Blocage rencontré et corrigé (hors périmètre quorum)

La première installation a échoué : `No active Node.js version is configured.
Run 'nvm install <version>' then 'nvm use <version>'.`

Cause : nvm-windows est installé **sans aucune version de Node**, mais son dossier de shims
(`%LOCALAPPDATA%\Author Software\nvm\.nodejs` → jonction vers `.shim`) est en **index 14 du PATH** et
contient un `pnpm.exe` (hardlink de `proxy.exe`) qui échoue systématiquement. Le Node réellement
utilisé est une installation autonome en index 12 (`C:\Program Files\nodejs`, v22.23.2), qui embarque
un pnpm fonctionnel via corepack (`node_modules\corepack\shims\pnpm.cmd`, pnpm 12.6.0).

Conséquence : **toute** installation de bundle échouait dans ce profil, pas seulement celle-ci.

Deux correctifs, indépendants :

1. **Durable** — `plugin-manager` accepte un champ `pnpmCommand`. Ajout d'une surcharge id-ciblée
   dans `C:\Users\bilel\.dsh\profiles\web\cordis.patch.yml` pointant sur le pnpm de corepack.
   Confirmé composé par `--dump-config`. **Prend effet au prochain démarrage de DSH** (le host en
   cours n'a pas rechargé la ligne). Réversible en supprimant ce bloc.
2. **Immédiat** — le host en cours résout `pnpm` par le PATH à chaque lancement et ne relit pas la
   config : ajout de `C:\Users\bilel\AppData\Local\Author Software\nvm\pnpm.cmd`, un shim de 8 lignes
   en index 13, donc avant le shim cassé. C'est ce qui a permis l'installation dans cette session.
   **À supprimer après le prochain redémarrage de DSH** (le correctif 1 suffit alors) :
   `Remove-Item "C:\Users\bilel\AppData\Local\Author Software\nvm\pnpm.cmd"`.

### M1-bis — Outillage de diagnostic (ajouté à la demande)

Décision : **ne pas instrumenter le preset**. DSH journalise déjà les `tool/call` avec arguments
complets (brief de délégation, `run_in_background`), les `tool/result` avec le marqueur d'erreur du
runtime, l'`usage` par étape, le catalogue d'outils de chaque requête et l'arbre de délégation
(`parentSession` + `subagent/descriptor`). Un second chemin de logs aurait dupliqué cette source.

Livré à la place, dans `tools/` :

| Fichier | Rôle |
|---|---|
| `session-log.mjs` | lecteur des logs de session, arbre de délégation, `hasTurn` |
| `boost-report.mjs` | rapport de run complet + `--json` / `--out` / `--json-out` |
| `dump-records.mjs` | schéma : types d'enregistrements et échantillons |
| `diagnose-frames.mjs` | framing zstd : nombre de frames, décodage |

Trois pièges découverts et traités :

1. **Le log est une concaténation de frames zstd** (148 frames pour 317 Ko). `zstdDecompressSync` et
   `createZstdDecompress` s'arrêtent tous deux à la première frame (267 octets lus sur 1,3 Mo) : une
   lecture naïve ne voit que l'en-tête et produit un rapport vide sans erreur. Découpage sur le magic
   `28 B5 2F FD`, avec fusion en cas de faux positif.
2. **`header.agentPreset` peut être périmé** — il nomme le preset de création, qu'un changement de
   preset sur session vierge ne réécrit pas. Constaté : en-tête `standard`, composition `cordis`. Le
   rapport déduit le preset vivant des en-têtes enfants (écrits depuis la portée vivante du parent).
3. **En PTC, les appels de rôle peuvent n'exister que dans le code** `run_code`. Le rapport analyse
   donc aussi le programme (rôles cités, `await` sur le vérificateur, `run_in_background: false`).

Correction notable côté analyse : les heuristiques de texte produisaient ~40 faux positifs sur un run
réel (tout résultat contenant « timeout » ou « rejected », y compris un simple `grep`). Les erreurs ne
sont plus rapportées que sur le **signal explicite** du runtime (`data.error`, `message.isError`) ; les
codes de sortie et les échecs PTC sont isolés dans une section « anomalies » étiquetée heuristique.

Vérifié sur données réelles : le run de recherche de cette session (3 sessions, profondeur 1) donne
2 délégations détectées dans le **même step** (fan-out parallèle), 2 erreurs d'outil réelles
(`WebError/WEB_REDIRECT_BLOCKED`, 2 × `FsError/FS_EDIT_NOT_FOUND`), 7 anomalies de code de sortie, et
l'arbre complet avec durées et tokens.

### M1-ter — Premier run réel : un bug du preset, trouvé par l'outillage

Run utilisateur en mode Quorum (workspace `Scalpel-mcp`), session arrêtée après ~2 min 30, 13 programmes
`run_code`, 0 sous-agent.

**Ce qui marchait** : marqueurs `boost orchestrator` + `Programmatic Tool Calling` dans le prompt
système, surface d'outils = `run_code` seul ⇒ le mode et PTC sont bien actifs.

**Ce qui échouait** : l'orchestrateur a bien tenté le fan-out (programme `run_code` #12 « Launch two
evidence audits… » citant `subagent_investigate` ×2, `subagent_verify` ×1, `subagent` ×3, puis un
programme #13 de sondage), mais **chaque création d'enfant mourait** :

```
CodeRunFailedError / CODE_RUN_FAILED
  ToolCallError: tools.restrict() names unknown global tool "subagent";
  known global tools: ask_user_question, create_goal, edit, exit_plan_mode, get_goal,
  glob, grep, harness_update, interrupt_agent, job_kill, job_list, job_output,
  list_agents, present, pwsh, read, …
```

Cause : `dsh-tool-subagent` installé avec `modelSelectionSettings: true` est enregistré **par Agent**
(sur `agent/created`), donc dans la **propre couche** de l'agent. `tools.restrict()` exclut par
construction la couche propre du scope (`dsh-tools/lib/index.js` : « A restriction filters what a scope
inherits … and never what its OWN layer registers »), donc un filtre enfant qui nomme `subagent` lève.
Le nom était de surcroît **inutile** : `subagent` n'est pas hérité par un enfant.

Correctifs appliqués :

1. `subagent` retiré des trois `toolFilter` de rôle, avec le commentaire expliquant la règle ;
2. `maxDepth: 1` explicite sur les cinq lignes de délégation — `spawn` **et** `fork` déclarent la
   capacité `depthLimit` (vérifié), donc plus aucune dépendance au réglage host `subagent.maxDepth`.

**Second problème, indépendant du preset** : 3 des 6 échecs sont
`worker-exit: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace>) File sandbox: workspace-write`
— le worker PTC ne peut pas poser son ACL d'écriture Windows. La session est passée de
`workspace-write` à `danger-full-access` en cours de run et cette classe d'échec a disparu
(bilan : 9 `run_code` réussis, 6 échoués). Cela affecte le preset `ptc` livré à l'identique.
Contournement : garder les sessions Quorum en `danger-full-access` jusqu'à correction amont.

**Fait établi au passage : un host en cours ne relit pas un patch de bundle SEUL.** Test par ligne sonde
(`preset-boost-probe` ajouté puis retiré) : la déclaration n'est jamais apparue dans l'arbre vivant
(`Config.listConfigs` → toujours 5 entrées).

**Périmé.** La conclusion qui suivait — « toute modification d'un `cordis.patch.yml` de bundle exige un
redémarrage de DSH » — est **fausse pour un patch de profil**, et la mesure est dans le harnais :
`dsh-hmr/lib/index.js:353-376` ne surveille que **trois** chemins — `<profil>/package.json`,
`<profil>/cordis.patch.yml` et `$DSH_HOME/cordis.patch.yml` — et compare leur **contenu** (`:360-368`).
Dès que l'un des trois change, il relit **toutes** les couches depuis le disque
(`readProfilePatches` puis `reconcileProfilePatches`, `:369-370`), **patchs de bundle compris, sans
redémarrage**. C'est ainsi que le seuil de compaction du preset `quorum` a été appliqué à chaud le
2026-09-30 (la mesure est écrite dans `profiles\web\cordis.patch.yml:85-104`), et c'est aussi ce qui
impose de faire une bascule de profil en **une seule passe** (`docs/HANDOVER.md` §11). Ce qui reste vrai :
un patch de bundle modifié **sans toucher** à l'un des trois chemins surveillés n'est jamais relu, et
ajouter une **ligne** à un patch de preset n'est pas relu à chaud non plus.

### M1-quater — Run de production : le mode marche, la vérification a dérivé

Run utilisateur en Quorum (session `session-d06c6d28`, workspace `Scalpel-mcp`), observé en direct.

**Validé** : le preset `quorum` actif ; surface = `run_code` seul (PTC) ; **3 workers lancés depuis un seul
programme** (`t1/s10` « Launch three parallel workers » : `subagent_investigate×2` +
`subagent_implement×1`) ; les 3 enfants héritent `preset=boost` **et tournent en PTC** (`run_code`) ;
0 erreur d'outil sur la racine ; 20 programmes PTC, ~1,2 M tokens sur la racine. Le correctif
`toolFilter` de M1-ter est donc validé en conditions réelles, et l'héritage PTC par les enfants — la
propriété centrale du design (F3 + F6) — est confirmée.

**Constat majeur : la vérification n'a jamais été déléguée.** Le contrôle `verification-foreground`
reste KO sur tout le run : `subagent_verify` n'apparaît ni comme appel d'outil, ni dans aucun des
20 programmes. L'orchestrateur a fait le calcul statistique lui-même (`t1/s12` « Independent
statistical cross-check of the claim », `t1/s13`, `t1/s14`, `t1/s16`) et l'a présenté comme un
« calcul croisé » indépendant — la session affiche : « Le calcul croisé révèle un point que la doc
ignore… ». C'est exactement le mode d'échec que quorum doit supprimer : une conclusion produite **et**
validée par le même agent.

Cause : **une faille de rédaction du preset**. La phase 3 disait à la fois « appelle toujours
`subagent_verify` » et « exécute toi-même les critères d'acceptation, mécaniquement ». L'orchestrateur
a retenu la seconde comme autorisation de faire l'analyse. Phase 3 réécrite : la vérification
analytique/statistique/interprétative est **désormais explicitement déléguée**, et l'orchestrateur ne
garde que la confirmation mécanique (code de sortie, existence de fichier, diff). Le calcul inline est
nommé comme une violation de protocole. *Prend effet au prochain redémarrage.*

**Deux échecs côté workers, causes distinctes** (aucun n'affecte la racine) :

1. `'import', and 'export' cannot be used outside of module code` — un worker a écrit un programme
   comme un module. Ajout d'une phrase au persona : un programme est le **corps d'une fonction async**,
   pas un module. C'est une ergonomie du runtime PTC, qui touche aussi le preset `ptc` livré.
2. `ToolCallError: tool call timed out after 30000ms` — un appel d'outil *interne* au worker est
   plafonné à 30 s, indépendamment du budget de l'outil lui-même. Mention ajoutée : passer un
   `timeoutMs` plus grand pour les programmes longs.

**Deux bugs de l'outillage trouvés en analysant ce run**, tous deux corrigés :

- le compteur de rôles du code PTC utilisait une recherche de sous-chaîne, et `subagent` est un
  préfixe de `subagent_investigate`/`_implement`/`_verify` : il fabriquait des délégations génériques
  fantômes (`subagent×3` pour 2 investigate + 1 implement). Remplacé par une regex à limite
  d'identifiant ;
- le contrôle `parallel-fanout` ne regardait que les délégations directes, inexistantes en PTC : il
  annonçait « aucun step parallèle » sur un run dont un programme lançait 3 workers. Il compte
  maintenant aussi les rôles cités par programme.

De plus, `no-unsettled-at-answer` pouvait passer au vert à tort pendant un run en cours (le dernier
message de la racine peut dater d'après la dernière écriture d'un enfant) : il renvoie désormais
`INFO — run en cours` tant que la racine n'a pas de `turn/end`.

**Attribution des enfants en PTC** : les appels d'outils internes du SDK n'étant pas journalisés comme
`tool/call`, plus rien ne reliait un enfant au programme qui l'a créé. Le rapport apparie maintenant le
label du `subagent/descriptor` aux `description` cités dans le code du programme (`run_code@1/10`).

### M1-quinquies — Analyse du run complet : 13 erreurs, 12 évitables

Run mesuré de bout en bout (session `session-d06c6d28`, **4 tours tous `completed`**, 3 h 37,
**116 programmes `run_code`**, **6 sous-agents tous terminés**).

**Validé sans réserve** : les 9 contrôles du rapport passent, y compris `verification-foreground`
(2 vérifications déléguées et attendues en premier plan — 566 s puis 300 s, toutes deux `OK`),
`parallel-fanout`, `no-unsettled-at-answer` et `children-inherit` (6/6 enfants en `preset=boost`, tous
en PTC).

**Économie mesurée** : racine 25,17 M tokens d'entrée dont **99,35 % de cache** (25,01 M lus en cache,
164 k d'entrée réelle) pour 183 k de sortie, contexte à **240 k / 1 M (24 %)** après 116 programmes —
donc **aucune compaction**. Les workers restent minuscules (17 k à 107 k d'entrée). La thèse centrale
— le contexte du principal ne gonfle pas, les enfants portent le volume — est mesurée, pas supposée.

**Les 13 erreurs, par cause** :

| Classe | Nb | Exemples observés | Traitable par |
|---|---|---|---|
| Syntaxe TypeScript | 4 | `Expected a semicolon` ; `Expected ',', got ';'` ×2 ; `'import'/'export' cannot be used outside of module code` | persona |
| Discipline `edit` | 4 | `file has not been read` ; `old_string matched 2 times` ; `old_string was not found` ; `old_string and new_string must differ` | persona |
| Délai de programme | 2 | `execution deadline reached (120000ms)` | persona (`timeoutMs`) |
| **`process.env` vide** | 1 | `ENOENT …\Scalpel-mcp\undefined\temp\_verif_a.py` | persona |
| `read` sur binaire | 1 | `cannot read …out5.txt: binary file` | persona |
| Limite de plateforme | 1 | `tool call timed out after 30000ms` (appel interne plafonné à 30 s) | amont |
| Bug de plateforme | 1 | `ReplaceFileW EIO (Win32 1175)`, écriture atomique Windows | amont |
| Environnement | 1 | `rg: …dichotomy_16k_2: IO error … introuvable` (chemin disparu) | — |

**Découverte principale** : les `executionInstructions` du runtime PTC disent textuellement
« Relative paths use the supplied working directory; **`process.env` starts empty** »
(`dsh-ptc-runtime-node/lib/index.js:785`). Le modèle a écrit `process.env.TEMP` → `undefined` →
chemin `…\undefined\temp\…` → `ENOENT`. C'est une classe entière d'échecs, silencieuse jusqu'à
l'écriture.

**Correctifs appliqués** (effet au prochain redémarrage) : un bloc **« Field notes »** dans le persona
de l'orchestrateur — `process.env` vide donc jamais de chemin construit dessus, TypeScript sans
`import`/`export` et concis, ancre d'`edit` unique et différente après lecture, `read` refuse le
binaire, `timeoutMs` explicite au-delà d'une minute — plus une phrase de rappel dans chacun des trois
rôles. **12 des 13 erreurs** tombent dans ces cinq règles ; les deux restantes sont une limite et un bug
de plateforme, hors de portée du preset.

**Confirmations de conception au passage** :

- les deux vérifications, lancées en premier plan, sont ressorties en **`mode: one-shot`** — un appel
  foreground produit un enfant jetable et non continuable, donc « re-déléguer une fois » repaie tout le
  contexte. À retenir pour la future escalade de modèle ;
- l'orchestrateur a tenu la répartition corrigée : contrôles **mécaniques** chez lui (`exit 0`,
  selftest) et vérification **analytique** déléguée ;
- il a néanmoins écrit « Check that all children are settled ✓ » **au moment où le vérificateur qu'il
  venait de lancer tournait encore**. Sans conséquence ici, puisque le programme l'attendait — mais
  c'est exactement la formulation que le ledger « enfants non réglés » (M4) devra rendre impossible ;
- **mesure à refaire** après activation des Field notes : le taux d'erreurs par run est la métrique qui
  dira si les 5 règles suffisent (13 erreurs sur 116 programmes ≈ 11 % aujourd'hui).

### M1-sexies — « Le père attend encore » : un déficit d'observabilité, pas une panne

Constat utilisateur : tous les sous-agents terminés, le père toujours en attente. **Vérifié, et l'observation
était juste** — mais la cause n'est ni un interblocage ni une dérive du modèle.

État mesuré : 13 tours `completed`, tour 14 en cours, écriture 30 s plus tôt, 12 sous-agents **tous
terminés**, 166 programmes `run_code`. Le père exécutait `t14/s2` « Bounded wait then recheck workers »,
`timeoutMs=340000`, dont le code est un `Start-Sleep -Seconds 240` suivi d'un relevé de
`benchmarks\.work\analysis\*_v2*`.

**Le sommeil était une demande de l'utilisateur**, pas une initiative du modèle : celui-ci attendait sans
trouver aucun indice de blocage, et l'utilisateur lui a demandé de *timeboxer* l'attente — d'où le timer de
4 minutes. Le modèle a donc obéi. **La leçon de méthode compte autant que le constat** : la règle
« ne jamais attendre en dormant », que j'étais sur le point d'écrire, aurait contredit une instruction
légitime. La règle retenue préserve l'intention et remplace seulement le mécanisme — *timeboxer oui, mais
avec une attente qui rend la main à la settlement*.

**Usage réel du système de jobs par le père : sain.** 19 `run_in_background: true`, 8 appels à
`job_output`, 11 avis de fin reçus. Le sommeil fixe est une exception (2 programmes sur 166), pas une
dérive.

**Le vrai déficit, et il est structurel.** Un job appartient à la session qui l'a lancé (l'abonnement aux
settlements est `{ owners: 'scope' }`), et l'avis de fin va à ce propriétaire. Or un worker invoqué en
**premier plan** est un enfant `one-shot` : dès qu'il rend son rapport, **les jobs qu'il a lancés
continuent sans que le père en soit jamais notifié**. Mesuré : le vérificateur `b9247900` a lancé
**5 jobs** (`pwsh-95/106/113/117/118`) — pour le père, ils n'existent que comme *fichiers apparaissant sur
le disque*. C'est exactement ce qui produit « il attend indéfiniment sans indice de blocage ».

**Correctifs appliqués (persona, effet au prochain redémarrage)** :

- orchestrateur — *timeboxer oui, dormir non* : une attente qui rend la main à la settlement
  (`job_output` avec `wait: true` et `timeout_ms` = la timebox, plafond 600 000 ms) plutôt qu'un
  `Start-Sleep` fixe, qui coûte toujours la totalité du délai même si le travail a fini en 5 secondes et
  laisse la session muette pendant que les avis s'empilent ;
- orchestrateur — *le travail lancé dans un worker est invisible* : si une tâche longue doit être
  observable, le père la possède lui-même, ou exige que le worker la termine avant de rendre ;
- rôles `implement` et `verify` — terminer tout travail d'arrière-plan lancé avant de rendre le rapport,
  avec la raison (le job appartient à la session qui l'a lancé).

**Le relais M4 n'est plus un candidat à instruire : il est faisable, mécanisme identifié.** La règle de
persona ne fait que contourner le déficit ; la vraie correction existe.

- **Pourquoi le père est aveugle, en une ligne de code** : `job_list` appelle
  `ctx.jobs.list(exec.agent?.id)` (`dsh-tool-jobs/lib/index.js:362`) et `JobRegistry.list(caller)` vérifie
  le lecteur **contre le propriétaire** (« Owned-job access is fenced by the owner's session id »,
  `dsh-jobs/lib/types/index.d.ts:33`). L'ensemble visible d'une session, c'est **ses propres jobs plus
  les jobs sans propriétaire** (`types.d.ts:212-213`). Les 5 jobs du vérificateur appartiennent au
  **vérificateur** : le père ne peut pas les lister, ni être notifié.
- **Pourquoi c'est réparable** : `JobRegistry.subscribe(filter, listener)` accepte
  `{ owners: 'scope' }`, qui « delivers the owners **composed under the subscribing context** »
  (`types.d.ts:214-216`). Un plugin monté dans la portée du **preset quorum** entend donc les settlements
  du père **et de tous ses enfants**. Il ne reste qu'à réinjecter l'avis dans la session racine
  (`agent.inject(...)`, le chemin qu'utilise déjà `dsh-tool-jobs` pour un propriétaire occupé,
  `dsh-tool-jobs/lib/index.js:295`).
- **Ce que cela change** : « il attend indéfiniment sans indice de blocage » devient impossible — chaque
  job d'un descendant produit un avis dans la session du père.

**Option secondaire, à ne pas confondre avec la précédente** : exposer le même contenu que
`/boost-status` sous forme de **tool** dans le preset, pour que l'orchestrateur se diagnostique lui-même.
Utile, mais **partiel** : un tel tool interrogerait `job_list`, donc resterait aveugle aux jobs des
descendants. Le relais est la correction ; le tool n'est qu'un confort — et il coûte un schéma par
requête en mode natif (négligeable en PTC, où il devient une entrée de SDK).

#### Implémenté : `@local/dsh-boost-relay` (installé et actif, sans redémarrage)

Bundle séparé `C:\CodeSource\dsh-boost-relay`, monté **au niveau host** — un nouveau bundle s'active à
chaud, et rien dans le preset ne peut rendre visible un job appartenant à un autre propriétaire.

- abonnement `ctx.jobs.events.subscribe({ owners: 'all' })` puis filtrage : ne relaye que les
  settlements dont le propriétaire est un **descendant d'une racine vivante** et dont l'agent
  propriétaire **n'est plus `running`** (sinon il reçoit l'avis nativement, le relais serait un doublon) ;
- relation propriétaire → racine par `ctx.subagents.listDescendants(rootId)` : lecture durable, donc
  valable aussi pour des enfants créés **avant** l'installation ; résultat mis en cache 5 s, parce
  qu'un `listDescendants` lit le catalogue de chaque branche (12 lectures pour un arbre de 12 enfants) ;
- avis injecté (`agent.inject`), ou **réveil** (`agent.followup`) si la racine est `idle`, plafonné à
  **3 réveils par racine** — un tour réveillé peut démarrer le travail dont la fin le réveille ;
- la source du message réutilise le discriminant `tool-jobs` : un plugin ne peut pas déclarer un nouveau
  membre de cette union à l'exécution, et la réutilisation est exacte ;
- commande `/boost-relay` : dépendance résolue, compteurs de relais, settlements ignorés, dernier relais.

**Deux obstacles rencontrés et traités**, tous deux instructifs pour tout futur bundle de ce profil :

1. **Un bundle lié hors du profil ne résout aucun spécificateur nu** — `ERR_MODULE_NOT_FOUND` vérifié.
   C'est pourquoi le bundle local déjà présent (`dsh-auto-update`) n'importe que des builtins `node:*` et
   des fichiers relatifs. `createUserMessage` est donc résolu à l'exécution via
   `createRequire(process.argv[1]).resolve('@deepseek-ai/dsh-llm')` (ancre validée).
2. **Le module lève si la résolution échoue** — un relais inerte qui ne relaie rien en silence serait
   pire qu'une ligne qui refuse de s'activer. Conséquence utile : `fiberPhase: active` **prouve** que le
   chargement, la résolution, l'export et l'application ont tous réussi. Vérifié, y compris après une
   désactivation/réactivation qui a rechargé le code sur disque.

**Ce qui reste non exercé** : aucun relais réel ne s'est encore déclenché, faute d'un run où un worker
laisse un job derrière lui. Les compteurs de `/boost-relay` le diront. C'est la seule étape non prouvée.

### Reste à vérifier (nécessite une session Quorum)

Un preset se lie à la création de la session ; ces points ne peuvent pas être observés depuis la
session courante (mode creator). À contrôler dans une nouvelle session en mode **Quorum** :

1. la surface d'outils ne montre que `run_code` (+ SDK généré) ⇒ PTC effectif ;
2. le SDK généré expose `subagent_investigate`, `subagent_implement`, `subagent_verify`,
   `send_message`, `interrupt_agent`, `list_agents` — **le point le moins certain du plan** ;
3. un sous-agent lancé en parallèle tourne lui aussi en PTC ⇒ héritage de composition confirmé ;
4. une délégation réelle réussit ⇒ les noms des listes `toolFilter` sont valides.
   (`tools.restrict()` lève sur un nom inconnu *à la création de l'enfant*, pas au montage —
   `dsh-tools/lib/index.js:2906-2908` — donc un nom fautif n'apparaîtrait qu'ici.)

Puis, pour l'analyse : `node tools/boost-report.mjs --session <id>` et me transmettre
`--out` / `--json-out` (ou simplement l'id).

---

## 1. Objectif et critères de succès

**Objectif.** Ajouter un 5ᵉ preset d'agent `quorum` qui transforme une session en pipeline de
raisonnement multi-agents : l'orchestrateur (agent principal) décompose, délègue à des rôles isolés,
puis fait vérifier le résultat par un agent indépendant avant de conclure.

**Critères de succès (vérifiables)**

1. `quorum` apparaît dans le sélecteur « Agent preset » du Web GUI sans écrire une ligne de code client.
2. Une session `quorum` ne voit que `run_code` comme outil appelable directement (présentation PTC) et
   retrouve les rôles de délégation dans le SDK généré.
3. Un sous-agent lancé depuis une session `quorum` tourne **aussi** en PTC (héritage de composition).
4. Un rôle `verify` ne peut ni écrire de fichier, ni déléguer, et doit citer la sortie brute des
   commandes qu'il exécute.
5. Sur une tâche piégée (bug seedé + suite de tests), la session `quorum` produit une réponse finale
   qui cite la sortie d'un test réellement exécuté, sans affirmation non vérifiée.
6. Aucune régression sur les 4 presets existants (leur roster reste actif).

**Hors périmètre.** Le mode « Teamwork » d'Antigravity (DAG durable, mailbox, campagne multi-jours) :
DSH le fournit déjà via `@deepseek-ai/dsh-experimental-agent-team-profile`, c'est un **autre** mode.

---

## 2. `/boost` chez Antigravity : la description technique

Source officielle : [antigravity.google/docs/boost](https://antigravity.google/docs/boost.md),
complétée par [Subagents](https://antigravity.google/docs/subagents) et
[Teamwork](https://antigravity.google/docs/teamwork).

`/boost` est une **commande slash** tapée dans n'importe quel tour de conversation
(`/boost <tâche>`). Elle active un pipeline de raisonnement multi-agents en **trois phases** :

| Phase | Nom | Contenu |
|---|---|---|
| 1 | **Goal & strategy formulation** | Le *Primary Orchestrator* inspecte le workspace, décompose le problème en sous-tâches discrètes et **vérifiables**, choisit les workstreams spécialisés nécessaires. |
| 2 | **Parallel execution & verification** | Dispatch vers des sous-agents dans des **scopes isolés et propres** : workstreams *d'implémentation* (solution candidate, refactoring, tests unitaires) et workstreams *d'investigation* (root-cause, trace de call-graph, analyse de dépendances **sans modifier de fichier**). Les sous-agents exécutent builds et suites de tests **localement** pour valider leurs hypothèses avant de rapporter. |
| 3 | **Synthesis & delivery** | Agrégation, puis **checks de régression** : l'orchestrateur valide la solution combinée contre la suite complète et les cas limites. Si une assertion échoue, **les diagnostics d'erreur sont réinjectés dans l'itération suivante**. Une fois tout vert, un résumé concis avec changements vérifiés est livré. |

Hiérarchie annoncée dans le catalogue des commandes : `Orchestrator` → `DeepCoder` /
`DeepInvestigator` → **isolated workers**.

**Positionnement (tableau officiel, résumé)**

| Dimension | Default Agent | 🚀 Boost | 👥 Teamwork |
|---|---|---|---|
| Focus | codage interactif complet | **raisonnement profond, bugs retors** | équipes autonomes multi-jours |
| Horizon | secondes → minutes | **secondes → heures** | heures → jours |
| Scoping | prompt unique | **exécution immédiate** | interview de scoping en 2 phases |
| Architecture | boucle mono-agent | **hiérarchie de raisonnement en 3 phases** | équipes multi-rôles |
| Workspace | arbre partagé | **worktrees éphémères isolés** | worktrees persistants par jalon |
| Vérification | check d'outil en un passage | **vérification indépendante multi-tours** | falsification adversariale + audit de succès |

**Sécurité** : les sous-agents héritent des règles d'accès fichiers/commandes du workspace ; une
approbation demandée par un worker remonte à l'UI ; l'isolation mémoire empêche les logs de debug et
les diffs de brouillon de polluer l'historique principal.

### Ce qui rend `/boost` efficace (avantages)

1. **Découplage stratégie / exécution.** L'orchestrateur ne fait ni le travail lourd ni la recherche
   de détail : sa chaîne de raisonnement reste stable, ce qui évite la compaction et la perte
   d'information en cours de route.
2. **Parallélisme réel.** Les investigations indépendantes avancent en même temps au lieu d'être
   séquencées dans un seul contexte.
3. **Isolation de contexte.** Chaque worker a un scope propre : les logs verbeux et les hypothèses
   mortes restent dans le transcript de l'enfant, pas dans la fenêtre de l'orchestrateur.
4. **Vérification adversariale.** Le résultat n'est pas auto-déclaré : il est re-testé (suite
   complète + cas limites) et, en cas d'échec, l'erreur revient dans la boucle.
5. **Coût d'entrée nul.** Pas d'interview de scoping, pas de setup : utilisable au milieu du flux de
   travail quotidien — c'est précisément la « zone intermédiaire » entre l'agent par défaut et les
   campagnes Teamwork.
6. **Reproductibilité.** Les worktrees éphémères gardent l'arbre principal propre.

**Limites d'Antigravity** : réservé aux offres payantes ; pas de DAG durable ni de mailbox (c'est
Teamwork) ; la vérification reste pilotée par des instructions d'agent, pas par un mécanisme.

---

## 3. Est-ce que quelqu'un l'a déjà fait pour DSH ?

**Réponse courte : beaucoup de choses très proches existent, mais aucune n'est un équivalent de
`/boost`, et la quasi-totalité est cassée sur votre version de DSH.**

### 3.1 Ce que livre DSH lui-même (upstream)

- Presets embarqués : **`standard`, `ptc`, `minimal`, `cordis`** uniquement — vérifié sur `master`
  ([API GitHub](https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/bundle/web-app/presets)).
  Aucun preset `quorum` upstream.
- Ce que vous appelez « mode creator » **est le preset `cordis`** : c'est lui qui monte
  `skill-filesystem` sur les skills `cordis-plugin-development` / `editing-cordis-compositions` /
  `cordis-composition-reference` (cf. README `@deepseek-ai/dsh-agent-preset`, « the `skills/`
  directory that creator mode mounts »). Votre session courante tourne dans ce mode.
- Un équivalent **Teamwork** est livré mais désactivé : `@deepseek-ai/dsh-experimental-agent-team-profile`
  (roster durable, mailbox pair-à-pair, DAG de tâches partagé, 9 outils `team_*`). Il **ne contient
  aucun outil de revue/vérification** (« review » n'existe qu'en prose dans la politique du Lead) et
  il désactive les outils `subagent` standard. → mauvaise base pour `quorum`, bonne base pour un futur
  mode long-horizon.

### 3.2 Implémentations communautaires proches

| Projet | Ce qu'il fait | Pertinence pour `quorum` |
|---|---|---|
| [y08lin4/dsh-multiagent-modes](https://github.com/y08lin4/dsh-multiagent-modes) | Presets « 协作模式-均衡 / 高效 » : le principal ne fait que décomposer/dispatcher/accepter, tout le travail part en sous-agents, deux paliers de concurrence (≤10 / ≤20). Plugin local avec interception `agent/request` pour injecter l'effort, + un SKILL de protocole. | **Très proche** : même thèse (préserver la chaîne de raisonnement du principal). Licence CC BY-SA 4.0. |
| [ninipa/oh-my-dsh-slim](https://github.com/ninipa/oh-my-dsh-slim) | Orchestrateur + 5 rôles spécialisés (oracle/designer/fixer/explorer/librarian), chacun avec persona, modèle, effort, `toolFilter` et MCP propres ; délégation background-first ; plugin `early-close-context` contre le « j'ai fini » prématuré. | **La meilleure source de mécanique** : c'est exactement le modèle « un rôle = un outil dédié ». |
| [zhaoyilun/dsh-preset-flash-director](https://github.com/zhaoyilun/dsh-preset-flash-director) | Flash = contrôleur, Pro = experts ; outils `expert_consult`/`expert_review` avec **validation du brief** (champs obligatoires + plafonds) et **budget d'experts** dur par tâche utilisateur. | **La meilleure source de garde-fous mécaniques** (validation + budget, pas de la prose). |
| [Asher-2000/dsh-expert-mode](https://github.com/Asher-2000/dsh-expert-mode) | Persona chef-coordinateur + 11 sous-agents experts. | Rôles nombreux, pas de vérification adversariale. |
| [hu568/dsh-plugin-cluster-preset](https://github.com/hu568/dsh-plugin-cluster-preset) | « Cluster mode » : orchestrateur principal + 5 experts nommés + indicateur de phase. | Proche, sans PTC ni vérification. |
| [KannaKuron/dsh-ptc-cordis-preset](https://github.com/KannaKuron/dsh-ptc-cordis-preset) | Mode créatif bâti **sur PTC** (Code Mode + outils Cordis). | Prouve la faisabilité d'un preset PTC communautaire. |
| [qwe225380/dsh-omni-router](https://github.com/qwe225380/dsh-omni-router) | Routage par complexité + Plan Mode + TDD + delivery gate + checklist d'acceptation. | Bonnes idées de portes de sortie. |
| [SeverusZh/dsh-plugin-subagent-director](https://github.com/SeverusZh/dsh-plugin-subagent-director), [muzyLink/dsh-subagent-profile](https://github.com/muzyLink/dsh-subagent-profile), [wxxb789/dsh-legion](https://github.com/wxxb789/dsh-legion) | Sélection provider/modèle/effort/tool-scope par sous-agent. | Le « configurer les sous-agents » que vous demandez. |
| [zhuzhujunandy/dsh-model-router](https://github.com/zhuzhujunandy/dsh-model-router) | Routage par paliers (fast/medium/heavy) avec **vérification DoD**, fallback inter-provider, budgets par conversation. | Routage + definition-of-done. |
| [huiliyi37/oh-my-tianshu](https://github.com/huiliyi37/oh-my-tianshu) | Distribution complète : verification gates, agent routing, rollback. | Trop large pour un mode. |

Catalogues pour aller plus loin :
[awesome-deepseek-harness](https://github.com/Dominic789654/awesome-deepseek-harness),
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin),
[dsh.fish](https://github.com/stvlynn/dsh.fish), [dshmarket](https://dshmarket.com/).

### 3.3 Le blocker décisif

**DSH 0.1.6 a remplacé les presets « répertoire » par des presets « déclaratifs »** (déclarés par un
bundle, donc par un patch Cordis). C'est écrit noir sur blanc par `oh-my-dsh-slim` :

> « ⛔ DSH 0.1.6 and newer — including the whole 0.1.7 line — are not supported by this release.
> DSH 0.1.7 replaced directory agent presets with declarative ones declared by plugin bundles, so
> this preset would install and then never appear. »

Or `y08lin4/dsh-multiagent-modes`, `flash-director` et `oh-my-dsh-slim` s'installent tous en copiant
un répertoire dans `~/.dsh/.agent-presets/` — **que DSH 0.1.7 ne lit plus**
(`editing-cordis-compositions` : « Nothing reads that directory any more »).

**Conclusion** — *périmée : le disque et le process vivant portent `0.2.0-rc.2` depuis le 2026-09-30, et le livrable est le dépôt consolidé `C:\CodeSource\dsh-boost` (voir `docs/HANDOVER.md`) ; la conclusion ci-dessous est celle du moment de ce plan, où l'installation portait `0.1.7-rc.2`.* Vous êtes sur `0.1.7-rc.2`. Aucune de ces implémentations ne fonctionnera telle quelle.
Il faut soit migrer l'une d'elles vers le modèle déclaratif, soit — ce que propose ce plan — écrire
le preset `quorum` nativement en déclaratif, en réutilisant leurs idées de conception (rôles par
`toolFilter`, budget, validation de brief, ledger « enfant non réglé »).

**Le trou dans l'écosystème** : personne ne publie un preset déclaratif qui combine
(i) présentation PTC ⇒ sous-agents en Code Mode, (ii) rôles spécialisés par instance d'outil, et
(iii) **vérification adversariale comme étape obligatoire en premier plan**. C'est exactement la
cible de `quorum`.

---

## 4. Faits DSH vérifiés qui contraignent la conception

Tous vérifiés dans l'installation `0.1.7-rc.2` — **périmé : c'est `0.2.0-rc.2` qui est installé depuis le 2026-09-30** (chemins sous
`…\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`).

| # | Fait | Source |
|---|---|---|
| F1 | Un preset est un **bundle patch** (`dsh.bundle.patch` → `cordis.patch.yml`) qui insère une ligne `preset-<id>` de `@deepseek-ai/dsh-agent-preset`. Champs : `id`, `plugins`, `name`, `description`, `order`. | README `dsh-agent-preset` |
| F2 | Le sélecteur Web lit `agentPresets.list` ; **tout preset sain déclaré apparaît automatiquement** avec son `name`/`description`. Aucun code client à écrire. | `dsh-client-ui-agent-preset/lib/types/client/settings-store.d.ts` |
| F3 | **Un sous-agent hérite exactement du preset de son parent.** `childSessionMeta()` lit `agentPresets.composedPreset(parent.ctx)` et `applyChildComposition()` appelle `composeFrom(childCtx, parent.ctx)`. **Aucun champ, aucune API, aucun chemin de code ne permet de nommer un preset pour un enfant** — ni dans `dsh-tool-subagent`, ni dans `ctx.subagents`, ni dans le moteur de workflow. | `dsh-subagent/lib/types/child-agent.js:111-173`, `dsh-tool-subagent/lib/index.js:509-520` |
| F4 | La politique d'un enfant est **figée par instance d'outil** : `persona`, `toolFilter {allow,deny}`, `agentOptions {provider,model,reasoningEffort,maxTokens}`, `maxDepth`. « another persona, tool filter, or depth cap requires another distinctly named tool ». | `dsh-tool-subagent/lib/types/index.d.ts`, README §Known Limitations |
| F5 | La `persona` passée à un enfant **remplace** la persona du preset pour cet enfant (`deployment:persona-prefix` est *shadowed*). | `dsh-subagent/lib/types/child-agent.js:157-173` |
| F6 | **PTC = Programmatic Tool Calling.** `mode` ∈ `native` \| `ptc` \| `both`. `ptc` n'expose que le transport réservé `run_code` + un SDK TypeScript généré + la règle « seul `run_code` est appelable directement » ; tout appel direct à un autre outil ⇒ `UNKNOWN_TOOL`. La déclaration est **au niveau du preset** et couvre **tout agent joint à ce preset** ⇒ les sous-agents aussi. Une seule déclaration par composition. Le runtime PTC doit exister au niveau host, sinon le preset **refuse de monter**. | README `dsh-agent-tool-presentation` ; `dsh-client-ui-agent-preset/lib/client.js:102` |
| F7 | `ctx.ptcRuntime` est fourni par `@deepseek-ai/dsh-ptc-runtime-node`, **actif dans votre profil** (ligne host `ptc-runtime`, `enabled: true`). | `plugin_manager list_plugins` |
| F8 | **Au plus une instance d'outil par scope peut posséder la sélection de modèle** (`modelSelectionSettings: true`), car `list_subagent_models` a un nom global. | README `dsh-tool-subagent` |
| F9 | `subagent_fork` **ne peut pas** router le modèle de l'enfant (il hérite de la route du parent pour préserver le KV-cache). | idem |
| F10 | `run_in_background: false` en mode `continuable` **attend l'enfant en premier plan**. C'est le seul mécanisme nécessaire pour bloquer sur une vérification. | idem |
| F11 | DSH est *turn-based* : un modèle peut clore son tour alors qu'un enfant background tourne encore (« early close »). C'est un défaut connu, contourné par `oh-my-dsh-slim` avec un ledger + un bloc de contexte. | `oh-my-dsh-slim` README §Known limits + `dsh-tool-subagent` README |
| F12 | `@deepseek-ai/dsh-tool-workflow` (outil `workflow`) offre `agent(prompt, {schema,label,phase,provider,model})`, `pipeline`, `parallel`, `phase`, `log` ; `@deepseek-ai/dsh-workflow-ptc` exécute ce script **dans le runtime PTC**. Aucun override de preset. | `dsh-tool-workflow`, `dsh-workflow-ptc` |
| F13 | `ralph` = boucle bornée sur `workflowEngine`, un enfant frais à sortie structurée par round, statuts `continue/complete/blocked`, budget `maxRounds`. | `dsh-tool-ralph` |
| F14 | `ctx.subagents` : `maxActiveSubagents` défaut **8**, `maxDepth` défaut **1** (les enfants ne peuvent donc pas déléguer davantage). | `dsh-subagent` README/types |
| F15 | `ctx.commands.register({name, description, input, handler})` permet une commande slash ; un plugin monté sous le contexte d'un agent enregistre une commande **scopée à cet agent** ; `agentPresets.select(agent, preset)` ne fonctionne que sur un **agent vierge** (avant le premier tour). | README `dsh-commands`, `dsh-agent-preset-registry/lib/types/index.d.ts` |
| F16 | Les skills du mode creator sont chargées à la demande via `skill-filesystem` + `customSkillDirs`, avec un chemin résolu par `createRequire(baseUrl)`. | `presets/cordis.patch.yml:143-149` |

---

## 5. Décisions d'architecture

**D1 — `quorum` est un preset (mode), pas une commande slash.**
Chez Antigravity, `/boost` peut changer d'architecture en cours de session. Dans DSH, la composition
d'une session est figée à sa création (stabilité du préfixe de requête / KV-cache) et **les enfants
héritent de cette composition** (F3). Un `/boost` tapé dans une session `standard` ne pourrait donc
ni activer PTC ni donner les rôles aux enfants. Le mode est le bon analogue. Une commande `/boost`
reste possible **à l'intérieur** du preset `quorum` (escalade d'intensité, §8) et, en option, comme
raccourci global qui n'accepte que les sessions vierges via `agentPresets.select` (F15).

**D2 — La base est la présentation PTC.** C'est ce qui répond à « que les sous-agents utilisent aussi
PTC » : l'héritage de composition (F3) + la portée preset de la présentation (F6) donnent PTC aux
enfants **gratuitement**. Bonus : en PTC, les schémas d'outils disparaissent au profit d'un SDK, donc
ajouter des rôles coûte beaucoup moins cher qu'en mode `native`.

**D3 — Un rôle = une instance de `@deepseek-ai/dsh-tool-subagent`** avec son `toolName`, sa `persona`,
son `toolFilter`, son `maxDepth` (F4). C'est le mécanisme officiel de spécialisation, et il reproduit
le modèle « agent custom » d'Antigravity (`tools: [...]`, `model:`, body = system prompt).

**D4 — Cinq lignes de délégation** : `subagent` (générique, seul porteur de `modelSelectionSettings`),
`subagent_fork`, `subagent_investigate`, `subagent_implement`, `subagent_verify`.

**D5 — v1 ne fixe aucune route de modèle par rôle** (tout hérite de la route de session, ici
`deepseek-official/deepseek-flash`). Un id de modèle inconnu fait échouer la délégation au premier
appel ; on évite ce risque en v1, puis on ajoute `agentOptions` par rôle en v1.1 (édition d'une ligne,
documentée, avec validation préalable du catalogue `list_subagent_models`).

**D6 — `tool-workflow` et `workflow-ptc` désactivés en v1**, comme dans le preset `ptc` livré : en
PTC, l'orchestration se fait dans `run_code` (`await Promise.all([...])` sur les fonctions du SDK), et
deux surfaces de scripting concurrentes coûtent des tokens et créent de l'ambiguïté. Décision à
réévaluer par A/B (jalon M5) car `workflow` apporte en échange la sortie structurée validée par
schéma, les phases affichées dans l'UI (`ui-workflow-run`) et les plafonds déterministes.

**D7 — La vérification est un appel en premier plan, pas une consigne.** `run_in_background: false`
sur l'outil de vérification (F10) ⇒ l'orchestrateur ne peut pas conclure avant que le vérificateur
ait rendu son verdict. C'est la différence entre un protocole d'agent et un mécanisme.

**D8 — Le protocole d'orchestration vit dans la `persona` en v1.** C'est shadowé pour les enfants
(F5), ce qui est **voulu** : chaque rôle porte ses propres instructions complètes, comme le body
Markdown d'un agent custom Antigravity. En M2, le plugin `dsh-boost` déplace les invariants *partagés*
(citer la sortie brute, ne jamais conclure sur un enfant non réglé) dans une `systemPrompt.section`
de portée preset, donc visible aussi par les enfants.

**D9 — Plan mode conservé mais désarmé par défaut.** Les 4 presets livrés montent `dsh-plan-mode` ;
on garde la ligne pour la parité et parce que `exit_plan_mode` reste un outil utilisable, mais le
protocole quorum dit explicitement « quorum exécute immédiatement, n'entre pas en plan mode sans
demande » — c'est le différenciateur d'Antigravity face à Teamwork.

**D10 — Agent Teams hors périmètre.** `dsh-experimental-agent-team-profile` est un bundle **host**
(global) qui désactive les outils `subagent` standard, impose un checkout partagé et n'offre aucune
vérification. Il ne doit pas être mélangé au preset `quorum`. Il constituera la base d'un futur mode
`teamwork` (campagnes longues), pas de `quorum`.

---

## 6. Livrables et arborescence

```
C:\CodeSource\dsh-boost-mode\
├── PLAN.md                      # ce document
├── package.json                 # manifeste bundle : dsh.bundle.patch -> ./cordis.patch.yml
├── cordis.patch.yml             # insère le preset quorum (et, en M2, le plugin dsh-boost)
├── README.md                    # doc utilisateur : ce que fait le mode, comment l'installer/le tuner
├── index.js                     # (M2) plugin host : section de prompt, commande /boost, garde-fous
└── skills/
    └── boost-protocol/
        └── SKILL.md             # (M2) protocole détaillé chargé à la demande
```

`package.json` (M1) :

```json
{
  "name": "@local/dsh-boost-mode",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

Installation (jamais via `dsh plugin add` à la main ; `plugin_manager` fait tout) :

```
plugin_manager { action: "install_bundle", target: "C:\\CodeSource\\dsh-boost-mode" }
```

---

## 7. Composition du preset `quorum`

> **Copie historique, et elle a divergé.** Le bloc qui suit recopie le `cordis.patch.yml` du bundle tel
> qu'il était au moment du plan. Le patch réel est `packages/boost-mode/cordis.patch.yml`, agrégé par le
> `cordis.patch.yml` de la racine du dépôt `C:\CodeSource\dsh-boost` — et c'est le nœud du `preset-boost`
> de CE fichier qui est monté. `test/aggregate.test.mjs` (4 cas) défend l'égalité entre les deux, mais rien
> ne relie cette copie-ci : ne pas s'en servir comme source.

`cordis.patch.yml` (M1) — les lignes marquées ★ diffèrent du preset `ptc` livré.

```yaml
- insert:
    - id: preset-boost
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: boost
        name: Boost
        description: >-
          Raisonnement profond multi-agents : un orchestrateur décompose, des rôles isolés
          investiguent et implémentent en parallèle, un vérificateur indépendant tranche avant
          la conclusion. Code Mode (PTC) pour l'orchestrateur et tous ses sous-agents.
        order: 5
        plugins:
          # ---- ★ Persona orchestrateur : porte le protocole 3 phases (shadowé chez les enfants) ----
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              suffix: Your working directory is {{cwd}}.
              prefix: |
                You are a boost orchestrator powered by the {{model}} model, running in
                Programmatic Tool Calling (PTC) mode: you act by writing TypeScript that calls
                tools through the generated SDK, and only `run_code` is directly callable.

                You do not do the heavy work yourself. You decompose, delegate, verify, integrate.
                ... (protocole complet : voir §8.1) ...
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config:
              maxBytes: 65536
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
            disabled: !!js process.platform === 'win32'
          - id: tool-pwsh
            name: '@deepseek-ai/dsh-tool-pwsh'
            disabled: !!js process.platform !== 'win32'
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
            config:
              sampleOverCapGlobResults: false
          - id: tool-jobs
            name: '@deepseek-ai/dsh-tool-jobs'
          - id: skill-filesystem
            name: '@deepseek-ai/dsh-skill-filesystem'
          - id: tool-skill
            name: '@deepseek-ai/dsh-tool-skill'
          - id: command-goal
            name: '@deepseek-ai/dsh-command-goal'
          - id: tool-goal
            name: '@deepseek-ai/dsh-tool-goal'

          - id: planning
            name: cordis:group
            group: true
            isolate:
              planMode: true
            config:
              - id: plan-mode
                name: '@deepseek-ai/dsh-plan-mode'
                config:
                  section: |   # texte identique au preset livré
                    ... (copie verbatim de standard.patch.yml lignes 52-62) ...

          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
              - id: tool-result-pruner
                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
                config:
                  thresholdChars: 8192
                  headChars: 4096
                  tailChars: 1024

          # ---- ★ Délégation : orchestration + 3 rôles spécialisés ----
          - id: delegation
            name: cordis:group
            group: true
            isolate:
              workflowEngine: true
            config:
              - id: tool-subagent-control
                name: '@deepseek-ai/dsh-tool-subagent-control'
              - id: tool-subagent-list-agents
                name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'

              # seul porteur de la sélection de modèle (F8)
              - id: tool-subagent
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: spawn
                  toolName: subagent
                  modelSelectionSettings: true
                  backgroundMode: continuable
                  maxDepth: 1          # ★ un worker ne délègue pas
              - id: tool-subagent-fork
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: fork
                  toolName: subagent_fork
                  backgroundMode: continuable
                  maxDepth: 1          # ★

              # ★ DeepInvestigator — read-only, aucune écriture, aucune délégation
              - id: tool-subagent-investigate
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: spawn
                  toolName: subagent_investigate
                  backgroundMode: continuable
                  maxDepth: 1
                  persona: |   # §8.2
                    ...
                  toolFilter:
                    deny: [ ... ]   # noms exacts à confirmer en M0

              # ★ DeepCoder — écrit, teste, ne délègue pas
              - id: tool-subagent-implement
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: spawn
                  toolName: subagent_implement
                  backgroundMode: continuable
                  maxDepth: 1
                  persona: |   # §8.3
                    ...
                  toolFilter:
                    deny: [ ... ]

              # ★ Vérificateur adversarial — read-only + shell, doit citer la sortie brute
              - id: tool-subagent-verify
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: spawn
                  toolName: subagent_verify
                  backgroundMode: continuable
                  maxDepth: 1
                  persona: |   # §8.4
                    ...
                  toolFilter:
                    deny: [ ... ]

              - id: workflow-ptc            # ★ désactivé (D6)
                name: '@deepseek-ai/dsh-workflow-ptc'
                disabled: true
                config:
                  provider: spawn
              - id: tool-workflow           # ★ désactivé (D6)
                name: '@deepseek-ai/dsh-tool-workflow'
                disabled: true
              - id: tool-ralph              # ★ désactivé en v1 (M4 : levier d'escalade)
                name: '@deepseek-ai/dsh-tool-ralph'
                disabled: true
                config:
                  subagentProvider: spawn
                  maxRounds: 32

          - id: tool-ask-user
            name: '@deepseek-ai/dsh-tool-ask-user'
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
            config:
              allowParallelInProgress: true
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
            config:
              fetch: true
              searchTimeoutMs: 60000

          # ---- ★ PTC pour l'orchestrateur ET tous ses sous-agents (F3 + F6) ----
          - id: tool-presentation
            name: '@deepseek-ai/dsh-agent-tool-presentation'
            config:
              mode: ptc

          - id: present
            name: '@deepseek-ai/dsh-tool-present'
          - id: tool-plugin-manager      # creator mode reste le mode d'extension
            name: '@deepseek-ai/dsh-plugin-manager/tools'
            disabled: true
```

### Points d'attention à l'implémentation

- **`toolFilter` : un nom d'outil inconnu fait échouer le montage.** Les listes `deny`/`allow`
  doivent être construites à partir des noms réellement déclarés par les lignes montées, vérifiés par
  `cordis_inspect_query { provider: "Tool", method: "listTools" }` dans une session quorum (jalon M0).
  Ne jamais deviner un nom.
- **`maxDepth: 1`** est explicite pour la lisibilité ; la valeur par défaut de l'hôte est déjà 1 (F14).
- **`isolate.workflowEngine: true`** sur le groupe `delegation` : conservé du preset livré. Si
  `workflow-ptc` reste désactivé et que plus rien ne consomme `ctx.workflowEngine` dans le preset,
  cette isolation peut être retirée — à trancher en M1 en vérifiant que le montage reste `active`.
- **`order: 5`** place Quorum après creator dans le roster.

---

## 8. Rôles : personas et filtres

### 8.1 Protocole de l'orchestrateur (persona, v1)

```
You are a boost orchestrator. You do not perform deep work yourself: you decompose, delegate,
verify and integrate.

PHASE 1 — STRATEGY. Inspect the workspace first (reads, searches, builds, test runs). Produce a
short internal plan: the discrete, verifiable subtasks, which role owns each, and — for every
subtask — the concrete acceptance check you will run afterwards. Write acceptance criteria BEFORE
delegating; a delegation without an acceptance check is invalid.

PHASE 2 — PARALLEL EXECUTION. Fan out with run_code: start every independent workstream in one
turn (await Promise.all over subagent_investigate / subagent_implement, run_in_background true).
- Investigations that must not modify files go to subagent_investigate.
- Code changes and their unit tests go to subagent_implement; give each worker a disjoint file set
  so two workers never write the same file.
- While children run, keep doing useful work yourself: read files, prepare the acceptance commands,
  narrow the diff. Do not duplicate a running child's scope.
- A child's interim message is NOT completion. Only the settlement notice settles a child.

PHASE 3 — VERIFICATION AND DELIVERY. Before concluding anything:
- Run subagent_verify with run_in_background FALSE, always in the foreground. It must cite raw
  command output; a verdict without raw output is rejected and you re-delegate once.
- Run the acceptance checks you wrote in phase 1 yourself, mechanically.
- If an assertion fails, feed the exact diagnostics back into the next iteration (bounded: at most
  two correction rounds, then report the failure honestly).
- Never claim completion while a child is unsettled, and never report a test as passed unless you
  saw its real output.

Report format: what was verified and how, then the change, then residual risk. Never summarise a
child's prose as if it were evidence.
```

### 8.2 `subagent_investigate` (DeepInvestigator)

Persona : identité d'enquêteur **strictement read-only** ; produit une hypothèse, une chaîne de
preuves (commande exécutée + extrait de sortie + fichier:ligne), et **ce qui a été exclu et comment** ;
interdit de modifier le workspace ; conclut par `HYPOTHESIS / EVIDENCE / RULED OUT / NEXT PROBE`.

`toolFilter.deny` attendu : tous les outils d'écriture (`write`, `edit`), tous les outils de
délégation (`subagent`, `subagent_fork`, `subagent_investigate`, `subagent_implement`,
`subagent_verify`, `send_message`, `interrupt_agent`, `list_agents`), `present`, `ask_user_question`,
`create_goal`/`update_goal`, `workflow`, `ralph`, `todo_write`.

### 8.3 `subagent_implement` (DeepCoder)

Persona : implémente la solution candidate sur un **périmètre de fichiers explicitement borné** ;
diff minimal ; écrit et exécute les tests unitaires de ce qu'il change ; interdit de déléguer ; doit
rendre `WHAT CHANGED / FILES / TESTS RUN (raw output) / OPEN QUESTIONS`.

`toolFilter.deny` : outils de délégation, `present`, `ask_user_question`, `create_goal`/`update_goal`,
`ralph`, `workflow`. (Il garde l'écriture et le shell.)

### 8.4 `subagent_verify` (vérificateur adversarial)

Persona : « you did not write this code and you are not here to agree. Your job is to falsify it. »
Doit construire des cas limites, exécuter la suite réelle (et non des mocks), et **citer la sortie
brute** ; un test simulé, ignoré ou dont la sortie n'est pas montrée est un **échec** ; rend
`VERDICT: pass|fail` + `COUNTEREXAMPLES` + `RAW EVIDENCE` + `WHAT I COULD NOT CHECK`.

`toolFilter` : **périmé — c'est une deny-list qui est montée, pas une allow-list.** Le plan proposait
une allow-list (lecture + shell + jobs) pour rendre l'impossibilité d'écrire structurelle et non
déclarative. La configuration réelle est l'inverse : chaque rôle porte un `deny:`
(`packages/boost-mode/cordis.patch.yml`, et la même ligne dans le `cordis.patch.yml` agrégateur). Mesuré
le 2026-09-30 : **16** noms refusés pour `subagent_verify` (`packages/boost-mode/cordis.patch.yml:310-327`
— `write`, `edit`, `present`, `ask_user_question`, `todo_write`, `exit_plan_mode`, `subagent_fork`,
`subagent_investigate`, `subagent_implement`, `subagent_verify`, `send_message`, `interrupt_agent`,
`list_agents`, `get_goal`, `create_goal`, `update_goal`), **13** pour `subagent_implement` (les mêmes
moins `write`, `edit`, `todo_write`). La composition `dsh --profile boost-test --dump-config` porte
exactement ces listes. *L'orchestrateur de cette passe annonçait « une deny-list de 14 noms » : je ne
retrouve pas 14 — c'est 16, ou 13 selon le rôle.*

```yaml
toolFilter:
  deny:
    - write        # 16 noms pour subagent_verify, 13 pour subagent_implement
    - …
```

### 8.5 Paramètres à monter (F14)

`ctx.subagents` : `maxActiveSubagents` défaut **8**. Pour du fan-out type quorum, monter à **12–16**
via le réglage host `subagent.maxActiveSubagents`. À documenter dans le README du bundle — ce n'est
pas un réglage du preset.

---

## 9. Jalons

### M0 — Vérifications préalables (aucune écriture de code)

1. `plugin_manager list_plugins` : confirmer `include:ptc-runtime` `active` (F7).
2. Dans la session courante : `cordis_inspect_query { provider: "Tool", method: "listTools" }` pour
   figer la liste exacte des noms d'outils (base des `toolFilter`).
3. `cordis_inspect_query Config.listConfigs { name: '@deepseek-ai/dsh-agent-preset' }` : 4 entrées.
4. Confirmer que `@deepseek-ai/dsh-companion…`-style resolver n'est pas nécessaire : le bundle ne
   déclare aucune dépendance vers des paquets livrés avec `dsh` (ils résolvent depuis l'installation).

**Sortie** : tableau `outil → nom exact` figé, plus la confirmation du runtime PTC.

### M1 — Preset `quorum` minimal viable (le cœur)

Livrer `package.json` + `cordis.patch.yml` (+ `README.md`), sans `index.js`, avec :
persona porteuse du protocole §8.1, les 5 lignes de délégation avec personas/filtres §8.2–8.4,
`tool-presentation: ptc`, et le reste identique au preset `ptc` livré.

**Acceptation**
1. `plugin_manager install_bundle` renvoie `application: applied` sans warning bloquant.
2. `cordis_inspect_query Config.listConfigs { name: '@deepseek-ai/dsh-agent-preset' }` renvoie **5** entrées, dont `preset-boost` avec `status: schema`.
3. Nouvelle session, sélecteur « Agent preset » : **Quorum** présent (F2).
4. Dans la session quorum, `Tool.listTools` ne montre que `run_code` (+ les outils du SDK annoncés) : PTC effectif.
5. Le SDK généré expose bien `subagent_investigate`, `subagent_implement`, `subagent_verify`,
   `send_message`, `interrupt_agent`, `list_agents` — **point le moins certain du plan**, à vérifier ici.
6. Un `subagent_verify` lancé depuis la session quorum démarre : le transcript de l'enfant montre des
   appels `run_code` ⇒ héritage PTC confirmé (F3+F6).
7. Les presets `standard`/`ptc`/`minimal`/`cordis` restent `active`.

### M2 — Protocole externalisé + invariants partagés

Ajouter `index.js` (plugin host du bundle) qui :
- enregistre une `systemPrompt.section` « boost:invariants » (citer la sortie brute ; ne jamais
  conclure sur un enfant non réglé ; worktrees/périmètres disjoints) — donc visible par les enfants,
  contrairement à la persona (F5) ;
- allège la persona en conséquence.

Optionnel dans le même jalon : `skills/boost-protocol/SKILL.md` chargé à la demande, en résolvant le
chemin comme le fait le preset creator (F16).

**Acceptation** : la section apparaît dans le prompt d'un enfant ; le preset monte toujours `active`.

### M3 — Commande `/boost` et état de session

Ajouter au plugin un `ctx.commands.register` **scopé à l'agent** (F15) :
- `/boost <tâche>` : marque la session en « intensité profonde » (≥2 hypothèses concurrentes, 2ᵉ
  vérificateur sur `stakes: high`), puis soumet `<tâche>` comme message utilisateur — même schéma que
  `dsh-plan-mode` pour `/plan [message]`.
- Option : commande **globale** `/boost` qui appelle `agentPresets.select(agent, 'boost')` et ne
  réussit que sur une session vierge, sinon renvoie un message expliquant qu'il faut choisir le mode
  dans le sélecteur (la composition d'une session entamée est figée).

**Acceptation** : `/boost` tapé dans une session quorum exécute la tâche et l'état est journalisé ;
en session `standard`, la commande globale explique la contrainte au lieu de mentir.

### M4 — Garde-fous mécaniques (optionnel, recommandé)

Porter les deux meilleures idées communautaires dans le plugin :
1. **Validation de brief** (modèle `flash-director`) : refuser une délégation sans critère
   d'acceptation ni preuve collectée, avec plafonds de taille — au point d'extension
   `tools/pre-execute` (waterfall).
2. **Ledger « enfants non réglés »** (modèle `early-close-context` de `oh-my-dsh-slim`) : bloc de
   contexte ré-évalué à chaque tour listant les enfants `running`/`reported`, pour tuer le « j'ai
   fini » prématuré (F11). En v1 la parade est D7 (vérification en premier plan) ; ceci couvre les
   workstreams d'implémentation restés en background.
3. Levier d'escalade : activer `ralph` (`maxRounds: 32`) pour les objectifs objectivement binaires
   (« rendre `pnpm test` vert »).

### M5 — Recette et A/B

1. Bug seedé + suite de tests dans un projet jetable ; exécuter la même tâche en `standard` puis en
   `quorum`, 3 fois chacun.
2. Mesurer : taux de verdict correct, présence de sortie de test brute dans la réponse finale,
   tokens consommés, durée.
3. Trancher D6 (workflow activé ou non) sur ces mesures.
4. Documenter les résultats dans le README du bundle.

**Acceptation globale** : les 6 critères de succès du §1 sont satisfaits et consignés.

---

## 10. Risques et limites

| Risque | Impact | Mitigation |
|---|---|---|
| Le SDK PTC n'expose pas les outils `subagent_*` scopés | Le mode ne marche pas en PTC | Vérifié en M1.5 ; repli : `mode: both` (schémas + SDK), puis `native` + rôles |
| Nom d'outil inconnu dans un `toolFilter` | Le montage du preset échoue (diagnostic visible sur le roster) | M0 fige les noms ; `verify` en allow-list |
| Mode PTC sans runtime PTC au niveau host | Le preset refuse de monter, nommant la ligne fautive | Runtime déjà actif (F7) ; à revérifier si le profil change |
| Un modèle non supporté dans `agentOptions` | Échec de la délégation au premier appel | v1 sans route par rôle (D5) ; validation par `list_subagent_models` en v1.1 |
| « Early close » : conclusion avant réglage des enfants (F11) | Réponse finale non fondée | D7 (vérification en premier plan) + ledger M4 |
| Prolifération de rôles figés par instance (F4) | Ajouter un rôle = ajouter une ligne, pas un paramètre | Assumé : 3 rôles + générique suffisent ; documenter la recette d'ajout |
| Agent Teams activé en parallèle | Conflit de noms : `send_message`, `list_agents`, `interrupt_agent` sont enregistrés par `tool-agent-team` dans la portée propre de **chaque agent** et masquent ceux de `tool-subagent-control` que quorum monte, avec des signatures incompatibles | Traiter les deux comme exclusifs dans un profil ; voir annexe A |
| Dérive du nom `quorum` vs. écosystème | Confusion avec les presets communautaires (legacy) | Nommer le bundle et le README explicitement `declarative preset, DSH ≥ 0.1.6` |

---

## 11. Décisions ouvertes (à trancher avant M1)

1. **Routes de modèle par rôle dès v1 ou v1.1 ?** Recommandation : v1.1, avec des `agentOptions`
   paramétrables en haut du `cordis.patch.yml` (contrôleur flash, vérificateur pro) — c'est l'apport
   principal des projets communautaires, mais cela introduit un risque d'id de modèle inconnu.
2. **`workflow` activé ou non** (D6) : recommandation = désactivé en v1, A/B en M5.
3. **Nombre de rôles** : 3 (investigate/implement/verify) + générique ; faut-il un 4ᵉ rôle `plan`
   dédié à la décomposition ? Recommandation = non, la phase 1 reste chez l'orchestrateur.
4. **Commande globale `/boost`** (M3, option) : à inclure ou non.
5. **Emplacement du bundle** : `C:\CodeSource\dsh-boost-mode` (proposé) et publication ultérieure
   éventuelle sur GitHub avec le topic `dsh-plugin` (l'écosystème cherche précisément ce mode, cf. §3).

---

## 12. Références

- Antigravity [`/boost`](https://antigravity.google/docs/boost.md), [Subagents](https://antigravity.google/docs/subagents), [Teamwork](https://antigravity.google/docs/teamwork), [catalogue des slash commands](https://antigravity.google/docs/slash-commands)
- DSH : `packages/bundle/web-app/presets/{standard,ptc,minimal,cordis}.patch.yml`
- `@deepseek-ai/dsh-agent-preset`, `-registry`, `dsh-subagent`, `dsh-tool-subagent`,
  `dsh-agent-tool-presentation`, `dsh-ptc-runtime(-node)`, `dsh-tool-workflow`, `dsh-workflow-ptc`,
  `dsh-tool-ralph`, `dsh-commands`, `dsh-experimental-agent-team(-profile|-tool-)`

---

## Annexe A — Agent Teams (bundle expérimental livré) : ni équivalent, ni compatible en l'état

`@deepseek-ai/dsh-experimental-agent-team-profile` est présent dans l'installation mais **non activé**
(`plugin_manager list_bundles` → `enabled: false, installed: false, optional: true, removable: false`).
Il monte trois lignes : `agent-team` (`ctx.agentTeams` : roster + mailbox + DAG durables),
`tool-agent-team` (9 outils) et `ui-agent-team` (UI Web).

C'est l'analogue DSH d'Antigravity **`/teamwork-preview`**, pas de `/boost` :

| Axe | Agent Teams | Preset `quorum` |
|---|---|---|
| Emplacement | bundle **host**, global à tous les presets | preset : **un mode sélectionnable** |
| Horizon | heures → jours, adossé au log de session | secondes → heures, éphémère |
| Topologie | roster plat de ≤ 8 pairs nommés, mailbox pair-à-pair, DAG de tâches partagé | orchestrateur → workers isolés, persona et `toolFilter` figés par rôle |
| Persistance | log du Lead = source de vérité ; roster/mailbox/DAG rejoués ; 4 événements `team/*` | aucune : un enfant est un sous-agent jetable ou continuable |
| Vérification | **aucun outil** — seulement la prose « have the Lead review the final diff » dans le texte de politique | vérificateur adversarial indépendant, obligatoire, en premier plan |
| Code Mode | aucun | `mode: ptc`, hérité par tous les enfants |
| Isolation | un process, un checkout partagé ; write scopes **indicatifs** (Bash les contourne) | même limite de runtime, plus un `toolFilter` structurel par rôle |

**Interaction problématique.** `tool-agent-team` installe ses outils dans la portée propre de chaque
agent (`maybeInstall` à l'activation puis sur `agent/created`,
`dsh-experimental-tool-agent-team/lib/index.js:539-545`). Trois noms coïncident avec ceux que quorum
monte, avec des signatures différentes :

| Nom | Agent Teams | quorum (`tool-subagent-control`) |
|---|---|---|
| `send_message` | `target` = **nom** d'un pair | `agent_id` = id de sous-agent |
| `list_agents` | `{}` | `scope: children \| descendants` |
| `interrupt_agent` | `target` = nom de pair | `agent_id` |

La portée la plus proche gagnant, les versions Agent Teams masqueraient celles de quorum : le protocole
de quorum (« une seule relance via `send_message` ») changerait silencieusement de sémantique. Les quatre
`disabled: true` du bundle visent par ailleurs des lignes host déjà désactivées dans ce profil, donc
inoffensifs aujourd'hui — mais fragiles.

**Piste pour un futur mode long-horizon** : monter `agent-team` + `tool-agent-team` **à l'intérieur d'un
preset** (au lieu d'un bundle host), avec PTC et `subagent_verify`. `ui-agent-team` doit rester au niveau
host. Les README amont ne documentent pas ce montage en preset : à vérifier (jalon M6, non planifié).

---

## Annexe B — Parallélisme et clés API : ce que dit la doc officielle DeepSeek

Source : [Rate Limit & Isolation](https://api-docs.deepseek.com/quick_start/rate_limit), consultée
le 2026-09-29.

**Fait décisif, cité textuellement** :

> « **Concurrency limits are calculated at the account level, regardless of which API Key is used.** »

| Modèle | Connexions simultanées par **compte** |
|---|---|
| `deepseek-flash` | **2500** |
| `deepseek-v4-pro` | **500** |

- « A request counts as one concurrent connection from the time it is sent until the model response is
  complete » ; au-delà : **HTTP 429**.
- `user_id` : « For regular API users, **all `user_id` values are combined** for concurrency limit
  calculation. » Le partitionnement par `user_id` (2500 / 500 par `user_id`) ne s'applique **qu'aux
  comptes ayant obtenu une augmentation de quota**, et il s'ajoute au plafond global du compte.
- `user_id` isole aussi le **KVCache** et la sécurité de contenu.
- L'augmentation de capacité se demande officiellement et est **gratuite** (« There is no additional
  cost for capacity expansion »).
- Une requête dont l'inférence n'a pas démarré au bout de 10 min voit sa connexion fermée.

**Conséquence pour quorum : multiplier les clés d'un même compte n'apporte aucun parallélisme.** Le
plafond est au niveau du compte, pas de la clé.

Et le goulot est **entièrement local** : DSH plafonne à `maxActiveSubagents: 8` (défaut, `.volatile()`
donc modifiable à chaud) et à `maxParallelToolCalls` côté agent-loop. Face aux 2500 de `deepseek-flash`,
il y a donc un facteur **~300** de marge inutilisée côté fournisseur. La bonne question n'est pas
« combien de clés » mais « pourquoi 8 ».

### Un piège contre-intuitif

Le réflexe « une clé ou un `user_id` par agent » **dégraderait** ce qui rend quorum économique :
`user_id` isole le KVCache, donc fragmenter les agents par identité casse le partage de préfixe. Or le
run mesuré en M1-quinquies tourne à **99,35 % de cache** sur 25,17 M tokens d'entrée. Répartir les
agents sur des identités distinctes ferait grimper le coût réel, pour un gain de parallélisme nul
(compte unique). À ne pas faire.

### Axes d'amélioration, par valeur décroissante

1. **Monter la limite locale avant tout le reste — décidé.** Cibles : **`maxActiveSubagents` 8 → 16** et
   **`maxParallelToolCalls` 10 → 24**. `maxDepth` reste à **1** : c'est le garde-fou exponentiel, et le
   relever globalement exposerait les autres presets alors que les lignes de quorum se plafonnent déjà
   elles-mêmes.
   **Chemin obligatoire : l'interface** (Settings → Subagent, Settings → Agent Loop). Preuve :
   `dsh-settings` n'a **aucun watcher** — son seul déclencheur de relecture est
   `app-boot/config-reload` (`dsh-settings/lib/index.js:196,336`). Un `settings.yaml` écrit à la main ne
   s'appliquerait donc qu'au prochain redémarrage, alors que ces deux champs sont `.volatile()` : un
   écrit via le panneau s'applique **immédiatement**, sans redémarrage.
   À mesurer après coup : largeur de fan-out réellement atteinte et taux de 429.
   *Attente honnête* : la campagne en cours lance 3 bras à la fois, donc 8 suffisait — le gain porte sur
   les runs quorum à fan-out large, pas sur cette campagne.
2. **~~Routage statique par rôle sur deux modèles~~ — INVALIDÉ par la recherche du 2026-09-29.**
   L'axe supposait `deepseek-v4-pro` plus capable. C'est **faux** : DeepSeek documente l'inverse (voir
   « Modèles » ci-dessous). Router le vérificateur vers `deepseek-v4-pro` reviendrait à payer ~4,4× sur
   l'entrée et ~3,3× sur la sortie pour un modèle **plus faible** sur les benchmarks agentiques et
   **sans entrée d'image**.
   **Décision : tous les rôles restent sur `deepseek-flash`** — ce que le preset fait déjà par héritage
   de la route de session. L'axe 2 ne demande donc **aucun changement de modèle**, et c'est une bonne
   nouvelle : le meilleur choix était aussi le moins cher.
   Le seul levier restant est l'**effort** (`none`/`low`/`high`/`max`, défaut `high`) : `high` pour les
   travailleurs, `max` pour le vérificateur. Contrainte à connaître avant de l'écrire : dans le schéma,
   `agentOptions` exige **ses quatre champs ensemble** —
   `{provider, model, reasoningEffort, maxTokens}` (`dsh-tool-subagent/lib/index.js:258-263`, aucun
   champ interne n'est optionnel). Poser l'effort **épingle donc la route**, et un `maxTokens` mal choisi
   plafonnerait la sortie (le plafond effectif observé sur la route du profil est `256000`, et la doc
   annonce 128 K à `effort=max`). À décider explicitement, avec le redémarrage — pas en aveugle.
3. **Escalade sur échec — révisée.** Le principe tient (l'échec est un signal gratuit et fiable, et le
   harnais fournit des codes stables : `RATE_LIMIT`, `QUOTA`, `ACCOUNT_QUOTA`, `CodeRunFailedError`),
   mais **la cible change** : on n'escalade plus vers un « modèle plus fort » qui n'existe pas dans cette
   gamme. On escalade sur l'**effort** (`high` → `max`) et sur le **re-brief** enrichi des diagnostics.
   Classer la difficulté en amont reste déconseillé : une requête par tâche, et un classifieur qui se
   trompe sur les seuls cas qui comptent.
4. **Plafond de budget par tâche utilisateur** (M4) : `maxTokens` par rôle + ledger de délégations, sur
   le modèle de `maxExpertsPerUserTask`. Base de calibrage disponible : la consommation par session est
   déjà mesurée.
5. **Si le plafond du compte devient réellement contraignant** : demander l'augmentation de capacité
   (gratuite). C'est seulement à partir de là que `user_id` devient un levier — et il faudra alors
   arbitrer explicitement entre isolation KVCache et partage de cache.

**Confirmé le 2026-09-29** — le déploiement utilise l'API DeepSeek **directe, sans intermédiaire**. Les
plafonds ci-dessus s'appliquent donc tels quels : aucune limite de relais ne s'y ajoute, et la marge
locale (~300× sur `deepseek-flash`, ~60× sur `deepseek-v4-pro`) est réelle.

---

## Annexe C — Modèles : la gamme officielle, et pourquoi le moins cher est le meilleur

Recherche vérifiée le 2026-09-29 sur les pages first-party (pricing, API reference, changelog, news,
thinking mode, vision). **Conclusion : `deepseek-flash` (V4.1-Flash) est devant `deepseek-v4-pro`
(V4-Pro-0813).**

| | `deepseek-flash` | `deepseek-v4-pro` |
|---|---|---|
| Version servie | DeepSeek-V4.1-Flash | DeepSeek-V4-Pro-0813 |
| Contexte / sortie max | 1 M / 384 K | 1 M / 384 K |
| `reasoning_effort` | `none`/`low`/`high`/`max`, défaut `high` | identique |
| Prix /1 M — cache hit | **$0,003** hors pointe / $0,006 pointe | $0,022 / $0,044 |
| Prix /1 M — entrée cache-miss | **$0,15** / $0,30 | $0,66 / $1,32 |
| Prix /1 M — sortie | **$0,60** / $1,20 | $1,98 / $3,96 |
| Connexions simultanées / compte | **2500** | 500 |
| Entrée d'image | **oui** | **non** |

Preuves first-party : la [note de sortie V4.1-Flash du 2026-09-10](https://api-docs.deepseek.com/news/news260910)
annonce des « benchmark results ahead of flagship models, including DeepSeek-V4-Pro » et précise
« We're phasing out V4-Pro ». Sur les tableaux officiels, Flash devance Pro sur HLE avec outils
(63,9 / 60,0), Terminal-Bench 2.1 (90,6 / 87,9), NL2Repo (65,4 / 61,5), CyberGym (88,1 / 83,3),
DeepSWE (74,2 / 62,7), Automation-Bench (54,8 / 31,8) et Agents' Last Exam (31,8 / 25,7) ; Pro ne gagne
que sur HLE **sans** outils (42,7 / 36,8). Les deux ids sont les seuls acceptés dans `model`.

**Trois conséquences opérationnelles :**

1. **Ne pas router vers `deepseek-v4-pro`.** C'était l'erreur de l'axe 2 d'origine : plus cher, plus
   faible sur l'agentique, et aveugle aux images. Seul levier restant entre les deux : l'effort.
2. **Hors pointe = 50 % du prix.** Pointe = **01:00–04:00 et 06:00–10:00 UTC** du lundi au vendredi
   (hors jours fériés chinois) ; tout le reste est hors pointe. En heure locale (UTC+2) : **03:00–06:00
   et 08:00–12:00**. Planifier les campagnes lourdes hors de ces fenêtres **divise la facture par deux**
   — le levier de coût le plus simple qui existe, et il est gratuit.
3. **Conflit non résolu, à trancher par une requête.** DeepSeek a annoncé qu'à partir du 2026-09-14
   04:00 UTC, **toutes** les requêtes `deepseek-v4-pro` seraient routées vers V4.1-Flash aux tarifs
   Flash. Or la page de prix liste toujours `deepseek-v4-pro` séparément, avec ses prix, sa version et
   ses 500 connexions, et l'API l'accepte encore. **Rien ne dit si le routage est actif.** S'il l'est,
   les deux ids sont le même backend aujourd'hui et tout A/B entre eux est vide de sens. Une seule
   requête le tranche : appeler une fois chaque id et lire le `model` / `system_fingerprint` renvoyé —
   la recherche n'a pas pu le faire (pas de clé : 401 ; `platform.deepseek.com` : 403).

**À ne pas retenir comme fiable** : « 5.5 ». Aucun id `deepseek-v5.5` ni mention « 5.5 » n'existe dans
la pricing page, la référence API, le changelog ou l'index des news (dernière news officielle :
2026-09-10). Le seul modèle futur nommé est `V4.1-Pro`. Les affirmations « un V5 est sorti sans
étiquette » sont non officielles et ne nomment aucun id. De même, « tests by multiple parties » n'est
étayé par aucune source citée : à traiter comme promotionnel.

**Contrainte de harnais à connaître** : en mode *thinking* **avec** `tools`, l'API exige le passage
intégral de `reasoning_content`, sinon elle renvoie 400. L'adaptateur officiel s'en charge ; cela ne
concerne que l'écriture d'un adaptateur tiers.

---

## Annexe D — Infrastructure pour un modèle premium (type Opus 5.5) : préparée, non activée

Décision : **les deux niveaux restent sur `deepseek-flash`**, et rien ne change aujourd'hui — c'est déjà
le cas par héritage de la route de session. Vérifié dans `request/header` d'un run réel :
`{provider: deepseek-official, model: deepseek-flash, reasoningEffort: high, maxTokens: 256000}`.
Cette annexe décrit la plomberie pour qu'une clé premium s'active **sans reconception**.

### État vérifié aujourd'hui

`subagent-model-selection-settings.enabled = false` (défaut). Conséquence observable : le tool
`subagent` **n'expose pas** `provider`/`model`/`reasoning_effort` par appel, et `list_subagent_models`
n'est **pas** enregistré — constaté sur le catalogue d'outils vivant, où le schéma de `subagent` ne porte
que `description`, `prompt` et `run_in_background`.

### Les trois étapes d'activation, le jour où la clé arrive

1. **Enregistrer la route premium** — Settings → Models, via l'adaptateur multi-fournisseur
   `dsh-llm-pi-ai` : une entrée dans son dictionnaire `providers` (`api: 'anthropic-messages'`,
   `baseURL`, `apiKeyEnv`, `models[]`). **La clé n'entre jamais dans un fichier de configuration** :
   `apiKeyEnv` est une *référence* résolue à chaque requête par le seam de credentials, et un
   fournisseur du catalogue pi-ai se connecte par OAuth ou saisie interactive, le credential allant au
   coffre. Les changements de route prennent effet **à la requête suivante, sans redémarrage**.
2. **Autoriser la route à la sélection par appel** — Settings → Subagent, section de sélection de
   modèle : activer le toggle puis cocher la route. Champs `enabled` et `allowedModels[]` du namespace
   `subagent-model-selection-settings`, **tous deux `.volatile()`** ⇒ à chaud. L'UI précise « Applies
   only to new sessions » : la politique est échantillonnée à la composition de la session.
3. **Router**, au choix :
   - **escalade ponctuelle, sans redémarrage** — l'orchestrateur délègue via le tool **générique
     `subagent`** en nommant `provider`/`model` (+ `reasoning_effort`) **par appel** ; aucune
     modification du preset. C'est la voie préparée par défaut ;
   - **rôle épinglé** (ex. le vérificateur toujours sur le modèle premium) — il faut `agentOptions` sur
     la ligne du rôle, et comme le schéma exige **les quatre champs ensemble**, cela épingle la route.
     Fragment prêt à coller — **mais lire d'abord le mur de coût ci-dessous, qui déconseille cette
     voie** :

```yaml
              - id: tool-subagent-verify
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: spawn
                  toolName: subagent_verify
                  backgroundMode: continuable
                  maxDepth: 1
                  agentOptions:
                    provider: <route-anthropic>
                    model: claude-opus-5-5
                    reasoningEffort: <valeur-declaree-par-ladaptateur, PAS 'max' a priori>
                    maxTokens: 131072
```

### Claude Opus 5.5 — spécificités vérifiées (doc Anthropic, 2026-09-29)

| | `claude-opus-5-5` | comparaison `deepseek-flash` (hors pointe) |
|---|---|---|
| Contexte / sortie max | 1 M / 128 K (300 K via Batch bêta) | 1 M / 384 K |
| Entrée | **$4 / MTok** | $0,15 → **26,7×** |
| Sortie | **$20 / MTok** | $0,60 → **33,3×** |
| **Lecture de cache** | **$0,20 / MTok** | $0,003 → **66,7×** |
| Écriture de cache | $5 (5 min) / $8 (1 h) | — |
| Effort par défaut | **`medium`** (échelle propre à Anthropic) | `high` |
| *Thinking* | **adaptatif, toujours actif — non désactivable** | paramétrable, `none` possible |
| Batch API | −50 % sur entrée et sortie | hors pointe déjà −50 % |

Sources : [Models overview](https://platform.claude.com/docs/en/models/overview) et
[Claude Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview).

**Le mur de coût, chiffré sur notre propre run.** Le run mesuré en M1-quinquies a consommé, pour la
seule racine, 25,0 M de tokens **lus en cache**, 164 k d'entrée réelle et 183 k de sortie :

| | `deepseek-flash` hors pointe | `claude-opus-5-5` |
|---|---|---|
| 25,0 M lus en cache | 0,075 $ | **5,00 $** |
| 164 k d'entrée | 0,025 $ | 0,66 $ |
| 183 k de sortie | 0,110 $ | 3,66 $ |
| **total racine** | **≈ 0,21 $** | **≈ 9,30 $** |

Soit **≈ 44× plus cher pour la même session d'orchestration**. C'est un ordre de grandeur, pas un devis
(les politiques de cache diffèrent entre fournisseurs et 25 M est un cumul de relectures), mais le
rapport est sans ambiguïté — et il vient surtout de la **lecture de cache**, poste dominant des deux
côtés, où Opus coûte **67×** le prix de Flash.

**Conclusion d'architecture : escalade par appel, jamais par rôle.** Épingler un rôle entier sur Opus
ferait payer 67× le poste de coût principal d'une session agentique longue. La bonne cible est
l'**escalade ponctuelle d'une seule sous-tâche** via le tool générique `subagent` — c'est-à-dire la voie
« sans redémarrage » de l'étape 3, qui devient la voie recommandée, le fragment `agentOptions`
ci-dessus restant disponible mais déconseillé.

**Trois pièges à vérifier le jour J** (tous documentés par Anthropic, tous susceptibles de mordre ici) :

- **le *thinking* ne peut pas être désactivé** : chaque appel paie des tokens de raisonnement, au prix
  de la sortie ;
- **l'usage d'outil forcé renvoie une erreur** — à vérifier côté adaptateur si un `tool_choice`
  impératif est un jour utilisé ;
- **le texte entre deux appels d'outil revient dans des blocs `thinking` vides** au réglage `display`
  par défaut. Autrement dit : **l'interface se tait entre les appels d'outil**, exactement le symptôme
  de « silence » qu'on a passé la session à diagnostiquer. À anticiper si un jour un run quorum tourne
  sur Opus.
- **Pour aller au-delà d'Opus**, la gamme Anthropic place **`claude-fable-5-1`** au-dessus ($10 / $50,
  effort par défaut `high`), « for demanding reasoning and long-horizon agentic work ». Opus 5.5 est le
  défaut recommandé, pas le sommet.

### Trois points de vigilance

- **Les niveaux d'effort appartiennent à l'adaptateur.** `reasoning_effort` est « adapter-owned » : les
  quatre niveaux `none`/`low`/`high`/`max` sont ceux de l'API DeepSeek. Anthropic expose sa propre
  échelle, dont le défaut est **`medium`** pour Opus 5.5 — ne pas recopier `max`, et lire les valeurs
  admises sur la page du modèle ou dans ce que l'adaptateur déclare, sinon la requête échoue à la
  validation avant tout appel réseau.
- **Le ledger de budget (M4) cesse d'être optionnel.** Aujourd'hui une erreur coûte des centimes ; sur
  un modèle « très puissant, très cher », une boucle de vérification de dix minutes coûte l'équivalent
  d'une campagne entière. Sans plafond dur par tâche utilisateur, l'escalade devient un risque
  financier et non une optimisation.
- **La politique d'escalade doit nommer la route — et seulement quand elle existe.** Le modèle ne peut
  pas deviner qu'une route plus chère est disponible : il faut lui écrire *quand* y aller (échec répété,
  diagnostics joints) — c'est l'axe 3 révisé. À ajouter **avec le vrai nom de route**, jamais avant :
  une consigne citant une route inexistante ferait perdre un tour à chaque délégation.

**Sans effet** : le piège `user_id`/KVCache de l'annexe B ne s'applique pas — un fournisseur distinct a
son propre cache, l'isolation est naturelle entre fournisseurs.

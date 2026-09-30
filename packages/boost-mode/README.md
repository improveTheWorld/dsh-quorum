# Boost — mode de raisonnement profond multi-agents pour DeepSeek Harness

`@local/dsh-boost-mode` est un **bundle de preset déclaratif** (DSH ≥ 0.1.6). Il ajoute un 5ᵉ mode
sélectionnable à côté de `standard`, `ptc`, `minimal` et `cordis` (creator).

## Ce que fait le mode

Un pipeline de raisonnement en trois phases, calqué sur le `/boost` de Google Antigravity :

1. **Stratégie** — l'orchestrateur inspecte le workspace, décompose en sous-tâches vérifiables et
   écrit *avant* de déléguer le critère d'acceptation qu'il exécutera lui-même.
2. **Exécution parallèle** — fan-out depuis un seul tour `run_code` vers des rôles isolés, puis
   travail utile de l'orchestrateur pendant que les enfants tournent.
3. **Vérification et livraison** — un vérificateur adversarial indépendant, appelé **en premier
   plan**, doit produire un verdict étayé par de la sortie brute avant que l'orchestrateur puisse
   conclure. En cas d'échec, les diagnostics repartent dans l'itération suivante (bornée à 2 tours).

## Les trois rôles

Chaque rôle est une **instance distincte** de `@deepseek-ai/dsh-tool-subagent` (c'est le seul
mécanisme de spécialisation : `persona`, `toolFilter` et `maxDepth` sont figés par instance).

| Outil | Rôle | Écriture | Délégation | Shell |
|---|---|---|---|---|
| `subagent_investigate` | DeepInvestigator : hypothèses, chaîne de preuves, éliminations | ❌ | ❌ | ✅ (observation) |
| `subagent_implement` | DeepCoder : solution candidate + ses tests, périmètre de fichiers borné | ✅ | ❌ | ✅ |
| `subagent_verify` | Vérificateur adversarial : falsifier, pas confirmer | ❌ | ❌ | ✅ (suite réelle) |
| `subagent` / `subagent_fork` | Fan-out générique / continuation d'une conversation | ✅ | — | ✅ |

## PTC pour l'orchestrateur **et** ses sous-agents

Le preset déclare `@deepseek-ai/dsh-agent-tool-presentation` avec `mode: ptc`. Deux propriétés de DSH
rendent l'héritage gratuit :

- la présentation est fixée **pour toute la portée du preset** ;
- `dsh-subagent` joint chaque enfant à la **révision exacte du preset de son parent**
  (`composeFrom`) — il n'existe aucun moyen de nommer un preset pour un enfant.

Conséquence : l'orchestrateur et tous ses sous-agents voient `run_code` + le SDK TypeScript généré, et
aucun schéma d'outil natif. Ajouter un rôle coûte donc très peu de catalogue.

## Installation

```
plugin_manager { action: "install_bundle", target: "C:\\CodeSource\\dsh-boost-mode" }
```

Puis, dans le Web GUI : **Settings → Agent Presets**, choisir **Boost** pour la prochaine session
(le sélecteur lit `agentPresets.list`, aucun code client n'est nécessaire).

## Réglages recommandés

- **Concurrence** : `ctx.subagents.maxActiveSubagents` vaut 8 par défaut. Pour du fan-out type boost,
  monter à 12–16 via le réglage host `subagent.maxActiveSubagents`. Ce n'est pas un réglage du preset.
- **Profondeur** : `maxDepth` est volontairement omis sur toutes les lignes de délégation ; il retombe
  donc sur le réglage host `subagent.maxDepth` (1 par défaut), ce qui interdit déjà à un worker de
  déléguer à son tour. Nommer le champ exigerait que le provider déclare la capacité `depthLimit`.
- **Effort de raisonnement** : les rôles héritent de la route de la session (v1). Pour un modèle
  dédié par rôle, ajouter des `agentOptions {provider, model, reasoningEffort}` sur les lignes
  `tool-subagent-investigate` / `-implement` / `-verify`. Attention : un id de modèle inconnu fait
  échouer la délégation au premier appel — valider contre le catalogue `list_subagent_models`.

## Limites connues

- **`toolFilter` = confinement, pas sandbox.** Un vérificateur garde le shell parce qu'il doit lancer
  la vraie suite de tests ; il peut donc *techniquement* écrire via une commande. Les outils
  `write`/`edit` lui sont retirés structurellement, le reste relève de sa persona.
- **Noms de `toolFilter`** : `tools.restrict()` rejette tout nom inconnu en levant une erreur. Les
  listes de ce preset ne contiennent que des noms réellement montés **sur Windows**. Sur POSIX, la
  ligne `tool-pwsh` est désactivée et `bash` monte à sa place — mais comme aucun filtre ne nomme de
  shell, le preset reste portable en l'état.
- **Pas d'isolation par worktree** : contrairement à Antigravity, DSH n'offre pas de worktrees
  éphémères par sous-agent. Donner à chaque `subagent_implement` un jeu de fichiers disjoint est donc
  une discipline de protocole, pas une garantie du runtime.
- **`workflow` et `ralph` désactivés** en v1 : en PTC, le fan-out s'écrit directement dans `run_code`.
  À réévaluer par A/B (jalon M5 de `PLAN.md`).
- **Présentation unique** : une seule ligne `tool-presentation` par composition ; en ajouter une
  seconde est refusé, pas fusionné. Si votre déploiement ne compose pas de runtime PTC, ce preset
  refuse de monter en nommant la ligne fautive.

## Traces et diagnostic

**Aucune instrumentation n'est embarquée dans le preset, volontairement.** DSH journalise déjà tout ce
qu'il faut, y compris **une session par sous-agent** : `tool/call` avec les arguments complets (donc le
brief de délégation et `run_in_background`), `tool/result` avec le marqueur d'erreur du runtime,
`usage` par étape, le catalogue d'outils envoyé à chaque requête, et l'arbre de délégation via
`parentSession` / `subagent/descriptor`. Ajouter un second chemin de logs aurait dupliqué cette source
et l'aurait laissée dériver.

Ce qui manquait, c'est de savoir **lire** ces fichiers. `tools/` comble ce trou — ces scripts
vivent à la **racine du dépôt** `dsh-boost/`, pas dans ce paquet : ils lisent des journaux de session,
jamais ce preset. Les commandes ci-dessous se lancent depuis cette racine.

```
node tools/boost-report.mjs                       # session la plus récente hors session courante
node tools/boost-report.mjs --session <id>        # session exacte (le plus fiable)
node tools/boost-report.mjs --list                # sessions candidates
node tools/boost-report.mjs --out r.txt --json-out r.json
node tools/boost-report.mjs --briefs --brief-chars 600 --max-errors 40
```

Le rapport contient : l'arbre de délégation (rôle, label, modèle, durée, tokens, issue par session),
les délégations dans l'ordre avec la taille des briefs et le `run_in_background` demandé, les
programmes `run_code` exécutés avec les rôles cités, neuf contrôles de santé, les erreurs d'outil
(signal explicite), les anomalies (codes de sortie, échecs PTC) et la réponse finale de chaque session.

### Trois pièges que ces outils contournent

1. **Le log n'est pas un flux zstd unique.** DSH ajoute une frame indépendante par flush : un fichier
   de 317 Ko contient 148 frames. `zstdDecompressSync` **et** `createZstdDecompress` s'arrêtent à la
   première frame (vérifié : 267 octets lus sur 1,3 Mo). `tools/session-log.mjs` découpe sur le magic
   `28 B5 2F FD` puis inflate chaque frame ; une frame candidate qui échoue est fusionnée avec la
   suivante plutôt que perdue.
2. **`agentPreset` dans l'en-tête peut être périmé.** Il enregistre le preset de *création* ; un
   changement de preset sur une session encore vierge modifie la composition sans réécrire l'en-tête
   (`dsh-subagent/lib/types/child-agent.js` documente ce cas). Constaté en vrai : en-tête `standard`,
   composition `cordis`. Le rapport déduit donc le **preset vivant** des en-têtes enfants — écrits
   depuis la portée vivante du parent — et affiche l'écart.
3. **En PTC, les appels de rôle peuvent n'exister que dans le code.** Seul `run_code` est appelable
   directement ; le rapport analyse donc aussi le texte des programmes exécutés (rôles cités,
   `await` sur le vérificateur, `run_in_background: false`) pour ne pas conclure à l'absence de
   vérification à tort.

### Outils annexes

```
node tools/dump-records.mjs <session-id|dir>   # schéma : types d'enregistrements + échantillons
node tools/diagnose-frames.mjs <fichier.zstd>  # framing : nombre de frames, tailles, décodage
```

### Autres canaux d'observation déjà présents dans DSH

- panneau **subagent** et vue **trajectory** du Web GUI ;
- `session-log-download` (export du log d'une session) et `dsh-session-stats` ;
- `plugin_manager` → `@local/dsh-boost-mode` pour vérifier que le preset est `active`.

## Fichiers

- `cordis.patch.yml` — la déclaration `preset-boost` (composition complète).
- `lib/index.js` — volontairement vide ; ce bundle ne publie aucune API runtime.
- `README.md` — cette page.

Les scripts d'analyse (`tools/`), la conception (`docs/PLAN.md`), le protocole
(`docs/PROTOCOL.md`) et la passation (`docs/HANDOVER.md`) vivent à la **racine du dépôt**
`dsh-boost/`, aux côtés des quatre autres paquets du mode Boost.

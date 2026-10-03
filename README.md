# dsh-boost — le bundle agrégateur du mode Quorum

**Le mode Quorum** est une famille de **trois** presets d'agent DSH pour le raisonnement profond multi-agents : un orchestrateur décompose la demande, délègue à des sous-agents **isolés par rôle** (`subagent_investigate`, `subagent_implement`, `subagent_verify`) et ne livre rien avant qu'un vérificateur indépendant ait essayé de falsifier le résultat. Les trois presets ne diffèrent que par la **présentation des outils** : `preset-quorum-ptc` en **PTC** (*Programmatic Tool Calling* : l'agent écrit un programme TypeScript qui appelle les outils), `preset-quorum-standard` en appels d'outils **natifs**, `preset-quorum-minimal` sur le **socle nu**. Le mode s'ajoute aux presets livrés (`standard`,
`ptc`, `minimal`, `cordis`) et se choisit dans *Settings → Agent Presets*.

Ce dépôt **consolide les sources et la documentation du mode Quorum** en un seul endroit, et publie
**un livrable installable** : le paquet racine `@local/dsh-boost`, une couche bundle DSH qui monte les
**huit** lignes du mode depuis un unique `cordis.patch.yml` — **une** entrée `insert:` portant les huit
lignes. Les cinq paquets d'origine vivent sous `packages/`, rejoints par les trois paquets ajoutés
depuis (`boost-channel`, `boost-context-budget`, `boost-lessons`) ; les huit portent chacun son propre
`cordis.patch.yml`, son `dsh.bundle` et ses tests : chacun reste installable seul. L'agrégateur est le
livrable **recommandé**, pas le seul possible — et les deux formes **s'excluent** (section suivante).

> **Pour reprendre dans une session neuve** : [`docs/REPRISE.md`](docs/REPRISE.md) — ce qu'il faut
> faire en premier, ce qui est vérifié, et les pièges qui ont coûté du temps.

## Installer, pas à pas

### 1. Installer le bundle

```powershell
dsh plugin --profile <profil> add C:\CodeSource\dsh-boost
```

- **Le chemin doit être ABSOLU.** Un chemin relatif est refusé.
- Le gestionnaire exécute `pnpm add <spec>` (ce qui écrit `dependencies`) puis ajoute le nom du paquet
  **en queue de `dsh.profile.bundles`**. Pour un chemin local, le registre npm n'est **jamais**
  interrogé.
- Mesure sur cette machine (`--profile boost-test`) : exit 0, `dependencies` porte
  `"@local/dsh-boost": "link:C:/CodeSource/dsh-boost"`, la jonction
  `profiles\boost-test\node_modules\@local\dsh-boost` est créée (type `Junction`, cible
  `C:\CodeSource\dsh-boost`), et `bundles` se termine par `@local/dsh-boost`.

### 2. Le piège `pnpm` — mesuré, et il arrête l'installation entière

Sur cette machine, le `pnpm` du PATH est le shim **nvm**
(`C:\Users\bilel\AppData\Local\Author Software\nvm\.nodejs\pnpm.exe`) et il échoue :

```
pnpm.exe : No active Node.js version is configured. Run `nvm install <version>` then `nvm use <version>`.
```

Contournement **mesuré** : mettre **corepack** en tête de PATH **pour la commande** (`pnpm` 12.6.0
depuis ce shim), puis installer :

```powershell
$env:PATH = 'C:\Program Files\nodejs\node_modules\corepack\shims;' + $env:PATH
dsh plugin --profile <profil> add C:\CodeSource\dsh-boost
```

**Le contournement `pnpmCommand` du profil ne s'applique pas ici.** Le profil réel porte, dans son
`cordis.patch.yml` (`~/.dsh/profiles/web/cordis.patch.yml:23-32`), un
`plugin-manager: config: pnpmCommand` qui pointe sur ce même shim corepack. Ce réglage n'est lu que par
le **gestionnaire composé** — l'interface et l'outil agent `plugin_manager`. **Le chemin CLI ne le lit
pas** : mesuré, `dsh plugin --profile web list` échoue avec le même message nvm et rend
`dsh: plugin command failed; diagnostics: …\.plugin-manager\logs\operation-uXxp84\pnpm.log`. C'est
pourquoi l'étape 1 a besoin du PATH corrigé, alors que l'étape 3 n'en a pas besoin.

### 3. Si le CLI échoue : installer depuis l'interface, ou par l'outil agent

Les deux passent par le gestionnaire **composé**, donc par `pnpmCommand` :

- **Interface** : le gestionnaire de bundles du profil (le service `plugin_manager`), cible
  `C:\CodeSource\dsh-boost`.
- **Outil agent** (PTC) :
  `plugin_manager { action: "install_bundle", target: "C:\\CodeSource\\dsh-boost" }`.

### 4. Vérifier l'installation

```powershell
dsh --profile <profil> --dump-config
```

Attendu : les ids du mode, **chacun exactement une fois** — les **trois** presets de la famille `quorum` (`preset-quorum-ptc` en PTC, `preset-quorum-standard` en outils natifs, `preset-quorum-minimal` sur le socle nu), puis `boost-job-relay`, `boost-status-command`, `dsh-detached-jobs`, `dsh-guard-surrogate`,
`dsh-boost-channel`, `dsh-boost-context-budget`, `dsh-boost-lessons`. Mesure du **2026-10-03** : sur
`boost-test` **2999** lignes composées et les **dix** compteurs à **1** (sur `web` : **3048** lignes et
les **dix** compteurs à **1**). Un id à **2** est le symptôme de l'exclusion mutuelle violée (section
suivante) ; un id à **0** veut dire que la ligne n'est pas montée.

### 5. Choisir le preset

*Settings → Agent Presets* → l'un des trois presets de la famille **Quorum** (`preset-quorum-ptc`, `preset-quorum-standard`, `preset-quorum-shell`), pour la prochaine session.

Un bundle **nouveau** s'active à chaud (ses lignes hôte montent sans redémarrage) ; **éditer** le patch
d'un bundle déjà chargé n'est pas relu à chaud — `dsh-hmr` ne surveille que trois chemins (voir
`docs/HANDOVER.md` §11), donc un patch de bundle modifié seul attend le prochain démarrage.

## Ne jamais installer l'agrégateur ET les sous-paquets

> `dsh-app-boot/lib/index.js:87` fait `data.push(...insert)` **sans déduplication** : deux bundles qui
> insèrent le même `id` montent la ligne **deux fois** — preset monté deux fois, outil dupliqué.

Les deux formes s'excluent donc :

- **agrégateur** : `dsh.profile.bundles` porte `@local/dsh-boost` (et rien des huit) ;
- **sous-paquets** : il porte les huit noms (`@local/dsh-boost-mode`, `@local/dsh-boost-relay`,
  `@local/dsh-boost-status`, `@local/dsh-detached-jobs`, `@local/dsh-guard-surrogate`,
  `@local/dsh-boost-channel`, `@local/dsh-boost-context-budget`, `@local/dsh-boost-lessons`) et **pas**
  l'agrégateur.

`test/aggregate.test.mjs` défend l'invariant côté sources : si un id dérivait d'un sous-paquet, le test
échoue au lieu de monter une ligne périmée.

## Les paquets

| Nom | Rôle | Cas de test | Invocation |
|---|---|---|---|
| `@local/dsh-boost-mode`<br>`packages/boost-mode/` | Déclare les **trois presets d'agent** de la famille `quorum` — `preset-quorum-ptc` (PTC), `preset-quorum-standard` (outils natifs), `preset-quorum-minimal` (socle nu) : protocole en trois phases, persona de l'orchestrateur, et trois outils de délégation isolés par rôle. Le `name` de cette ligne est un nom de paquet npm (`@deepseek-ai/dsh-agent-preset`), pas un fichier. | **aucun** — la ligne est un patch de preset, il n'y a pas de suite (0 cas) | `cd packages\boost-mode` puis `node --test` |
| `@local/dsh-boost-relay`<br>`packages/boost-relay/` | Relais **hôte** : remonte au propriétaire d'un arbre les *settlements* des jobs lancés à l'intérieur de ses sous-agents (angle mort du registre, dont la propriété est clôturée par l'id de session propriétaire). | **14/14** — `test/notice.test.mjs` 5, `test/journal.test.mjs` 9 | `cd packages\boost-relay` puis `node --test` |
| `@local/dsh-boost-status`<br>`packages/boost-status/` | Commande **hôte** `/boost-status` : l'état de délégation vivant d'une session, lu sur le plan de commande de l'UI — donc **elle répond même pendant qu'un appel d'outil est en vol**. | **10/10** — `test/status.test.mjs` | `cd packages\boost-status` puis `node --test` |
| `@local/dsh-detached-jobs`<br>`packages/detached-jobs/` | Ajoute `run_detached` : un job d'arrière-plan possédé par la **racine** de session et non par l'agent demandeur, donc qui survit à un worker jetable. Ligne **hôte** : c'est la seule portée non scopée qui peut posséder un job au nom de la racine. | **56/56** — `test/root.test.mjs` 10 (propriété), `apply` 19 (activation, contexte strict), `shell` 8, `spill` 9, `purge` 10 | `cd packages\detached-jobs` puis `node --test` ; sondes : `node tools\probe-profile-import.mjs` (résolution par la jonction) et `node tools\probe-spill-announce.mjs` (annonce par le vrai registre) |
| `@local/dsh-guard-surrogate`<br>`packages/guard-surrogate/` | Répare les **surrogates UTF-16 non appariés** dans les résultats d'outil, sur le waterfall `tools/post-execute`, **avant** l'écriture au journal : un seul surrogate isolé empoisonne toutes les requêtes suivantes en `HTTP 400 INVALID_REQUEST`. | **26/26** — `test/guard.test.mjs` | `cd packages\guard-surrogate` puis `node --test` |
| `@local/dsh-boost-channel`<br>`packages/boost-channel/` | Canal de **retour** entre un enfant et le propriétaire de son arbre : une **enveloppe structurée** (jamais la charge utile), un `kind` **déclaré** par l'appelant et un `state` **dérivé** par le runtime, le réveil **décidé à l'arrêt** de l'émetteur (au dépôt, l'émetteur travaille encore), un jeton de livraison à **deux bourses** et la politique du destinataire (`channel_subscribe`). Ligne **hôte** : elle capture le service `agents` non scopé et installe ses outils dans la surface de **chaque** agent. | **52/52** — `test/channel.test.mjs`, dont quatre cas de falsification | `cd packages\boost-channel` puis `node --test` ; sondes : `node tools\probe-stop.mjs` (quel événement marque l'arrêt) et `node tools\probe-mount.mjs` (la ligne hôte installée par agent) |
| `@local/dsh-boost-context-budget`<br>`packages/boost-context-budget/` | Occupation du contexte et **garde du fork** : `context_occupancy` mesure le préfixe qu'un fork hériterait par `SessionProjectionRegistry.restore(...)` **borné à la frontière** du dernier `turn/end` — égalité **prouvée contre un enfant RÉEL** à trois coupes, dont une après compaction — et `subagent_fork` est **refusé au-delà d'un seuil** configurable (`forkThresholdRatio`). Aucun repli : une mesure absente vaut `unknown` et la garde **s'abstient**. La compaction n'est **jamais** automatique : le père la **demande** (`context_compact`), et un refus n'arme rien. | **36/36** — `test/context-budget.test.mjs` | `cd packages\boost-context-budget` puis `node --test` |
| `@local/dsh-boost-lessons`<br>`packages/boost-lessons/` | **Étape 1 des leçons à la compaction** : un listener `session/event` **sans tag** qui **journalise** les compactions de **racine** — mesure de fréquence, **aucun** appel de modèle, aucun enfant, aucune surface d'outil. Dédup par `compactionId` (un enfant forké porte les mêmes ids que son père) et corps **intégralement protégé** : une erreur d'écriture est comptée et repliée, jamais propagée à `Session.append`. | **14/14** — `test/lessons.test.mjs` | `cd packages\boost-lessons` puis `node --test` ; sonde : `node tools\probe-lessons.mjs` |

Compteurs mesurés le **2026-10-02** sur ce disque, paquet par paquet (`node --test` dans chaque
`packages/<paquet>`), puis recomposés par le run racine : les cinq premiers sont les paquets
d'origine, les trois derniers les ajouts.

## Le patch agrégateur

`cordis.patch.yml` (racine) contient **UNE** entrée `insert:` dont la valeur est la **liste des huit
lignes**, recopiées à l'identique depuis les huit patches d'origine — mêmes `id`, mêmes `name`, mêmes
`config`.

Un seul écart, imposé par le chargeur : le `name` d'une ligne est résolu **relativement au fichier de
patch**. Depuis la racine, les sept lignes fichier portent donc `./packages/<paquet>/lib/index.js` au
lieu de `./lib/index.js`. Les lignes `preset-quorum-ptc`, `preset-quorum-standard` et `preset-quorum-minimal` gardent leur nom de paquet npm.

`test/aggregate.test.mjs` **exige** cette égalité et échoue à la moindre dérive : ids identiques,
`config` identiques (comparés en JSON canonique), `name` résolvant vers le **même module** que dans le
sous-paquet, aucun id dupliqué.

## Où sont les docs, et laquelle lire

| Document | À lire quand… |
|---|---|
| `README.md` (cette page) | on installe, ou on veut la carte des paquets |
| `docs/HANDOVER.md` | **l'état fait foi ici** : ce qui est acquis et vérifié, les recettes de contrôle (§4-§5), l'inventaire (§7), les faits du harnais à ne pas redécouvrir (§8), ce qui reste ouvert (§9), le plantage surrogate (§10) et **la procédure de coupure (§11)** |
| `docs/PROTOCOL.md` | on veut **mesurer** le mode : le protocole des trois phases, le prompt de mission de torture, et les règles de recevabilité d'une preuve |
| `docs/PLAN.md` | on cherche la **conception d'origine** et les jalons M0-M5. **Document historique** : il contient une copie du patch qui a divergé et des affirmations périmées, marquées comme telles ; il ne décrit pas l'état courant |
| `packages/<paquet>/README.md` | on travaille sur **un** paquet : ses limites connues et ses réglages |
| `tools/` | on doit **lire un journal de session** : décodage zstd multi-frame, rapport de run, audit, notation de protocole, recherche de texte, intégrité |

```powershell
node tools/boost-report.mjs                     # session la plus récente
node tools/boost-report.mjs --list              # sessions candidates
node tools/boost-report.mjs --session <id>      # session exacte
```

## Tests

```powershell
node --test                                  # racine                    231/231
node --test test/aggregate.test.mjs          # racine (anti-dérive)         5/5
node --test tools/tests.test.mjs             # racine (lecteur de logs)    22/22
```

Puis, **le répertoire du paquet comme dossier courant** :

```powershell
cd packages\boost-relay;          node --test   # 20/20
cd packages\boost-status;         node --test   # 10/10
cd packages\detached-jobs;        node --test   # 61/61
cd packages\guard-surrogate;      node --test   # 26/26
cd packages\boost-channel;        node --test   # 57/57
cd packages\boost-context-budget; node --test   # 36/36
cd packages\boost-lessons;        node --test   # 19/19
cd packages\boost-mode;           node --test   #  0/0   (aucun cas : vert vacant)
```

`node --test` **sans argument** découvre les huit suites, l'anti-dérive et le lecteur de journaux :
**231** cas, mesurés le 2026-10-02 — 5 (anti-dérive) + 22 (lecteur de journaux) + 14 (`boost-relay`) +
10 (`boost-status`) + 56 (`detached-jobs`) + 26 (`guard-surrogate`) + 52 (`boost-channel`) + 32
(`boost-context-budget`) + 14 (`boost-lessons`) + 0 (`boost-mode`). La somme se recompose donc à partir
des compteurs de la table ci-dessus. **Ne pas** écrire `node --test test/` : le dossier en argument
échoue en `MODULE_NOT_FOUND`.

Un `0/0` se lit « non déclenché », pas « vérifié » : `packages/boost-mode` n'embarque aucune suite.

Le test anti-dérive doit pouvoir **échouer**. Recette de falsification :

```powershell
Copy-Item -Recurse C:\CodeSource\dsh-boost $env:TEMP\dsh-boost-falsify
# renommer un id dans la copie jetable, par ex. boost-job-relay
node --test $env:TEMP\dsh-boost-falsify\test\aggregate.test.mjs
```

## Arborescence

```
dsh-boost/
  package.json          le bundle agrégateur (@local/dsh-boost, dsh.bundle.patch)
  cordis.patch.yml      UNE entrée insert: portant les dix lignes
  index.js              entry point du bundle (aucune API runtime)
  README.md             cette page
  docs/                 HANDOVER.md, PLAN.md, PROTOCOL.md
  tools/                analyse des journaux de session
  packages/
    boost-mode/           preset-quorum-ptc        (@local/dsh-boost-mode)
                          preset-quorum-standard
                          preset-quorum-shell
    boost-relay/          boost-job-relay          (@local/dsh-boost-relay)
    boost-status/         boost-status-command     (@local/dsh-boost-status)
    detached-jobs/        dsh-detached-jobs        (@local/dsh-detached-jobs)
    guard-surrogate/      dsh-guard-surrogate      (@local/dsh-guard-surrogate)
    boost-channel/        dsh-boost-channel        (@local/dsh-boost-channel)
    boost-context-budget/ dsh-boost-context-budget (@local/dsh-boost-context-budget)
    boost-lessons/        dsh-boost-lessons        (@local/dsh-boost-lessons)
  test/
    aggregate.test.mjs  le test anti-dérive
```

# dsh-boost — le bundle agrégateur du mode Boost

Ce dépôt consolide **les sources et la documentation du mode Boost** en un seul
endroit, et publie **un livrable installable** : le paquet racine
`@local/dsh-boost`, une couche bundle DSH qui monte les cinq lignes du mode
depuis un seul `cordis.patch.yml`.

Les cinq paquets d'origine restent dans `packages/` avec **leur propre
`cordis.patch.yml` et leur champ `dsh.bundle`** : chacun reste installable
seul. L'agrégateur est le livrable **recommandé**, pas le seul possible.

## Installer

```
dsh plugin --profile web add C:\CodeSource\dsh-boost
```

- **Chemin absolu obligatoire.** Un chemin relatif est refusé.
- Le gestionnaire exécute `pnpm add <spec>` (ce qui écrit `dependencies`) puis
  ajoute le nom du paquet **en queue de `dsh.profile.bundles`**. Pour un chemin
  local, le registre npm n'est **jamais** interrogé.
- Forme outil équivalente :
  `plugin_manager { action: "install_bundle", target: "C:\\CodeSource\\dsh-boost" }`.

Un bundle **nouveau** s'active à chaud (ses lignes hôte montent sans
redémarrage) ; **éditer** le patch d'un bundle déjà chargé exige un
redémarrage — et une ligne de preset ajoutée à un patch existant n'est pas
relue à chaud.

> **Ne pas installer l'agrégateur ET les sous-paquets.** `dsh-app-boot/lib/index.js:87`
> fait `data.push(...insert)` **sans déduplication** : deux bundles insérant le
> même `id` montent la ligne **deux fois**. Les deux formes s'excluent.

Après installation, choisir le preset **Boost** dans *Settings → Agent Presets*
pour la prochaine session.

## Ce que fait chaque paquet

| Dossier | Paquet | Ligne insérée | Ce qu'elle fait |
|---|---|---|---|
| `packages/boost-mode/` | `@local/dsh-boost-mode` | `preset-boost` | Déclare le **preset d'agent** `boost` : protocole en trois phases, trois outils de délégation isolés par rôle (`subagent_investigate`, `subagent_implement`, `subagent_verify`), et **PTC** pour l'orchestrateur comme pour ses enfants. Le `name` de cette ligne est un nom de paquet npm (`@deepseek-ai/dsh-agent-preset`), pas un fichier. |
| `packages/boost-relay/` | `@local/dsh-boost-relay` | `boost-job-relay` | Relais **hôte** : remonte au propriétaire d'un arbre les *settlements* des jobs lancés à l'intérieur de ses sous-agents (angle mort du registre, dont la propriété est clôturée par l'id de session propriétaire). |
| `packages/boost-status/` | `@local/dsh-boost-status` | `boost-status-command` | Commande **hôte** `/boost-status` : l'état de délégation vivant d'une session, lu sur le plan de commande de l'UI — donc **elle répond même pendant qu'un appel d'outil est en vol**. |
| `packages/detached-jobs/` | `@local/dsh-detached-jobs` | `dsh-detached-jobs` | Ajoute `run_detached` : un job d'arrière-plan possédé par la **racine** de session et non par l'agent demandeur, donc qui survit à un worker jetable. Ligne **hôte** : c'est la seule portée non scopée qui peut posséder un job au nom de la racine. |
| `packages/guard-surrogate/` | `@local/dsh-guard-surrogate` | `dsh-guard-surrogate` | Répare les **surrogates UTF-16 non appariés** dans les résultats d'outil, sur le waterfall `tools/post-execute`, **avant** l'écriture au journal : un seul surrogate isolé empoisonne toutes les requêtes suivantes en `HTTP 400 INVALID_REQUEST`. |

## Le patch agrégateur

`cordis.patch.yml` (racine) contient **UNE** entrée `insert:` dont la valeur est
la **liste des cinq lignes**, recopiées à l'identique depuis les cinq patches
d'origine — mêmes `id`, mêmes `name`, mêmes `config`.

Un seul écart, imposé par le chargeur : le `name` d'une ligne est résolu
**relativement au fichier de patch**. Depuis la racine, les quatre lignes
fichier portent donc `./packages/<paquet>/lib/index.js` au lieu de
`./lib/index.js`. La ligne `preset-boost` garde son nom de paquet npm.

`test/aggregate.test.mjs` **exige** cette égalité et échoue à la moindre
dérive : ids identiques, `config` identiques (comparés en JSON canonique),
`name` résolvant vers le **même module** que dans le sous-paquet, aucun id
dupliqué.

## Où sont les docs

- `docs/HANDOVER.md` — état, décisions prises et passation.
- `docs/PLAN.md` — conception, faits DSH vérifiés, jalons M0–M5.
- `docs/PROTOCOL.md` — le protocole des trois phases dans le détail.
- `README.md` de chaque sous-paquet — le paquet lui-même (limites connues,
  réglages recommandés).
- `tools/` — les douze scripts d'analyse des journaux de session. Aucune
  instrumentation n'est embarquée dans le preset : DSH journalise déjà tout, et
  `tools/` est ce qui sait **lire** ces fichiers.

```
node tools/boost-report.mjs                     # session la plus récente
node tools/boost-report.mjs --list              # sessions candidates
node tools/boost-report.mjs --session <id>      # session exacte
```

## Tests

```
node --test                                  # racine                    118/118
node --test test/aggregate.test.mjs          # racine (anti-dérive)         4/4
node --test tools/tests.test.mjs             # racine (lecteur de logs)    22/22
```

Puis, **le répertoire du paquet comme dossier courant** :

```
node --test     # packages/boost-relay         14/14
node --test     # packages/detached-jobs       52/52
node --test     # packages/guard-surrogate     26/26
node --test     # packages/boost-status         0/0   (aucun cas : vert vacant)
```

`node --test` **sans argument** à la racine découvre les cinq suites plus
l'anti-dérive : 118 cas. `packages/boost-status` n'embarque aucun test — sa
suite est vide, et `0/0` se lit comme « non déclenché », pas comme « vérifié ».

Le test anti-dérive doit pouvoir **échouer**. Recette de falsification :

```
Copy-Item -Recurse C:\CodeSource\dsh-boost $env:TEMP\dsh-boost-falsify
# renommer un id dans la copie jetable, par ex. boost-job-relay
node --test $env:TEMP\dsh-boost-falsify\test\aggregate.test.mjs
```

## Arborescence

```
dsh-boost/
  package.json          le bundle agrégateur (@local/dsh-boost, dsh.bundle.patch)
  cordis.patch.yml      UNE entrée insert: portant les cinq lignes
  index.js              entry point du bundle (aucune API runtime)
  README.md             cette page
  .gitignore
  docs/                 HANDOVER.md, PLAN.md, PROTOCOL.md
  tools/                les douze scripts d'analyse de journaux
  packages/
    boost-mode/         preset-boost      (@local/dsh-boost-mode)
    boost-relay/        boost-job-relay   (@local/dsh-boost-relay)
    boost-status/       boost-status-command (@local/dsh-boost-status)
    detached-jobs/      dsh-detached-jobs (@local/dsh-detached-jobs)
    guard-surrogate/    dsh-guard-surrogate (@local/dsh-guard-surrogate)
  test/
    aggregate.test.mjs  le test anti-dérive
```

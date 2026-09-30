# `@local/dsh-detached-jobs`

Ajoute l'outil `run_detached` : un job d'arrière-plan **possédé par la session RACINE** plutôt que par
l'agent qui l'a demandé, de sorte qu'un job qu'un worker one-shot laisse derrière lui **survit** au lieu
d'être détruit avec lui, et que la racine puisse le lire.

## Le problème, mesuré

Un job est une ressource possédée par une portée : « l'Agent vivant du propriétaire doit être celui
enregistré sous cet identifiant : sa destruction annule et attend le job »
(`dsh-jobs/lib/types/types.d.ts:122-128`). L'outil `pwsh` met ce propriétaire à l'agent **appelant**
(`dsh-tool-pwsh/lib/index.js:366-369`), donc un job lancé par un worker meurt avec le worker. Observé :

```
19:32:57 registered job=pwsh-1   <- un worker lance un job de 60 s
19:33:00 stopping   job=pwsh-1   <- le worker se règle
19:33:00 settled    job=pwsh-1   cause=teardown
19:33:00 removed    job=pwsh-1
```

Trois conséquences, toutes mauvaises : le travail n'a pas tourné, sa sortie est perdue, et
l'orchestrateur — qui croit une campagne en vol — n'est prévenu de rien et ne peut même pas lire le job
(`job_output` est clos par le propriétaire).

La cause n'est pas le teardown : cette garantie est délibérée et correcte, c'est elle qui empêche une
session morte de laisser des processus orphelins. La cause est le **choix du propriétaire** du job.

## L'outil `run_detached`

| Paramètre | Rôle |
|---|---|
| `command` (requis) | commande shell à exécuter |
| `label` | libellé du job ; défaut : les 80 premiers caractères de la commande |
| `cwd` | répertoire de travail ; défaut : le cwd de l'appelant |

Rend `{ job_id, owner, text }`, `owner` étant toujours la session racine. Le `text` s'adresse à
l'appelant : à la racine il dit que le job se lit avec `job_output` (`wait: true` bloque jusqu'au
règlement) ; à un worker il dit que le job **n'est pas** lisible depuis sa session et qu'il faut rendre
l'identifiant au propriétaire.

### Ce qui le distingue

**1. Propriété RACINE, résolue par les en-têtes durables.** La racine est trouvée en remontant
`parentSession` dans les en-têtes de session écrits sur disque, 16 sauts au maximum (une chaîne
malformée ne peut donc pas bloquer l'hôte). C'est la seule source qui a répondu correctement à chaque
fois : `ctx.agents.list()` est intermittemment vide, `agent/created` ne rejoue jamais pour un agent
antérieur au montage, et `listDescendants` ne voit que le catalogue d'enfants délégués — donc pas un
`fork`. Si la racine ne peut pas être résolue, l'outil **refuse** (il lève) au lieu de démarrer un job au
mauvais propriétaire.

**2. Montage HÔTE et installation PAR AGENT, les deux depuis la même ligne.** Le niveau hôte est une
condition de fonctionnement : seuls les enregistrements faits depuis une portée non scopée servent
n'importe quel propriétaire (`dsh-jobs/lib/index.js:102-104`), donc `owner: <racine>` n'est accepté que
là. L'outil, lui, est installé dans la surface **de chaque agent** par l'écouteur `agent/created` et
l'injection différée de `agents` — jamais depuis la portée de cette ligne, qui atteindrait le service
`tools` sans jamais apparaître dans une surface composée (mesuré deux fois, ligne hôte et ligne de
preset ; `packages/boost-mode/cordis.patch.yml:369-384` le consigne). Un second montage ne capture ni
n'installe à nouveau : chaque étape est journalisée, y compris le saut.

**3. Fichier de récupération.** Un fichier par job :
`$DSH_HOME/plugin-data/dsh-detached-jobs/<identifiant>-<3 octets aléatoires>.log`, plafond **32 MiB**.
Le fichier garde la **tête** du flux et l'anneau du registre garde la **fin** : l'éviction ne retire que
les octets les plus anciens, et le plafond annonce la coupe *dans* le fichier. Le jeton aléatoire supprime
une collision mesurée — `pwsh-1` est un compteur par processus et le fichier était ouvert `'w'` : après un
redémarrage, un nouveau `pwsh-1` tronquait le fichier qu'une session plus ancienne citait encore.
Un fichier **plafonné** est **retiré de l'annonce** : il ne doit jamais être présenté comme le flux
complet. La source pull `output: [recoverySource]` n'existe que pour que le registre remplisse
`job.spillPaths[]` — le pump n'existe que si `spec.output` est un tableau **non vide**
(`dsh-jobs-local/lib/index.js:479-485`) — sans quoi le harnais annonce `full output: (unavailable)` alors
que le fichier complet est sur le disque. Son `text` est toujours vide : l'anneau n'est jamais touché.

**4. Livraison unique.** Le producteur pousse chaque morceau dans l'anneau *et* le registre délivre un
`result` terminal unique : les deux à la fois, c'est la sortie livrée **deux fois** — mesuré, un job de
3000 lignes (~219 Ko) relu à 436 Ko, la ligne de pointeur enterrée au milieu de son propre flux. Donc
`result` n'est que le repli d'un magasin dégradé : avec un fichier sur le disque, le lecteur a la sortie
complète par construction.

**5. Purge.** La passe de rétention tourne **au démarrage d'un job**, avant que le sien n'arrive dans le
magasin. Trois nombres, fixés dans le code plutôt que configurables : TTL **7 jours** (sur le mtime,
jamais sur le nom — les identifiants comme `pwsh-1` se répètent d'une session à l'autre), plafond de
**20 fichiers** `*.log` du répertoire seulement (pas de récursion, pas d'autre nom), et plancher de
**60 minutes** : un fichier plus jeune n'est **jamais** retiré, plafond ou pas — c'est le fichier d'un job
en cours d'écriture, celui dont la perte compterait. Le fichier du job courant est `except`. Toute erreur
d'E/S est avalée et le verdict reste honnête : un chemin n'entre dans `removed` qu'une fois `unlinkSync`
réellement revenu.

### Limites, écrites ici pour être lues

- la purge ne tourne **qu'au démarrage d'un job** : un hôte qui ne lance plus jamais de job détaché garde
  sa résiduelle. Aucun timer et aucun travail d'arrière-plan ne sont possédés par ce module,
  volontairement ;
- un fichier plafonné n'est jamais annoncé : un tel job rapporte `full output: (unavailable)` — dégradé,
  et honnête à ce sujet.

## La commande `/detached-jobs`

Le même montage hôte enregistre, en différé (`ctx.inject(['commands'], …)`, `lib/index.js:693-720`), la
commande qui dit l'état du lanceur :

```
/detached-jobs
```

Quatre lignes : l'en-tête, si le service non scopé a été capturé, par quel montage (`config.share` ou
« premier montage »), et que `run_detached` est installé par agent depuis **ce** montage hôte, jamais
déclaré depuis la portée d'une ligne (`lib/index.js:722-724`).

## Tests — 52 cas

```
cd packages/detached-jobs
node --test
```

**`node --test` sans argument**, impérativement : le runner découvre alors `test/*.test.mjs`.

```
1..52
# tests 52
# suites 0
# pass 52
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

**Le piège : `node --test test/` échoue.** Node prend `test/` pour le spécificateur d'un module au lieu de
découvrir un dossier : `MODULE_NOT_FOUND`, un unique « test » (le chargeur lui-même) et `fail 1`.

```
> node --test test/
# Error: Cannot find module '<dossier>\test'
#   code: 'MODULE_NOT_FOUND'
1..1
# tests 1
# fail 1
```

Nommer un **fichier** fonctionne : `node --test test/root.test.mjs` rend `# tests 10`, `# pass 10`,
`# fail 0`.

| Fichier | Cas | Ce qu'ils décident |
|---|---|---|
| `test/root.test.mjs` | 10 | la résolution de la racine : un saut, une chaîne multi-sauts, un **fork** (`origin` absent, `delegationDepth` 0, mais `parentSession` posé — le cas qui avait vaincu `listDescendants`), un lien parent pendant (rendu, pas supprimé), un cycle borné, une queue de frame tronquée, un log de zéro octet, le chemin de cache |
| `test/apply.test.mjs` | 15 | le montage : contexte strict, journal du montage et de la capture, outil installé par `agent/created` **et** pour un agent déjà présent, contrat `output` du registre (son absence est une ligne `register-failed`), job possédé par la **RACINE** et jamais par le worker appelant, ce que le `text` dit à une racine, refus quand la racine est introuvable, refus quand aucun service non scopé n'a été capturé (pas de repli silencieux), second montage inerte, `apply-failed` journalisé sans rethrow, journal non inscriptible inoffensif, source pull qui ne rend jamais un octet, `pwshPath` du service `shell` suivi, repli explicite sans service `shell` |
| `test/shell.test.mjs` | 8 | l'exécutable : PowerShell 7 d'abord, repli Windows PowerShell 5.1, entrées PATH nettoyées et dé-citées, sonde d'existence (fichier ou lien, jamais un dossier), repli PATH hors Windows, le producteur lance le shell résolu, une annulation se règle en `killed` au lieu de pendre |
| `test/spill.test.mjs` | 9 | le fichier de récupération : il contient la sortie complète d'un job qui dépasse l'anneau, la ligne de pointeur y renvoie, la sortie n'est livrée qu'**une** fois, le nom vient du job et non de l'environnement, le plafond est annoncé dans le fichier, un magasin non inscriptible ne touche pas le job, deux jobs de même identifiant laissent deux fichiers, l'annonce à l'ouverture puis au règlement, le retrait d'un fichier plafonné |
| `test/purge.test.mjs` | 10 | la rétention : TTL, fichier récent gardé, `except` gardé même le plus ancien, plafond de 20, plancher d'âge, dossier absent inoffensif, entrée non supprimable rapportée `kept` sans rien arrêter, ni récursion ni autre nom que `*.log`, purge déclenchée par le démarrage d'un job, magasin illisible inoffensif |

Douze de ces cas se **sautent** d'eux-mêmes (`{ skip: … }`) quand PowerShell est absent : les neuf de
`spill.test.mjs`, les deux derniers de `purge.test.mjs` et celui de `shell.test.mjs` ; sur cet hôte le
compte rend `# skipped 0`.

## Les deux sondes

```
node tools/probe-profile-import.mjs [chemin-du-module.js]
node tools/probe-spill-announce.mjs [harness-node-modules] [entree-du-plugin]
```

Elles existent **à côté** des tests, pas à leur place. Les tests importent `../lib/index.js` et prouvent
donc le CODE ; ils ne disent rien de la **résolution** (la jonction de profil pointe-t-elle encore sur ce
checkout ?) ni de ce que le **vrai** registre fait du spec qu'on lui passe.

- `probe-profile-import.mjs` importe le module par le chemin que l'hôte résout
  (`$DSH_HOME/profiles/<profil>/node_modules/@local/dsh-detached-jobs/lib/index.js`), l'applique à une
  portée stricte au-dessus d'un magasin de sessions jetable, puis **sort non-zéro** à moins que le montage
  n'aboutisse, que l'outil n'arrive dans la surface avec son contrat `output`, qu'un job ne soit lancé
  avec `owner = session racine`, et que le journal porte `mount`, `capture`, `apply-complete` et
  `registered` sans aucun `apply-failed`. Verdict : `PASS — …` ou `FAIL — …` (code 1).
- `probe-spill-announce.mjs` monte le **vrai** `@deepseek-ai/dsh-jobs-local` sur une application cordis
  réelle, installe ce plugin par-dessus, pilote le `run_detached` installé à travers un **vrai** job
  PowerShell, attend le règlement avec le `wait()` du registre, puis lit `output.spillPaths` sur la
  projection — le champ exact que `dsh-tool-jobs` rend. Il ne sort 0 que si le chemin annoncé est non
  vide, **existe** et porte **plus de zéro octet** ; il imprime `PROBE-PASS` ou `PROBE-FAIL — …`. Son
  troisième argument permet de faire tourner une **variante** du plugin dans la même sonde — par exemple
  le `output: []` d'avant correctif — pour montrer que le verdict suit bien la ligne testée.

## Fichiers

- `lib/index.js` — résolution de la racine, producteur et fichier de récupération, rétention, outil,
  commande ;
- `cordis.patch.yml` — la ligne **hôte** (condition de fonctionnement, pas un détail de rangement) ;
- `test/*.test.mjs` — les 52 cas ; `tools/*.mjs` — les deux sondes ;
- `README.md` — cette page, listée dans `package.json.files`.

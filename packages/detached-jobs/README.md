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

Rend `{ job_id, owner, text }`, `owner` étant la **racine de la chaîne quand elle est vivante**, et
sinon son **plus haut ancêtre vivant** — jamais une session morte (section suivante). Le `text`
s'adresse à l'appelant : au propriétaire il dit que le job se lit avec `job_output` (`wait: true`
bloque jusqu'au règlement) ; à un worker il dit que le job **n'est pas** lisible depuis sa session et
qu'il faut rendre l'identifiant au propriétaire.

### Ce qui le distingue

**1. Propriété RACINE, résolue par les en-têtes durables.** La racine est trouvée en remontant
`parentSession` dans les en-têtes de session écrits sur disque, 16 sauts au maximum (une chaîne
malformée ne peut donc pas bloquer l'hôte). C'est la seule source qui a répondu correctement à chaque
fois : `ctx.agents.list()` est intermittemment vide, `agent/created` ne rejoue jamais pour un agent
antérieur au montage, et `listDescendants` ne voit que le catalogue d'enfants délégués — donc pas un
`fork`. Si la racine ne peut pas être résolue, l'outil **refuse** (il lève) au lieu de démarrer un job au
mauvais propriétaire.

**Le repli quand cette racine n'est plus vivante.** Une session **CONTINUÉE** après un redémarrage est
un fork seedé (`isSeeded`, `delegationDepth: 0`) dont le parent — la session du processus précédent —
**ne reviendra jamais**. La marche par les en-têtes a alors raison sur la forme de l'arbre et tort sur
le propriétaire, et les trois dispositifs tombaient avec elle. Mesuré, journal du relais, 2026-10-02
19:31 et 19:34 :

```
{"step":"register-skipped","why":"root-agent-unknown","id":"7fa9e670","root":"018354d9"}
{"step":"register-skipped","why":"root-agent-unknown","id":"00ce339d","root":"018354d9"}
```

`7fa9e670` est la session continuée (celle de l'utilisateur), `00ce339d` l'enfant qu'elle venait de
créer, `018354d9` la session morte dont elles descendent — `run_detached` était donc refusé **à la
racine même**. La règle reste inchangée au premier pas, et se complète au second :

1. `rootOf(sessionId)` — les en-têtes durables, seize sauts au plus : **le chemin normal, inchangé** ;
2. si l'agent de cette racine est **connu** (vivant, ou annoncé à ce montage) → propriétaire = **cette
   racine**, inchangé ;
3. sinon → propriétaire = le **plus haut ancêtre VIVANT** de la chaîne, ou l'appelant lui-même
   lorsqu'il en est le seul vivant. Le registre vivant est consulté **une seule fois**
   (`agents.list()`, une lecture pour toute la chaîne) pour **départager** ce choix, jamais pour
   résoudre la chaîne ; et s'il n'y a **rien de vivant**, la résolution échoue comme avant —
   `fail-closed`, jamais un job confié à une session qui ne peut pas le collecter.

Le repli est **journalisé** quand il sert —
`{"step":"owner-fallback","id":"7fa9e670","headerRoot":"018354d9","liveOwner":"7fa9e670"}` — parce
qu'un repli silencieux serait indistinguable d'une résolution normale dans le seul fichier qui consigne
ce qui s'est passé. La règle est **une seule fonction** (`resolveOwner`), partagée par la porte du
propriétaire et par le démarrage du job : admettre l'outil parce que le propriétaire vit, puis nommer
une session morte dans `owner:`, laisserait un job que personne ne peut lire.

**2. Montage HÔTE et installation PAR AGENT, les deux depuis la même ligne.** Le niveau hôte est une
condition de fonctionnement : seuls les enregistrements faits depuis une portée non scopée servent
n'importe quel propriétaire (`dsh-jobs/lib/index.js:102-104`), donc `owner: <racine>` n'est accepté que
là. L'outil, lui, est installé dans la surface **de chaque agent** par l'écouteur `agent/created` et
l'injection différée de `agents` — jamais depuis la portée de cette ligne, qui atteindrait le service
`tools` sans jamais apparaître dans une surface composée (mesuré deux fois, ligne hôte et ligne de
preset ; `packages/boost-mode/cordis.patch.yml:369-384` le consigne). Un second montage ne capture ni
n'installe à nouveau : chaque étape est journalisée, y compris le saut. Et l'installation est
**conditionnelle** : elle n'a lieu que si le **propriétaire** peut collecter — section suivante.

### L'outil n'est monté que si le propriétaire peut collecter

Un outil **visible et mort** est exactement la ligne en échec silencieuse que ce paquet existe pour
supprimer. Mesuré en session réelle, dans une composition **sans preset** (`tool-jobs` est
`disabled: true` à la base et ne remonte que par preset, `dsh-web-app/cordis.patch.yml:456-467`) :

```
Error: background jobs unavailable: no job controller serves this agent
       (load @deepseek-ai/dsh-tool-jobs in its composition)
```

`run_detached` était sur chaque surface, et **chaque appel échouait**. La correction ne consiste pas à
mieux refuser à l'exécution, mais à **ne pas annoncer** ce qui ne peut pas marcher : dans
`registerForAgent`, l'outil n'est enregistré que si le **propriétaire** — la racine de la chaîne de
délégation — peut collecter un job.

**Le prédicat porte sur le propriétaire, jamais sur l'appelant.** C'est la racine qui doit lire le job
(`job_output`) et pouvoir l'arrêter (`job_kill`) : elle seule sera encore là quand le worker aura
disparu. Un agent qui peut collecter pour lui-même ne prouve donc rien — la suite fixe les **deux**
sens : un worker dont la surface ne connaît pas `job_kill` reçoit quand même l'outil si la RACINE le
connaît, et un worker qui le connaît ne le reçoit **pas** si la racine ne le connaît pas.

**Pourquoi « voit `job_kill` » équivaut à « peut collecter ».** Dans tout déploiement livré, le seul
fournisseur d'un contrôleur de jobs (`dsh-tool-jobs/lib/index.js:256`) est **aussi** le seul
fournisseur des trois outils de collecte (`:298`, `:348`, `:368`) : une racine qui voit `job_kill` est
une racine servie par un contrôleur. Aucune API publique ne permet de poser la question directement —
`servesOwner` est privé et n'a **aucune** occurrence dans le contrat publié.

**Comment la question est posée.** Sur le service d'outils de la racine : `ctx.get('tools')`, puis
`tools.get('job_kill', <agent racine>)`. Les deux arguments comptent, et les deux sont mesurés contre le
vrai registre, avec `job_kill` enregistré depuis une portée de preset comme le fait `dsh-tool-jobs` :

| Appel | Réponse mesurée |
|---|---|
| `tools.get('job_kill')` | `undefined` — c'est la couche **globale** seule |
| `tools.get('job_kill', scopeOf(racine.ctx))` | la définition |
| `tools.get('job_kill', <agent racine>)` | la définition |
| la même chose dans une composition **sans** preset | `undefined` — l'outil est refusé, avec sa trace |

La première ligne est ce qui a écarté la forme **sans portée** : elle lit la couche globale, donc un
`job_kill` enregistré dans la portée du preset lui est invisible — l'outil aurait été retiré de la
composition même où il fonctionne. L'**objet agent** EST cette portée : les appels du harnais la passent
telle quelle (`dsh-tools/lib/types/index.js:784`), la boucle d'agent crée sa portée avec l'agent pour
clé (`dsh-agent-loop/lib/index.js:778`), et `scopeOf(agent.ctx) === agent` a été mesuré vrai — c'est
donc `scopeOf` **sans importer** `@deepseek-ai/dsh-scope`, dont ce paquet n'a délibérément aucune
dépendance.

**Refus total, jamais un repli silencieux sur l'outil.** Si la racine n'est pas résolue, si **aucun
agent vivant de la chaîne** ne peut être élu propriétaire, ou si le service d'outils de ce propriétaire
est absent, l'outil n'est **pas** enregistré (`fail-closed`), et chaque refus écrit une ligne
`register-skipped` portant la raison exacte — `root-not-resolved`, `root-agent-unknown`,
`root-tools-unavailable`, `owner-cannot-collect` — tandis que chaque enregistrement écrit une ligne
`registered` qui nomme le propriétaire. Un outil retiré sans trace serait un silence de plus.

Ce paquet **n'attache aucun contrôleur**, jamais : un attachement depuis une portée non scopée servirait
tous les propriétaires du process et élargirait l'admission pour `pwsh`/`bash` en arrière-plan, les
subagents et les workflows.

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
- le repli lit le registre vivant **une fois** (`agents.list()`) : sur un hôte où ce registre répond
  vide au mauvais moment, aucun propriétaire vivant n'est élu et l'outil est **retiré**
  (`register-skipped(root-agent-unknown)`) — dégradé, `fail-closed`, et jamais confié à une session
  morte ;
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

## Tests — 61 cas

```
cd packages/detached-jobs
node --test
```

**`node --test` sans argument**, impérativement : le runner découvre alors `test/*.test.mjs`.

```
1..61
# tests 61
# suites 0
# pass 61
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
| `test/apply.test.mjs` | 24 | le montage : contexte strict, journal du montage et de la capture, outil installé par `agent/created` **et** pour un agent déjà présent, contrat `output` du registre (son absence est une ligne `register-failed`), job possédé par la **RACINE** et jamais par le worker appelant, ce que le `text` dit à une racine, refus quand la racine est introuvable, refus quand aucun service non scopé n'a été capturé (pas de repli silencieux), second montage inerte, `apply-failed` journalisé sans rethrow, journal non inscriptible inoffensif, source pull qui ne rend jamais un octet, `pwshPath` du service `shell` suivi, repli explicite sans service `shell` ; **plus les quatre cas du prédicat de propriété** — T1 le propriétaire peut collecter, l'outil est monté ; T2 il ne peut pas, aucun outil **et** une trace `register-skipped` de raison `owner-cannot-collect` ; T3 le verdict suit le propriétaire **dans les deux sens** (worker sans `job_kill` servi par une racine qui l'a ; worker qui l'a refusé par une racine qui ne l'a pas) ; T4 propriétaire introuvable, `fail-closed` avec la raison (`root-not-resolved`, `root-agent-unknown`) ; **plus les cinq cas du repli de propriétaire** — T-S1 racine vivante : le repli n'est **pas** pris et n'écrit rien ; T-S2 racine morte, appelant vivant : l'outil **est monté** et le job est possédé par l'appelant ; T-S3 chaîne de trois, racine morte, milieu vivant : le propriétaire est le **milieu**, pas le plus proche ; T-S4 le repli est journalisé (`owner-fallback` avec `headerRoot` et `liveOwner`) et une résolution normale n'écrit pas cette ligne ; T-S5 rien de vivant : comportement inchangé, `register-skipped(root-agent-unknown)` |
| `test/shell.test.mjs` | 8 | l'exécutable : PowerShell 7 d'abord, repli Windows PowerShell 5.1, entrées PATH nettoyées et dé-citées, sonde d'existence (fichier ou lien, jamais un dossier), repli PATH hors Windows, le producteur lance le shell résolu, une annulation se règle en `killed` au lieu de pendre |
| `test/spill.test.mjs` | 9 | le fichier de récupération : il contient la sortie complète d'un job qui dépasse l'anneau, la ligne de pointeur y renvoie, la sortie n'est livrée qu'**une** fois, le nom vient du job et non de l'environnement, le plafond est annoncé dans le fichier, un magasin non inscriptible ne touche pas le job, deux jobs de même identifiant laissent deux fichiers, l'annonce à l'ouverture puis au règlement, le retrait d'un fichier plafonné |
| `test/purge.test.mjs` | 10 | la rétention : TTL, fichier récent gardé, `except` gardé même le plus ancien, plafond de 20, plancher d'âge, dossier absent inoffensif, entrée non supprimable rapportée `kept` sans rien arrêter, ni récursion ni autre nom que `*.log`, purge déclenchée par le démarrage d'un job, magasin illisible inoffensif |

Douze de ces cas se **sautent** d'eux-mêmes (`{ skip: … }`) quand PowerShell est absent : les neuf de
`spill.test.mjs`, les deux derniers de `purge.test.mjs` et celui de `shell.test.mjs` ; sur cet hôte le
compte rend `# skipped 0`.

Les quatre cas du prédicat ont été **falsifiés** sur des copies jetables hors du dépôt, pour montrer
qu'ils peuvent échouer : **inverser le prédicat** (enregistrer quand le propriétaire ne peut *pas*
collecter) fait tomber 14 cas, dont T1, T2 et T3 ; **supprimer la ligne de trace** du refus, en gardant
le prédicat, fait tomber T2, T3 et T4.

Les cinq cas du repli ont été falsifiés de même, **sur des copies jetables hors du dépôt**, dont la
sortie brute est citée dans le rapport de la session qui les a ajoutés :

- **retirer le repli** (`resolveOwner` rendant `root-agent-unknown` dès que l'agent de la racine est
  inconnu) fait tomber **T-S2, T-S3 et T-S4** — `# tests 61`, `# pass 58`, `# fail 3`, le premier
  échec étant `not ok 21 - T-S2 … the continued session must be MOUNTED, not refused`, `0 !== 1` —
  tandis que T-S1 (résolution normale) et T-S5 (`fail-closed`) **restent vertes**, ce qui est
  exactement ce qu'elles mesurent ;
- **élire le plus PROCHE vivant au lieu du plus haut** fait tomber **T-S3 seule** — `# tests 61`,
  `# pass 60`, `# fail 1`.

La suite du dépôt (`node --test` à la racine) reste verte : **245 cas, 0 échec** au moment de cette
mesure — 235 avant ces cinq cas, plus cinq cas ajoutés dans la même passe à `packages/boost-channel`
par une autre session, qui y implémente la même règle du propriétaire vivant.

## Les trois sondes

```
node tools/probe-profile-import.mjs [chemin-du-module.js]
node tools/probe-spill-announce.mjs [harness-node-modules] [entree-du-plugin]
node tools/probe-owner-gate.mjs [harness-node-modules] [entree-du-plugin]
```

Elles existent **à côté** des tests, pas à leur place. Les tests importent `../lib/index.js` et prouvent
donc le CODE ; ils ne disent rien de la **résolution** (la jonction de profil pointe-t-elle encore sur ce
checkout ?), ni de ce que le **vrai** registre fait du spec qu'on lui passe, ni de ce que la
**composition** fait de l'outil.

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
- `probe-owner-gate.mjs` monte le **vrai** registre d'outils et la **vraie** ligne
  `@deepseek-ai/dsh-tool-jobs` **dans une portée de preset** — la forme que compose
  `dsh-web-app/cordis.patch.yml:456-467`, où `tool-jobs` est `disabled: true` à la base — lie les
  portées d'agent à ce preset comme le fait `dsh-agent-preset-registry`, monte ce plugin en ligne
  **hôte**, annonce un worker, puis lit `tools.get('run_detached', worker)` : la vue par portée du
  registre lui-même. Il rejoue ensuite la **même** composition **sans** la ligne de preset — la
  composition où le défaut a été mesuré — et ne sort 0 que si l'outil est **présent** dans le premier cas
  et **absent**, avec une ligne `register-skipped(owner-cannot-collect)`, dans le second. C'est la seule
  sonde qui répond à la question de fond : l'outil est-il monté là où il peut servir, et retiré là où il
  ne pouvait qu'échouer ?

## Fichiers

- `lib/index.js` — résolution de la racine, producteur et fichier de récupération, rétention, outil,
  commande ;
- `cordis.patch.yml` — la ligne **hôte** (condition de fonctionnement, pas un détail de rangement) ;
- `test/*.test.mjs` — les 61 cas ; `tools/*.mjs` — les trois sondes ;
- `README.md` — cette page, listée dans `package.json.files`.

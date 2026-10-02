# boost-context-budget

Septieme ligne du bundle Boost. Elle repond a un seul probleme, mesure :

```
dsh-subagent-fork-in-process/lib/index.js:23-28   completedTurnPrefix(parent)
   = events.slice(0, last turn/end + 1)   -> TOUT, sans aucune borne ni curseur
dsh-subagent-fork-in-process/lib/index.js:14      const Config = z.object({ providerName: z.string() })
```

Le fork est **tout-ou-rien** : un enfant forke herite de la plenitude du pere. Un pere a 85 % de sa
fenetre donne a son enfant un prefixe qui ne lui laisse presque aucune place pour travailler. Et
`subagent_fork` a ete utilise **0 fois sur 176 delegations** : la contrainte n'est pas encore payee,
et elle ne doit l'etre que quand on forke.

## 1. L'outil : `context_occupancy`

Rend, pour l'agent **appelant** :

```
{ inheritedTokens, windowTokens, ratio, forkThresholdRatio, verdict }
```

- `inheritedTokens` — la taille de CE QU'UN FORK HERITERAIT : le **prefixe clos** (jusqu'au **dernier
  `turn/end`**, la frontiere exacte de `completedTurnPrefix` ; le tour en vol est exclu, parce qu'il
  n'est pas herite), mesure par la **seule API du harnais parametree par un seq d'arret** :
  `SessionProjectionRegistry.restore(checkpoint, events, baseSeq, header, inheritedEventCount)`
  (`dsh-session-projection/lib/types/index.d.ts:263`), dont `asOfSeq` vaut le **dernier evenement
  fourni**. On lui donne `events[0..boundary]` — exactement ce que `completedTurnPrefix` transmet — et
  l'on somme les trois champs de `contextBreakdown` (`systemTokens + toolsTokens + messageTokens`).
  **Prouve egal a la taille d'un ENFANT REEL** a trois cuts, dont un apres compaction (cas `T-C10`).
  Pourquoi pas une somme de **surface vive** : une compaction ne sp.lice que la surface
  (`dsh-session/lib/index.js:463`), pas le journal — une region remplacee **apres** la frontiere
  disparait des noeuds retenus, la somme tombait a **zero**, et la garde se rouvrait sur le fork
  qu'elle venait de refuser. **Aucun repli** : quand `restore` est absent ou jette, la mesure vaut `null`,
  le verdict `unknown`, et la garde **s'abstient** — le journal dit pourquoi (`fork-unguarded`,
  `why: restore-failed`). Confondre ABSENCE de mesure et mesure fausse est le defaut que ce paquet
  corrige : un repli qui rend un chiffre faux (13 849 contre 542 393, sous-mesure 39x) fait croire que la
  garde a decide. Cas `T-C9b`.
- `windowTokens` — la fenetre du modele de la route. Lue sur la projection `contextPressure`
  (`contextWindow`), et a defaut sur l'evenement durable `request/context` (`data.contextWindow`).
  Jamais codee en dur. Une valeur **implausible** (entier positif sous `MIN_PLAUSIBLE_WINDOW_TOKENS`,
  4096) n'est pas une fenetre mais un accident de lecture : la mesure vaut `unknown`, la source
  `implausible-window`, et la garde s'abstient — sinon un `contextWindow: 1` rendait « 7 100 000 %
  de la fenetre » (cas `T-C9c`).
- `verdict` — `ok` | `refused` | `unknown`. Trois etats, jamais deux : sans mesure, l'outil le DIT
  au lieu de deviner.

L'outil ne prend **aucun argument** : la mesure est celle de l'appelant, jamais celle d'un autre.

## 1bis. L'outil de demande : `context_compact`

La compaction n'est **jamais** automatique. Ce paquet expose un second outil, `context_compact`, que le
pere appelle pour **demander sa propre compaction** :

- elle ne tourne **pas** pendant l'appel — un agent qui appelle un outil est actif, et
  `runMaintenance` « throws synchronously when the agent is already active »
  (`dsh-compaction/lib/types/index.d.ts:57-65`) — mais au **`turn/end` de ce tour**, quand il ne l'est
  plus ;
- **une demande par tour au plus** : une seconde demande du meme tour rend `already-pending` et ne
  double rien ;
- elle est **IRREVERSIBLE** : la compaction resume l'histoire, et le detail remplace est perdu ;
- si le fork **n'est pas bloque** (`ratio <= forkThresholdRatio`, mesure faite), elle n'est pas retenue
  (`below-threshold`) : compacter ne gagnerait rien et perdrait de l'histoire ;
- apres une compaction **demandee**, la mesure est **REPRISE**. Si le ratio n'est pas passe sous le
  seuil, le journal porte `compact-ineffective` **avec les deux valeurs** (`ratio`, `ratioBefore`,
  `threshold`), et **aucune nouvelle tentative** n'est armee : un pere qui ne peut pas descendre ne paie
  pas une compaction par tour.

La valeur rendue est **declaree** au schema de sortie (`requested`, `pending`, `duplicate`, `turn`,
`ratio`, `forkThresholdRatio`, `verdict`, `reason`) et validee par le registre — cas `T-K6`, monte par
`registry.execute(...)` et non par `tool.execute(...)`.

## 2. La regle, au moment du fork

Un listener `tools/pre-execute` (waterfall) refuse `subagent_fork` quand `ratio > forkThresholdRatio` :

```
fork refuse : ton contexte heritable vaut 71 % de la fenetre, le seuil est 60 % (71000 tokens herites
sur 100000). trois sorties : 1) tu veux toujours forker -> demande ta compaction (outil context_compact),
elle tournera a ton turn end ; elle ecrit APRES la frontiere, donc ton fork ne la verra qu apres UN TOUR
DE PLUS (mesure : le prefixe herite ne bouge pas au tour suivant) ; 2) ou delegue avec subagent_implement et un
brief indexe (la route la moins chere) ; 3) ou renonce au fork et continue : rien ne t y oblige.
```

Le refus est journalise (`fork-refused`, avec les deux nombres) et compte. Refuser sans dire pourquoi
serait pire que ne pas refuser — et un refus qui n'en nomme qu'une impose celle-la.

**Le refus n'ARME RIEN.** C'est le correctif, et il a un cout mesure : l'armement automatique tirait la
compaction meme quand le pere renoncait au fork pour deleguer avec un brief (un appel de modele et de
l'histoire perdue **pour un fork qui n'aura pas lieu**), et il la declenchait des **60 %** quand la
politique du harnais ne compacte d'elle-meme qu'a **85 %**. L'arbitrage : **une compaction MANQUANTE coute
un tour ; une compaction NON VOULUE coute de l'histoire et un appel de modele** — le doute doit profiter a
celui qui ne perd rien.

### Le garde par PROPRIETE : le fork se reconnait a ce qu'il EST

`subagent_fork` est une **valeur du preset** (`dsh-base/cordis.patch.yml:383-388`), pas une propriete
du harnais : monte sous un autre nom, le meme provider passait **sans refus ni trace** (mesure). Une
liste de noms ne peut donc pas suffire.

Il existe un seam ou le provider **et** le contexte sont connus tous les deux : `SubagentProvider`
porte `inheritsParentContext` en **propriete requise** (`dsh-subagent/lib/types/types.d.ts:337`), elle
vaut `true` exactement pour un fork (`dsh-subagent-fork-in-process/lib/index.js:44`), et
`start(request)` recoit `request.parent` — l'agent delegant, donc sa session
(`dsh-subagent-in-process-driver/lib/index.js:164-185`). Le registre publie chaque enregistrement
(`subagent/provider-added`, `dsh-subagent/lib/index.js:3076-3086`).

La ligne enveloppe donc `start` et `prepareContinuable` des providers qui **heritent** : le controle
ne depend plus d'un nom, il depend de la propriete qui **definit** le fork. Le refus est une promesse
rejetee portant le meme message (cas `T-C11`). Si l'enveloppe ne peut pas etre posee (provider gele),
c'est **journalise** (`provider-guard-unavailable`), jamais suppose.

`forkToolNames` reste comme repli : c'est lui qui donne un refus **propre au seam des outils**
(`tools/pre-execute`), ou seul le nom est visible, et il sert aux deploiements qui renomment l'outil.

## 3. La compaction DEMANDEE

Un agent qui appelle un outil est `running`, donc il ne peut pas se compacter lui-meme a cet instant
(`dsh-compaction/lib/types/index.d.ts:57-65` : `runMaintenance` « throws synchronously when the agent
is already active »). C'est l'outil `context_compact` qui **demande**, et c'est le `turn/end` du tour
de la demande qui la declenche : `ctx.compaction.compactNow(agent, signal)`. Rien d'autre n'ecrit dans
la table des demandes — un refus, en particulier, n'y ecrit plus jamais.

`turn/end` est publie **synchroniquement** par `session.append` (`dsh-session/lib/index.js:1473`),
appelee dans le `finally` de `runTurn` (`dsh-agent-loop/lib/index.js:1027`) — **avant** que `kick` ne
ramene la phase a `idle` (`dsh-agent-loop/lib/index.js:892-899`). A cet instant precis l'agent est
donc encore `running` : la garde attend l'inactivite observee (`agent.whenIdle()`) avant d'appeler
`compactNow`. Une compaction par tour, jamais deux — et **la demande porte le tour** : un tour qui ne
se ferme jamais (arret, annulation) ne fait pas compacter le suivant (`compact-request-orphaned`).

**La boucle est fermee**, et la frontiere de la re-mesure n'est **pas** celle du fork. Une compaction exige
un tour ferme (`dsh-compaction-basic/lib/index.js:455-462` : `manual compaction: the session already has
an open turn` est le refus `busy`), donc elle ecrit ses evenements **apres** le dernier `turn/end`.
Mesure sur la vraie pile (`Session` + `TokenMeter` + `SessionProjectionRegistry`) : 4 532 tokens au
dernier `turn/end` **avant** la compaction, **4 532 au meme cut apres**, et 10 au **dernier evenement**.
Juger une compaction au cut du fork declarerait `compact-ineffective` **toute compaction qui marche** —
et le verrou qui suit refuserait la demande suivante d'un pere qui a pourtant de la place. La re-mesure
prend donc la frontiere du **dernier evenement** (`measureAfterCompaction`), meme source (`restore`),
meme fonction, une seule frontiere change — et `sources.boundarySeq` dit laquelle. Trois etats, jamais
deux : sous le seuil, rien a dire ; au-dessus, `compact-ineffective` est journalise avec les deux valeurs
(`ratio`, `ratioBefore`, `threshold`), et une **preuve** est posee qui refuse la demande suivante tant que
la mesure reste au-dessus du seuil (`compact-request-refused`). La preuve tombe d'elle-meme des qu'une
mesure repasse sous le seuil.

## Configuration

| cle | defaut | sens |
|---|---|---|
| `forkThresholdRatio` | `0.6` | au-dela, le fork est refuse (jamais `-0` : refuse et journalise) |
| `forkToolNames` | `['subagent_fork']` | les NOMS gardes au seam des outils (repli du garde par propriete) |
| `home` | `$DSH_HOME` | racine du journal `plugin-data/dsh-boost-context-budget/decisions.jsonl` |

Pourquoi **0,6** : un enfant doit garder ~40 % de la fenetre pour lire, tester et ecrire. Plus haut,
la garde ne se declenche jamais (les sessions racines les plus lourdes du corpus tournent a
~349 000 cache-read par pas, au plafond) ; plus bas, elle refuse des forks qui auraient tenu. Une
valeur hors `[0,1]` ou non numerique est journalisee (`threshold-invalid`) et remplacee par le
defaut — le montage tient dans tous les cas.

## Montage

Ligne HOTE, outils installes PAR AGENT sur `agent/created` : un outil enregistre depuis la portee
d'une ligne n'atteint jamais la surface composee d'un agent (mesure deux fois). `TOOL_NAMES` est la
source unique que lisent le code, les tests et toute sonde : un outil ajoute fait rougir la SUITE.

## Tests

```
node --test packages/boost-context-budget/test/context-budget.test.mjs
```

36 cas, T-C1 a T-C11 et T-K1 a T-K6. Ceux qui ont decide la conception :

- **T-K1, LE CORRECTIF** : un refus **seul** n'appelle **jamais** `compactNow`, meme a son `turn/end`,
  meme apres un tour entier et un second refus. C'est le cas qui rougit si l'armement automatique
  revient (falsification : sur une copie jetable, remettre l'armement au refus fait ROUGIR T-K1).
- **T-K2..T-K4** : une demande par l'outil fait compacter **une fois** au `turn/end` du tour de la
  demande ; deux demandes du **meme** tour n'en font qu'une ; une demande dans un tour qui ne se ferme
  **jamais** ne compacte pas un tour etranger (la regle par tour existait deja, elle est conservee).
- **T-K5** : une compaction demandee qui **ne fait pas descendre** le ratio est journalisee
  (`compact-ineffective`, avec `ratio`, `ratioBefore` et `threshold`) et **jamais repetee** — ni par un
  tour suivant, ni par un refus, ni par une seconde demande.
- **T-K6** : la **valeur RENDUE par `context_compact` validee par le REGISTRE**, et la demande
  effectivement honoree au `turn/end` — par `registry.execute(...)`, pas par `tool.execute(...)`.
- **T-C10, l'acceptation** : la mesure **egale la taille d'un ENFANT REEL** — une vraie `Session` construite
  a partir du seed, mesuree par la meme pile (vrai `SessionProjectionRegistry`, vraie projection
  `contextBreakdown`) — a **trois cuts**, dont un **apres une compaction** posee dans le tour en cours,
  ou la surface vive du parent s'est effondree. C'est ce cas qui a mis a bas la somme de surface.
- **T-C8** : la **valeur REELLE de `context_occupancy` validee par le REGISTRE** `dsh-tools`. Il existe
  pour un defaut reel : l'outil rendait `sources`, absent du schema de sortie, et le registre rejette
  toute cle non declaree. Les cas qui appellent `tool.execute(...)` directement passent **au-dessus** de
  cette couture.
- **T-C11** : le garde par **propriete** (`inheritsParentContext`), qui reconnait le fork meme renomme.
- `T-C9a`..`T-C9e` tiennent les autres defauts trouves par falsification : la borne du prefixe et
  l'absence de maximum (`T-C9a`), le repli journalise (`T-C9b`), la fenetre implausible (`T-C9c`), le
  nom garde configurable (`T-C9d`), la disparition de tout etat d'armement (`T-C9e`), et le seuil `-0`
  refuse (`T-C6`).

## Sonde

```
node packages/boost-context-budget/tools/probe-fork-guard.mjs
```

Elle monte la VRAIE application cordis, le VRAI registre `dsh-tools` et les VRAIES portees
(`dsh-scope`), puis mesure ce qu'un test a surface factice ne peut pas mesurer :

1. l'**admission** d'un listener `tools/pre-execute` sans tag monte sur la ligne HOTE, avec son
   **controle de vivacite** (un listener monte sous une portee TAGUEE ne recoit pas l'appel d'un
   autre agent) ;
2. le **refus arrive jusqu'au registre** par `registry.execute(...)`, avec son motif et son code,
   et le corps de l'outil n'est pas invoque ;
3. le **passage** sous le seuil, corps execute et chaine non coupee (un listener en aval le voit) ;
4. le **faux negatif** : sans mesure, le fork n'est pas refuse et le journal dit `fork-unguarded` ;
5. la **compaction DEMANDEE** : un refus puis `turn/end` -> `compactNow` **jamais** (le correctif
   mesure), la **demande** par `context_compact` puis `turn/end` -> **une fois**, un tour sans demande
   jamais, et le journal sans aucune etape `fork-arm-*` ;
6. le **retour REEL de `context_occupancy`** par le registre : la valeur rendue (avec ses `sources`) et
   le fait qu'elle soit acceptee.

Sortie 0 seulement si les six concordent. Falsification : en montant la garde sous la portee
TAGUEE de l'enfant au lieu de la ligne hote, la sonde sort en `PROBE-FAIL` et nomme la perte
(`le refus n atteint pas le registre`, journal vide, zero compaction).

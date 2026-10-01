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

- `inheritedTokens` — la taille de CE QU'UN FORK HERITERAIT : la somme des noeuds de SURFACE dont le
  `seq` est inferieur ou egal au **dernier `turn/end`**. C'est exactement la frontiere de
  `completedTurnPrefix` ; le tour en vol est exclu, parce qu'il n'est pas herite.
- `windowTokens` — la fenetre du modele de la route. Lue sur la projection `contextPressure`
  (`contextWindow`), et a defaut sur l'evenement durable `request/context` (`data.contextWindow`).
  Jamais codee en dur.
- `verdict` — `ok` | `refused` | `unknown`. Trois etats, jamais deux : sans mesure, l'outil le DIT
  au lieu de deviner.

L'outil ne prend **aucun argument** : la mesure est celle de l'appelant, jamais celle d'un autre.

## 2. La regle, au moment du fork

Un listener `tools/pre-execute` (waterfall) refuse `subagent_fork` quand `ratio > forkThresholdRatio` :

```
fork refuse : ton contexte heritable vaut 71 % de la fenetre, le seuil est 60 % (71000 tokens
herites sur 100000). termine ton tour — la compaction tournera pendant que tu es inactif — puis
forke au tour suivant, ou delegue avec subagent_implement et un brief indexe.
```

Le refus est journalise (`fork-refused`, avec les deux nombres) et compte. Refuser sans dire pourquoi
serait pire que ne pas refuser.

## 3. La compaction differee

Un agent qui appelle un outil est `running`, donc il ne peut pas se compacter lui-meme a cet instant
(`dsh-compaction/lib/types/index.d.ts:57-65` : `runMaintenance` « throws synchronously when the agent
is already active »). Le refus **arme** donc une compaction, et c'est le `turn/end` du meme tour qui
la declenche : `ctx.compaction.compactNow(agent, signal)`.

`turn/end` est publie **synchroniquement** par `session.append` (`dsh-session/lib/index.js:1473`),
appelee dans le `finally` de `runTurn` (`dsh-agent-loop/lib/index.js:1027`) — **avant** que `kick` ne
ramene la phase a `idle` (`dsh-agent-loop/lib/index.js:892-899`). A cet instant precis l'agent est
donc encore `running` : la garde attend l'inactivite observee (`agent.whenIdle()`) avant d'appeler
`compactNow`. Une compaction par tour, jamais deux.

## Configuration

| cle | defaut | sens |
|---|---|---|
| `forkThresholdRatio` | `0.6` | au-dela, `subagent_fork` est refuse |
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

25 cas, T-C1 a T-C8 : la mesure et sa frontiere, le refus et son message, le seuil configurable, la
compaction differee et son idempotence par tour, le seuil invalide, l'outil lui-meme, et — **T-C8** — la
**valeur REELLE validee par le REGISTRE** `dsh-tools`. Ce dernier cas existe pour un defaut reel : l'outil
rendait `sources`, absent du schema de sortie, et le registre rejette toute cle non declaree. Les cas qui
appellent `tool.execute(...)` directement passent **au-dessus** de cette couture — ils etaient verts quand
l'outil ne marchait pas.

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
5. la **compaction differee** : un refus arme, `turn/end` declenche `compactNow` une fois, un tour
   sans refus jamais ;
6. le **retour REEL de `context_occupancy`** par le registre : la valeur rendue (avec ses `sources`) et
   le fait qu'elle soit acceptee.

Sortie 0 seulement si les six concordent. Falsification : en montant la garde sous la portee
TAGUEE de l'enfant au lieu de la ligne hote, la sonde sort en `PROBE-FAIL` et nomme la perte
(`le refus n atteint pas le registre`, journal vide, zero compaction).

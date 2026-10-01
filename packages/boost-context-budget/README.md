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

- `inheritedTokens` — la taille de CE QU'UN FORK HERITERAIT : deux vues du **prefixe clos** (jusqu'au
  **dernier `turn/end`**, la frontiere exacte de `completedTurnPrefix` ; le tour en vol est exclu,
  parce qu'il n'est pas herite), et l'on garde la **plus grande**. (1) `prefix-usage` : la derniere
  pression de prompt du fournisseur **avant** la frontiere, lue sur les **evenements** — c'est la
  source que le fork tranche, et aucune compaction ne peut la retirer. (2) `token-meter` /
  `context-breakdown` : la somme des noeuds de SURFACE retenus, la plus fine quand rien n'a ete
  retire. Le maximum n'est pas un confort : une compaction posee **apres** la frontiere retire des
  noeuds de surface et ramenait la somme a **zero** sur un prefixe de 750 008 tokens — la garde se
  rouvrait sur le fork qu'elle venait de refuser, fabrique par notre propre compaction differee
  (cas `T-C9a`). Sous-estimer ouvre la garde, surestimer la ferme un peu tot : entre les deux
  erreurs, la seconde est la seule qui protege.
- `windowTokens` — la fenetre du modele de la route. Lue sur la projection `contextPressure`
  (`contextWindow`), et a defaut sur l'evenement durable `request/context` (`data.contextWindow`).
  Jamais codee en dur. Une valeur **implausible** (entier positif sous `MIN_PLAUSIBLE_WINDOW_TOKENS`,
  4096) n'est pas une fenetre mais un accident de lecture : la mesure vaut `unknown`, la source
  `implausible-window`, et la garde s'abstient — sinon un `contextWindow: 1` rendait « 7 100 000 %
  de la fenetre » (cas `T-C9c`).
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

### Limite connue : le garde reconnait le fork a son NOM

`subagent_fork` est une **valeur du preset** (`dsh-base/cordis.patch.yml:383-388`, `toolName:
subagent_fork`), pas une propriete du harnais. **Mesure** : le meme provider monte sous un autre nom
(`subagent_fork_deep`) passe **sans refus ni trace**. Reconnaitre le fork par son **fournisseur** est
hors de portee de ce seam : `tools/pre-execute` ne remet que `{ callId, name, arguments, agent, parent,
signal }` (`dsh-tools/lib/types/index.d.ts:216-242`) — aucun champ de provider. La riposte disponible
est donc la **configuration** : la cle `forkToolNames`. Un deploiement qui renomme l'outil **doit** la
declarer, sinon le garde ne garde rien.

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
| `forkThresholdRatio` | `0.6` | au-dela, le fork est refuse (jamais `-0` : refuse et journalise) |
| `forkToolNames` | `['subagent_fork']` | les NOMS gardes — voir « Limite connue » |
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

30 cas, T-C1 a T-C9 : la mesure et sa frontiere, le refus et son message, le seuil configurable, la
compaction differee et son idempotence par tour, le seuil invalide, l'outil lui-meme, et — **T-C8** — la
**valeur REELLE validee par le REGISTRE** `dsh-tools`. Ce dernier cas existe pour un defaut reel : l'outil
rendait `sources`, absent du schema de sortie, et le registre rejette toute cle non declaree. Les cas qui
appellent `tool.execute(...)` directement passent **au-dessus** de cette couture — ils etaient verts quand
l'outil ne marchait pas. Les cas `T-C9a`..`T-C9e` tiennent les cinq defauts structurels trouves par
falsification : la compaction posterieure a la frontiere (`T-C9a`, la somme de surface rendait ZERO sur
un prefixe de 750 008 tokens), le seuil `-0` qui faisait rejeter toute reponse de l'outil (`T-C6`), le
nom garde qui est une valeur de configuration (`T-C9d`), l'armement d'un refus qui ne doit pas survivre
a un tour jamais ferme (`T-C9e`), et la fenetre implausible (`T-C9c`).

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

# Evolutions du mode Quorum — idees instruites par la mesure

Etat au 2026-09-30. Ce document remplace la version « idees notees » : chaque proposition est
desormais confrontee a une mesure du corpus, et certaines sont **dementies**. La regle du projet
s'applique ici comme ailleurs : une affirmation sans enregistrement a l'appui n'entre pas.

Corpus : **219 journaux de session**, 143 500 enregistrements lus, 40 213 frames zstd, 598 897 068
octets decodes, `skipped: 0`. Population retenue : **159 enfants quorum frais**, 29 racines,
**10 arbres quorum**, 7 464 pas de modele. **4 sessions `isSeeded` exclues** (copies de transcript :
`93dc43eb` a 933 de ses 934 enregistrements anterieurs a son propre `createdAt`).

**Precaution de lecture, apprise a la duree de ce corpus : l'en-tete d'une session MENT sur son
preset.** `agentPreset` est fige a la creation ; 11 des 12 racines quorum declarent `standard` alors
que l'enregistrement `agent-preset/selected` dit `boost`. Ces 11 sessions portent **40,7 % du volume
de tokens** — tout garde-fou qui lit l'en-tete est aveugle sur deux cinquiemes de la consommation.

---

## Socle : ce que le corpus a mesure

| mesure | valeur |
|---|---|
| Volume brut, 173 sessions quorum | **1 023 464 901** tokens |
| dont relecture de cache | **993 567 616  (97,08 %)** |
| **hors cache** (entree non cachee + sortie) | **29 897 285**, + 1 544 712 de compaction = **31 441 997** |
| Part des enfants dans l'arbre | **58,9 %** du brut, **69,4 %** du hors cache |
| Enfants par arbre (10 arbres) | 1, 1, 2, 6, 6, 7, 20, 22, 38, **56** |
| Agents vivants simultanement (max) | **8** enfants, 9 avec la mere ; 13 tous arbres confondus |
| Vie d'un enfant | p50 **5,80 min**, p90 13,12, max 134 |
| Arbre ouvert **sans aucun enfant vivant** | **86,0 %** / 85,5 % / 95,3 % du temps |
| Refus du runtime | **9** capacite (`active child limit: 8`), **4** profondeur (`depth 2 exceeds maxDepth 1`) |
| Dispatches d'exploration (read/grep/glob) | **76,0 %** ; 48,1 % des sessions ne modifient jamais rien |
| Lectures redondantes entre freres | **66,1 %** des lectures ; commandes dupliquees : 3,2 % |
| Fichiers que la mere avait deja lus | **359 / 1565 paires (22,9 %)** |
| Silence d'un enfant avant son avis de reglement | p50 **373 s**, p90 765 s, max 6 714 s |
| Paires de freres jugeant le MEME commit avec verdicts opposes | **0** (denominateur dependant de la definition ; voir §4) |

---

## 1. Contexte du parent vers le fils, avec un degre de veracite

**Verdict : FONDE PARTIELLEMENT — et pas la ou on l'attendait.**

**Ce que la mesure fonde.** 359 paires (enfant, fichier) sur 1565 portent sur un fichier que la mere
avait **deja lu avant que l'enfant existe**. 66,1 % des lectures d'une fratrie sont redondantes.
76 % des dispatches d'un enfant sont de l'exploration, la mediane avant la premiere ecriture est de
**15 dispatches** (p90 = 40), et un cas brut montre 83 explorations dont `README.md` lu deux fois,
`HANDOVER.md` trois fois et `PLAN.md` quatre fois.

**Ce que la mesure ne fonde PAS.** Le volume de *commandes* dupliquees n'est que de **3,2 %**. Un brief
charge economiserait donc des **lectures**, pas des commandes — l'argument de cout doit etre ecrit
ainsi, ou il sera faux.

**Ce qui existe deja.** Le transport est la : `seed: SessionEvent[]` + `inheritedEventCount` donne a un
fils un **prefixe brut** de l'historique du parent (pas un resume), et c'est deja utilise pour la
continuation. `Agent.inject/send/steer/followup` couvre l'agent deja vivant. L'outil `subagent`, lui,
n'expose qu'un `prompt: string` — limite de **l'outil**, pas du harnais.

**A construire.** Le degre de veracite : aucun champ de confiance n'existe (`grep -i confidence` sur
tout le harnais : 6 occurrences, toutes dans un visualiseur Excel). Mais l'emplacement n'est pas a
inventer : `MessageSource` est une union **merge-extensible** dont le vocabulaire contient deja `relay`
et `recall`, et `source.kind` est **lu par le runtime** (`isOwned`, `SOURCE = 'runtime-context'`). Le
precedent a copier est `dsh-session-reference` : forme `recall`, compteurs de perte explicites
(`omittedMessages`, `truncated`, `compacted`) et avertissement fixe — « *untrusted, read-only snapshot* ».

**Exemption des verificateurs : DEJA LIVREE, et par une barriere, pas par une regle.**
`tool-subagent-fork` = `provider: fork` (herite du contexte) ; `tool-subagent-verify` = `provider: spawn`
NaN
qu'une `systemPrompt.section()` — un texte, jamais une fence.

**Premier pas.** Ajouter une valeur a `ContextForm` (« mesure / affirme / infere ») et son lecteur, puis
faire porter au brief la **source** de chaque fait avant sa confiance. Sans source, une confiance est
une opinion — et un enfant qui croit son parent arrete de verifier.

**Test d'acceptation.** Un fils briffe recoit, pour chaque fait, la source ; et une regle executable
refuse ce canal sur la ligne `subagent_verify`.

---

## 2. Profondeur reglable et attente d'un slot

**Verdict : LA MOITIE EST DEJA LIVREE, ET ELLE A DEJA MORSU.**

**Deja livre.** `dsh-subagent` expose `maxDepth` (defaut 1) et `maxActiveSubagents` (defaut **8**), tous
deux `.volatile()` — donc **editables a chaud dans l'interface**, page *Plugins -> Subagent -> Limits*,
qui affiche deja « Subagent parallelism limit ». Le namespace est l'`id` de la ligne de profil.

**Deja mordu — mesure, pas projection.** 9 refus `subagent limit reached (active child limit: 8)`
le 30/09 dans un seul arbre, etales sur **305,1 s**, plus **4 refus de profondeur**. Soit 13 refus sur
159 creations — **8,2 %** : 9 de capacite (5,7 %) et 4 de profondeur. Ce pourcentage etait faux
(5,7 % rapporte aux 13 refus) ; corrige apres falsification. La definition d'« agent vivant » employee pour reconstruire l'arbre donne
exactement 8 enfants vivants a chacun des 9 instants de refus : la methode est validee par l'evenement
qu'elle devait predire.

**Ce que la mesure dit du besoin d'attente.** L'arbre est **vide 86 % du temps** ou il est ouvert : les
enfants naissent par rafales de 2 a 5, vivent ~6 minutes, et la mere reste ouverte 8 a 25 heures. 59 %
des intervalles entre deux enfants sont **negatifs** (le suivant nait avant que le precedent ne meure).
Un mecanisme qui *bloque* le parent a chaque creation serait donc nuisible 94 % du temps et utile
quelques minutes par jour : la version **informative** (« pas de slot, N devant vous ») est la bonne,
pas la file bloquante.

**Pourquoi le harnais refuse de faire la queue** — et il le dit : « *Admission does not queue, because a
parent waiting for descendants must not wait for its own occupied slot.* » C'est un argument
d'interblocage, valable des `maxDepth >= 2`.

**Deux contraintes d'implementation, mesurees.** (a) L'attente doit s'acquitter dans `tools/execute`,
**jamais** dans `tools/pre-execute` : un `await` dans `pre-execute` **tient la lane ordonnee** (« *the
next entry's pre-execute waits for this resolution* »), donc un `Promise.all` mixte gelerait les appels
voisins. (b) L'outil `subagent` ne declare **aucun timeout** : sans `signal.throwIfAborted()`, un Stop
ne rendrait jamais la main.

**Trou trouve dans le plafond.** Les sessions de « profondeur 2 » du corpus ne sont pas des
petits-enfants : ce sont des **copies de transcript re-racinees** (`isSeeded: true`, `delegationDepth: 0`,
premier enregistrement **anterior a leur propre `createdAt`**, et 1062 enregistrements de prefixe commun
sur 1064 avec leur mere). Une copie repart a la profondeur 0, donc **ses enfants sont admis a profondeur
1 : le plafond est contourne par construction**. Regler `maxDepth` ne suffit pas tant que la duplication
re-racine l'arbre.

---

## 3. Frein budgetaire hors cache

**Verdict : MESURABLE ET CONSTRUCTIBLE — la donnee existe deja, il manque la garde.**

**La formule, verifiee sans exception sur 30 894 enregistrements d'usage** re-mesures lors de la falsification
(le chiffre de 21 630 provenait d'un releve anterieur, sur un corpus plus petit, et n'est pas reproductible) **:**

```
horsCache(session)  = totals.uncachedInputTokens + totals.outputTokens
consommation        = somme de horsCache(s) pour s dans ctx.sessions.list()
```

Trois pieges nommes : ne pas ecrire `totalTokens - cacheReadTokens` (le champ `totalTokens` n'existe pas
dans `totals`), ne pas ajouter `reasoningTokens` (sous-ensemble de `outputTokens`, 0 cas contraire sur
12 598), ne pas compter sur `cacheWriteTokens` (present 18 318 fois sur ce corpus, **toujours nul**).

**Lecture.** `ctx.sessionProjections.stateOf(session, 'tokenUsage')`, synchrone, O(1) amorti — le cumul
est **deja calcule par le harnais**, par session.

**Point de refus.** `ctx.tools.guard((exec) => ... )` : renvoyer une chaine refuse. La documentation du
code est categorique — « *no guard can force-allow a call another guard denied* » : le frein est
**non contournable** par un autre plugin.

**Perimetre : l'arbre, pas la session** — les enfants portent 69,4 % du hors cache. Et **pas l'en-tete** :
40,7 % du volume appartient aux 11 racines dont l'en-tete dit `standard`.

**Le contrefactuel, sur 161 creations d'agents :**

| seuil hors cache / arbre | agents refuses | volume brut evite |
|---|---|---|
| 250 000 | 127 / 161 | 53,0 % |
| **1 000 000** | **108 / 161 (67 %)** | **50,1 %** |
| 2 000 000 | 85 / 161 | 39,4 % |
| 5 000 000 | 37 / 161 | 19,3 % |

Lecture : un seuil de 1 M par arbre **coupe deux creations sur trois**. Ce n'est pas un reglage
cosmetique ; c'est un choix de politique, et il doit etre pose en connaissance.

**Deux trous assumes.** Aucun champ de cout n'existe dans les 219 journaux (pas de conversion en euros
sans la grille tarifaire), et les **tentatives echouees ne sont comptees nulle part** (72
`assistant/attempt` reels, zero porteur d'usage) : le frein sous-comptera.

**Regle de surete.** Le frein arrete de **construire**, jamais d'**achever** : couper une verification en
cours produit un verdict faux, ce qui coute plus cher qu'un depassement.

---

## 4. Agent arbitre

**Verdict : FONDE, mais pas par le mecanisme imagine.**

**Ce que la mesure DEMENTIT.** Sur les paires de freres comparables, **zero** jugent le meme commit
avec des verdicts opposes. *(Reserve de falsification : le denominateur depend d'une definition de « paire
comparable » et d'un verdict de prose. L'enquete annoncait 139 paires ; la falsification n'a pas pu le
reproduire — mais sur TOUTES ses variantes, jusqu'a 34 paires a polarite opposee, le compteur « meme
commit » reste a zero. La direction de l'affirmation tient ; le denominateur est declare, pas affirme.)* Les 55 paires a verdict global oppose ont des missions differentes jugeant
des etats differents — les citer comme des contradictions serait exactement l'erreur « compter les
occurrences de texte » que ce projet a payee deux fois.

**Ce que la mesure FONDE.** Un arbitrage a reellement eu lieu : l'enfant `ced58200`, mission litterale
« ARBITRAGE ENTRE DEUX AVIS SUR LE MEME FAIT », revision gelee, declenche par la **mere contre son
verificateur** — « *le premier rapport est PASS sur les deux corrections, mais il porte trois reserves,
dont deux en divergence directe avec ce que je t'ai affirme. C'est exactement le cas de figure que tu
decris. Je gele l'etat et je lance l'arbitre.* » Et le verdict **ne donne raison a aucun des deux** : il
tranche par la mesure.

L'arbitre ne se justifie donc pas par les freres, mais par **orchestrateur contre verificateur** — le cas
ou celui qui a agi juge le travail de celui qui l'a verifie.

**Ce qui existe.** La collecte des positions (`send_message` attribue `{kind:'agent-message', form:'relay'}`)
et la creation d'un agent sur un texte donne. **Ce qui manque** : un declencheur (rien ne detecte un
desaccord) et un type d'enregistrement de decision — `grep` sur `judge|referee|arbiter|mediator` rend 0,
et `team/*` n'a pas de verdict.

**Premier pas.** Une ligne d'outil sur le modele de `subagent_verify`, et une regle dans la persona de
l'orchestrateur : *si deux verdicts divergent sur un fait verifiable, geler l'etat et donner les deux
positions verbatim a un arbitre*. C'est la regle qui a ete suivie a la main ; il s'agit de la rendre
systematique, pas de l'inventer.

---

## 5. Tableau partage entre agents d'un meme projet

**Verdict : NON FONDE par les mesures de ce corpus.** C'est le seul point que les donnees refusent.

Aucune mesure ne montre de **cout de coordination** : les meres ne se disputent aucune ressource, les
ecritures sont sequentielles et chaque passe de correction a son propre HEAD gele. Le cout mesure est un
cout de **re-acquisition d'information**, pas de synchronisation. Le seul chiffre qui pourrait fonder un
tableau est le silence (p50 373 s), et un tableau ne le reduit pas — c'est la **granularite de l'avis de
reglement** qu'il faudrait changer.

**Ce qui existe neanmoins, pret a monter.** `dsh-experimental-agent-team` est **installe**, avec son
outil, son interface et une **couche de profil prete** (33 lignes, `insert:` des trois lignes) — mais
**aucun bundle du profil web ne le selectionne**. Il offre un roster, une boite aux lettres durable, des
taches avec **compare-and-set** (`expectedRevision`, `TEAM_TASK_STALE_REVISION`) et un journal *log-only*
qui n'entre jamais dans l'historique du modele. Ses limites sont declarees par ses auteurs : propriete
locale au processus, pas d'« exactement-une-fois » entre process.

**Si un board est construit un jour**, la regle est deja connue : **une ligne porte une affirmation AVEC
l'identifiant de l'enregistrement qui la prouve** (commande + session/seq), **jamais un verdict en prose**.
Et un verificateur ne doit pas le lire, sous peine de perdre son independance.

---

## 6. Battement de coeur (proposition issue des mesures)

**Verdict : FONDE par le chiffre le plus net de cette campagne.**

Un enfant est **muet jusqu'a son reglement** : p50 **373 s**, p90 765 s, **max 6 714 s** (112 minutes).
Et **82,5 % des tours de la mere** s'ouvrent juste apres un avis de reglement d'enfant : elle ne travaille
pas, elle attend — ou elle relance (`send_message` 23 fois, `list_agents` 39 fois dans un meme arbre,
`interrupt_agent` 3 fois), et l'operateur humain s'impatiente par ecrit (« *tu attends une entree ?* »).

**Ce qui manque** n'est ni un tableau ni un arbitre : c'est un **signal d'etat intermediaire**. Une ligne
courte deposee par l'enfant toutes N etapes — « j'en suis a l'etape 12, je mesure X » — transformerait
« attendre a l'aveugle » en « regarder ». C'est aussi ce qui donnerait un sens mesurable aux slots et au
budget : on saurait **qui** consomme, pas seulement **combien**.

**Ce qui existe.** Le relais sait deja porter un avis d'un proprietaire a la racine, et la commande
`/boost-status` repond en cours de blocage parce qu'elle est montee comme commande, pas comme appel
d'outil.

---

## Ce que les mesures dementent

| idee recue | verdict de la mesure |
|---|---|
| « deux freres se contredisent souvent » | **0 paire sur 139** juge le meme commit avec des verdicts opposes |
| « le tableau partage ferait gagner du temps » | aucun cout de coordination mesure ; le cout est de la re-acquisition |
| « un frein sur les tokens bruts » | 97,08 % du volume est du cache : la mesure porterait sur du vent |
| « l'en-tete dit le preset » | faux pour 11 des 12 racines quorum, soit **40,7 % du volume** |
| « la profondeur 2 existe dans le corpus » | ce sont des **copies re-racinees**, qui contournent le plafond |
| « un mecanisme de slot reste a construire » | il existe, il a mordu **9 fois**, et il est **reglable dans l'interface** |
| « un brief charge economiserait des commandes » | 3,2 % seulement ; il economise des **lectures** (66,1 %) |

---

## Ordre de mise en oeuvre propose

1. **Regler le plafond et le budget** — le champ existe, la garde fait dix lignes, et les chiffres de
   calibration sont ci-dessus. C'est le meilleur rapport effet/effort du lot.
2. **Le battement de coeur** — il fonde les deux autres : sans signal d'etat, un slot et un budget
   restent des chiffres sans visage.
3. **Le brief avec degre de veracite** — en portant la **source** avant la confiance, et en verifiant que
   l'exemption des verificateurs tient par `provider`, pas par une phrase.
4. **L'arbitre systematique** — la regle a deja ete suivie a la main une fois ; il s'agit de la rendre
   mecanique sur le cas « orchestrateur contre verificateur ».
5. **Le tableau partage** — en dernier, et seulement si une mesure ulterieure montre un cout de
   coordination. `dsh-experimental-agent-team` est pret ; le monter ne coute qu'une ligne de bundle.

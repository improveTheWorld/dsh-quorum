# Decisions — etat au 2026-09-30

Registre des decisions prises pendant la conception, **avec la mesure qui les a fondees** et les
propositions **retirees** (un registre qui cache ses revirements est un document qui ment).

---

## Partie 1 — Decisions prises

### Le livrable

| # | decision | pourquoi | etat |
|---|---|---|---|
| D1 | Le livrable est un **bundle agregateur** : un paquet, un `cordis.patch.yml`, huit lignes | `dsh-app-boot` fait `data.push(...insert)` sans deduplication : huit bundles monteraient chaque ligne une fois — un seul les monte dans l'ordre voulu. (Le canal, sixieme ligne, le budget de contexte, septieme, puis les lecons a la compaction, huitieme, ont ete ajoutes apres ; la decision, elle, n'a pas bouge) | construit, installe pour de vrai, **229 cas verts** a la racine (dont 51 du canal, 24 du budget de contexte et 12 des lecons a la compaction : le run racine collecte les suites des paquets, ne pas les additionner) |
| D2 | **Un depot** : `packages/` (sources), `docs/`, `tools/`, racine = le bundle | consolidation demandee ; le test anti-derive empeche l'agregateur et les sous-paquets de diverger | construit (`dsh-boost`) |
| D3 | Les sous-paquets gardent leur `dsh.bundle` (installables seuls) **et** l'agregateur insere les memes ids | aucune deduplication a l'insertion : installer les deux monterait chaque ligne **deux fois**. L'exclusion mutuelle est ecrite dans le README | construit |
| D4 | **Boost possede l'arbre ; AgentTeams n'est pas l'orchestrateur** | un membre AgentTeams ne peut pas porter notre filtre d'outils (`members.js:539`, code en dur) : on perdrait la seule barriere machine du marche. Et sa section hote coute **5 171 caracteres** dans le prompt de chaque agent non-membre | decide sur mesure |
| D5 | **Prendre l'idee, pas le plugin** : le verdict structure est a nous | la seule chose precieuse de leur cote est un **modele de donnees**, pas un runtime — et il rend les contradictions detectables (0/139 aujourd'hui) | decide |
| D6 | La garde anti-surrogate est une **remontee amont**, pas un plugin | DSH ecrit lui-meme « is not repaired here » ; `hermes-agent` place le meme chokepoint ; RFC 8259 §8.2 documente la classe | recommande, non lance |

### Le canal

| # | decision | pourquoi |
|---|---|---|
| D7 | **Tirer, pas pousser** : signal minuscule pousse, charge utile tiree | le push bourre le contexte du destinataire par construction ; un tour de mere coute ~28x une session mediane |
| D8 | **`kind` declare / `etat` derive** ; « urgent » n'est pas un niveau | `blocked`/`failed` se constatent, ne se declarent pas ; notre propre regle : « a model cannot judge the mode it is running in » |
| D9 | Les niveaux servent a **reveiller**, pas a livrer | 82,5 % des tours de la mere s'ouvrent sur un avis : le volume du canal **fixe** la facture |
| D10 | Six regles anti-brouillage (bornage dur, adressage, dedup par identite, un message n'est pas une affirmation, le destinataire peut dire stop) | 78 770 lignes de bruit pour 1 924 faits : 41 pour 1 |
| D11 | **La retrogradation** : le declaratif ne peut pas forcer un reveil que l'etat ne justifie pas | seule regle qui rende l'inflation d'urgence **inoperante** plutot que deconseillee |
| D12 | **Metrique de sante definie AVANT la premiere ligne** : livres / lus | 50 Mo d'instrumentation que personne ne lisait, et il a fallu une mesure pour s'en apercevoir |
| D13 | **Structurer l'enveloppe, jamais la charge utile** | une charge utile structuree est un resume par construction, et le protocole rejette un verdict sans preuve brute |
| D14 | Le **brief indexe** economise la recherche, pas la lecture | mesure A/B, n=3 : exploration −56 %, sortie −25 %, **entree +3 %**, hors-cache −8,4 % (dans le bruit) |
| D15 | Le degre de veracite loge dans une **valeur ajoutee a `ContextForm`**, avec son lecteur | `MessageSource` est merge-extensible, `source.kind` est **lu par le runtime** (`isOwned`) ; aucun champ de confiance n'existe ailleurs |
| D16 | L'exemption des verificateurs tient par le **provider**, pas par une persona | `subagent_verify` est deja en `provider: spawn` (zero contexte herite) ; une persona est une section de prompt, pas une barriere |

### Les autres briques

| # | decision | pourquoi |
|---|---|---|
| D17 | ~~Frein budgetaire par **arbre**, via `ctx.tools.guard()`~~ — **RETIRE le 2026-10-02** | **« je peux avoir plusieurs arbres independants »** : un frein local ne plafonne rien de global, il se contourne en ouvrant une session. Jamais construit. Remplace par D22 |
| D18 | ~~Le frein arrete de construire, jamais d'achever~~ — **RETIRE avec D17** | la regle reste juste, mais elle qualifiait un frein qui n'existe plus. Elle resservira si un plafond GLOBAL voyait le jour |
| D22 | **Alerte de debit GLOBALE en DOLLARS**, fenetre glissante d'une heure, deux seuils avec hysteresis, **elle n'empeche rien** | portee globale (tous arbres, tous processus, lue sur les journaux de session) ; le debit moyen sur l'heure tolere les pics par construction ; spec separee : `docs/ALERTE-DEBIT.md` |
| D19 | La **profondeur reste a 1** tant que le canal n'existe pas | un petit-fils muet serait indistinguable d'un agent bloque (silence mesure : p50 373 s, max 112 min) |
| D20 | **Ordre** : canal -> verdict a cible -> profondeur | chaque etape est la condition de lisibilite de la suivante |
| D21 | **Une seule edition du profil** puis un redemarrage | `dsh-hmr` surveille `package.json` et `cordis.patch.yml` : editer en cours de session force la relecture de toutes les couches |

---

## Partie 2 — Propositions RETIREES

| proposition | pourquoi elle est morte |
|---|---|
| **Fork borne** par une frontiere, pour un pere a ras | le seed est un **prefixe depuis seq 0** (`fork.js:19`, `slice(0, boundary+1)`) : borner jetterait les tours les plus **recents** et garderait les plus anciens — l'inverse de « continue mon travail ». Le levier reel est de **compacter avant de forker** |
| Predicat `tools.get('job_kill')` **sans portee** (ma prescription) | ne lit que la couche globale : aurait retire `run_detached` **dans la composition ou il fonctionne**. La bonne voie est l'objet agent comme cle de portee (`scopeOf(agent.ctx) === agent`) |
| Attacher notre propre **controleur de jobs** | au niveau hote il elargit l'admission a **tout le process** (pwsh, subagents d'arriere-plan, workflows) ; chez un worker il ne sert jamais la racine |
| Un **tableau partage** entre agents | aucune mesure ne montre de cout de **coordination** : le cout observe est de la **re-acquisition d'information** |
| Integrer Boost **dans** AgentTeams (roles = membres) | perdrait le filtre d'outils par role et la profondeur par role, qui n'ont **aucun equivalent** sur le marche |
| Un frein sur les **tokens bruts** | 97,08 % du volume est du cache relu, facture ~1/50 : la mesure porterait sur du vent |

---

## Partie 3 — Choix OUVERTS

### 1. La coupure du profil — **FAIT** (2026-10-01 01:57)
Appliquee, redemarree, verifiee (cf. Partie 5). Le journal du relais porte `via:"owner-can-collect"` :
c'est le format que **seul** le correctif ecrit — donc le code neuf est vivant, ce n'est pas une absence d'erreur.

### 2. Monter AgentTeams **a cote** de Boost ? — **DECIDE : NON**
Coherent avec D4 : **un seul orchestrateur, et c'est le notre.** La coexistence est techniquement prouvee
(zero avertissement, outils disjoints), mais elle coute **5 171 caracteres de protocole capitaine dans le
prompt de CHAQUE agent non-membre** — tes verificateurs compris, dont l'independance est toute la valeur.
Reouvrable en une commande si le DAG ou le panneau venaient a manquer : c'est justement pourquoi on ne le
monte pas par defaut — une ligne s'ajoute en une commande, elle ne se retire pas aussi facilement.

### 3. Remonter le defaut de la garde anti-surrogate en amont ? — **DECIDE : OUI · rapport ecrit**
`docs/UPSTREAM-SURROGATE.md` est pret a poster : impact mesure (3 journaux sur 182, ces 3 seuls, 0
contre-exemple), l'instance tracee avec ses enregistrements bruts, la couture `tools/post-execute` et son
precedent en arbre, la couture REJETEE (`llm/stream`, qui casserait l'invariant), le residu a sa vraie
taille, et une reproduction minimale. Reste : le poster.

### 4. Construire le canal ? — **FAIT, verifie PASS** (2026-10-01, cf. Partie 6)
Sept regles anti-brouillage tiennent, cinq falsifications successives, 184 cas racine et 51 au paquet.
Ce qui restait — que le canal SERVE — a demande une ligne de persona, pas du code.

### 5. Publier ? — **DECIDE : NON** (1er octobre)
Decision de l'utilisateur : **garder pour soi**, faire evoluer et stabiliser tranquillement, et ne partager
que le jour ou une **efficacite mesuree** serait etablie — en consommation, en justesse d'execution et en
stabilite. L'etude de marche reste au dossier (6 469 paquets `dsh-plugin`, un concurrent direct plus mur) :
elle sert de reference le jour ou ce seuil serait atteint.

### 6. `dsh-auto-update` dans le depot consolide ? — **DECIDE : NON**
Cinquieme plugin, **hors `CodeSource`** et hors git (`profiles/local-plugins/`) : c'est de l'infra de
harnais, pas du mode Boost. Il reste ou il est, et le HANDOVER le documente.

### 7. Que faire des cinq depots d'origine apres la coupure ? — **DEPLACE, purement archivistique**
Ils ne portent PLUS le code que le profil charge : depuis la coupure, le dump resout tout sous
`profiles\web\node_modules\@local\dsh-boost\packages\...`, c'est-a-dire par la jonction vers le depot
consolide. Chacun porte un `FROZEN.md` qui dit ou est la source qui fait foi. La question n'est plus
« quelle version est vivante » mais « garde-t-on l'historique git » — et personne n'a de distant.

### 8. Le seuil de compaction automatique — **ARBITRE : 0,85** (1er octobre, par l'utilisateur)

Le test anti-derive a arrete **deux configurations contradictoires pour la meme ligne** — et les deux
sont argumentees par des mesures :

```
packages/boost-mode/cordis.patch.yml:152-158   (PRUDENTE, retenue)
  defaut 0,8 -> 678 464 estimes -> jusqu'a ~790 000 reels sur du code = 79 % de la fenetre
  « Mesure : l'agent avait deja decroche a ce niveau (une session a repondu en CHINOIS a 792 000) »
  0,5 -> ~500 000 estimes ~ 550 000 reels : « la cible voulue »

cordis.patch.yml:144-179                        (DESSERREE, ecartee pour l'instant)
  seuil = floor(min(W x ratio, W - O - headroomTokens)), O = 256 000 -> plafond 744 000
  0,85 + headroomTokens 0 + maxTokens 32768 -> cible « ~85 % » de la fenetre, pour le COUT
  n'evoque PAS le decrochage observe a 792 000, qui est SOUS sa cible
```

**ARBITRE le 1er octobre par l'utilisateur : 0,85**, pour le COUT. Ses sessions sont devenues couteuses et
le taux bas y contribue — et le facteur entre les deux reglages vaut exactement 1,5x (744 000 estimes
contre 500 000), pour une compaction mesuree a ~309 000 hors cache (1 544 712 pour 5 declenchements).

```
dsh-llm-deepseek/lib/types/defaults.d.ts:5   DEFAULT_CONTEXT_WINDOW = 1000000
dsh-compaction-basic/lib/index.js:128         messageBudgetTokens = contextWindow - reservedCompletionTokens
                             :132             thresholdTokens = floor(min(contextWindow x ratio, pressureBudget))
0,85 -> min(850 000, 1 000 000 - 256 000) = 744 000 estimes   ~ 820 000 a 870 000 reels
0,5  -> min(500 000, 744 000)             = 500 000 estimes   ~ 550 000 a 585 000 reels
```

**La valeur vit dans les DEUX fichiers a l'identique** (l'agregateur est la copie vivante, le sous-paquet
en est la source) : `thresholdRatio: 0.85` + `headroomTokens: 0` + `maxTokens: 32768`.

**RESERVE NON LEVEE**, ecrite dans les deux blocs : un decrochage a ete mesure a 792 000 (79 % de la
fenetre) sous l'ancien reglage 0,8 — donc SOUS la cible de 85 %. Si une longue session derive, c'est le
premier suspect. Le seuil est mesurable RETROACTIVEMENT : la taille estimee au declenchement est lisible
dans `contextBreakdown` (validé a 0,25226 token par caractere), et 500 000 vs 744 000 se distinguent sans
ambiguite.

**Ce que ce revirement a appris** : le reglage « ecarte » n'etait pas un accident emporte par un
`git add -A` — c'etait une edition MANUELLE de l'utilisateur, faite dans un FICHIER SOURCE du depot
d'origine. Une seule intention, deux emplacements, dont un par megarde : de quoi croire a deux reglages
deliberes concurrents la ou il n'y en avait qu'un.


---

### 9. La garde du fork par occupation — **DESARMEE** (1er octobre), a reprendre

Deux falsifications successives ont refute la MESURE sur la vraie pile (vraie `Session`, vrai
`TokenMeter`, vrai `ToolRuntime`, vrai registre). La garde refusait un fork a 75 %, puis l'autorisait
apres la compaction que le plugin avait lui-meme armee — l'enfant heritant EXACTEMENT ces 75 %.

```
le fork tranche des POSITIONS DE JOURNAL   events.slice(0, lastEnd.seq + 1)
la mesure lisait des PROJECTIONS           prefix-usage s'arrete au dernier echantillon du
                                            fournisseur, DONC AVANT les tool/result du tour clos ;
                                            la surface est detruite par une compaction posterieure
                                            -> LES DEUX VUES TOMBENT ENSEMBLE, un max ne protege de rien
mesure inverse, aussi observee             : 70 000 herites annonces pour 5 tokens de surface close
```

Le harnais lui-meme emet cette operation : `dsh-compaction-tool-result-pruner` ecrit
`surfaceOp:{op:'replace', startSeq, endSeq}` sur un `tool/result` — ce n'est pas un cas d'ecole.

**Ce qui est fait** : la ligne est DESARMEE (`disabled: true`, verifie sautee au chargement par
`dsh-app-boot/lib/index.js:3134`), dans les deux patches a l'identique. Le code, les 30 cas et la sonde
restent en place.

**Pourquoi desarmer plutot que laisser** : elle echouait OUVERTE (elle laissait passer ce qu'elle venait
de refuser) et fermait A TORT dans l'autre sens — au prix d'une compaction a ~309 000 hors cache. Un
garde qui ne garde pas est pire qu'aucun garde, parce qu'il rassure.

**Ce qui la rendrait juste** : mesurer **les evenements du prefixe que le fork tranche**, pas une
projection. Le fait est etabli (`completedTurnPrefix` rend le prefixe complet meme apres compaction), la
source manque. **Et l'exposition du nom demeure** : la garde s'indexait sur `exec.name`, une valeur de
configuration — le verificateur a identifie un AUTRE point de coupure ou le fournisseur est connu
(`ctx.subagents.registerProvider`, et `inheritsParentContext = true` sur le provider du fork), qui
reconnaitrait ce qui herite par une PROPRIETE et non par un nom.
**RESOLU le 1er octobre, en fin de journee** — trois falsifications, trois defauts reels, puis la mesure juste.

```
1re version : somme des noeuds de SURFACE retenus  -> REFUTEE (la compaction les retire : mesure a 0,
              la garde S OUVRAIT sur le fork qu elle venait de refuser)
2e version  : max(surface, prefix-usage)           -> REFUTEE (les DEUX vues tombent ensemble)
3e version  : restore(...) borne a la frontiere    -> l EGALITE tient contre un ENFANT REEL,
              reproduite sur la session 018354d9 aux cuts 1821/3332/5898
defaut final: le REPLI rendait un chiffre faux (13 849 au lieu de 542 393, sous-mesure 39x)
              -> EFFACE du code. Quand restore manque ou jette : NULL, verdict unknown,
                 fork-unguarded why/error, et LA GARDE S ABSTIENT.
```

**Et la garde ne s'indexe plus sur un nom** : elle enveloppe `start`/`prepareContinuable` des providers dont
`inheritsParentContext === true`, au seam `subagent/provider-added`. Un provider renomme qui herite est
refuse, parce qu'il herite — mesure. `forkToolNames` reste un repli.

**Mesure en direct sur la session racine, apres montage :**

```
inheritedTokens : 440 633   windowTokens : 1 000 000   ratio : 44,06 %   seuil : 60 %   verdict : OK
sources : inherited=restore-boundary  window=context-pressure  frontiere seq=6057
```

**Ce que la garde protege, mesure** : le fork transmet le PREFIXE CLOS du pere — son journal jusqu'au
dernier `turn/end`. Une compaction **close** est donc DANS ce prefixe, et l'enfant qui en nait voit la vue
**compactee**. Mesure sur `018354d9` : les trois compactions ferment a 1822, 3441 et 4532, chacune avant
une frontiere, et les deux cuts posterieurs donnent l'accord (438 501 contre 439 662 ; 437 564 contre
424 115).

**L'exception est etroite** : un fork pris PENDANT le tour ou le pere vient de compacter — la compaction
est encore dans le tour en vol, donc apres la frontiere, donc absente du prefixe. La seulement, l'enfant
herite de l'histoire d'avant (surface vive 16 898 contre heritage 541 857). Un fork pris au mauvais moment,
pas le cas normal.

**La vraie raison d'etre de la garde** n'est donc pas « l'enfant herite plus que le pere » : c'est que le
prefixe herite est **grand** (440 633 dans cette session), et qu'un enfant forke qui compacte a son tour
relit ce prefixe **au prix plein**. Mesure du corpus : **360 000 a 584 000 hors cache** par compaction
d'enfant forke, contre une mediane de **5 933** pour une racine. Elle protege l'enfant d'une depense qu'il
n'a pas demandee.


---

---

## Partie 7 — Les points de suspension, eprouves (1er octobre, 19 h)

### Le FORK REEL — jamais exerce avant ce soir

```
le pere mesure     : 463 106 tokens · 46,31 % · frontiere seq 6114 · verdict ok · restore-boundary
la garde           : LAISSE PASSER  (elle n'avait jamais dit `ok` en vrai)
l enfant re-mesure : 463 106 tokens · 0,463106 · frontiere 6114      -> DELTA = 0 TOKEN
l heritage est PROUVE : l enfant cite trois faits qu il n a pas pu lire sur le disque
                        (dernier commit a07e302 · 217 cas racine / 32 au paquet · le nom de la garde)
```

L'egalite `mesure == ce que l'enfant recoit` est desormais verifiee **du cote de l'enfant**, sur un vrai
fork — et non plus contre une `Session` fabriquee pour un test. C'est la seule verification possible de
cette egalite, et elle est faite.

### Les BORNES DU CANAL — mesurees a zero toute la journee, enfin exercees

```
7 avancements du meme enfant : 2 injected (budget ordinary 1 -> 0), 5 throttled
l enfant lit                 : count=0                          -> l adressage tient
le proprietaire tire         : count=10, les SEPT sont la       -> rien n est perdu
compteurs                    : posted=7  delivered=2  throttled=5  throttled_by_sender={ffc98724:5}
```

La borne mord **a 2 par emetteur**, exactement comme concu ; le refus est **stocke et tirable** ; et le
bavard est **nomme**. C'est la regle du §2 tenue de bout en bout : *borner par construction, puis rendre
visible ce qui survit quand meme.* Le proprietaire n'a recu que **deux lignes** pour sept messages.

### Ce qui RESTE ouvert, et qu'un test ne fermerait pas

- **Les quatre constantes du jeton** (300 s · 2 · 4 · 3) ne se calibrent que sur des **jours de trafic
  reel**. Un test les validerait contre des chiffres inventes.
- **Multi-process** : « jamais perdu » est FAUX — une course a deux processus fait echouer `channel_post`
  en `EPERM` (7 sur 342 en configuration par defaut). Limite declaree, non reparee.

### Et un fait du HARNAIS, mesure au passage — **AFFIRME A TORT, puis CORRIGE le 2 octobre**

**Ce qui a ete affirme** : « le fork tranche le journal BRUT, donc un pere compacte transmet a son enfant
**plus qu'il ne detient** — surface vive 16 898 contre heritage 541 857, soit **32x** ».

**Pourquoi c'etait faux** : une compaction CLOSE (son `compaction/end` precede une frontiere) est DANS le
prefixe que le fork transmet, et la surface de l'enfant l'applique — **l'enfant voit la vue compactee**.
Mesure sur `018354d9` : les trois compactions ferment a **1822, 3441 et 4532**, chacune avant une
frontiere ; les deux cuts posterieurs donnent l'accord (**438 501** contre **439 662** ; **437 564** contre
**424 115**).

**Ce qui est vrai, et plus etroit** : le 32x existe **uniquement** pour un fork pris pendant le tour ou la
compaction est encore **en vol** — absente du prefixe, donc invisible pour l'enfant. C'est reel (c'est le
cas qui a defait la premiere version du garde), mais ce n'est pas le cas normal.

**Fautes commises, ecrites ici pour ne pas les refaire** : (a) j'ai cite **le seul cut divergent sur
trois** — les deux autres montraient l'accord, et je ne les ai pas mentionnes ; (b) j'en ai tire une regle
trop large, « ne pas forker apres une compaction », alors que la bonne est **« ne pas forker dans le tour
meme ou l'on compacte »** ; (c) j'en ai tire une explication du COUT qui n'en avait pas besoin — la
compaction d'un enfant forke est chere parce que le prefixe herite est **grand** (~440 000 tokens), pas
parce qu'il serait non compacte.

**La correction n'est pas venue d'une mesure mais de l'utilisateur**, qui a dit « ca n'a pas de sens ».
Il a fallu trois commandes pour l'etablir. C'est le seul defaut de cette serie qu'aucun verificateur n'a
trouve.

## Partie 4 — Ce qui est etabli, quoi qu'on decide

```
le livrable est installable et installe pour de vrai (une commande, huit lignes, chacune une fois)
la documentation est consolidee, les defauts mesures corriges, 231 cas verts a la racine
la coupure est ecrite et eprouvee sur un clone
les mesures du corpus : 97,08 % de cache, 86 % de vacance de l'arbre, 0/139 contradictions,
                        silence p50 373 s, 8,2 % de refus de capacite
```

Et cinq mecanismes sans equivalent trouve sur le marche — **quatre construits, un seulement concu** :

```
CONSTRUITS et vivants : le job possede par la racine (detached-jobs, porte du proprietaire)
                        le relais adaptatif (journal borne, avis de reglement)
                        la garde anti-surrogate (montee, 26 cas, journal de reparation)
                        la garde du fork par occupation (7e ligne : exposition + refus + compaction
                          differee ; admission MESUREE a la couture du registre)
RETIRE le 2026-10-02    : le frein hors cache par arbre. Il n'a jamais ete construit, et l'argument
                        qui le tue est decisif : plusieurs arbres independants -> un frein local ne
                        plafonne rien. Remplace par une ALERTE GLOBALE en dollars (D22,
                        `docs/ALERTE-DEBIT.md`) qui, elle, n'empeche rien.
```

**Et une lecon transverse, payee cinq fois en une journee** : les defauts ne vivent pas dans les
composants, ils vivent dans les COUTURES — l'adressage applique au stockage et pas a la lecture, le reveil
decide au depot et jamais a l'arret, la frontiere des arguments en passoire, la place qui fuit quand la
rotation reemet un identifiant, deux sondes qui ne mesuraient plus rien, et un schema de sortie qui ne
declare pas un champ rendu. Aucun test unitaire ne les voyait : il fallait exercer la couture.

Les trois construits sont des lignes hote : leur sort ne depend **pas** des choix ci-dessus.

---

## Partie 5 — La coupure, appliquee le 2026-10-01 a 01:57

**Appliquee et verifiee sur disque** :

```
profil web/package.json : 5 dependances -> 2 (agregateur + auto-update)
                          8 bundles -> 6 (+ @local/dsh-boost, + schedule-bundle)
cordis.patch.yml        : 104 -> 98 lignes (time-context, schedule, ui-schedule purges)
jonction                : node_modules/@local/dsh-boost -> C:\CodeSource\dsh-boost
dsh --profile web --dump-config : 0 avertissement, les cinq ids presents une fois chacun
```

**Ce que le rechargement a chaud a fait, et n'a pas fait — mesure** :

```
A FAIT   : monte les lignes NEUVES — les outils schedule_* sont revenus dans ma propre surface
           (ils avaient disparu au passage en 0.2.0), et la garde est entree dans la composition
N'A PAS  : remplace le code d'une ligne DEJA montee. Preuve : apres la coupure, un agent cree
FAIT       trace {"step":"registered","id":…} — l'ANCIEN format ; le code neuf ecrit
           {"step":"registered","id":…,"root":…,"via":"owner-can-collect"}
```

C'est la regle du cache ESM, desormais **demontree sur ce cas precis** : `patchReload: live` recompose la
liste des couches, il ne recharge pas le code d'un module deja importe.

**Consequence : un redemarrage reste necessaire** pour charger le correctif `detached-jobs`, faire
monter la garde pour de vrai, et faire lire les cinq lignes depuis le depot consolide. Ce n'est plus une
precaution : c'est mesure.

**Sauvegardes** (retour arriere en une copie) : `package.json.20261001-015721.bak` et
`cordis.patch.yml.20261001-015721.bak`, dans le profil `web`.

---

## Partie 6 — Le canal de retour, verifie le 2026-10-01

**Cinq falsifications successives**, chacune sur une revision GELEE, chacune avec sa sortie brute.
Verdict final : **PASS**. Racine 184 cas, paquet 51, deux sondes vertes.

### Ce que les falsifications ont detruit, et qui est corrige

| # | defaut trouve | corrige par |
|---|---|---|
| 1 | l'ADRESSAGE n'etait applique qu'au STOCKAGE, pas a la LECTURE : un agent voyait les resumes de ceux qu'il devait contredire | la lecture ne rend que ce qui est adresse a l'appelant (`read_refused`) |
| 2 | le REVEIL etait decide au DEPOT — donc jamais : `channel_post` EST un appel d'outil, l'emetteur est `running`, et les lignes `question`+`blocked` / `resultat`+`done` du §4 etaient du code mort | re-evaluation differee a l'ARRET (`turn/end` + `agent/disposed`, les deux mesures) |
| 3 | la FRONTIERE DES ARGUMENTS etait une passoire : un `to` ou un `root` non declare ecrivait dans le magasin d'un AUTRE arbre et ouvrait un tour de son proprietaire | seules les cles declarees sont lues ; les autres sont ignorees et journalisees |
| 4 | une PLACE RESERVEE fuyait : la rotation reemettait un id, `markPending` ecrasait la place du precedent, et la `question` d'un frere INNOCENT etait refusee — l'etat exact que la bourse reservee existe pour empecher | `load()` fusionne la generation, identite monotone par emetteur, collision refusee avant toute consommation |
| 5 | DEUX SONDES NE MESURAIENT PLUS RIEN (celle du reveil executait ZERO mesure depuis l'ajout d'un troisieme outil) et personne ne l'avait vu | `TOOL_NAMES` source unique, consommee par le code, les tests ET les deux sondes ; un 4e outil fait rougir la SUITE |

### Les limites mesurees, ecrites et non cachees

- **Multi-process : « jamais perdu » est FAUX.** Une course reelle a deux processus fait echouer `channel_post` en `EPERM`/`ENOENT` — 27 echecs sur 342 depots en configuration hostile, **7 sur 342 en configuration par defaut**, sur les DEUX revisions. Cause : le `.tmp` porte un nom fixe partage, sans verrou. (`withFileLock` existe, non utilise.)
- **`writeAll` sans `merged` rend un message DEUX FOIS** — jamais perdu, mais duplique. Atteignable seulement par le descripteur interne (`storeFor(root).writeAll(...)`), pas par la surface des outils ; 0 doublon en ~500 operations et en course reelle.
- **Un reveil en attente n'est jamais repris par un processus neuf** : la marque monotone et l'index des attentes vivent en memoire. L'ancien processus mort, ce reveil n'est decide par personne.
- **Aucun nombre n'est calibre sur une mesure de trafic reel** : les 300 s, les 2/4/3 des bourses, les 2000 caracteres et le N=50 sont des valeurs de depart. Les compteurs (`throttled`, `filtered`, `wake_sent`, `wake_refused`) rendent le reglage mesurable ; ils ne le mesurent pas.

### Ce qui reste avant que le canal SERVE

Le canal est monte, borne, filtre, verifie, **et les personas le nomment** depuis le 2026-10-01 : une
ligne au capitaine (« tire-le avant de declarer une etape finie »), une par role (« si la tache depasse
quelques minutes, publie un avancement quand tu changes de phase »). Cout : ~870 caracteres, contre les
**5 171** du protocole AgentTeams refuse a D4.

**Mais la mesure du premier jour est un ZERO** : sur deux enfants (taches de ~2 minutes), aucun depot.
Et c'est *correct* — sur une tache courte, l'avis de reglement EST le rapport. Le dispositif n'a de valeur
que la ou le pere est aveugle : au-dela de quelques minutes (silence p50 mesure : **373 s**, max **112 min**).
La premiere consigne, une disposition (« declare ce que tu trouves au fil de l'eau »), n'a rien produit ;
elle est devenue un **declencheur** (« si la tache depasse quelques minutes »). Ce qui reste a etablir :
qu'un enfant s'en serve, et ce que cela coute.



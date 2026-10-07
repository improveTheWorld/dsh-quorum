# Reprendre ici — etat au 2026-10-02

Document de PASSATION. Court et actionnable : ce qu'une session neuve doit faire en premier, ce qui
est verifie, et les pieges qui ont coute du temps. Le detail est dans `HANDOVER.md` ; les choix et
leurs mesures dans `DECISIONS.md`.

---

## 1. En une ligne

`C:\CodeSource\dsh-boost` est le depot consolide du mode Quorum : **dix lignes** montees par un seul
bundle installable. Le profil `web` pointe dessus. Etat : **283 cas a la racine, 0 echec**, arbre propre
(`git log -1` pour le HEAD — un compte ecrit ici perime a chaque commit).

```
les dix lignes, dans l'ordre :
  preset-quorum-ptc · preset-quorum-standard · preset-quorum-shell ·
  boost-job-relay · boost-status-command · dsh-detached-jobs ·
  dsh-guard-surrogate · dsh-boost-channel · dsh-boost-context-budget · dsh-boost-lessons
```

---

## 2. A FAIRE EN PREMIER — dans cet ordre

### 2.1 Redemarrer le harnais

Le code de deux paquets a change APRES leur montage : **le cache ESM ne relit pas un module.** Un
process neuf charge tout depuis le disque. Ce que le redemarrage apporte :

```
boost-context-budget : la compaction est devenue une DEMANDE (outil `context_compact`),
                       un refus n'arme plus rien
boost-lessons        : la TRACE DE MONTAGE (le signal positif qui manque aujourd'hui)
```

### 2.2 Verifier le montage — deux signaux, pas une supposition

```powershell
dsh --profile web --dump-config     # 0 "not found", les huit ids UNE fois chacun
Get-Content "$env:USERPROFILE\.dsh\plugin-data\dsh-boost-lessons\decisions.jsonl"
# doit porter {"step":"mounted","floor":2000,"reseeded":0,...}
```

La trace de montage est le seul signal POSITIF. Sans elle, « la ligne figure au dump » ne prouve rien :
un dump liste les lignes `disabled`, et une ligne ajoutee a un bundle n'est montee qu'au refresh.

### 2.3 La premiere mesure qui manque

`plugin-data\dsh-boost-lessons\compactions.jsonl` : il se remplira a la **premiere compaction de
racine**. Il repond a la question qui decide de l'etape suivante : **a quelle frequence cela se
declenche-t-il ?** Mesure RETROACTIVE sur le corpus : ~**2,6 par jour**, matiere mediane **517 611
tokens**. Si la ligne est montee, le compte reel commencera a s'ecrire tout seul.

### 2.4 Deux documents perimes, signales et NON corriges

```
README.md:117,171   et   docs/HANDOVER.md:276   annoncent encore 32/32 pour boost-context-budget
                    (il en a 36) et l'ancien comportement (la compaction automatique au refus)
```

---

## 3. Ce qui est VERIFIE (mesure, pas opinion)

```
les dix lignes montees, 0 avertissement        dsh --profile web --dump-config
283 cas a la racine, 0 echec                     node --test  (le run racine COLLECTE les paquets)
CINQ sondes vertes                              probe-stop · probe-mount · probe-fork-guard · probe-lessons
                                                · probe-owner-gate
le canal, en service                             3 usages reels ; bornes exercees (2 livres / 5 throttles)
la garde du fork                                 egalite a DELTA 0 TOKEN sur un fork REEL
le fork reel                                     46,31 %, verdict ok, l'enfant re-mesure 463 106
```

**Un test vert ne prouve pas sa portee.** Lire ce qu'un test compare avant de s'y fier : celui de
l'anti-derive compare la LIGNE entiere hors `name` (un `disabled: true` faisait passer une ligne
racine au vert avant qu'on l'etende).

---

## 4. L'effort : le knobs unique, et ce qui ne suit PAS

Mesure du 2026-10-03, quand la ligne du profil et la session vivante ont diverge pour la premiere fois.

```
LA LIGNE `agent-default-model.config.reasoningEffort` (profil) est le DEFAUT
  -> un ENFANT NEUF la prend : la ligne disait `low`, ma session disait `high`, et l enfant
     lance a l instant a recu `low`. Mesure sur son propre `request/header`.
  -> les SESSIONS FUTURES aussi.

UNE SESSION VIVANTE garde sa route : la ligne disait `low` depuis 13:27, mon entete disait
  `high` a seq 7330. Un changement de la ligne ne la traverse pas.
  -> pour reprendre une session en cours, passer par le SELECTEUR.
```

**Le selecteur de l'interface ECRIT dans cette ligne** : `saveSelection` fait
`configEditor.edit(entree, ...)` (`dsh-agent-default-model/lib/index.js:53-66`). Changer le selecteur
d'une session change donc le **defaut des autres** — et c'est ce qui a rendu ma premiere conclusion
fausse : tant que la ligne et la session portent la MEME valeur, « l'enfant suit le pere » et
« l'enfant suit la ligne » predisent exactement la meme chose. Le jour ou elles divergent separe les
deux hypotheses. **Mesure-les, ne deduis pas du code.**

### Et la hierarchie des paliers, du cote du modele

```
low = 50   high = 75   max = 100        (encodeur officiel : REASONING_EFFORT_MAPPINGS)
le defaut du harnais et de l API est `high`
l'effort n'est PAS un cadran de calcul : c'est un NOMBRE ECRIT DANS LE PROMPT
  (« Reasoning Effort: {budget} (range 1-100, the higher the value, the more thorough the
    reasoning) »), rendu au premier message, en mode thinking seulement
```
Le rapport technique officiel (arXiv 2609.19969, §B.2/B.3) dit que l'effort fait monter la LONGUEUR
monotonement, et que la justesse **correle faiblement** — avec des plateaux et des creux aux reglages
intermediaires. Ce n'est donc pas une echelle de qualite.
## 5. Les pieges — chacun a coute une passe

**Le cache ESM decide de ce qui est vivant.** Un fichier ecrit n'est pas un fichier charge. Un process
neuf, ou une ligne NEUVE au refresh — jamais le code d'une ligne deja montee. Trois fois en deux jours.

**Un patch de bundle modifie seul n'est JAMAIS relu.** `dsh-hmr` ne surveille que le patch du profil,
son `package.json` et `$DSH_HOME/cordis.patch.yml`. Toucher le patch du profil force le refresh.

**Un dump n'est pas un montage.** Il liste des lignes `disabled`, et `--dump-config` montre la config
composee, pas l'etat du process.

**Les fins de ligne different.** Le patch RACINE et celui de `boost-mode` sont **CRLF** ; les sept
autres patches de paquets sont **LF**. Ne jamais editer par decoupage/recollage sur `\n` : un `\r` s'est
deja retrouve au milieu d'une phrase.

**Un test lance sur un arbre qui bouge ne mesure rien.** Vu en direct : `230/1 -> 223/8 -> 224/7 ->
235/235` pendant qu'une autre session editait le meme paquet.

**Une surcharge de preset depuis le profil REMPLACE la config en bloc** (`target[key] = value`, « config
is replaced wholesale, not deep-merged »). Les lignes internes (`persona`) ne sont pas adressables.

**La mesure est l'endroit ou vivent les erreurs.** Douze fois en deux jours, un chiffre etait juste et sa
LECTURE fausse — un en-tete vide qui fait passer toutes les sessions pour des racines, deux fois de
suite ; trois cuts mesures dont un seul cite ; les fins de ligne generalisees a tort a huit fichiers.
**Regle ecrite dans les personas et dans AGENTS.md : les outils mesurent, le raisonnement juge.**

---

## 5. Les choix OUVERTS

```
l'extracteur de lecons (etape 3)   la frequence se mesure ; la QUALITE des lecons reste a prouver
l'alerte de debit en dollars        spec ecrite (ALERTE-DEBIT.md), RIEN de construit
les 4 constantes du jeton          a calibrer sur des JOURS de trafic reel
multi-process                      « jamais perdu » est FAUX (7 echecs sur 342) — limite declaree
la remontee amont                  le demi-caractere UTF-16 : ecrite, pas postee
archiver les cinq depots d'origine purement archivistique — ils portent un FROZEN.md
```

---

## 6. Les documents

```
HANDOVER.md            la reference : installation, coupure (§11 FAITE), inventaire, recettes
DECISIONS.md           7 parties : 22 decisions mesurees, 6 propositions RETIREES, les choix ouverts
CANAL.md               la conception du canal de retour (7 regles, la table du reveil)
LECONS.md              la spec des lecons a la compaction (coutures mesurees, cinq pieges)
ALERTE-DEBIT.md        la spec de l'alerte globale en dollars
EVOLUTIONS.md          le plan, instruit par la mesure du corpus
UPSTREAM-SURROGATE.md  la remontee de defaut, prete a poster
PLAN.md · PROTOCOL.md  documents d'epoque, dates
```

---

## 7. Pour continuer le travail

Le seul chiffre qui manque aujourd'hui est la **frequence reelle des compactions de racine**. Il
decide si les lecons sont un outil ou une usine. Il s'ecrit tout seul — il suffit que la ligne soit
montee et qu'une compaction survienne.

Ensuite, dans l'ordre que `DECISIONS.md` propose : **les lecons** (etape 3), puis **l'alerte de debit**.
Et pour toute nouvelle mesure : ecrire la trace d'abord, formuler l'hypothese ensuite.

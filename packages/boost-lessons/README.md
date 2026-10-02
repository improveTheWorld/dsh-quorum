# dsh-boost-lessons — les lecons a la compaction, ETAPE 1

**Huitieme ligne de l'agregateur** `@local/dsh-boost`. Elle ne fait qu'une chose :
**JOURNALISER chaque compaction de RACINE**, pour repondre a la seule question qui manque avant de
construire l'extracteur — *a quelle frequence cela se declencherait-il ?*

    aucun appel de modele     aucun enfant     aucune depense     aucune surface d'outil

La specification est `docs/LECONS.md` ; ce paquet en realise l'etape 1 du §8.

---

## 1. Ce que la ligne fait, et pourquoi chacune des coutures

| # | decision | mesure qui la fonde |
|---|---|---|
| 1 | listener sur `session/event`, **SANS TAG** | un listener non tague recoit les evenements de TOUTES les sessions, racines ET enfants (`dsh-scope/lib/index.js:329-335`, `if (tag === void 0) return true`) : c'est le seul point qui voie les deux sans plomberie |
| 2 | filtre sur `event.type === 'compaction/summary'` | c'est l'instant ou LE RESUME EST DANS L'EVENEMENT et ou la surface n'est PAS encore remplacee. Ordre mesure, session `018354d9` : 1818 start -> 1820 summary -> 1821 replace -> 1822 end |
| 3 | filtre sur `session.header.parentSession === undefined` | RACINES SEULEMENT. Le marqueur est `parentSession`, **PAS la profondeur** : une session mesuree porte `parentSession` AVEC `delegationDepth: 0`, donc tester la profondeur prendrait un enfant pour une racine. C'est ce filtre qui ferme la recursion (un enfant de profondeur 1 a compacte seul) |
| 4 | plancher de matiere `summaryFloorChars`, **2000** par defaut | valeur de DEPART, pas une calibration (`docs/LECONS.md` §7) : les resumes du corpus font en moyenne **12 896** caracteres, donc 2000 laisse passer la quasi-totalite des compactions de racine reelles — c'est voulu pour la premiere mesure |
| 5 | dedup par **`compactionId`**, jamais par session | un enfant forke porte les MEMES ids que son pere (le seed ne republie pas, `dsh-session/lib/index.js:1273`) |
| 6 | une ligne JSONL par compaction **retenue**, append-only, rotation d'une generation | meme couture que le journal du canal (`packages/boost-channel/lib/index.js:601-620` et `:728-747`) |

### L'exigence premiere : le listener ne peut pas casser une session

L'invocation est **SYNCHRONE** : `Session.append` resout puis invoque les listeners a la main, sans
`await` (`dsh-session/lib/index.js:1466-1473`). Le corps du listener est donc **entierement
protege** : aucun chemin ne peut lever — ni un disque plein, ni un chemin invalide, ni un JSON
imprevu, ni une charge utile absente, ni un getter hostile. Une erreur d'ecriture est **comptee**,
deposee dans un **repli best-effort** (`compactions.jsonl.failed.jsonl`) qui ne leve pas lui non plus,
et le pire cas est un silence. Un journal qui casse la session qu'il observe est pire que pas de
journal.

---

## 2. Le journal

`$DSH_HOME/plugin-data/dsh-boost-lessons/compactions.jsonl` — une ligne par compaction de racine
retenue, jamais deux fois le meme `compactionId`. Extrait **brut** d'une execution reelle du probe :

```json
{"at":"2026-10-02T17:17:01.270Z","session":"session-probe-root","cwd":"C:\\CodeSource\\dsh-boost","compactionId":"8073f4c0-dbc9-4c4b-b86e-26a6a9175037","turn":null,"summaryChars":11786,"rawOutputChars":520,"shadowedSeqs":[1,2,3,345],"reason":"root-summary-above-floor"}
```

| champ | sens |
|---|---|
| `at` | date ISO de l'observation |
| `session` | l'id de la session RACINE, rendu sur (`safeKey`) |
| `cwd` | `session.header.cwd` — la seule cle d'attribution disponible DANS l'evenement (classe (b) de la spec), `null` si absente |
| `compactionId` | l'identite de la compaction — **la** cle de dedup |
| `turn` | le tour, ou `null` : il est **absent** des charges utiles reelles mesurees, et un tour invente serait un fait invente |
| `summaryChars` | le nombre de CARACTERES du resume. La forme reelle est `ContentBlock[]` (1 bloc `{type:'text'}` de 11 786 caracteres dans le corpus) : le comptage concatene le TEXTE, il ne compte pas les blocs |
| `rawOutputChars` | idem pour `rawOutput` (0 s'il est absent) |
| `shadowedSeqs` | les seqs ombres, entiers seulement — de la METADONNE, jamais la charge utile |
| `reason` | `root-summary-above-floor` : le token stable qui dit pourquoi la ligne existe |

### La trace de montage — `decisions.jsonl`

Meme repertoire, une ligne **par montage**, ecrite par `apply` **au montage** et jamais a la premiere
compaction :

```json
{"at":"2026-10-02T17:31:02.114Z","step":"mounted","floor":2000,"reseeded":0,"log":"C:\\Users\\bilel\\.dsh\\plugin-data\\dsh-boost-lessons\\compactions.jsonl"}
```

| champ | sens |
|---|---|
| `step` | `mounted` — le seul pas de cette ligne |
| `floor` | le plancher **effectif** (celui de la configuration, pas le defaut du module) |
| `reseeded` | le nombre d'identites re-amorcees depuis le journal **a cet instant** : c'est ce qui prouve que la re-amorce a tourne |
| `log` | le journal observe |

Pourquoi elle existe : **une configuration presente au `dump-config` ne prouve pas qu'une ligne est
montee** (mesure du 2026-10-02 : une ligne `disabled` y figurait, et un remaniement n'avait pas ete
charge par le processus vivant). Sans trace, un listener mort et un listener vivant se ressemblent —
un controle qui ne se declenche pas ressemble a un controle qui passe. Cette ecriture est soumise a la
**meme regle** que les autres : repertoire impossible a creer ? on abandonne en silence, l'echec est
compte (`mount_failed`) et **le montage tient**.

**Rotation** : avant chaque ecriture, si `taille + ligne > plafond` (1 Mio par defaut), le fichier est
renomme en `compactions.jsonl.1` — une generation gardee, la plus ancienne ecrasee. Le **re-amorcage
lit les DEUX** generations : ne lire que l'actif ferait reecrire un `compactionId` qu'une rotation vient
de renommer (le defaut qui a coute une passe au canal).

**Re-amorcage au montage** : l'ensemble des `compactionId` vus vit en memoire et est relu du journal
(les deux generations) au montage. Un redemarrage ne rejoue donc pas ce qui est deja ecrit.

### Compteurs (`boostLessons.stats`, en memoire, jamais ecrits)

`events`, `summaries`, `retained`, `skipped_child`, `skipped_no_header`, `skipped_no_payload`,
`skipped_below_floor`, `skipped_no_id`, `skipped_duplicate`, `write_failed`, `fallback_failed`,
`contained`, `mount_failed`, `reseeded`, `floor_invalid`. Le service `boostLessons` porte aussi `errors` (un
releve borne a 20 entrees) : c'est le repli qui ne peut pas echouer, et c'est ce qui rend un echec
d'ecriture **observable** au lieu d'invisible.

Chaque raison est un compteur distinct : un evenement ecarte ne disparait pas en silence, il est
compte. Un `compaction/summary` **sans `compactionId`** n'est PAS journalise — on ne peut pas dedupliquer
ce qu'on ne peut pas identifier, et le compter deux fois dans le cas du fork serait pire.

---

## 3. Configuration

| cle | defaut | sens |
|---|---|---|
| `summaryFloorChars` | `2000` | plancher de matiere, en caracteres de resume. `0` retient tout ; une valeur invalide est comptee (`floor_invalid`) et remplacee par le defaut |
| `home` | `$DSH_HOME` | racine du journal — une couture de test, jamais posee par le patch |
| `maxBytes` | `DSH_BOOST_LESSONS_LOG_MAX_BYTES` ou 1 Mio | plafond du journal, couture de test du chemin de rotation |

La ligne ne declare **aucune injection** : elle ne lit aucun service, donc rien ne peut retarder son
montage ni le faire echouer sur un service absent. Elle **fournit** `boostLessons` (le controleur).

---

## 4. Lancer les tests et la sonde

    node --test packages/boost-lessons/test/lessons.test.mjs
    node packages/boost-lessons/tools/probe-lessons.mjs

* les **14 cas** T-L1..T-L10 tiennent le filtre, le plancher, la dedup, la rotation, le re-amorcage,
  la **trace de montage** (T-L9 : le plancher effectif et un `reseeded` REEL, pas une constante) et les
  trois formes d'echec d'ecriture — chemin inecrivable, ecriture refusee sur le fichier lui-meme, et
  repertoire de trace impossible (T-L10 : le montage ne leve pas et rien n'est ecrit) ;
* le **probe** monte une VRAIE application cordis et de VRAIES `Session` (`@deepseek-ai/dsh-session`),
  et mesure de bout en bout : une racine ecrit, un enfant non (avec son temoin), le fork ne double
  pas, le plancher tient, l'imprevu ne leve pas, le journal inecrivable ne propage rien — et un
  **controle de vivacite** prouve que l'absence d'alerte de log veut dire quelque chose (un listener
  qui jette pour de vrai EST vu par le meme exportateur).

### Falsification

Sur une copie jetable, retirer la protection du corps du listener (le `try/catch` de `note`) et
relancer le cas T-L5 : il doit ROUGIR. Sans lui, la levee remonte dans l'enveloppe du harnais — qui la
journalise, et, sur un contexte sans logger, la laisse echapper de `Session.append` elle-meme.

---

## 5. Ce que ce paquet ne fait pas, et pourquoi

L'**extracteur** (un enfant qui lit le resume et propose des lecons) est l'etape 3 de la spec : il
coute un modele par compaction, et cette ligne existe precisement pour savoir combien de fois il
tournerait avant de le construire. Rien ici n'exige un outil : si la suite en demande un, ce sera une
decision, pas un glissement.

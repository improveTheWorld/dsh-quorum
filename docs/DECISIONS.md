# Decisions — etat au 2026-09-30

Registre des decisions prises pendant la conception, **avec la mesure qui les a fondees** et les
propositions **retirees** (un registre qui cache ses revirements est un document qui ment).

---

## Partie 1 — Decisions prises

### Le livrable

| # | decision | pourquoi | etat |
|---|---|---|---|
| D1 | Le livrable est un **bundle agregateur** : un paquet, un `cordis.patch.yml`, cinq lignes | `dsh-app-boot` fait `data.push(...insert)` sans deduplication : cinq bundles monteraient chaque ligne une fois — un seul les monte dans l'ordre voulu | construit, installe pour de vrai, 132 cas verts |
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
| D17 | Frein budgetaire sur **entree non cachee + sortie**, par **arbre**, via `ctx.tools.guard()` | compteurs disjoints verifies sur 30 894 enregistrements ; la garde est monotone, « no guard can force-allow » ; le cache pese 92 % des tokens et 11 % de la facture |
| D18 | Le frein arrete de **construire**, jamais d'**achever** | couper une verification en cours produit un verdict faux, pire qu'un depassement |
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

### 1. La coupure du profil — **ta decision**
Le script est ecrit et **eprouve sur un clone** de `web` (patch 104 -> 98 lignes, cinq liens -> un agregateur,
zero avertissement apres). Il reste a dire **quand**. Ce qu'elle achete : le correctif `detached-jobs`
(seul paquet dont le code a diverge), la garde jamais montee, `/schedule` rendu, les trois entrees mortes purgees.

### 2. Monter AgentTeams **a cote** de Boost ? — **ta decision**
Coexistence prouvee (zero avertissement, outils disjoints). Ce que ca apporte : DAG, boite aux lettres,
panneau d'activite. Ce que ca coute : **5 171 caracteres de protocole capitaine dans le prompt de CHAQUE
agent non-membre** — tes verificateurs compris, dont l'independance est toute la valeur.

### 3. Remonter le defaut de la garde anti-surrogate en amont ? — **ta decision**
Valeur maximale, cout de maintenance nul. Demande un rapport de defaut avec nos mesures (3 journaux sur
182, 0 contre-exemple, HTTP 400 en cascade).

### 4. Construire le canal maintenant ?
C'est le seul chantier qui debloque les trois autres (verdict, profondeur, budget lisible). Le document
de conception est ecrit ; l'implementation reste a faire, avec la metrique de sante des le premier jour.

### 5. Publier quelque chose ?
Etude faite : le paquet tel quel arriverait dans un marche sature (6 469 paquets `dsh-plugin`, un concurrent
direct plus mur). Les actifs reellement uniques : le frein hors cache, le job possede par la racine, le
relais adaptatif, et **les mesures** — que personne ne publie.

### 6. `dsh-auto-update` rejoint-il le depot consolide ?
Cinquieme plugin, **hors `CodeSource`** et hors git (`profiles/local-plugins/`). Inclus ou laisse dehors ?

### 7. Que faire des cinq depots d'origine apres la coupure ?
Ils portent encore le code que le profil charge. Les retirer proprement — ou les garder comme historique ?

---

## Partie 4 — Ce qui est etabli, quoi qu'on decide

```
le livrable est installable et installe pour de vrai (une commande, cinq lignes, chacune une fois)
la documentation est consolidee, les defauts mesures corriges, 132 cas verts
la coupure est ecrite et eprouvee sur un clone
les mesures du corpus : 97,08 % de cache, 86 % de vacance de l'arbre, 0/139 contradictions,
                        silence p50 373 s, 8,2 % de refus de capacite
```

Et quatre mecanismes sans equivalent trouve sur le marche : **le frein hors cache**, **le job possede par
la racine**, **le relais adaptatif**, **la garde anti-surrogate**. Les trois premiers sont des lignes hote :
leur sort ne depend **pas** des choix ci-dessus.

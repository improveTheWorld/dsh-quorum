# Alerte de debit — specification

Etat au 2026-10-02. Document SEPARE, comme demande. Il ne decrit pas un frein : il decrit une **alerte**.

---

## 1. Ce que ce document remplace

**D17/D18 est RETIRE.** Le registre decrivait un frein budgetaire **par arbre**, sur `entree non cachee +
sortie`, via `ctx.tools.guard()`. L'argument qui le tue est celui de l'utilisateur, et il est sans replique :

> *« je peux avoir plusieurs arbres independants »*

Un frein local ne plafonne **rien de global** : il suffit d'ouvrir un second arbre pour repartir a zero. Un
dispositif qui se contourne en ouvrant une session n'est pas un plafond, c'est une decoration.

**Ce qui est retire, precisement :** le frein par arbre, la garde `tools.guard()` sur la creation d'agents,
et la graduation `canSpawn` du preset. Le mecanisme n'a **jamais ete construit** (mesure : `tools.guard`
n'apparait nulle part dans le code) : ce document ferme une piste, il ne demonte rien.

---

## 2. Le besoin, tel que formule

```
portee   : GLOBALE (tous les arbres, tous les processus)
unite    : des DOLLARS, pas des tokens
fenetre  : une plage d'environ UNE HEURE, pas l'instant
pics     : les pics instantanes sont TOLERES par construction
action   : ALERTER — il n'empeche rien
```

La phrase qui porte la conception : *« réagir plutôt sur une plage de 1 heure si on continue à y aller trop
vite »*. Autrement dit : **le débit moyen sur l'heure, pas le débit instantané**. Un pic de dix minutes ne
doit pas déclencher ; une heure entière au-dessus du seuil, oui.

---

## 3. La mesure — et le piege qui a failli tout fausser

Quatre compteurs, **jamais un total brut** : `inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`. Identite verifiee sur **30 894 enregistrements** : `total = input + output + cacheRead +
cacheWrite`.

Le piege, mesure :

```
volume total du corpus boost : 1 023 464 901 tokens
  dont cache relu            :   993 567 616   = 97,08 %   -- facture environ 1/50
  dont entree non cachee     :    22 352 573
  dont sortie                :     7 544 712
```

**Un debit calcule sur les tokens bruts mesurerait du vent** : il serait domine par du cache relu qui pese
92 % du volume et 11 % de la facture. Le prix se calcule sur les **quatre** compteurs, chacun a son tarif.

Et la repartition par role donne le reste : les **enfants** portent 69,4 % du hors-cache. Une alerte qui ne
regarderait que les racines manquerait les deux tiers de la depense.

---

## 4. La table de prix

```
par MODELE : entree · cache-lu · cache-ecrit · sortie          (quatre tarifs, pas deux)
`total_dollars = sum over (session, tour) of  input*r_in + cacheRead*r_cached + cacheWrite*r_write + output*r_out`
```

**C'est la piece qui vieillit mal.** Un tarif faux rend l'alerte fausse sans rien casser d'autre — donc :

- les tarifs vivent dans **un seul fichier** du paquet, versionne, avec la date de releve et la source ;
- un modele **inconnu** ne devine pas : il est compte a part et **signale** dans l'alerte (`modele non
  tarife : X tokens`) — une alerte qui se tairait sur un modele non tarife mentirait par omission ;
- changer un tarif est une edition d'une ligne, sans redeploiement.

---

## 5. La fenetre, et pourquoi les pics passent tout seuls

**Deux seuils, avec hysterese** — c'est ce qui rend le dispositif supportable :

```
ALERTE   quand le debit glissant sur 60 min depasse  SEUIL_HAUT
REARME   quand il redescend sous                     SEUIL_BAS
un seul avis par franchissement, jamais en rafale
```

Les pics instantanes sont toleres **par construction** : une fenetre glissante d'une heure amortit un pic de
dix minutes par un facteur six. Rien a prevoir de plus — c'est la fenetre elle-meme qui lisse.

**Un seul avis par franchissement** : sans cette borne, le dispositif deviendrait exactement le brouilleur
qu'on a passe la journee a construire contre — un message par minute pendant une heure de surconsommation.
Le canal nous a donne la regle : *un signal borne, puis lisible dans un compteur.*

---

## 6. Ce que l'alerte dit, et ce qu'elle ne fait pas

```
elle DIT   : le debit de l heure, le seuil, la depense de l heure en dollars, les N arbres concernes,
             et les modeles non tarifes s'il y en a
elle NE    : refuse rien, arrete rien, ne modifie aucun reglage
```

**L'alerte ne freine pas.** C'est un choix de l'utilisateur, et il est coherent : un frein global couperait
un travail legitime au milieu d'un pic mesure sur une heure ; une alerte laisse la decision a l'humain, qui
seul sait si la depense est du travail ou de l'emballement.

---

## 7. Ou ca vit

- **une ligne HOTE** dans l'agregateur : elle doit voir tous les agents, donc elle s'installe par agent sur
  `agent/created` (mesure : un outil enregistre depuis la portee d'une ligne n'atteint jamais la surface).
- **la source est le JOURNAL DE SESSION**, pas un compteur en memoire : c'est la seule chose partagee entre
  processus. Un compteur par processus raterait les autres processus — et l'utilisateur fait tourner
  plusieurs arbres en parallele.
- **une passe periodique courte** (lire la queue des journaux recents, pas leur totalite) : le corpus fait
  **282 journaux**, un scan complet a chaque passe serait absurde.
- l'outil rend l'etat courant a la demande (`debit_actuel`), et l'alerte passe par le **canal** — qui sait
  deja adresser, borner et compter.

---

## 8. Ce que cette spec ne decide pas

```
LE SEUIL              : a calibrer sur une mesure, pas a inventer. Il faut connaitre le debit d une
                        journee normale avant de pouvoir dire ce qui est anormal.
UNE ALERTE DANS LE PROMPT : l'utilisateur a choisi un outil separe ; rien n'interdit plus tard de pousser
                        l'avis dans le contexte du capitaine. A decider apres la premiere calibration.
LE DEVENIR DU FREIN   : si un jour l'alerte ne suffit pas, la forme correcte serait un plafond GLOBAL
                        (pas par arbre) — mais ce document ne le propose pas.
```

---

## 9. Le cout du dispositif lui-meme

Une passe qui relit la queue des journaux coute des **lectures disque**, pas des tokens. Le seul cout en
tokens serait l'extraction d'un resume par un modele — **non retenue ici** : l'alerte se calcule, elle ne
se raconte pas.

---

## 10. Ordre de mise en oeuvre propose

```
1. lire la queue des journaux et calculer les quatre compteurs sur une fenetre glissante   (aucun modele)
2. la table de prix versionnee, avec le signalement des modeles non tarifes                 (aucun modele)
3. l'outil qui rend le debit, et la ligne hote qui le monte                                 (aucun modele)
4. l'alerte elle-meme, avec hysterese, diffusee par le canal                                (aucun modele)
5. la calibration du seuil, sur une mesure reelle                                           (aucun modele)
```

**Aucune etape n'appelle de modele.** Le dispositif qui surveille la depense ne doit pas en etre une —
sinon il faudrait le surveiller lui-meme.

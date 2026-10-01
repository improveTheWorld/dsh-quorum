# Le canal de retour — conception

Etat au 2026-09-30. Ce document specifie le canal entre un enfant et son proprietaire. Il n'est
pas encore implemente : chaque regle ci-dessous existe pour repondre a un **fait mesure**, cite.

---

## 1. Le probleme, mesure

Le retour d'un enfant vers son parent est aujourd'hui un **bloc de texte unique**, livre **une fois** :

```
silence d'un enfant avant l'avis de reglement : p50 373 s   p90 765 s   max 6 714 s
tours de la mere ouverts juste apres un avis     : 82,5 %
cout d'un tour de mere contre la mediane        : 3 641 068 vs 127 798 hors cache  (~28x)
```

Et l'ordre des signaux n'est pas connu, il est **devine** — le relais ecrit au lecteur :
« treat this one as a duplicate unless its report predates the job ». C'est un pari, pas un fait.

Le cout de cette conception n'est donc pas l'ergonomie : **chaque avis recu coute un tour de mere**, et
la mere est l'agent le plus cher de l'arbre. Le volume du canal **fixe** la facture.

### Ce que le brouillage ressemble, en donnees

Notre propre relais l'a produit :

```
78 770 lignes "skip"  pour  1 924 reglements distincts      (41 pour 1)
581 746 lignes de journal, dont 50,8 % de simples "output"
82 abonnements actifs pour un seul relais
```

Cause : un filtre `{ owners: { owner } }` qui n'etait **pas** une forme valide — donc rien n'etait
filtre. Le brouillage n'est pas venu de la verbosite des producteurs, mais d'un filtre qui ne
filtrait pas.

---

## 2. Principe : tirer, pas pousser

Un canal qui **pousse** bourre le contexte du destinataire par construction : la taille de son
contexte depend de la verbosite de l'emetteur, que le destinataire ne controle pas.

Donc :
- on **pousse un signal minuscule** — « il y a du nouveau de X, N elements, le plus grave est Y » ;
- on **tire la charge utile** — le lecteur decide s'il lit, et combien.

C'est ce que fait deja bien notre relais dans son bon regime : avis court, substance derriere
`job_output`, fichier de recuperation pour le reste.

---

## 3. Les niveaux : declarer le kind, DERIVER l'etat

Un niveau « urgent » auto-declare fabrique la fatigue d'alerte : chaque agent trouve son probleme
urgent, et le parent apprend a ignorer le niveau cense le reveiller. Notre propre regle, ecrite
apres l'avoir payee (`tools/protocol.mjs`) :

> « A model cannot judge the mode it is running in. Every narrative claim examined here turned out
> to be wrong… An agent cannot mark its own scenario green. »

Donc **deux axes separes** :

```
kind  (le fils DECLARE)  : decouverte · avancement · question · resultat · echec
etat  (le runtime DERIVE) : running · blocked · done · failed
```

« Urgent » n'est pas un niveau. Un enfant bloque **est** bloque — il a cesse de produire.

**Mesure du 1er octobre** : l'etat NE PEUT PAS porter l'echec a lui seul. Un enfant qui poste le fait
DEPUIS un appel d'outil — donc en travaillant, donc `running` — voit son etat derive valoir `running` au
depot. L'echec doit donc etre un **kind declare** : `echec`, le seul kind qui porte l'urgence lui-meme.

### La regle d'eligibilité, ecrite (elle ne se deduit pas de la table)

```
eligibilite = le KIND SEUL : question | resultat | echec
              decouverte et avancement ne reveillent JAMAIS, quel que soit l'etat

l'etat DECIDE, une fois l'eligibilite acquise :
              echec                         -> reveil
              question | resultat + blocked -> reveil
              resultat + running            -> reste en ATTENTE (le §4 exige done)
```

Un `avancement` dont l'etat derive vaut `failed` ne reveille donc **pas** : c'est un fait qui se declare
avec le kind `echec`, jamais un effet de bord de l'etat. Sans cette porte, un enfant dont un outil a
echoue une fois pourrait reveiller son proprietaire avec du battement de coeur — mesure sur la revision
`7969329`, corrige depuis.

## 4. La politique de reveil — le seul enjeu

Les niveaux ne servent pas a **livrer** : tout se stocke. Ils servent a **reveiller**, parce que le
reveil est le seul evenement cher (un tour de mere, ~28x une session mediane).

| kind | etat derive | reveille ? | charge utile |
|---|---|---|---|
| decouverte | running | **non** | un pointeur |
| avancement | running | **non** | un compteur |
| question | **blocked** | **oui** | la question, courte |
| resultat | done | oui, **une fois** | pointeur + taille |
| echec | quel qu'il soit | **oui** | l'erreur brute |

**C'est ce qui rend le battement de coeur abordable.** Sans niveaux, un battement = un reveil = un
tour de mere a 28x : un desastre de cout. Avec les niveaux, un enfant peut dire « j'en suis a
l'etape 12, je mesure X » quarante fois **sans couter un seul tour**. Les niveaux ne sont pas un
confort : c'est la condition de faisabilite du canal.

---

## 5. Les sept regles anti-brouillage

1. **Tirer, pas pousser** (§2).
2. **Borne par construction, pas par discipline** : plafond de taille DUR, troncature **visible**
   (`truncated: true`, jamais silencieuse), et N derniers messages par agent. Precedent mesure :
   l'outil `read` plafonne a 49 931 caracteres, constate sur douze fichiers differents.
3. **Adresse, jamais diffuse.** Le destinataire ne recoit que ce qui lui est adresse. Le bug des
   82 abonnements est exactement ce qui arrive quand on croit filtrer sans filtrer.
4. **Deduplication par identite, jamais par texte** : chaque message porte `{de, seq, at}`. Le
   comptage textuel a ete paye trois fois dans ce projet.
5. **Un message n'est pas une affirmation** : chaque entree porte l'identifiant de
   l'enregistrement qui la prouve. Un canal qui accumule des affirmations invérifiables est un
   brouilleur semantique — pire qu'un brouilleur bruyant, parce qu'il est credible.
6. **Le destinataire peut dire stop** : baisser la verbosite ou la cadence **en cours de vol**, pas
   seulement a la naissance.
7. **Le budget de LIVRAISON appartient au destinataire** — mesure du 1er octobre. La regle 2 bornait la
   **taille** ; le **nombre** ne l'etait pas : le chemin `inject` livrait sans plafond, et 200
   `avancement` d'un meme enfant injectaient 200 lignes (~26 000 caracteres, ~6 500 tokens) dans le
   contexte de son proprietaire — la ressource rare, partagee par tous ses enfants. Deux bourses
   **separees**, chacune bornee par emetteur ET par arbre, sur une fenetre glissante de 300 s (les
   quatre nombres et la fenetre sont des constantes nommees et exportees) :

   ```
   ORDINAIRE  kinds decouverte, avancement :  2 / emetteur / 300 s   ET   4 / ARBRE / 300 s
   RESERVEE   kinds question, resultat, echec:                       3 / ARBRE / 300 s
   ```

   Les deux bornes s'appliquent, la plus stricte mord : un seul enfant tres bavard ne peut pas manger
   le budget de l'arbre. La bourse reservee **n'est jamais consommee par l'ordinaire** : le bruit ne
   peut pas affamer le signal, et un enfant bloque atteint toujours son proprietaire.

   Ce qui est borne est la **livraison, jamais l'ecriture** : un message qui ne peut pas etre livre est
   **stocke quand meme**, marque `throttled: true`, et reste **tirable** par `channel_read`. Un jeton
   qui ferait perdre un message serait pire que le bruit qu'il evite. `channel_post` rend
   `budget: { ordinary, reserved }` — le restant des deux bourses — pour que l'appelant puisse
   **choisir de se taire** : un agent qui le voit peut se discipliner, celui qui l'ignore devient un
   chiffre.

   Ce dispositif est **separe du limiteur de reveil** (1 / enfant / 120 s, 3 / arbre / 120 s) : celui-ci
   borne la **cadence des tours ouverts**, celui-la la **livraison**. Un message peut etre livre sans
   reveiller personne (une injection), et un reveil peut etre refuse par la cadence sans qu'aucune
   bourse ne soit touchee.

## 6. La retrogradation — la cle de voute

Quand un fils declare une **question** alors que son etat derive est `running` — c'est-a-dire qu'il
n'est pas bloque, il continue — le message **ne reveille pas** : il attend le prochain reveil
legitime.

Le declaratif ne peut donc pas forcer un reveil que l'etat ne justifie pas. Un agent qui veut
vraiment etre entendu n'a qu'une façon de le prouver : **s'arreter et attendre**. C'est la seule
regle qui rende l'inflation d'urgence inoperante.

---

## 7. La metrique de sante, a definir AVANT la premiere ligne

```
messages LIVRES  /  messages LUS
```

Si la plupart des messages livres ne sont jamais lus, le canal **est** du bruit — par definition, et
sans discussion. C'est ce que le journal du relais a appris : 50 Mo d'instrumentation dont personne
ne lisait rien, et il a fallu une mesure pour s'en apercevoir.

Deux compteurs supplementaires, **par emetteur et par arbre** : nombre de messages emis, et
**ratio de retrogradation** (messages qui ont demande un reveil et ne l'ont pas obtenu). Un enfant
qui emet quarante « avancement » la ou son frere en emet trois est un brouilleur — et c'est
mesurable des le premier jour.

Et les deux compteurs qui rendent le jeton de livraison (regle 7) mesurable :

```
throttled            messages LIVRES A ZERO : la bourse de leur kind etait epuisee. Un message
                     refuse est STOCKE, marque 'throttled: true', et reste tirable — le compter
                     separement de 'delivered' est ce qui distingue « moins livre » de « perdu ».
throttled_by_sender  le meme compte, PAR EMETTEUR : un total ne designe pas le brouilleur, un
                     compte par emetteur si.
```

Chaque refus porte une ligne de journal `{"step":"throttled", id, from, kind, purse, remaining,
budget}` : la bourse epuisee est **nommee** (`ordinary` ou `reserved`) et le restant est ecrit.
Une bourse epuisee ne change ni l'eligibilite (elle depend du kind SEUL) ni la politique de reveil :
elle retire une livraison, jamais une regle.

---

## 8. Le verdict attache a une cible — le declencheur qui manquait

Mesure : **0 contradiction detectable sur 139 paires de freres**. Non pas parce que les agents ne se
contredisent pas, mais parce que **rien n'enregistre qui a dit quoi sur quelle cible**.

Chaque verdict porte donc une enveloppe structuree :

```
{ de, vers, quand, cible, revision, verdict, constats, commandes, resultats }   <- structure
la prose et les preuves brutes                                                   <- verbatim
```

**Regle non negociable : structurer l'enveloppe, jamais la charge utile.** Une charge utile
structuree est un resume par construction, et le protocole rejette un verdict sans preuve brute.
C'est toute la difference entre un canal qui **renforce** la verification et un canal qui la
dissout.

Avec cette enveloppe, deux verdicts opposes sur la meme `cible`+`revision` deviennent une **donnee**
et non une recherche de texte : c'est le declencheur qui manquait a l'agent arbitre.

---

## 9. Ordre de mise en oeuvre

1. **Le canal** — enveloppe + niveaux + politique de reveil + la metrique de sante des le premier
   jour. Il transforme les 373 s de silence en information.
2. **Le verdict attache a une cible** (§8). Il rend les contradictions mesurables et arme l'arbitre.
3. **La profondeur, ensuite** — et seulement si le canal tient. Aujourd'hui un worker est plafonne a
   `maxDepth: 1` (mesure : 4 refus, aucun worker n'a jamais delegue). Ouvrir la profondeur avant
   d'avoir le canal, c'est multiplier le seul probleme que la mesure designe clairement : un
   petit-fils muet serait indistinguable d'un agent bloque.

---

## 10. Ce qui reste ouvert

- **La forme du stockage** : `plugin-data/<plugin>/*.jsonl` (precedent : relais, jobs detaches) ou
  la session du proprietaire. Le premier survit a la mort du processus, le second est deja
  journalise et rejoue.
- **La portee multi-process** : notre flux fait tourner plusieurs processus (`liveCount: 16` mesure).
  Un stockage fichier partage exige un verrou (le harnais fournit `withFileLock`).
- **Le niveau de granularite du N** (combien de messages gardes par agent) : a calibrer sur une
  mesure, pas sur une intuition.
- **Le cout du canal lui-meme** : a instrumenter comme le reste, avant de generaliser.
---

## 11. Mesure A/B du brief indexe — 2026-09-30, n = 3 par condition

Six enfants, **mission identique** (trois faits a extraire du depot, avec la commande brute exigeante),
trois avec un **index source** en plus, trois sans. L'index contenait une **valeur deliberement fausse**
(`SPILL_MAX_BYTES = 16777216` ; la vraie vaut `32 * 1024 * 1024`, ligne 242).

### Surete : 3/3 ont attrape le piege

```
B1 : « la valeur [valeur] 16777216/16 Mio est FAUSSE »
B2 : « la valeur du parent (16777216) est fausse »
B3 : « PAS 16777216 (l'entree [valeur] du parent est fausse) »
```

Les trois temoins ont rendu les memes reponses justes : **la qualite est egale**, seule la depense differe.

### Cout : le mecanisme est net, l'effet ne l'est pas

```
              hors-cache   dispatches   exploration   lectures   sortie
A1 temoin        9 518         15            6            2        4 158
A2 temoin        6 725         12            7            1        2 543
A3 temoin        6 853          9            5            2        2 787
moyenne A        7 699        12,0          6,0          1,67      3 163

B1 indexe        5 585          6            2            0        1 925
B2 indexe        6 014         11            2            2        2 233
B3 indexe        9 566          9            4            2        2 976
moyenne B        7 055         8,67         2,67         1,33      2 378

exploration   -56 %     <- la RECHERCHE s'effondre
sortie        -25 %     <- l'effort de reflexion baisse
lectures      -20 %     <- a peine
entree        +3 %      <- INCHANGEE : l'index coute ce que la recherche coutait
hors-cache     -8,4 %   <- dans le bruit a n=3
```

### Ce que la mesure etablit

**Un index dit OU, pas QUOI — donc il economise la recherche, pas la lecture.** L'index coute a peu
pres ce que la recherche coutait (+3 % d'entree), et le contenu, l'enfant le lit quand meme. Le gain
porte sur l'**effort** (la sortie du modele), pas sur le **contexte**.

Consequence pour la regle de role (§10 de EVOLUTIONS.md) : donner un index a un enfant cooperatif
**n'allege pas son contexte, il accelere sa mise au travail**. Pour couper la facture, le levier est
ailleurs — et le corpus le chiffre : la **sortie** (10,6 M sur 23,0 M de hors-cache chez les enfants)
et les **lectures** (5,2 M, soit 22,5 %).

### La tension, desormais explicite

La regle « tout fait utilise doit etre soutenu par une commande » rend l'index sur — et **dissout son
economie d'entree** : 3/3 ont re-mesure. Sans la regle, l'economie apparait et les erreurs se
propagent invisiblement.

D'ou la distinction a tester ensuite, entre deux classes de connaissance :

```
navigation (ou sont les choses, conventions, structure)  -> a faire confiance : economise la recherche
assertion  (une valeur, un diagnostic, une cause)        -> a re-mesurer si l'enfant l'utilise
```

Dans l'experience, la fausse valeur etait une **assertion** — attrapee ; et l'enfant a verifie meme
l'entree de **navigation** exacte, parce que la regle ne distinguait pas les deux classes.

### Limites declarees

- **n = 3 par condition**, sur une tache triviale (~7 700 hors-cache contre **130 000 pour un enfant
  reel** — un facteur 17) : la mesure etablit la **structure** de l'effet, pas son ampleur.
- Une seule forme de tache : extraire des faits a des endroits connus. Sur une tache
  d'**interpretation**, un index ne substitue rien et l'effet serait nul.
- Un seul piege, vu trois fois : cela prouve que la regle **peut** marcher, pas qu'elle marche
  toujours.


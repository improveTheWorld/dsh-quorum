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
kind  (le fils DECLARE)  : decouverte · avancement · question · resultat
etat  (le runtime DERIVE) : running · blocked · done · failed
```

« Urgent » n'est pas un niveau : c'est l'etat `blocked` ou `failed`. Un enfant bloque **est** bloque —
il a cesse de produire ; un enfant en echec a un `tool/result` en erreur. Cela ne se declare pas.

## 4. La politique de reveil — le seul enjeu

Les niveaux ne servent pas a **livrer** : tout se stocke. Ils servent a **reveiller**, parce que le
reveil est le seul evenement cher (un tour de mere, ~28x une session mediane).

| kind | etat derive | reveille ? | charge utile |
|---|---|---|---|
| decouverte | running | **non** | un pointeur |
| avancement | running | **non** | un compteur |
| question | **blocked** | **oui** | la question, courte |
| resultat | done | oui, **une fois** | pointeur + taille |
| echec | **failed** | **oui** | l'erreur brute |

**C'est ce qui rend le battement de coeur abordable.** Sans niveaux, un battement = un reveil = un
tour de mere a 28x : un desastre de cout. Avec les niveaux, un enfant peut dire « j'en suis a
l'etape 12, je mesure X » quarante fois **sans couter un seul tour**. Les niveaux ne sont pas un
confort : c'est la condition de faisabilite du canal.

---

## 5. Les six regles anti-brouillage

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

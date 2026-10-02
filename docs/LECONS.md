# Lecons a la compaction — specification

Etat au 2026-10-02. Document separe. Il decrit un mecanisme **non construit** : ses coutures sont mesurees.

---

## 1. Le principe, et pourquoi le moment est le bon

**La compaction est l'evenement qui dit ce qu'on peut se permettre d'oublier.** Une lecon est exactement
ce qu'il ne faut pas oublier. Le signal et le besoin coincident par construction : ce n'est pas un
accrochage opportuniste sur un evenement disponible, c'est le seul instant ou le harnais declare lui-meme
que de la matiere va disparaitre.

---

## 2. Les coutures, mesurees

**Le signal.** `compaction/*` sont des evenements de session ordinaires, publies par `Session.append`
(`dsh-session/lib/index.js:1466-1470`, `:1471` push, `:1473` invocation) sur le feed `session/event`. Un
listener **non tague** les recoit tous, y compris ceux des enfants (`dsh-scope/lib/index.js:329-335`,
`if (tag === void 0) return true`).

Ordre mesure, session `018354d9` :

```
1818  compaction/start        le resume n'existe pas encore
1820  compaction/summary      LE RESUME EST DANS L'EVENEMENT, la surface n'est PAS encore remplacee
1821  user/message(replace)   le remplacement de surface
1822  compaction/end          fait
```

**`compaction/summary` est donc l'instant exact.** Corpus : 45 crochets complets, 0 `end` en erreur, 201
`prune`.

**Le cout.** Le resume est dans `data.summary` (+ `rawOutput`) : moyen **12 896** caracteres (max 22 250).
La region compactee moyenne vaut **421 120 tokens** — rapport **1:130**. Relire la region n'a aucune raison
d'etre ; le resume est deja paye.

**Le parallelisme.** Le feed est un `emit` resolu puis invoque a la main, **jamais `await`**, et un rejet
est seulement journalise (`dsh-session/lib/index.js:1228-1237`). Ni waterfall, ni veto. Autrement dit :
l'extraction ne peut **pas** ralentir la compaction.

---

## 3. La forme retenue

```
1. un paquet HOTE (huitieme ligne) : un listener `session/event` NON TAGUE est le seul point qui voie
   les racines ET les enfants sans plomberie
2. filtrer sur `event.type === 'compaction/summary'`
3. ET sur `session.header.parentSession === undefined`  -> RACINES SEULEMENT (voir la recursion, §5)
4. ET sur un plancher de matiere : ne rien extraire d'une compaction minuscule
5. ne RIEN faire dans le corps synchrone : `queueMicrotask`, jamais d'`await` dans le listener
6. resoudre l'agent par `ctx.agents.get(session.id)`, puis lancer un enfant
7. une file PAR CLASSE sous `plugin-data/<plugin>/lessons/<classe>.jsonl` (append + tmp/rename)
```

L'enfant d'extraction se lance par `ctx.subagents.start('spawn', { parent, prompt, signal, maxDepth: 1,
toolFilter, persona })` — la requete porte `prompt` (blocs de contenu), `parent`, `signal`.

---

## 4. Les deux classes, et ou chacune va

```
(a) FONCTIONNEMENT DES AGENTS   -> un fichier lu par `dsh-agent-instructions`
    (notre preset le monte deja : `cordis.patch.yml:83-86`, `maxBytes: 65536`)
    AUCUNE API d'ecriture n'existe : c'est un fichier, assume comme tel.

(b) LE PROJET                   -> cle = `session.header.cwd` canonique
    `WorkspaceRegistry` indexe par dossier canonique ; c'est la seule cle d'attribution
    disponible DANS l'evenement.
```

**Et une regle pour la classe (a), non negociable :** l'extracteur **propose**, il n'ecrit pas dans le
prompt. Un agent qui edite son propre prompt systeme peut se degrader sans que personne le voie — la meme
famille de risque que le demi-caractere qui tue une session. La lecon est deposee dans un fichier de
candidats ; un humain l'applique.

---

## 5. Les pieges, tous mesures

**La recursion.** Un enfant de profondeur 1 a compacte seul (mesure : `compactionId 942b56bf`, `turn: 6`).
Sa compaction declencherait le listener, qui engendrerait un extracteur, qui compacterait... Le filtre
« racines seulement » ferme la boucle.

**Le fork rejoue les compactions de son pere.** Le seed ne republie pas (`dsh-session/lib/index.js:1273`)
mais il les **contient** : l'enfant forke porte les **memes `compactionId`** que son parent (mesure : trois
identiques). **Deduplication par `compactionId`, jamais par session.**

**Ne jamais ecrire dans la session qui compacte** : un `append` reentrant sur la meme session LEVE
(`dsh-session/lib/index.js:1452`).

**`maxDepth` n'est pas un garde automatique** : il est porte par la **requete**, et `start()` ne valide que
ce qu'on lui donne (`dsh-subagent/lib/index.js:3118`, `:400-404`). Sans `maxDepth`, **aucun plafond** — la
recursion serait ouverte. Le passer explicitement, et attraper `SubagentDepthError` (c'est la borne
gratuite d'un enfant qui tenterait d'en engendrer un).

**Un enfant lance par le listener n'est pas un enfant d'outil** : pas de `tool/call`, donc pas de
`backgroundMode: continuable`, pas de persona ni de filtre de role, pas de garde d'outil. La politique de
delegation devient la notre — a verifier : l'enfant herite de la composition du parent
(`applyChildComposition`), donc il faut s'assurer qu'il ne recoit pas les outils de role.

**Le marqueur de parente est `parentSession`, PAS la profondeur** : une session mesuree porte
`parentSession` avec `delegationDepth: 0`. Tester le premier.

---

## 6. Le risque de fond, et la discipline qui va avec

**Un extracteur qui tourne a chaque compaction est lui-meme une depense, et peut fabriquer du bruit** —
des « lecons » qui ne sont que des reformulations. C'est le probleme qu'on a passe la journee a resoudre
pour le canal, et la reponse est la meme :

```
borne      : un plancher de matiere, et un extracteur par compaction de racine, jamais en rafale
compte     : combien de lecons par compaction, et combien sont RETENUES (le rapport est le juge)
filtrable  : qui lit la file peut la reduire ; une lecon non lue n'est pas une lecon
```

**Le rapport qui compte n'est pas « combien de lecons sont produites » mais « combien changent quelque
chose ».** Un extracteur qui produit trente lecons dont aucune n'est appliquee coute trente fois pour
rien. C'est mesurable, et c'est la metrique de sante a poser des la premiere ligne — comme pour le canal.

---

## 7. Ce que cette spec ne decide pas

```
LE PLANCHER DE MATIERE   : a calibrer (taille du resume ? nombre d'evenements ombres ? les deux ?)
LA FORME DE LA LECON     : texte libre, ou schema de sortie structure (classe, portee, constat, preuve)
                           — un schema rendrait la consolidation et le comptage possibles
LE DEVENIR DU PROMPT     : qui applique les candidats, et a quelle cadence
LE COUT PAR COMPACTION   : a mesurer avant de generaliser (un enfant + un resume de 13 000 caracteres)
```

---

## 8. Ordre de mise en oeuvre propose

```
1. le listener et le filtre, qui JOURNALISE seulement (aucun modele, aucune depense)
2. la mesure : combien de compactions de racine, de quelle taille, par jour
3. l'extracteur en file, avec un schema de sortie a deux classes
4. la deduplication par compactionId, et les deux files
5. le compteur lecons produites / retenues
```

L'etape 1 coute **zero** et repond a la question qui manque : **a quelle frequence cela se declencherait-il
chez toi ?** Sans ce chiffre, on ne sait pas si le dispositif est un outil ou une usine.

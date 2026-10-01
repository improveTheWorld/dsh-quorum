# @local/dsh-boost-channel — le canal de retour

Le canal entre un enfant et le proprietaire de son arbre. Specification complete :
'../../docs/CANAL.md' ; decisions : 'docs/DECISIONS.md' (D7-D13).

    node --test                        # depuis la racine du depot (decouverte)
    node --test test/channel.test.mjs  # depuis ce paquet
    node tools/probe-stop.mjs          # quel evenement marque l'arret (mesure)
    node tools/probe-mount.mjs         # la ligne HOTE installe par agent (mesure)

## Ce que le canal transporte, et ce qu'il refuse de transporter

Une enveloppe STRUCTUREE, jamais la charge utile (D13) :

    { id, from, at, kind, state, to, target, revision, verdict, summary, payloadRef, payloadChars, truncated, wake_pending? }

| champ | sens |
|---|---|
| 'id' | '<from>:<seq>' — l'identite DANS le magasin, et la seule cle de deduplication (jamais le texte). Un depot dans un autre magasin (service interne) porte un id qualifie par la racine, '<racine>:<from>:<seq>' |
| 'kind' | ce que l'appelant DECLARE : 'decouverte' · 'avancement' · 'question' · 'resultat' · 'echec' |
| 'state' | ce que le runtime DERIVE : 'running' · 'blocked' · 'done' · 'failed' — re-derive A L'ARRET pour un message qui attendait |
| 'to' | le DESTINATAIRE : la racine de l'arbre, ou une session nommee. C'est lui que la lecture applique. Capacite du SERVICE INTERNE, jamais de la surface des outils |
| 'target' + 'revision' + 'verdict' | le verdict attache a une cible (§8) : deux verdicts opposes sur la meme cible deviennent une donnee |
| 'summary' | texte court, PLAFOND DUR de 2000 caracteres, troncature VISIBLE ('truncated: true') |
| 'payloadRef' | un CHEMIN vers la preuve brute — jamais son contenu — et 'payloadChars' sa taille |
| 'truncated' | vrai des que le resume a ete coupe |
| 'wake_pending' | present SEULEMENT sur un message dont le reveil attend l'arret de l'emetteur. Absent = rien n'attend |

## La politique de reveil (§4) — decidee a l'ARRET, jamais au depot

'channel_post' EST un appel d'outil : quand l'emetteur depose, **il travaille
encore**. Un enfant qui poste une question n'attend pas a cet instant — il
continue son tour, et il n'attendra qu'a la fin de celui-ci. Decider au depot
rendait donc les reveils 'question'+'blocked' et 'resultat'+'done' **inatteignables**,
et toute la table du §4 du code mort.

Le canal stocke donc le message, marque 'wake_pending: true' quand son kind est
**eligible**, et **ne decide rien**. La decision est prise quand l'emetteur
s'arrete :

**L'eligibilite depend du KIND SEUL — 'question', 'resultat', 'echec' — jamais de
l'etat.** Un etat ne promeut pas un kind : un 'avancement' dont le dernier
resultat d'outil est en erreur se livre par injection et **ne reveille
personne**, meme avec 'state: failed'. C'est ce qui rend le battement de coeur
abordable (un tour de mere coute ~28x une session mediane). Un echec qui doit
reveiller se DECLARE, avec le kind 'echec'.

| kind declare | etat derive A L'ARRET | decision |
|---|---|---|
| 'decouverte' / 'avancement' | (n'importe lequel, meme 'failed') | injecte au depot : un battement de coeur n'attend rien et ne reveille jamais |
| 'question' | 'blocked' | **reveil** ('Agent.send(message, "next-step", true)') |
| 'resultat' | 'done' | **reveil** — une fois, et l'idempotence le garantit |
| 'resultat' | 'blocked' | rien encore : l'emetteur est vivant. Le message RESTE en attente ; sa sortie du registre le decidera |
| 'echec' | 'blocked' / 'done' / 'failed' | **reveil** : c'est le seul kind qui porte l'urgence lui-meme |
| 'question' / 'resultat' / 'echec' | 'failed' | **reveil** |
| 'question' | 'done' | **retrogradation** : 'wake_refused', ni reveil ni injection |

**Retrogradation (§6)** : elle se prononce AU POINT DE DECISION, et elle a deux
formes — un kind eligible dont l'etat ne justifie pas le reveil (une question dont
l'emetteur est deja parti), et un reveil refuse par la cadence. Dans les deux cas
le message est STOCKE et consomme : il ne sera plus jamais re-evalue.

**Idempotence** : un message consomme une fois ne l'est plus jamais. Deux arrets
successifs — la fin du tour, puis la sortie du registre — ne produisent qu'un
seul reveil.

**Cadence** : au plus UN reveil par enfant et par 120 s, et au plus TROIS par arbre
et par 120 s. **Elle mord a la re-evaluation, jamais au depot** : deux questions
deposees pendant le tour ne consomment aucune place. Au-dela, le reveil compte
comme 'wake_refused' ('refused:child-rate' ou 'refused:tree-rate' dans le journal).

## Quel evenement marque « l'emetteur s'arrete » — MESURE

Deux arrets, et ils ne disent pas la meme chose. Mesure par 'tools/probe-stop.mjs'
(vraie application cordis, vrai magasin de sessions '@deepseek-ai/dsh-session',
vrai registre d'agents '@deepseek-ai/dsh-agent') :

    PROBE-T-D2: turn/end de la session de l enfant -> arrets observes=["session-child-a <- turn/end"]
      · reveils recus=1 · etat du reveil=["next-step"] · wake_pending=0
    PROBE-T-D3-a: resultat + turn/end -> reveils recus=1 · wake_pending=1
    PROBE-T-D3-b: agent/disposed -> reveils recus=2 · wake_pending=0
      · arrets observes=[...,"session-child-b <- turn/end","session-child-b <- agent/disposed"]
    PROBE-journal: {"step":"wake-reeval","id":"session-child-a:1","kind":"question","state":"blocked","why":"turn/end","wake":"sent"}
    PROBE-journal: {"step":"wake-reeval","id":"session-child-b:1","kind":"resultat","state":"done","why":"agent/disposed","wake":"sent"}

- **'turn/end'**, par le feed 'session/event' ('@mode emit', sans veto, dispatch
  post-commit) : l'emetteur a ferme son tour. Il est vivant, donc l'etat derive est
  'blocked' — c'est l'arret d'un enfant qui **reste ouvert**, celui qui attend une
  reponse. Aucun des deux autres candidats ne le couvre :
  'agent/disposed' ne le voit jamais (un enfant bloque n'est jamais dispose) et
  'subagent/start'/'subagent/end' ne parlent que d'une delegation qui se termine.
- **'agent/disposed'** ('@mode emit') : l'emetteur a quitte le registre, donc l'etat
  derive est 'done' — le seul arret ou un 'resultat' du §4 se decide. Le registre
  REEL retire l'agent de son magasin AVANT d'annoncer ('detachEntered'), donc l'etat
  re-derive a cet instant est bien 'done'.

L'arret est donc un **couple**, pas un evenement : 'turn/end' couvre l'enfant qui
reste ouvert, 'agent/disposed' couvre celui qui part. Prendre 'turn/end' seul
laisserait 'resultat'+'done' inatteignable (le tour se ferme alors que l'enfant est
encore vivant) ; prendre 'agent/disposed' seul laisserait 'question'+'blocked'
inatteignable. Le probe est la mesure, pas l'argument.

**Ce qui decide de la livraison est le TAG DE PORTEE, pas le niveau de montage.**
Correction d'une affirmation fausse de la passe precedente : 'scopeTarget'
('dsh-scope/lib/index.js:327-337') admet **tout listener SANS tag**, puis n'admet un
listener TAGUE que si son tag est sur la chaine de la cle du PORTEUR — et cette cle
differe d'un evenement a l'autre. Mesure :

    PROBE-controle-portee-session: SANS tag (racine)=2 · SANS tag (fiber enfant de la racine)=2 · TAGUE par une portee=0
    PROBE-controle-portee-disposed: TAGUE par la portee du preset: 1 agent/disposed

- pour 'session/event', le porteur est 'scopeTarget(session, scopeOf(this.ctx))'
  ('dsh-session/lib/index.js:1736') : sa cle est la portee du MAGASIN, donc **aucune**
  quand le magasin est a la racine. Un listener tague n'y est jamais admis — monter
  la ligne dans une portee de preset lui ferait perdre tous les arrets ;
- pour 'agent/disposed', le porteur est 'scopeTarget(agent, agent)'
  ('dsh-agent/lib/index.js:513') : sa cle est **l'agent**, dont la chaine remonte au
  preset ('bindScopeParent'). Un listener tague par un ancetre de l'agent est donc
  admis.

Une ligne HOTE a la racine reste la bonne configuration — parce qu'elle est SANS
tag, et parce qu'elle seule voit 'agents' et tous les agents — mais la raison n'est
pas un « niveau » : c'est le tag.

A l'arret, l'etat est re-derive par 'stoppedState' — 'deriveState' prive de sa
branche 'running', et ce n'est pas un oubli : l'arret observe EST la preuve que
l'emetteur a cesse de produire, alors que la bascule 'status: idle' peut suivre
l'enregistrement 'turn/end'. Lire 'status' a cet instant serait un pari.

## Les etats derives, et leurs trois faits

    failed   le dernier tool/result de l'emetteur est en erreur (waterfall 'tools/post-execute')
    done     l'emetteur n'est plus vivant dans le registre — il ne produira plus
    blocked  vivant mais pas en cours : il a cesse de produire
    running  tout le reste : un tour est ouvert

Aucun de ces faits ne vient du message. Un enfant ne peut pas declarer 'blocked' ni
'failed' : il declare un 'kind', et le runtime constate l'etat.

## L'adressage, applique a la LECTURE

Le stockage est par arbre, mais **ce n'est pas une raison pour diffuser** : la
lecture applique le destinataire ('to'), sinon le principe 3 de CANAL.md serait
enonce et non applique. Deux voies, et une seule est controlee :

- **la voie de l'OUTIL** ('channel_read', donc 'read({ from })') : l'appelant est
  connu, et il ne voit QUE ce qui lui est adresse. Le proprietaire de l'arbre
  ('from === <racine>') voit les messages adresses a la racine ; tout autre appelant
  ne voit que 'row.to === <lui>'. Comme un enfant depose avec 'to: <racine>', un
  enfant obtient une **page vide** — le VERIFICATEUR compris, qui doit re-deriver la
  verite par lui-meme ;
- **la voie du SERVICE INTERNE** ('read({ root })' sans 'from') : aucun controle de
  destinataire. C'est celle des tests et de l'outillage, et elle est nommee ici pour
  qu'on ne la confonde pas avec la premiere.

Une lecture vide d'un non-proprietaire est une lecture **REFUSEE** : 'read_refused'
l'enregistre, le journal porte '{"step":"read-refused", from, root, why:"not-addressee"}',
et **aucun marqueur de lecture n'est ecrit** — le message reste 'only_unread' vrai
pour le proprietaire. Un refus silencieux serait indistinguable d'un canal vide.

## La frontiere de l'outil : les arguments non declares sont IGNORES

Mesure du verificateur : le harnais passe 'exec.arguments' tel quel au corps de
l'outil ('dsh-tools/lib/index.js:3310') et ne rejette une cle non declaree que si le
schema porte 'additionalProperties: false' ('dsh-tools' :467-468). Sur un schema
ouvert, un enfant pouvait donc fournir 'to' et 'root' — et **adresser un frere,
ecrire dans le magasin d'un AUTRE arbre, et ouvrir un tour du proprietaire de cet
autre arbre** (mesure : 'send', 'wakeup: true').

Le corps des deux outils ne lit donc QUE des cles declarees :

    channel_post  ->  kind, summary, target, revision, verdict, payloadRef
    channel_read  ->  since, kinds, only_unread

Toute autre cle est **ignoree** — l'appel n'echoue pas, le tour de l'agent qui
hallucine un argument n'est pas casse — et **journalisee** :
'{"step":"undeclared-argument","tool":"channel_post","keys":["to","root"]}'. La
frontiere est dans le CORPS, pas dans le schema : fermer le schema ferait echouer
l'appel, ce qui est exactement ce qu'on ne veut pas. 'to' et 'root' restent des
capacites du service interne.

## L'identite d'une attente inclut son magasin

'<from>:<seq>' n'est unique que DANS un magasin, et un emetteur peut en ecrire deux
(voie du service interne). L'index des reveils en attente est donc cle par
'(racine, from, id)' : indexer sur '(from, id)' faisait disparaitre un message quand
les deux magasins portaient le meme id — le second ecrasait le premier, et le
message du magasin propre n'etait plus jamais decide. En complement, un depot hors
de son propre arbre porte un id qualifie par la racine, '<racine>:<from>:<seq>',
pour que deux messages distincts ne portent jamais la meme chaine dans deux
fichiers.

## Les bornes anti-brouillage

- plafond DUR de 2000 caracteres par resume, troncature visible ; coupe en POINTS DE
  CODE ('Array.from'), jamais a un index UTF-16 — un substitut isole tue la session ;
- les 50 derniers messages **par emetteur** ('KEEP_PER_SENDER'), les plus anciens retires ;
- rotation a 8 Mio par arbre (couture de test : 'DSH_BOOST_CHANNEL_LOG_MAX_BYTES'),
  une generation gardee dans '<fichier>.1' ;
- adressage : un fichier par arbre, ET un destinataire par message, applique a la lecture ;
- deduplication par identite d'id, jamais par texte ;
- 'payloadRef' refuse une chaine multiligne : un chemin n'a pas de retour a la ligne.

## Les compteurs de sante (§7), exposes et journalises

Neuf lectures, dont une jauge : 'posted', 'read', 'read_refused', 'delivered',
'wake_sent', 'wake_refused', 'wake_pending' (messages en attente d'arret),
'truncated', 'deduped'. Deux voies :

- **service** : 'ctx.get("boostChannel")' rend l'instance ; sa methode est
  'channel.stats()' (et 'post' / 'read' / 'stopped' pour un appelant de confiance —
  c'est cette voie qui peut nommer un destinataire 'to' ou un magasin 'root') ;
- **journal** : '$DSH_HOME/plugin-data/dsh-boost-channel/decisions.jsonl', une ligne par
  decision ('post', 'stop', 'wake-reeval', 'read', 'read-refused',
  'undeclared-argument') plus un instantane
  '{"step":"stats", ...}' apres chacune. Le journal tourne a 8 Mio et n'echoue jamais —
  un diagnostic qui casse ce qu'il observe est pire que rien.

La metrique qui decide si le canal EST du bruit reste le rapport 'delivered / read'.

## Stockage

    $DSH_HOME/plugin-data/dsh-boost-channel/<racine>.jsonl        les messages de l'arbre
    $DSH_HOME/plugin-data/dsh-boost-channel/<racine>.read.jsonl   les marques de lecture (only_unread)
    $DSH_HOME/plugin-data/dsh-boost-channel/decisions.jsonl       le journal du plugin

Le chemin rapide APPEND une ligne. La seule reecriture est celle qu'exigent la borne
par emetteur (retirer les plus anciens du meme emetteur) et la consommation d'un
reveil differe (le meme enregistrement passe a 'wake_pending: false' avec l'etat
re-derive). Le fichier des marques de lecture existe parce que 'only_unread' a besoin
de savoir ce qui a deja ete tire ; il est borne lui aussi. **Multi-process** : deux
processus qui ecrivent le meme arbre ne sont pas serialises (voir « ce qui n'est pas
fait »).

## Les deux outils

- 'channel_post({ kind, summary, target?, revision?, verdict?, payloadRef? })' rend
  '{ id, state, duplicate, wake }'. Un message eligible rend 'wake: "pending"' : le
  reveil se decide a l'arret, pas ici ;
- 'channel_read({ since?, kinds?, only_unread? })' rend au plus 10 enveloppes **qui
  lui sont adressees**, les plus recentes, et les marque lues. 'since' accepte un id
  deja lu ou une date ISO.

Ces listes sont **exhaustives** : toute autre cle de l'appel est ignoree et
journalisee ('undeclared-argument'). Ni 'to', ni 'root', ni 'from' ne sont de la
surface.

## Le montage : une ligne HOTE, des outils installes PAR AGENT — mesure

Un outil enregistre depuis la portee d'une ligne n'atteint jamais la surface composee
d'un agent : c'est mesure deux fois et ecrit dans
'packages/boost-mode/cordis.patch.yml:369-384'. Le canal est donc monte au niveau HOTE
et installe ses deux outils **dans la surface de chaque agent** depuis un listener
'agent/created' — le motif de 'packages/detached-jobs/lib/index.js:985-1026'.
La raison, ici, est la PORTEE DE L'ENREGISTREMENT (un outil enregistre depuis la
portee d'une ligne n'atteint pas la surface composee) ; ce n'est pas le TAG DE
PORTEE, qui decide lui de la livraison du feed — deux mecanismes distincts, mesures
par deux probes distincts.

L'inconnue restante etait l'ORDRE avec 'tools.restrict()', que
'applyChildComposition' ('dsh-subagent/lib/types/child-agent.js:157-172') applique
pendant le 'setup' de creation — donc AVANT l'annonce 'agent/created'
('dsh-agent/lib/types/index.js:319-337'). 'tools/probe-mount.mjs' monte le VRAI registre
d'outils sur une vraie application cordis, applique le filtre REEL avant l'annonce, puis
lit la surface modele ('schemas(agent)') de l'enfant :

    PROBE-filtre-deny: filtre applique avant agent/created: {"deny":["write","edit","present","ask_user_question","todo_write","subagent"]}
    PROBE-filtre-deny: SURFACE COMPLETE de l enfant: read, channel_post, channel_read
    PROBE-filtre-deny: outils ENREGISTRES pour l enfant (get): channel_post, channel_read
    PROBE-filtre-deny: outils sur la SURFACE MODELE de l enfant (schemas): channel_post, channel_read
    PROBE-filtre-deny: outils visibles SANS portee (niveau hote): (aucun)
    PROBE-PASS — ...

Le controle « le filtre a mordu » est la : sans lui, un filtre inerte ferait passer
l'absence de mesure pour une preuve.

## Ce qui n'est pas fait

- **un 'resultat' dont l'emetteur s'arrete sans jamais quitter le registre** reste
  'wake_pending' : le §4 exige l'etat 'done', et 'blocked' ne le justifie pas. Le
  message reste lisible par 'channel_read' — mais il ne reveille personne. C'est le
  prix de la regle ; l'inverse (reveiller sur 'blocked' pour un 'resultat') ferait
  dire au §4 autre chose que ce qu'il dit ;
- **un message eligible depose par un emetteur DEJA arrete** (ce que l'outil ne
  peut pas faire : un appel d'outil implique un tour ouvert) reste en attente
  jusqu'a son prochain arret. La voie du service interne peut le produire ; la
  parade serait de decider au depot, ce que la regle interdit ;
- **l'index des attentes est en memoire** : le marqueur 'wake_pending' est bien dans
  l'enregistrement stocke, donc un redemarrage ne re-evalue pas ce qui l'a deja ete ;
  mais un processus neuf ne re-evalue pas non plus les attentes laissees par un
  processus precedent — meme limite que le multi-process ci-dessous ;
- **multi-process** : rien ne serialise deux processus ecrivant le meme arbre. Le
  harnais fournit 'withFileLock' ; il n'est pas utilise ici (CANAL §10 le liste comme
  ouvert) ;
- **la portee du N** (50 par emetteur) n'est pas calibree sur une mesure : c'est une
  valeur de depart, comme le document le demande ;
- **le cout du canal** n'est pas instrumente en tokens : seuls les compteurs de volume
  le sont — et la lecture refusee d'un enfant n'est comptee qu'en nombre, pas en
  tentatives distinguees par appelant.

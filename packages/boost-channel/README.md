# @local/dsh-boost-channel — le canal de retour

Le canal entre un enfant et le proprietaire de son arbre. Specification complete :
'../../docs/CANAL.md' ; decisions : 'docs/DECISIONS.md' (D7-D13).

    node --test                        # depuis la racine du depot (decouverte)
    node --test test/channel.test.mjs  # depuis ce paquet
    node tools/probe-stop.mjs          # quel evenement marque l'arret (mesure)
    node tools/probe-mount.mjs         # la ligne HOTE installe par agent (mesure)

Un SEUL cas exige le harnais installe ('@deepseek-ai/dsh', resolu par 'DSH_HARNESS' ou
'%APPDATA%\npm\node_modules') : **T-V1**, qui monte le vrai 'ToolRuntime' et passe par
'registry.execute(...)'. Tous les autres n'ont besoin de rien.

## Ce que le canal transporte, et ce qu'il refuse de transporter

Une enveloppe STRUCTUREE, jamais la charge utile (D13) :

    { id, from, at, kind, state, to, target, revision, verdict, summary, payloadRef, payloadChars, truncated, throttled?, filtered?, wake_pending? }

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
| 'throttled' | present SEULEMENT sur un message que la bourse de son kind n'a pas pu livrer : il est STOCKE et tirable, mais il ne sera pas livre. Absent = rien n'a ete refuse |
| 'filtered' | present SEULEMENT sur un message que la POLITIQUE DU DESTINATAIRE a refuse (kinds non reveillants seulement) : STOCKE et tirable lui aussi. Absent = le destinataire n'a rien exclu |

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
  une generation gardee dans '<fichier>.1' — et la LECTURE lit les DEUX : la surface lisible
  est exactement ce que le disque porte ;
- l'identite d'un message n'est JAMAIS reemise : la marque est monotone par emetteur, et une
  place reservee n'est jamais ecrasee (collision journalisee et depot refuse) ;
- adressage : un fichier par arbre, ET un destinataire par message, applique a la lecture ;
- deduplication par identite d'id, jamais par texte ;
- 'payloadRef' refuse une chaine multiligne : un chemin n'a pas de retour a la ligne.

## Le jeton de livraison : le budget appartient au DESTINATAIRE

La taille etait bornee, le NOMBRE ne l'etait pas : le chemin 'inject' livrait sans plafond, et 200
'avancement' d'un meme enfant injectaient 200 lignes (~26 000 caracteres) dans le contexte de son
proprietaire — la ressource rare, partagee par tous ses enfants. Deux bourses SEPAREES bornent
desormais la livraison, chacune par emetteur ET par arbre, sur une fenetre glissante de 300 s :

    ORDINAIRE  decouverte, avancement :  2 / emetteur / 300 s   ET   4 / ARBRE / 300 s
    RESERVEE   question, resultat, echec:                       3 / ARBRE / 300 s

Quatre nombres et une fenetre, nommes et exportes par le paquet : 'ORDINARY_PER_SENDER',
'ORDINARY_PER_TREE', 'RESERVED_PER_TREE', 'RESERVED_PER_SENDER' (aucune borne par emetteur sur la
reservee, et c'est un choix : un enfant bloque atteint toujours son proprietaire quels que soient les
bavardages de ses freres) et 'DELIVERY_WINDOW_MS'. La plus stricte des deux bornes mord, donc un seul
enfant tres bavard ne peut pas manger la bourse de l'arbre.

- **la reservee n'est JAMAIS consommee par l'ordinaire** : le bruit ne peut pas affamer le signal ;
- **ce qui est borne est la LIVRAISON, jamais l'ECRITURE** : un message refuse est STOCKE, marque
  'throttled: true', et reste tirable par 'channel_read'. Un jeton qui ferait perdre un message serait
  pire que le bruit qu'il evite ;
- **le jeton est VISIBLE** : 'channel_post' rend 'budget: { ordinary, reserved }', le restant des deux
  bourses apres ce depot. Un agent qui le voit peut choisir de se taire ; celui qui l'ignore devient un
  chiffre. Le champ est aussi rendu dans le TEXTE de l'outil, parce qu'un appelant qui ne passe pas par
  PTC ne voit que ce texte ;
- **une place se reserve, puis se rend** : un message eligible ('question', 'resultat', 'echec')
  reserve sa place des le depot — sa livraison est differee jusqu'a l'arret de son emetteur — et la
  place est RENDUE quand la livraison n'a pas lieu (retrogradation §6, cadence, destinataire disparu,
  message evince par la borne par emetteur). Sans cela, un message jamais livre gelerait une place pour
  toute la fenetre, et le bruit affamerait le signal par la bande ;
- **ce dispositif est distinct du limiteur de reveil** (1 / enfant / 120 s, 3 / arbre / 120 s) : le
  limiteur borne la CADENCE des tours ouverts, les bourses bornent la LIVRAISON. Les fusionner ferait
  dire a l'un des deux autre chose que ce qu'il dit : un reveil refuse par la cadence ne consomme
  aucune place de bourse, et une bourse epuisee ne consomme aucune place du limiteur ;
- **une bourse epuisee ne change aucune regle** : l'eligibilite depend du KIND SEUL ('isWakeEligible'),
  la table du §4 est inchangee, et un 'avancement' refuse n'obtient jamais 'wake_pending'.

**Falsification** (le cas doit ECHOUER quand on retire la borne) : sur une copie jetable hors du
depot, remplacer 'ORDINARY_PER_TREE = 4' par 'Number.POSITIVE_INFINITY', puis lancer
'node --test test/channel.test.mjs' dans la copie. T-J2 (5 enfants, 4 livres au plus) tombe : les cinq
depots rendent 'injected' la ou le cinquieme doit rendre 'throttled'. Mesure : 39 cas sur 42 passent
dans cette copie, et T-J3 et T-J7 tombent avec T-J2 — les trois cas qui tiennent la borne d'arbre.

## La politique du destinataire : le CONTENU est regle par celui qui le recoit

Le proprietaire pouvait filtrer ce qu'il **tire** ('channel_read' : kind, date, jamais-lu) mais
subissait tout ce qu'on lui **pousse** : le jeton borne le VOLUME, rien ne bornait le CONTENU. Or la
regle 6 du §5 dit « le destinataire peut dire stop » — sur la poussee, il ne pouvait pas.

**Elle appartient au DESTINATAIRE** (le proprietaire de l'arbre), jamais a l'emetteur, et elle ne
porte QUE sur les kinds **non reveillants** : 'decouverte' et 'avancement'.

- **un 'question', un 'resultat' ou un 'echec' passe TOUJOURS, meme sous un filtre vide.** Sans cette
  clause, l'arbitre deviendrait un filtre a disparition : le proprietaire qui filtre le bruit perdrait
  aussi le signal, et la bourse reservee ne servirait plus a rien. C'est la condition non negociable,
  et c'est ce que T-F2 tient ;
- **un message filtre n'est jamais perdu** : STOCKE, marque 'filtered: true', compte, et tirable par
  'channel_read'. Meme regle que le jeton : on refuse la livraison, jamais l'ecriture ;
- **le refus explicite prime sur la borne de volume** : quand les deux refuseraient, la reponse vaut
  'wake: "filtered"', et les deux compteurs restent separes ;
- elle s'applique a l'**ARBRE** : c'est la politique du proprietaire, et elle vaut pour tout ce qui
  est injecte dans cet arbre.

**Deux facons de la regler**, et un defaut **permissif** (rien ne change pour qui ne regle rien) :

1. la **cle de configuration** 'injectKinds' de la ligne du plugin — meme endroit que 'maxBytes',
   'keep' et 'readLimit'. Absente = permissive ; 'injectKinds: ["decouverte"]' n'injecte plus que les
   decouvertes. Une valeur invalide est JOURNALISEE ('inject-config-invalid') et laisse le defaut
   permissif : un montage ne tombe pas pour un reglage, et rien n'est perdu pour autant ;
2. l'outil **'channel_subscribe({ inject: [...] })'**, qui la rend reglable **en cours de vol**.
   'inject' est une liste d'AUTORISATION : '[]' n'injecte plus aucun kind ordinaire,
   '["decouverte","avancement"]' remet le defaut permissif. **Lister un kind reveillant LEVE** —
   ce n'etait pas un no-op : 'inject: ["echec"]' rendait 'inject: []' et ETEIGNAIT toute la
   politique ordinaire d'un appelant qui croyait ne rien changer (mesure). L'appel rend ce qui est
   desormais injecte : '{ inject, refused, why }'.

**Seul le proprietaire de l'arbre peut l'appeler.** Un enfant est REFUSE, compte
('subscribe_refused', ligne 'subscribe-refused'), et sa demande ne change RIEN — meme forme que
'read_refused', parce qu'un refus muet se lit comme un reglage applique. Un argument invalide, lui,
LEVE : une politique qu'on devine est pire qu'une politique qui s'abstient.

**Falsification** (T-F2 doit ECHOUER) : sur une copie jetable hors du depot, retirer la clause « les
kinds reveillants passent toujours » — elle est tenue en trois points (le garde de 'filtersKind',
l'ordre des branches de 'post', et le marquage de l'attente) — puis lancer
'node --test test/channel.test.mjs' : UN SEUL cas tombe, T-F2, avec 'filtered' la ou 'pending' est
attendu (le compte exact suit la taille de la suite, il n'est pas fige ici).

## Ce qui est sur le disque est ce qui se LIT (rotation x identite x place)

Mesure du verificateur sur la revision gelee : 'load()' ne lisait que le fichier ACTIF. Trois
consequences, toutes mesurees :

1. **les messages throttles ou filtres disparaissaient** de la surface des qu'une rotation renommait
   le fichier — « jamais perdu » etait faux des qu'un fichier tournait ; 'writeAll' supprimait en plus
   la generation '.1' sans l'avoir reintegree ;
2. **une place reservee fuyait definitivement** : l'id etait recalcule sur le seul fichier actif, donc
   reemis apres une rotation, et 'markPending' ecrasait en silence la place du message precedent —
   perdue pour toute la fenetre ;
3. **la bourse reservee pouvait etre videe a zero** sans qu'aucune livraison reservee n'ait eu lieu, et
   la 'question' d'un frere innocent etait refusee : l'etat exact que cette bourse existe pour
   empecher.

Trois regles, tenues par T-R1, T-R2 et T-R4 :

- **la lecture lit la generation ET le fichier actif**, dans l'ordre chronologique : rien de ce qui a
  ete ecrit ne disparait de la surface de lecture ;
- **'writeAll' ne supprime '.1' que s'il l'a reintegree** ('merged') : sinon il ne le touche pas. La
  borne 'KEEP_PER_SENDER' s'applique a l'ensemble FUSIONNE, jamais au seul fichier actif ;
- **l'identite est monotone** : une marque haute par emetteur (et par magasin) vit en memoire, comme
  l'index des attentes, et ne redescend jamais — l'id est une IDENTITE, pas un numero de ligne ;
- **une place tenue n'est jamais ecrasee** : si un id est deja en attente d'arret, la collision est
  journalisee ('pending-collision') et le depot est REFUSE, avant toute consommation. Rien n'est
  consomme, rien n'est ecrit, la place du premier est intacte.

**Falsification** (T-R1 doit ECHOUER) : sur une copie jetable hors du depot, remettre la lecture du
SEUL fichier actif dans 'load()' (rendre 'this.readLines(this.file)' sans concatener '.1'), puis
lancer 'node --test test/channel.test.mjs' : T-R1 tombe, la lecture ne rend plus que la generation
vivante.

## La valeur RENDUE passe le REGISTRE (T-V1)

Mesure faite sur le paquet voisin, et qui vaut pour celui-ci : un outil rendait un champ
('sources') que son **schema de sortie ne declarait pas**. 'dsh-tools' valide la valeur au retour et
REJETTE toute cle non declaree ('dsh-tools/lib/index.js:468' : `"value.sources" is not a declared
property (additionalProperties: false)`, leve en `tool "..." returned invalid output`). **Vingt-quatre
cas passaient, l'outil n'avait JAMAIS fonctionne en usage reel** — parce que tous appelaient
'tool.execute(...)', c'est-a-dire **au-dessus** de la couture qui valide.

**T-V1** monte donc le VRAI 'ToolRuntime' ('dsh-tools'), la ligne comme le profil la monte, laisse le
vrai 'agent/created' installer les trois outils dans la surface de l'agent, puis appelle
'registry.execute({ callId, name, arguments, agent, signal })'. Il exerce **les cinq verdicts** de
'channel_post' ('self', 'injected', 'throttled', 'filtered', 'pending') parce qu'un schema peut etre
juste sur un chemin et faux sur un autre, plus 'channel_read' (proprietaire et enfant) et
'channel_subscribe' (proprietaire, enfant refuse, argument qui LEVE). Le journal part dans un
'mkdtemp' passe en configuration ('home'), jamais dans le '$DSH_HOME' de la machine.

**Falsification** (T-V1 doit ECHOUER) : sur une copie jetable hors du depot, ajouter une cle NON
DECLAREE a la valeur rendue — dans 'post', rendre
'{ id, state, duplicate, wake, budget, sources: { kind, wake } }' — puis lancer
'node --test test/channel.test.mjs' : UN SEUL cas tombe, T-V1, avec le message du registre
('"value.sources" is not a declared property').

## Les compteurs de sante (§7), exposes et journalises

Quatorze lectures, dont une jauge : 'posted', 'read', 'read_refused', 'delivered',
'wake_sent', 'wake_refused', 'wake_pending' (messages en attente d'arret),
'truncated', 'deduped', 'throttled' (messages livres a ZERO par une bourse
epuisee), 'throttled_by_sender' (le meme compte, par emetteur : un total ne
designe pas le brouilleur, un compte par emetteur si), 'filtered' (messages
refuses par la POLITIQUE du destinataire), 'filtered_by_kind' (le meme compte, par
kind) et 'subscribe_refused' (politique demandee par un non-proprietaire). Deux voies :

- **service** : 'ctx.get("boostChannel")' rend l'instance ; sa methode est
  'channel.stats()' (et 'post' / 'read' / 'stopped' pour un appelant de confiance —
  c'est cette voie qui peut nommer un destinataire 'to' ou un magasin 'root') ;
- **journal** : '$DSH_HOME/plugin-data/dsh-boost-channel/decisions.jsonl', une ligne par
  decision ('post', 'stop', 'wake-reeval', 'throttled', 'filtered', 'subscribe',
  'subscribe-refused', 'inject-config-invalid', 'read', 'read-refused',
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
re-derive). Une reecriture n'efface la generation '<fichier>.1' que si elle vient de
la LIRE ('load' fusionne, 'writeAll' ne supprime que ce qu'il a reintegre). Le fichier des marques de lecture existe parce que 'only_unread' a besoin
de savoir ce qui a deja ete tire ; il est borne lui aussi. **Multi-process** : deux
processus qui ecrivent le meme arbre ne sont pas serialises (voir « ce qui n'est pas
fait »).

## Les trois outils

- 'channel_post({ kind, summary, target?, revision?, verdict?, payloadRef? })' rend
  '{ id, state, duplicate, wake, budget }'. Un message eligible rend 'wake: "pending"' : le
  reveil se decide a l'arret, pas ici. 'wake: "throttled"' dit que la bourse de ce kind etait
  epuisee, 'wake: "filtered"' que la politique du proprietaire refuse ce kind — dans les deux
  cas le message est STOCKE, il n'est pas livre. 'budget' rend le restant des deux bourses,
  et le texte rendu par l'outil le porte aussi ;
- 'channel_read({ since?, kinds?, only_unread? })' rend au plus 10 enveloppes **qui
  lui sont adressees**, les plus recentes, et les marque lues. 'since' accepte un id
  deja lu ou une date ISO. Les messages refuses par la politique sont la, comme les autres :
  c'est le « tirer, pas pousser » ;
- 'channel_subscribe({ inject: [...] })' regle ce que le PROPRIETAIRE de l'arbre accepte de voir
  injecte : '{ inject, refused, why }'. 'inject' est une liste d'autorisation portant sur les kinds
  non reveillants ; les kinds reveillants passent toujours. Un non-proprietaire est refuse et compte.

Ces listes sont **exhaustives** : toute autre cle de l'appel est ignoree et
journalisee ('undeclared-argument'). Ni 'to', ni 'root', ni 'from' ne sont de la
surface.

La liste des outils est exportee par le paquet ('TOOL_NAMES') et c'est la **source unique** : la
fabrique, les deux sondes et la suite la lisent. Un quatrieme outil ajoute sans elle fait rougir un
cas de la suite — pas une sonde que personne ne lance. Mesure : 'probe-stop.mjs' verifiait encore
« deux outils » et sortait en PROBE-FAIL sans executer une seule mesure, pendant que
'probe-mount.mjs' n'inspectait que deux noms sur trois.

## Le montage : une ligne HOTE, des outils installes PAR AGENT — mesure

Un outil enregistre depuis la portee d'une ligne n'atteint jamais la surface composee
d'un agent : c'est mesure deux fois et ecrit dans
'packages/boost-mode/cordis.patch.yml:369-384'. Le canal est donc monte au niveau HOTE
et installe ses trois outils **dans la surface de chaque agent** depuis un listener
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
      (mesure ANTERIEURE a 'channel_subscribe' : le troisieme outil s'ajoute a cette surface, et c'est
       le corps de l'outil — pas sa visibilite — qui refuse un non-proprietaire)
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
- **la politique d'injection vit en memoire** : elle est posee par 'channel_subscribe' dans le
  processus qui l'a recue, et la cle 'injectKinds' est relue au MONTAGE. Un processus neuf repart donc
  du defaut de la ligne — meme limite que l'index des attentes ci-dessous, et la politique est un
  reglage, pas une donnee : rien n'est perdu, un message filtre reste stocke et tirable ;
- **les places reservees vivent en memoire** : une place est prise au depot et rendue a l'arret, dans
  le processus qui a vu les deux. Un redemarrage les perd — la fenetre de 300 s les expire de toute
  facon — et un second processus n'en voit aucune : meme limite que le multi-process ci-dessous ;
- **les quatre nombres ne sont pas calibres sur une mesure** : 2 / 4 / 3 viennent de la conception
  (CANAL §5, regle 7) et sont des constantes exportees, pas des reglages etudies ;
- **le cout du canal** n'est pas instrumente en tokens : seuls les compteurs de volume
  le sont — et la lecture refusee d'un enfant n'est comptee qu'en nombre, pas en
  tentatives distinguees par appelant.

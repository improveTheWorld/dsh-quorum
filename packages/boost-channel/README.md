# @local/dsh-boost-channel — le canal de retour

Le canal entre un enfant et le proprietaire de son arbre. Specification complete :
'../../docs/CANAL.md' ; decisions : 'docs/DECISIONS.md' (D7-D13).

    node --test                        # depuis la racine du depot (decouverte)
    node --test test/channel.test.mjs  # depuis ce paquet

## Ce que le canal transporte, et ce qu'il refuse de transporter

Une enveloppe STRUCTUREE, jamais la charge utile (D13) :

    { id, from, at, kind, state, to, target, revision, verdict, summary, payloadRef, payloadChars, truncated }

| champ | sens |
|---|---|
| 'id' | '<from>:<seq>' — l'identite, et la seule cle de deduplication (jamais le texte) |
| 'kind' | ce que l'appelant DECLARE : 'decouverte' · 'avancement' · 'question' · 'resultat' |
| 'state' | ce que le runtime DERIVE : 'running' · 'blocked' · 'done' · 'failed' |
| 'to' | la racine de l'arbre : l'adressage est une propriete du stockage, pas d'un filtre |
| 'target' + 'revision' + 'verdict' | le verdict attache a une cible (§8) : deux verdicts opposes sur la meme cible deviennent une donnee |
| 'summary' | texte court, PLAFOND DUR de 2000 caracteres, troncature VISIBLE ('truncated: true') |
| 'payloadRef' | un CHEMIN vers la preuve brute — jamais son contenu — et 'payloadChars' sa taille |
| 'truncated' | vrai des que le resume a ete coupe |

## La politique de reveil (§4)

| kind declare | etat derive | reveille ? | comment |
|---|---|---|---|
| 'decouverte' / 'avancement' | 'running' | non | 'Agent.inject' : le contexte du proprietaire, sans ouvrir de tour |
| 'question' | 'blocked' | oui | 'Agent.send(message, "next-step", true)' |
| 'resultat' | 'done' | oui, une fois | le limiteur de cadence fait le « une fois » |
| n'importe lequel | 'failed' | oui | un 'tool/result' en erreur se constate, il ne se declare pas |

**Retrogradation (§6)** : une 'question' dont l'etat derive est 'running' — l'enfant n'a
pas cesse de produire — est STOCKEE, et **rien n'est appele** : ni 'send', ni 'inject'.
Le compteur 'wake_refused' l'enregistre. C'est ce qui rend l'inflation d'urgence
inoperante : un agent qui veut etre entendu doit s'arreter.

**Cadence** : au plus UN reveil par enfant et par 120 s, et au plus TROIS par arbre et par
120 s. Au-dela le message est stocke et le reveil compte comme 'wake_refused'
('refused:child-rate' ou 'refused:tree-rate' dans le journal).

## Les etats derives, et leurs trois faits

    failed   le dernier tool/result de l'emetteur est en erreur (waterfall 'tools/post-execute')
    done     l'emetteur n'est plus vivant dans le registre — il ne produira plus
    blocked  vivant mais pas en cours : il a cesse de produire
    running  tout le reste : un tour est ouvert

Aucun de ces faits ne vient du message. Un enfant ne peut pas declarer 'blocked' ni
'failed' : il declare un 'kind', et le runtime constate l'etat.

## Les bornes anti-brouillage

- plafond DUR de 2000 caracteres par resume, troncature visible ; coupe en POINTS DE
  CODE ('Array.from'), jamais a un index UTF-16 — un substitut isole tue la session ;
- les 50 derniers messages **par emetteur** ('KEEP_PER_SENDER'), les plus anciens retires ;
- rotation a 8 Mio par arbre (couture de test : 'DSH_BOOST_CHANNEL_LOG_MAX_BYTES'),
  une generation gardee dans '<fichier>.1' ;
- adressage : un fichier par arbre, donc un arbre ne peut pas lire les messages d'un autre ;
- deduplication par identite d'id, jamais par texte ;
- 'payloadRef' refuse une chaine multiligne : un chemin n'a pas de retour a la ligne.

## Les compteurs de sante (§7), exposes et journalises

Sept compteurs : 'posted', 'read', 'delivered', 'wake_sent', 'wake_refused', 'truncated',
'deduped'. Deux lectures :

- **service** : 'ctx.get("boostChannel")' rend l'instance ; sa methode est
  'channel.stats()' (et 'post' / 'read' pour un appelant de confiance) ;
- **journal** : '$DSH_HOME/plugin-data/dsh-boost-channel/decisions.jsonl', une ligne par
  decision plus un instantane '{"step":"stats", ...}' apres chacune. Le journal tourne a
  8 Mio et n'echoue jamais — un diagnostic qui casse ce qu'il observe est pire que rien.

La metrique qui decide si le canal EST du bruit reste le rapport 'delivered / read'.

## Stockage

    $DSH_HOME/plugin-data/dsh-boost-channel/<racine>.jsonl        les messages de l'arbre
    $DSH_HOME/plugin-data/dsh-boost-channel/<racine>.read.jsonl   les marques de lecture (only_unread)
    $DSH_HOME/plugin-data/dsh-boost-channel/decisions.jsonl       le journal du plugin

Le chemin rapide APPEND une ligne. La seule reecriture est celle qu'exige la borne par
emetteur (retirer les plus anciens du meme emetteur). Le fichier des marques de lecture
existe parce que 'only_unread' a besoin de savoir ce qui a deja ete tire ; il est borne
lui aussi. **Multi-process** : deux processus qui ecrivent le meme arbre ne sont pas
serialises (voir « ce qui n'est pas fait »).

## Les deux outils

- 'channel_post({ kind, summary, target?, revision?, verdict?, payloadRef? })' rend
  '{ id, state, duplicate, wake }' ;
- 'channel_read({ since?, kinds?, only_unread? })' rend au plus 10 enveloppes, les plus
  recentes qui correspondent, et les marque lues. 'since' accepte un id deja lu ou une
  date ISO.

## Le montage : une ligne HOTE, des outils installes PAR AGENT — mesure

Un outil enregistre depuis la portee d'une ligne n'atteint jamais la surface composee
d'un agent : c'est mesure deux fois et ecrit dans
'packages/boost-mode/cordis.patch.yml:369-384'. Le canal est donc monte au niveau HOTE
et installe ses deux outils **dans la surface de chaque agent** depuis un listener
'agent/created' — le motif de 'packages/detached-jobs/lib/index.js:985-1026'.

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
    PROBE-filtre-deny: outils existants masques par le filtre: write, edit, present, ask_user_question, todo_write, subagent
    PROBE-filtre-deny: le filtre a mordu sur les outils existants: oui
    PROBE-PASS — ...

Le controle « le filtre a mordu » est la : sans lui, un filtre inerte ferait passer
l'absence de mesure pour une preuve. Les trois compositions mesurees (sans filtre, filtre
'deny' du preset, liste 'allow') laissent les deux outils sur la surface modele de
l'enfant, alors que les memes filtres masquent bien les outils pre-existants. Aucune
lecture sans portee ne les voit : le niveau hote n'enregistre RIEN.

**Pourquoi pas une ligne DANS le preset** — deux raisons, dont la premiere suffit :

1. la resolution d'un 'name:' RELATIF dans une liste 'plugins:' de preset n'a pas la
   meme base que dans un patch : le preset monte ses lignes avec
   'ctx.extend({ baseUrl: record.context.baseUrl })' ('dsh-agent-preset-registry/lib/index.js:534'
   puis ':269'), et c'est cet URL qui sert de base a 'loader.import(row.name, baseUrl)'
   ('dsh-app-boot/lib/index.js:3116'). Un 'name' relatif y depend donc de l'endroit ou le
   fichier de patch est installe, pas du paquet. Ce n'est PAS une mesure de bout en bout :
   c'est une lecture du code, et elle est declaree comme telle. La voie (b), elle, est
   mesuree (probe ci-dessus) ;
2. le fichier du preset ('packages/boost-mode/cordis.patch.yml') n'est pas dans le
   perimetre de ce paquet.

## Ce qui n'est pas fait

- **multi-process** : rien ne serialise deux processus ecrivant le meme arbre. Le
  harnais fournit 'withFileLock' ; il n'est pas utilise ici (CANAL §10 le liste comme
  ouvert) ;
- **la portee du N** (50 par emetteur) n'est pas calibree sur une mesure : c'est une
  valeur de depart, comme le document le demande ;
- **le cout du canal** n'est pas instrumente en tokens : seuls les compteurs de volume
  le sont ;
- **le reveil « une fois » d'un 'resultat'** est borne par la fenetre de cadence (120 s),
  pas par une duree de vie du resultat : un 'resultat' est stocke, et le proprietaire peut
  toujours le tirer avec 'channel_read'.

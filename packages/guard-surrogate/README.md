# dsh-guard-surrogate

Un garde-fou pour une seule panne, mesuree : **un demi-caractere UTF-16 (surrogate
isole) dans un resultat d'outil tue la session**.

Il s'abonne au waterfall `tools/post-execute` de `dsh-tools`, attend la decision
de la chaine, et remplace les demi-caracteres non apparies par U+FFFD avant que le
resultat ne soit journalise — dans le `content` d'une decision `accept` comme
dans le `feedback` d'une decision `block`.

## Le defaut

- Un surrogate isole dans un `tool/result` fait echouer **toutes** les requetes
  suivantes : HTTP 400 INVALID_REQUEST, 7 echecs consecutifs mesures, session
  perdue. Mesure du 2026-09-30 : sur les 182 journaux de session alors presents
  (le corpus en comptait 188 en fin de soiree), 3 en contenaient un et les 3
  sessions sont mortes ; 0 contre-exemple.
- Le chemin fournisseur (`dsh-llm-deepseek`) ne sanitise rien : 0 occurrence de
  `sanitize|surrogate|WellFormed`.
- Le texte casse reste dans l'historique reconstruit, donc le defaut ne
  s'efface pas tout seul : il faut qu'il ne soit jamais journalise.

## L'accroche, et pourquoi celle-la

`tools/post-execute` est un waterfall
(`dsh-tools/lib/types/index.d.ts:70`) :

    (exec, result, next) => Promise<PostToolDecision>

Trois proprietes mesurees en font le bon point d'accroche :

1. **Il est en amont du journal.** `dsh-agent-loop/lib/index.js:570-571` fait
   `await finalize(...)` **puis** `appendToolResult(...)`. Le contenu rendu par
   le waterfall est donc celui qui est ecrit dans le journal de session, et
   celui que `deriveMessages()` reconstruit ensuite. L'invariant
   `request === deriveMessages()` (`dsh-agent-loop/lib/invariant.js:26-27`) est
   **satisfait**, pas neutralise.
2. **La substitution est du code de premiere classe.** Une decision
   `{ kind: 'accept', content: [...] }` remplace le contenu sans redispatch ni
   rejeu (`dsh-tools/lib/index.js:3527-3531`).
3. **Un listener fautif ne tue pas la session.** `finalizeScheduledExecution`
   contient l'exception (`dsh-tools/lib/index.js:3359-3372`) : le resultat devient
   une erreur et la session survit.

Le listener est enregistre avec `{ prepend: true }` et suit le precedent du
harnais (`dsh-spill-policy/lib/index.js:237-255`) : il **appelle toujours
`await next()` d'abord**, puis nettoie la decision rendue. Il ne court-circuite
jamais la chaine.

## Installation (au REDEMARRAGE, jamais a chaud)

Le plugin vit hors du profil. Comme tout bundle lie (`link:`), il doit etre
declare dans le `package.json` du profil **et** dans ses bundles, puis le profil
doit etre reinstallé. Une entree de patch seule ne monte rien : dans une couche
de patch, une entree sans liste `insert:` ne fait que modifier une ligne
**existante**, et un id que personne ne declare n'a pas de cible
(`dsh-app-boot/lib/index.js`, avertissement ecrit dans le terminal de `dsh web`).

**1. Declarer le bundle** — `C:\Users\bilel\.dsh\profiles\web\package.json` :

```json
{
  "dependencies": {
    "@local/dsh-guard-surrogate": "link:C:/CodeSource/dsh-guard-surrogate"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@local/dsh-guard-surrogate"
      ]
    }
  }
}
```

**2. Installer** (le profil, pas ce depot) : `pnpm install` dans le dossier du
profil, ou la ligne via le gestionnaire de plugins de l'interface. Cela cree la
jonction `<profil>/node_modules/@local/dsh-guard-surrogate`.

**3. Extraire YAML a ajouter au patch du profil**
(`C:\Users\bilel\.dsh\profiles\web\cordis.patch.yml`) pour piloter la ligne :

```yaml
- id: dsh-guard-surrogate
  config:
    enabled: true
```

**4. Redemarrer** `dsh web`. La ligne est creee par le patch du bundle
(`cordis.patch.yml` de ce depot, forme `insert:`) et cette entree ne fait que
fixer sa configuration.

Ne pas editer le patch du profil en cours de session : `dsh-hmr` surveille le
`package.json` du profil, et le modifier force une relecture de **toutes** les
couches depuis le disque alors que le processus vivant est encore l'ancien
build.

## Interrupteur

`config.enabled` (defaut `true`). Le champ est declare `volatile` dans le
schema Schemastery, donc il est **modifiable a chaud** : le loader commit la
nouvelle valeur dans la reference vivante sans remonter la ligne
(`cordis-plugin-loader/lib/index.js:380-425`). Le listener lit la reference a
chaque appel, jamais une valeur capturee au montage.

A `false`, le listener rend `await next()` immediatement : aucun nettoyage,
aucune trace, aucune reconstruction.

Si `@deepseek-ai/schemastery` n'est pas resolvable depuis l'installation en
cours, la ligne **monte quand meme et repare quand meme** : l'interrupteur est
alors lu dans la configuration brute, donc un changement demande un redemarrage.
Le plugin emet un avertissement au montage ; il ne se tait pas.

## Journal de traces

`$DSH_HOME/plugin-data/dsh-guard-surrogate/repairs.jsonl`, une ligne JSON par
nettoyage **reel** (`C:\Users\bilel\.dsh\plugin-data\dsh-guard-surrogate\repairs.jsonl`) :

```json
{"at":"2026-09-30T16:20:11.482Z","tool":"run_code","repaired":2,"blocks":1,"before":512,"after":512}
```

- `repaired` : nombre de demi-caracteres remplaces ; `blocks` : nombre de blocs
  `text` reconstruits. Ce sont les deux compteurs qui portent l'information.
- `before`/`after` : longueur totale en unites UTF-16 des blocs `text`, avant et
  apres. **U+FFFD remplace une unite par une unite, donc les deux sont egales par
  construction** : un ecart signalerait un changement de strategie.
- **Aucun contenu de message n'est recopie.** Seul le nom de l'outil identifie
  l'appel.

L'ecriture ne fait jamais echouer la requete (try/catch, silence total). Une
trace vaut mieux qu'une inertie silencieuse : apres une mise a jour du harnais
qui deplacerait ce waterfall, ce journal est la seule preuve que le plugin ne
repare plus rien.

## Tests

```
node --test          # depuis la racine du depot
```

26 tests, 0 saute, avec ET sans `DSH_PROFILE_DIR` dans l'environnement. Aucun cas
ne se retire en silence : si le harnais n'est pas resolvable, `k` **echoue** en
disant quoi installer, il ne saute pas.

Les deux cas de bout en bout montent le **vrai** `dsh-tools` sur un `Context`
cordis reel et lisent le resultat que la boucle journalise :

- `k` : un outil qui **rend** un texte empoisonne ;
- `k2` : un outil qui **leve** avec un message empoisonne.

Chacun commence par le **controle inverse** : sans la garde, le meme appel rend le
texte empoisonne. Sans ce controle, le test pourrait passer sur un fixture qui
n'a jamais contenu de surrogate.

## RISQUES

Ecrit sans minimiser. Ces points sont des limites assumees, pas des details.

1. **Un outil qui LEVE est couvert.** Une premiere version de ce README
   presentait le `throw` d'un outil comme un trou : c'etait faux, et c'est
   mesure. `dispatchToolBody` contient le `throw` du corps
   (`dsh-tools/lib/index.js:3313-3314`) et rend `kind: 'post-result'`
   (`dsh-tools/lib/index.js:3341`) : le waterfall tourne donc sur un echec
   d'outil, et le texte `"Error: " + errorMessage(error)`
   (`dsh-tools/lib/index.js:3616-3623`) est nettoye comme n'importe quel
   contenu. Le test `k2` le mesure de bout en bout sur le vrai registre :
   `Error: kaboom \uD83D end` sans la garde, `Error: kaboom \uFFFD end` avec.

   **Ce qui reste decouvert est plus etroit** : les six chemins `final-result`
   (`dsh-tools/lib/index.js:3178, 3183, 3199, 3219, 3269, 3346`) — la boucle
   appelle alors `finish(...)`, jamais `finalize(...)` — ne couvrent que des
   echecs **hors corps d'outil** : materialisation des arguments, un outil non
   appelable directement en mode collapsed (`:3183`), annulation avant dispatch,
   et les exceptions levees par un service d'approbation, un listener
   `tools/pre-execute` ou un wrapper `tools/execute`. Un message empoisonne
   produit par CES chemins-la est journalise sans passer par la garde. C'est la
   limite residuelle reelle.

   **Deux precisions mesurees sur cette enumeration** (troisieme falsification,
   30/09) : un **refus** d'approbation n'est PAS un chemin `final-result` — il
   rend `post-result` (`dsh-tools/lib/index.js:3243-3246`) et le waterfall tourne
   donc sur son texte ; seule une **exception** du service d'approbation tombe en
   `final-result` (`:3269`). Et qui recompte les cas sautes doit respecter la
   casse : un filtre insensible a la casse sur `# SKIP` compte aussi la ligne de
   resume `# skipped 0`.
2. **Apres une mise a jour du harnais qui ignorerait `content`**, la decision
   rendue serait acceptee mais le contenu d'origine journalise : le plugin
   deviendrait **inerte en silence**. C'est la raison d'etre du journal
   `repairs.jsonl` : il faut le relire apres toute mise a jour du harnais. Le
   test `k` mesure la chaine complete, donc une telle mise a jour casserait ce
   test — mais seulement la ou les tests tournent.
   Corollaire : si le waterfall `tools/post-execute` disparaissait ou changeait
   de nom, `ctx.on` enregistrerait un listener sur un evenement que personne
   n'emet, et rien ne le signalerait hors du journal vide.
3. **L'ordre entre deux listeners `prepend` n'est pas mesure.** `prepend` fait
   passer un listener avant les autres (`cordis/lib/index.js:336`), et entre deux
   `prepend` le dernier enregistre est le plus externe — mais l'ordre relatif
   avec `dsh-spill-policy`, qui s'abonne exactement de la meme facon, **n'a pas
   ete mesure ici**. Les deux se contentent de transformer une decision qu'ils ont
   lue : ils devraient composer, mais ce n'est pas prouve.
4. **Un listener plus EXTERNE que le mien qui court-circuite empeche la garde de
   tourner.** `prepend` place un listener avant les autres, et entre deux
   `prepend` le dernier enregistre est le plus externe
   (`cordis/lib/index.js:336`). Un listener enregistre apres le mien qui rend sa
   decision **sans appeler `next()`** ne me laisse jamais voir le contenu, et ce
   qu'il rend part au journal tel quel — y compris un `content` ou un `feedback`
   empoisonne. (`dsh-spill-policy` n'est pas dans ce cas : il appelle `next()`.)
5. **La copie journalisee par le mode PTC** (`tools/ptc-dispatch-log`,
   `dsh-spill-policy/lib/index.js:256-259`) n'est pas couverte : un resultat
   d'outil nettoye au niveau natif peut apparaître sous une autre forme dans
   l'entree `tool/ptc-dispatch`. Le mode PTC n'a pas ete teste ici.
6. **U+FFFD n'est pas neutre.** Le modele voit un caractere de remplacement la ou
   l'outil avait produit un demi-caractere. C'est le choix assume (visible plutot
   que silencieux), mais cela reste une modification du resultat d'outil.

## Ce qui n'a pas pu etre teste

- Le chargement de la ligne par le loader du profil (installation au
  redemarrage) : interdite pendant ce tour par la consigne.
- Le comportement avec `dsh-spill-policy` monte en meme temps (ordre reel des
  deux `prepend`).
- Les chemins `final-result` reels : ils demanderaient une politique
  `tools/pre-execute` qui leve avec un texte empoisonne, ou un refus
  d'approbation, et le mode PTC.
- Le rafraichissement a chaud de l'interrupteur par le loader : le schema est
  verifie `volatile` et la reference vivante est verifiee lisible, mais le
  `_commitVolatile` complet n'a pas ete execute.

# `@local/dsh-boost-relay`

Remonte à la session propriétaire de l'arbre les **settlements de jobs lancés à l'intérieur de ses
sous-agents** — le seul angle mort du système de jobs de DSH.

## Le problème, mesuré

Un job appartient à la session qui l'a lancé : `job_list` appelle `ctx.jobs.list(exec.agent?.id)` et
`JobRegistry.list(caller)` vérifie le lecteur **contre le propriétaire**. L'avis de fin, lui, part vers
ce propriétaire (`dsh-tool-jobs` s'abonne à `{ owners: 'scope' }`).

Conséquence : quand un worker invoqué en **premier plan** rend son rapport alors qu'un job qu'il a lancé
tourne encore, ce job se règle **sans que personne ne soit prévenu** — le worker est détruit, et
l'orchestrateur ne peut ni lister ce job ni lire sa sortie. Dans un run boost réel, le vérificateur a
laissé **5 jobs** (`pwsh-95/106/113/117/118`) que l'orchestrateur ne pouvait observer que comme *des
fichiers apparaissant sur le disque* — d'où une attente sans aucun indice de blocage, terminée par une
timebox de 4 minutes imposée à la main par l'utilisateur.

## Ce que fait le plugin

Il s'abonne au registre avec `{ owners: 'all' }` depuis la portée host, et quand un job se règle :

- dont le propriétaire est un **descendant** d'une session racine vivante,
- et **dont le propriétaire ne peut plus recevoir l'avis lui-même**,

il injecte — ou, si la racine est `idle`, **réveille** — un avis de fin nommant le job et le worker qui
l'a lancé, avec la seule action réellement possible : `send_message` au sous-agent s'il est continuable,
ou re-délégation du contrôle.

**La règle exacte, mesurée le 2026-10-03 sur 18 491 enregistrements de journal (2 jours).** Le relais
s'abstient quand l'avis serait **redondant**, et notifie quand **personne d'autre ne peut le porter** :

| Cause du settlement | Propriétaire | Décision | Motif journalisé |
|---|---|---|---|
| `teardown` | vivant ou non | **NOTIFIER** | le job est mort avec son worker — le cas cher, et la raison d'être du plugin |
| `kill` | vivant ou non | **NOTIFIER** | la décision a été prise ailleurs que chez le producteur |
| `producer` | **absent** du registre vivant | **NOTIFIER** | aucun agent ne recevra cet avis nativement |
| `producer` | `running` | **S'ABSTENIR** | `{step:'bail', why:'owner-already-notified'}` |
| `producer` | `idle` | **NOTIFIER** | vivant mais entre deux tours : personne ne peut affirmer qu'il a reçu l'avis |

L'abstention sur un propriétaire **`running`** est la doctrine existante du `owner-is-the-root`
(15 abandons mesurés), étendue au second cas — **pas une politique nouvelle**. Le relais envoyait
auparavant un avis qu'il étiquetait lui-même « treat this one as a duplicate » : sur les 53 avis relayés
en deux jours, **52 étaient `producer`** et **100 % portaient `ownerState: running`**.

« Vivant » est volontairement réduit à **`running`** : c'est le seul état que la mesure a observé, et un
propriétaire `idle` doit rester notifié — l'avis `pwsh-1` du 2026-10-02, le seul cas de repli réellement
mesuré, allait à une session `idle`. Un garde plus large **détruisait cet avis** (mesuré en écrivant
T-V6).

## Décisions assumées

| Choix | Raison |
|---|---|
| Montage **host-level**, pas dans le preset | Rien dans le preset ne peut rendre visible un job qui appartient à un autre propriétaire ; et un nouveau bundle s'active **à chaud**, sans redémarrage |
| Réutilisation du discriminant de source `tool-jobs` | Un plugin ne peut pas déclarer un nouveau membre de cette union à l'exécution ; et c'est bien un avis de job d'arrière-plan |
| Relation propriétaire → racine par les **en-têtes durables** (`parentSession`, 16 sauts), avec un **repli sur le plus haut ancêtre VIVANT** | Lecture durable : fonctionne aussi pour des enfants créés **avant** l'installation du plugin. Le repli est ce qui sauve une session **continuée** — après un redémarrage, la session reprise est un fork seedé dont le parent (l'ancien processus) est mort |
| Réveil plafonné à **3 par racine**, puis injection | Borne la chaîne auto-excitante « un tour réveillé démarre le travail dont la fin le réveille » |
| Aucun import statique de paquet Harness | Un bundle lié hors du profil ne résout pas les spécificateurs nus (`ERR_MODULE_NOT_FOUND`, vérifié) ; `createUserMessage` est résolu à l'exécution depuis l'ancre `process.argv[1]` |
| Ne rien relayer pour un `producer` dont le propriétaire est `running` | Son propre agent reçoit l'avis nativement : le relais serait un doublon. C'est la doctrine de `owner-is-the-root`, **étendue** — pas un gain d'efficacité, une mise en cohérence (le coût est en « Limites ») |
| Un avis **nomme le propriétaire réel** dès que le destinataire n'est pas lui | Le repli peut désigner un autre agent que le propriétaire. L'ancien texte affirmait alors deux choses fausses — « it receives this notice itself » et « Read its output with `job_output` » — et la seconde est **mesurée impossible** depuis là : `job_output(pwsh-238)` répond *« job pwsh-238 belongs to another session »*. Un avis qui promet une lecture impossible envoie l'agent vers un échec, ce qui est pire qu'un avis muet |

## Vérification

```
/boost-relay
```

Affiche : dépendance résolue ou non, ancre de résolution, relais effectués (dont réveils), settlements
ignorés, jobs déjà relayés, dernier relais. Aucun coût modèle — c'est une commande, pas un outil.

## Limites

- **Uniquement les jobs.** Les 5 jobs du vérificateur sont l'angle mort mesuré ; un processus lancé hors
  du registre de jobs (par exemple par un `Start-Process` détaché) reste invisible, et aucun relais ne
  peut le rattraper.
- **Aucun effet rétroactif** : les jobs déjà rétablis avant l'installation du relais ne sont pas
  rattrapés. Leur sortie reste lisible dans la session du worker.
- **Le relais ne remplace pas la règle de persona** : il rend le père *informé*, il ne l'empêche pas de
  dormir. Les deux corrections sont complémentaires.
- **La perte de l'abstention est réelle, et elle s'écrit.** La règle « s'abstenir sur un `producer` dont
  le propriétaire est vivant » **retire 4 lectures utiles : 8 %** des 52 avis `producer` relayés (taux
  d'action mesuré : 6 lectures / 52 = 11,5 %, dont une refusée). **On ne sait PAS si ces 4 lectures
  comptaient.** Ce n'est pas un gain d'efficacité : c'est une mise en cohérence avec une doctrine que le
  relais appliquait déjà 15 fois (`owner-is-the-root`). Si un jour ces avis s'avèrent utiles, la mesure
  qui les a rendus redondants est à refaire *avant* de rouvrir la règle.
- **Un destinataire de repli ne peut pas lire la sortie du job.** Le job reste clôturé par l'id de
  session de son propriétaire : la seule action offerte au destinataire non-propriétaire est
  `send_message` au sous-agent (s'il est continuable) ou une re-délégation. Le texte de l'avis le dit
  désormais explicitement, au lieu de promettre `job_output`.
- **Abstention `running` : l'avis n'est pas *prouvé* reçu.** `ownerState: running` mesure que l'agent
  était vivant au moment du settlement, pas qu'il a lu l'avis. Un worker qui ne fait plus d'étape —
  boucle, blocage, `return` en cours — peut donc manquer un avis que l'ancien comportement lui
  aurait poussé. C'est la contrepartie assumée de l'abstention.
- **Le texte est plus honnête que le mécanisme n'est précis.** Quand le propriétaire est `running`, le
  relais s'abstient *en tablant* sur l'avis natif ; quand le destinataire est un repli, le texte affirme
  « this is not a duplicate of anything you received » — vrai du côté du **destinataire**, et le relais
  n'a aucune mesure de ce que le propriétaire, lui, a effectivement lu.

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
- et dont l'agent propriétaire **n'est plus `running`** (sinon il reçoit l'avis nativement à son étape
  suivante, et relayer ne ferait que dupliquer),

il injecte — ou, si la racine est `idle`, **réveille** — un avis de fin nommant le job et le worker qui
l'a lancé, avec la seule action réellement possible : `send_message` au sous-agent s'il est continuable,
ou re-délégation du contrôle.

## Décisions assumées

| Choix | Raison |
|---|---|
| Montage **host-level**, pas dans le preset | Rien dans le preset ne peut rendre visible un job qui appartient à un autre propriétaire ; et un nouveau bundle s'active **à chaud**, sans redémarrage |
| Réutilisation du discriminant de source `tool-jobs` | Un plugin ne peut pas déclarer un nouveau membre de cette union à l'exécution ; et c'est bien un avis de job d'arrière-plan |
| Relation propriétaire → racine par les **en-têtes durables** (`parentSession`, 16 sauts), avec un **repli sur le plus haut ancêtre VIVANT** | Lecture durable : fonctionne aussi pour des enfants créés **avant** l'installation du plugin. Le repli est ce qui sauve une session **continuée** — après un redémarrage, la session reprise est un fork seedé dont le parent (l'ancien processus) est mort |
| Réveil plafonné à **3 par racine**, puis injection | Borne la chaîne auto-excitante « un tour réveillé démarre le travail dont la fin le réveille » |
| Aucun import statique de paquet Harness | Un bundle lié hors du profil ne résout pas les spécificateurs nus (`ERR_MODULE_NOT_FOUND`, vérifié) ; `createUserMessage` est résolu à l'exécution depuis l'ancre `process.argv[1]` |
| Ne rien relayer pour un propriétaire `running` | Son propre agent reçoit l'avis nativement : le relais serait un doublon |

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

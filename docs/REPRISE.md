# Reprendre ici — etat au 2026-10-07

Document de PASSATION unique et actionnable : tout ce qu'une session neuve doit savoir en premier,
ce qui est verifie par la mesure, les pieges connus et la feuille de route immediate.
Reference detaillee : [`HANDOVER.md`](HANDOVER.md), [`DECISIONS.md`](DECISIONS.md), [`README.md`](../README.md).

---

## 1. En une ligne

`C:\CodeSource\dsh-boost` est le depot consolide du mode Quorum, publie sur GitHub :
**`https://github.com/improveTheWorld/dsh-quorum`** (branche `main` a jour).
Etat : **291 cas a la racine, 0 echec**, arbre propre. Dix lignes montees par le bundle agregateur.

```
Les dix lignes montees, dans l'ordre strict :
  preset-quorum-ptc · preset-quorum-standard · preset-quorum-shell ·
  boost-job-relay · boost-status-command · dsh-detached-jobs ·
  dsh-guard-surrogate · dsh-boost-channel · dsh-boost-context-budget · dsh-boost-lessons
```

---

## 2. A FAIRE EN PREMIER (Dans une session neuve)

### 2.1 Redemarrer le serveur DSH
Le code JavaScript de 4 paquets (`boost-relay`, `detached-jobs`, `boost-channel`, `guard-surrogate`) a
change. **Le cache ESM de Node.js ne recharge jamais un module sans redemarrage de process.**
Faire `Ctrl+C` dans le terminal de `dsh web` puis relancer `dsh web`.

### 2.2 Verifier la suite de tests
```powershell
node --test                          # Doit rendre 291/291 tests passes
node --test test/aggregate.test.mjs  # Doit rendre 21/21 (anti-derive et integrite)
```

---

## 3. Ce qui a ete repare et verifie le 2026-10-06 / 2026-10-07

1. **`quorum-shell` repare** : la collision d'outils entre la base (`persistent-pwsh`) et la queue
   (`tool-pwsh`) qui empechait tout chargement de session shell a ete supprimee. La famille persistante
   de la base est conservee, le one-shot est retire (T-Q10 borne l'invariant).
2. **Bouclier d'immunite Agent Teams** : `packages/guard-surrogate/lib/agent-teams-shield.js` intercepte
   `ctx.agentTeams.tryMembership(agent)` pour exclure les sessions Quorum. `tool-agent-team` n'injecte
   plus ses 9 outils dans Quorum, et le masquage de `send_message` est definitivement supprime.
   Valide unitairement (5 tests) et sur un hote DSH reel montant simultanement les deux bundles.
3. **Fuite de notices entre sessions forkees resolue** : `rootOf`, `chainOf` et `liveRootOf` dans
   `boost-relay`, `detached-jobs` et `boost-channel` s'arretent desormais sur les racines autonomes
   (`isAutonomousRoot` : `delegationDepth === 0` et `origin !== 'subagent'`). Les jobs d'une session
   forkee ne fuient plus jamais vers l'ancetre (T-U7).
4. **Contrat de brief pour `subagent_implement`** : la persona impose un gabarit en 4 volets
   (chemin absolu, lignes cibles, ancre de 5-10 lignes, commande de test) pour couper court aux 15
   dispatches d'exploration aveugles de l'ouvrier (gain net mesure : 15 000 a 40 000 tokens par worker).
5. **Migration des 324 anciennes sessions `boost`** : toutes ont recu un evenement d'adoption
   `agent-preset/selected { agentPreset: 'quorum-ptc' }`. En-tete conserve, projection a jour, ouverture
   reussie sans `agent-preset/not-found`. Outils et rollback sous `~/.dsh/boost-migration/`.
6. **Packaging autonome (Option A)** : `package.json` embarque `packages/` dans sa distribution.
   Archive testee et installable en 1 clic.

---

## 4. Ce que le corpus a mesure (Faits clairs, 4,78 milliards de tokens)

* **Volume brut** : 351 sessions Quorum reelles, 4 789 810 024 tokens.
* **KVCache** : **97,86 %** de relecture de cache (4,68 Mds tokens en cache), ultra-rentable.
* **Falsification adversariale** : sur 107 verifications par `subagent_verify`, **16 FAIL nets**
  ont ete captures (15 % de livraisons defectueuses interceptees avant conclusion).
* **Temps de cycle** : depuis la stabilisation du 2 octobre au soir, **0 blocage > 21 min** n'a
  eu lieu (les blocages d'1h30 a 2h appartenaient tous a la phase pre-stabilisation).

---

## 5. PROCHAIN OBJECTIF : Le "Quorum Model Resolver" & Matrice des Modeles

Le besoin : l'utilisateur utilise parfois un modele tres haut de gamme et cher (Claude Opus, Gemini Pro)
pour la reflexion strategique et la conception de methode. Il veut que l'orchestrateur prepare le
travail mais que les sous-agents ouvriers n'heritent JAMAIS de cette route hors de prix.

### 5.1 Matrice d'evaluation des modeles cibles
Etablir une grille simple sur 3 axes notes de 1 a 5 :
- **QI / Raisonnement** (1: basique -> 5: super-raisonneur / o3 / Opus)
- **Cout / Prix** (1: gratuit/tres pas cher -> 5: tres cher)
- **Rapidite / Latence** (1: tres lent -> 5: instantane)

### 5.2 Arbitrage et bascule dynamique de quota
- Priorite 1 (Gratuit / Quota fenetre) : Gemini via Antigravity proxy (quota par fenetre de 5 heures).
- Repli automatique quand le quota est epuise : basculer sur `deepseek-v4.1-flash` via API payante
  (tres bon marche, rapide, intelligence suffisante pour l'execution et les tests).
- Decouplage d'heritage : quand le parent tourne sur un modele Tier Premium (note QI >= 4 ou Prix >= 4),
  les outils `subagent_investigate`, `subagent_implement`, `subagent_verify` forcent automatiquement
  leur route vers le modele de travail economique (`agentDefaultModel` ou resolver).

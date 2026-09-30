# `/boost-status`

Commande host-level qui affiche l'**état temps réel** de la session où elle est tapée : statut de
l'agent, consommation de tokens, et l'arbre complet des sous-agents avec leur activité, leur mode,
leur label et — pour les enfants résidents — leur propre consommation.

## Pourquoi une commande, et pourquoi hors du preset

- Une commande s'exécute sur le **plan de commande de l'UI**, donc elle répond **même quand l'agent
  est bloqué dans un appel d'outil** — le cas exact pour lequel elle existe. Un `steer` envoyé
  pendant ce blocage est mis en file pour le tour suivant, il n'est pas traité.
- Elle n'entre **ni dans la requête ni dans l'historique** de session : coût modèle nul, catalogue
  d'outils inchangé. C'est pour cela qu'elle n'est pas montée dans le preset `boost`.
- Elle est **strictement en lecture** : registres d'agents/sous-agents et projections de session.
  Elle n'avance rien, ne pilote rien, ne modifie rien.

## Usage

```
/boost-status
/boost-status all        # ajoute l'horodatage local
```

Sortie type :

```
Boost — état temps réel
session    d06c6d28  C:\CodeSource\Scalpel-mcp
agent      running   (un tour est ouvert : il peut être bloqué dans un appel d'outil)
tokens     tokens cumulés in=1.24M (cacheRead=1.18M) out=42.1k  contexte=180.3k/1.00M
enfants    4 au total, 1 en cours
  RUN  b9247900  d1  one-shot  "Verify statistical report"  agent=running  tokens cumulés in=210.4k ...
  idle f10a9fd4  d1  one-shot  "Fix and extend power tool"
  idle f6fe5a8e  d1  one-shot  "Claim ledger from docs"
  idle 38f6a69f  d1  one-shot  "Corpus run ledger"

→ attendre : 1 sous-agent(s) en cours. Le parent ne peut pas traiter un
  message tant qu'un appel d'outil est en vol (un « steer » est mis en file pour le tour suivant).
```

La ligne `⚠ A DES ENFANTS (plafond de profondeur contourné ?)` apparaît si un enfant de profondeur 1
possède lui-même des enfants : c'est la surveillance du risque exponentiel. Avec `maxDepth: 1` dans
le preset `boost`, elle ne doit jamais s'afficher.

## Installation

```
plugin_manager { action: "install_bundle", target: "C:\\CodeSource\\dsh-boost-status" }
```

Puis taper `/boost-status` dans n'importe quelle session. Un bundle nouvellement installé s'active à
chaud : pas de redémarrage nécessaire.

## Limites

- Elle rapporte l'état **du registre**, pas la progression interne d'un programme PTC : on voit
  quels enfants tournent, pas où en est le code en cours d'exécution. Pour ça, `tools/boost-report.mjs`
  du bundle `dsh-boost-mode` lit le journal de session (`run_code` en vol, budget `timeoutMs`, etc.).
- Aucune durée par enfant : `listDescendants` ne porte pas d'horodatage. Le début et la durée se
  lisent dans le rapport de session.
- Les tokens par enfant ne sont disponibles que pour un enfant **résident** (agent vivant) ; un enfant
  terminé et déchargé n'affiche pas sa ligne de tokens.

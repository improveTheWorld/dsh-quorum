# Evolutions du mode Boost — idees retenues le 2026-09-30

Document de travail. Les idees sont notees ici pour ne pas etre perdues ; chacune porte son
**etat** (notee / instruite / concue) et, quand elle est instruite, les mecanismes MESURES du
harnais sur lesquels elle peut s'appuyer — jamais des suppositions.

## 1. Le parent fournit le contexte au fils, avec un degre de veracite par information

**Enonce.** Le parent transmet directement a l'agent fils la partie du contexte qu'il detient
deja, chaque information portant une notation de son degre de veracite. Reserve aux sous-agents
qui se partagent l'execution de la tache principale du pere. Les agents de VERIFICATION en sont
deroges par mesure de securite : ils construisent leur contexte en recherchant depuis les sources.

**Etat : notee.** Voir §Instructions en cours.

## 2. Configuration graphique de la profondeur de l'arbre, avec attente d'un slot

**Enonce.** Configurer graphiquement le nombre d'agents vivants simultanement (profondeur de
l'arbre). Si l'arbre est plein, un mecanisme d'ATTENTE doit rendre la main des qu'un slot se libere.

**Etat : notee.** Voir §Instructions en cours.

## 3. Frein global sur la consommation de tokens

**Enonce.** Freiner la construction d'agents quand un seuil de consommation de tokens GLOBAL
(hors cache) est atteint. A integrer eventuellement au mecanisme de slots de l'idee 2.

**Etat : notee.** Voir §Instructions en cours.

## 4. Agent arbitre sur les points de divergence

**Enonce.** Deux agents qui se contredisent doivent pouvoir generer un agent ARBITRE sur les
points de derive, plutot que de laisser le parent trancher a l'aveugle.

**Etat : notee.** Voir §Instructions en cours.

## 5. Tableau partage entre agents d'un meme projet

**Enonce.** Un board partage ou les agents d'un meme projet deposent leurs statuts et leurs
pieges (lecons apprises, leurres identifies), lisible par les autres agents du meme projet.

**Etat : notee.** Voir §Instructions en cours.

## Instructions en cours

Trois investigations independantes sont en vol (voir le rapport de session qui accompagne ce
document) :

- **A — tokens** : ou la consommation est enregistree, ce que « hors cache » signifie dans les
  donnees, et si un plugin peut la lire ET freiner une creation d'agent ;
- **B — arbre et configuration** : ou une creation d'agent peut etre interceptee, ce que le
  harnais offre deja comme limite (profondeur, concurrence), et comment une valeur devient un
  champ reglable dans l'interface ;
- **C — contexte, arbitrage, board** : quels canaux structures existent deja pour transmettre du
  contexte a un fils, ou loger un degre de veracite, et ce qui existe comme stockage partage.

Les resultats seront consolides ici, avec pour chaque idee : le mecanisme disponible (fichier:ligne),
le premier pas concret, et le test qui prouverait qu'elle marche.

# Quorum

> **Deep multi-agent reasoning with mandatory adversarial verification for DeepSeek Harness (inspired by Antigravity `/boost`).**

[![Tests](https://img.shields.io/badge/tests-291%20passed-brightgreen)](#tests)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.1.6-orange)](https://github.com/deepseek-ai/dsh)

[English](#english) | [Français](#présentation-en-français)

---

## English

### What is Quorum?

If you are coming from Google Antigravity or multi-agent orchestration frameworks, **Quorum** brings the deep-reasoning `/boost` protocol to **DeepSeek Harness** (`dsh`).

In standard harness sessions, LLMs often exhibit *complacency*: declaring tasks "fixed" without running test suites, missing regressions, or getting stuck in conversational loops.

Quorum solves this by construction:
1. **Strategy First** — The orchestrator inspects the workspace, decomposes the objective, and *writes verifiable acceptance criteria before delegating*.
2. **Parallel Fan-out** — Work is dispatched in a single turn to role-isolated subagents with zero context contamination.
3. **Mandatory Adversarial Verification** — An independent verifier runs in the foreground to aggressively attempt to **falsify** the solution against real test suites and entry points. **No conclusion is delivered without raw execution output proving the verdict.**

---

### Three Tailored Presets

Quorum installs three selectable agent presets under **Settings → Agent Presets**:

| Preset | Base Harness Preset | Tool Presentation & Execution | Best For |
|---|---|---|---|
| **`Quorum (PTC)`** | `ptc.patch.yml` | **Programmatic Tool Calling** (`run_code` + generated TypeScript SDK) inherited recursively by all subagents | Maximum token efficiency, complex workflows, high-speed automated code generation |
| **`Quorum (Standard)`** | `standard.patch.yml` | **Native tool calls** (direct JSON schema calls) + workflow engine | Standard models and native tool inspection |
| **`Quorum (Shell)`** | `minimal.patch.yml` | **Bare persistent shell** (`pwsh`/`bash` with persistent state across turns) | Interactive shell tasks, stateful build environments |

---

### Three Isolated Worker Roles

Subagents are created with strict mechanical boundaries (`toolFilter`):

```
                     ┌───────────────────────────────┐
                     │    Quorum Orchestrator Lead   │
                     │  (Strategy, Plan, Integrate)  │
                     └───────────────┬───────────────┘
                                     │
           ┌─────────────────────────┼─────────────────────────┐
           ▼                         ▼                         ▼
┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
│ subagent_investigate│   │ subagent_implement  │   │   subagent_verify   │
│  (DeepInvestigator) │   │     (DeepCoder)     │   │(Adversarial Verifier│
├─────────────────────┤   ├─────────────────────┤   ├─────────────────────┤
│ • Read-only         │   │ • Scoped diffs      │   │ • Foreground run    │
│ • Write denied      │   │ • Unit tests        │   │ • Write denied      │
│ • Delegation denied │   │ • Delegation denied │   │ • Falsification     │
└─────────────────────┘   └─────────────────────┘   └─────────────────────┘
```

* **`subagent_investigate`** (DeepInvestigator): Strictly read-only (`write`, `edit`, `git commit` denied). Traces call graphs, inspects logs, and eliminates hypotheses with raw proof.
* **`subagent_implement`** (DeepCoder): Owns bounded file diffs and writes tests. Cannot delegate.
* **`subagent_verify`** (Adversarial Verifier): Runs independently in the foreground. Attacks the implementation with real suites and boundary inputs. Rejects paraphrases — only raw command output is admissible.

---

### The Seven Companion Host Services

Quorum is not just a prompt; it mounts seven battle-tested infrastructure services:

1. **`boost-job-relay`** — Re-routes background job settlement notices to the root session when child workers complete early.
2. **`dsh-detached-jobs` (`run_detached`)** — Allows long-running builds/tests to survive disposable workers by attaching ownership to the root session.
3. **`dsh-boost-channel` (`channel_post` / `channel_read`)** — Typed, throttled asynchronous back-channel between workers and the lead (`decouverte`, `avancement`, `question`, `resultat`, `echec`).
4. **`dsh-boost-context-budget`** — Context occupancy meter (`context_occupancy`) and fork protection threshold. Supports requested compaction (`context_compact`).
5. **`dsh-guard-surrogate`** — Intercepts and repairs unpaired UTF-16 surrogates in tool results before session logging, preventing fatal `HTTP 400 INVALID_REQUEST` errors.
6. **`agent-teams-shield`** — Automatically shields Quorum sessions from tool shadowing when `@deepseek-ai/dsh-experimental-agent-team` is active in the host profile.
7. **`boost-status-command` (`/boost-status`)** — Command-plane status monitor that responds even while a tool call is in flight.

---

### Quick Start & Installation

#### Option 1: Install from GitHub clone

```bash
git clone https://github.com/improveTheWorld/dsh-quorum.git
dsh plugin add ./dsh-quorum
```

#### Option 2: Install into a specific profile

```powershell
dsh plugin --profile web add C:\path\to\dsh-quorum
```

#### Select in the Web GUI:
Go to **Settings → Agent Presets**, then select **Quorum (PTC)**, **Quorum (Standard)**, or **Quorum (Shell)**.

---

## Présentation en Français

### Le mode Quorum pour DeepSeek Harness

Ce dépôt consolide les sources et l'infrastructure du **mode Quorum** : une famille de **trois presets d'agent** DSH pour le raisonnement profond multi-agents avec vérification adversariale obligatoire, conçue pour éliminer les complaisances et les hallucinations d'ingénierie.

### Pourquoi « Quorum » ?
En systèmes distribués, un *quorum* est le nombre minimal de membres devant s'accorder pour qu'une décision soit valide. Dans ce mode, **l'orchestrateur ne peut rien livrer tant que le vérificateur indépendant n'a pas falsifié et validé le résultat sur pièces brutes**.

---

### Les 10 lignes montées par le bundle agrégateur

`cordis.patch.yml` monte exactement les 10 lignes suivantes :

```
preset-quorum-ptc · preset-quorum-standard · preset-quorum-shell ·
boost-job-relay · boost-status-command · dsh-detached-jobs ·
dsh-guard-surrogate · dsh-boost-channel · dsh-boost-context-budget · dsh-boost-lessons
```

| Paquet | Rôle | Tests |
|---|---|---|
| `packages/boost-mode/` | Les 3 presets Quorum (`quorum-ptc`, `quorum-standard`, `quorum-shell`) | Anti-dérive racine |
| `packages/boost-relay/` | Relais hôte des règlements de jobs orphelins vers la racine | 29/29 |
| `packages/boost-status/` | Commande `/boost-status` lisible même en cours d'appel d'outil | 10/10 |
| `packages/detached-jobs/` | Outil `run_detached` pour jobs persistants rattachés à la racine | 58/58 |
| `packages/guard-surrogate/` | Réparation des surrogates UTF-16 isolés + Bouclier d'immunité Agent Teams | 31/31 |
| `packages/boost-channel/` | Canal typé à double bourse (`channel_post`, `channel_read`) | 52/52 |
| `packages/boost-context-budget/` | Mesure d'occupation, garde du fork et compaction demandée | 36/36 |
| `packages/boost-lessons/` | Journalisation passive des compactions de racine | 14/14 |

---

<a id="tests"></a>
## Tests et Validation

La suite complète s'exécute avec le runner natif de Node.js :

```powershell
node --test
```

**Résultat : 291/291 tests passés, 0 échec.**

* `test/aggregate.test.mjs` : Test anti-dérive strict garantissant la cohérence absolue entre le patch agrégateur racine et les sous-paquets.
* Éprouvé en conditions réelles sur un corpus mesuré de plus d'**un milliard de tokens**.

---

## Licence

MIT © bilel GATRI (`@improveTheWorld`)

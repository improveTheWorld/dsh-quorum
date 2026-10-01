# A lone UTF-16 surrogate in a tool result kills the session (HTTP 400 INVALID_REQUEST)

> Ready-to-post defect report. Every figure below is a measurement on real session logs; the raw
> records are quoted. Environment: DSH 0.2.0-rc.2, Windows, `deepseek-official`/`deepseek-flash`.

## Summary

A single **unpaired UTF-16 surrogate** that reaches the model request payload makes **every subsequent
request fail with `HTTP 400 INVALID_REQUEST`**. The session is unrecoverable: the poisoned record is in
the derived history, so every later request re-sends it.

The value enters through a **tool result** and is never repaired on the way in.

## Measured impact

```
corpus at measurement time : 182 session logs
logs holding a lone surrogate : 3
sessions that died with HTTP 400 INVALID_REQUEST : those same 3
counter-examples : 0
```

A cross-tab over the whole corpus: 3 sessions contain a lone surrogate, exactly those 3 failed, and no
session failed without containing one. `dsh-llm-deepseek` on 0.2.0-rc.2 contains **0** occurrences of
`sanitize|surrogate|WellFormed`.

## Traced instance (raw records)

The causing slice — a program submitted through PTC:

```
tool/call  seq=576  15:26:44.584Z   the submitted code contains  x.text.slice(0, 400)
source line 86 holds a real pair  d83d dee1  at indices 399 / 400

tool/result seq=583  15:26:45.076Z  len 1407  carries a LONE U+D83D at index 1355

first HTTP 400  seq=586  15:26:47.791Z   -> 1.715 s later
```

So the cut happened one character inside a real pair: the retained half is the high surrogate, and the
tool result carries it into the log.

## Why this belongs in the harness, not in a plugin

DSH documents the hole explicitly — `dsh-output-retention/lib/index.js:289`:

```
An unpaired surrogate is not well-formed text — a strict JSON reader rejects a durable
Session log that carries one. An unpaired surrogate `text` already carries is NOT repaired here.
```

The only nearby protection is `truncateWithoutSplittingSurrogatePair` (same file, `:285-298`), which
guards one *internal* truncation (`[\uD800-\uDBFF]$`) and nothing else. Any text arriving from a tool —
a file read, a command output, a program's return value — passes through unexamined.

The JSON class itself is documented by RFC 8259 §8.2, which names the exact scenario:

> "Instances of this have been observed, for example, when a library truncates a UTF-16 string without
> checking whether the truncation split a surrogate pair."

## The seam that fixes it (one listener, no re-dispatch)

`tools/post-execute` is a waterfall whose listener may **replace the content** and let the chain
continue:

```
dsh-tools/lib/types/index.d.ts:70   'tools/post-execute'(exec, result, next)  @mode waterfall
dsh-tools/lib/index.js:3504         default next() resolves { kind: 'accept' }
dsh-tools/lib/index.js:3527-3531    a returned { kind: 'accept', content } is taken as-is
dsh-agent-loop/lib/index.js:570-571 the hook runs BEFORE appendToolResult
```

Because it runs before the append, **both the journal and `deriveMessages()` carry the repaired text**, so
the loop invariant `request === deriveMessages()` (`dsh-agent-loop/lib/invariant.js:26-27`) still holds.
There is an in-tree precedent for a listener of this shape: `dsh-spill-policy/lib/index.js:237-255`.

### Residual gap, stated at its real size

Six `kind: 'final-result'` paths bypass `tools/post-execute` (`dsh-tools/lib/index.js:3178, 3183, 3199,
3219, 3269, 3346` — the loop then calls `finish(...)`, never `finalize(...)`). They cover **out-of-body**
failures only: argument materialisation, cancellation before dispatch, an exception raised by a
`tools/pre-execute` listener or a `tools/execute` wrapper. A tool that throws **inside its body** is
already covered: `dispatchToolBody` catches at `dsh-tools/lib/index.js:3313-3314` and returns a
`post-result` (`:3341`), so the waterfall does run.

### Rejected alternative

Repairing downstream on `llm/stream` (`dsh-llm/lib/index.js:1801`) does **not** work: `next()` accepts no
replacement (measured), and `options` is deep-frozen (`dsh-agent-loop/lib/index.js:1261-1276`). Doing it
there would require a short-circuit plus a fresh `ctx.llm.stream(...)`, which replays `registration` and
`prepareCall` and **breaks the `request === deriveMessages()` invariant**.

## Minimal repro

Any tool result whose text ends on a lone surrogate reproduces it. The one-liner that produced the case
above:

```js
// PTC / run_code — the tool result now carries an unpaired U+D83D
return 'x'.repeat(399) + '\ud83d'
```

and the natural accident, which needs no malformed literal at all:

```js
const text = <any tool result containing an astral character at index 399/400>
return text.slice(0, 400)   // keeps the high half, drops the low half
```

Observable: the next request fails with `HTTP 400 INVALID_REQUEST`; every request after it fails too,
and the session cannot be resumed from that point.

## For reference: a plugin that closes it today

`dsh-guard-surrogate` (26 unit tests, one of them end-to-end against the real `dsh-tools` registry) does
exactly this on `tools/post-execute`: lone high or low halves become U+FFFD, well-formed pairs are left
untouched, the decision object is returned **by identity** when nothing changed, and one journal line is
written per real repair (`$DSH_HOME/plugin-data/dsh-guard-surrogate/repairs.jsonl`).

A patch was written first as a plugin because the fix must ship without waiting for a release. If the
seam above is acceptable, the same listener belongs in the tree.

## Environment

```
dsh           0.2.0-rc.2  (also reproduced on 0.1.7-rc.2 — the 3 deaths predate the upgrade)
provider      deepseek-official / deepseek-flash
OS            Windows 11, Node v22.23.2
```

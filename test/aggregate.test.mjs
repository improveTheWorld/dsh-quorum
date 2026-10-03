/**
 * Anti-drift test: the aggregate patch at the repository root must be exactly
 * the union of the eight package patches it claims to aggregate.
 *
 * Why it exists. `dsh-app-boot/lib/index.js:87` appends every inserted row with
 * `data.push(...insert)` and performs no deduplication, so the root patch can
 * silently diverge from its sources: an `id` renamed in a sub-package, a
 * `config` fixed in one place only, or a `name` that stops resolving (a patch's
 * `name` is resolved RELATIVE TO THE PATCH FILE) all mount a broken or stale
 * line with no error at load time. Each check below fails loudly instead.
 *
 * The parser is the one the harness itself uses: `parseDocument` of `yaml` with
 * the `tag:yaml.org,2002:js` custom tag. An unrecognised `!!js` would make the
 * mount fail, so parsing with anything weaker would not prove the file loads.
 *
 * Falsification recipe (the test is expected to FAIL when it is falsified):
 *   Copy-Item -Recurse C:\CodeSource\dsh-boost $env:TEMP\dsh-boost-falsify
 *   # rename one id in packages/boost-relay/cordis.patch.yml of the COPY
 *   node --test $env:TEMP\dsh-boost-falsify\test\aggregate.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const ROOT_PATCH = join(ROOT, 'cordis.patch.yml')

/**
 * The eight sub-packages, in the order the root patch lists their rows.
 *
 * `boost-channel` was added with the sixth row, `boost-context-budget` with the
 * seventh and `boost-lessons` with the eighth. Each carries its OWN
 * `cordis.patch.yml`, exactly like the five others, so this test keeps its full
 * strength: the root insert is compared to the union of the EIGHT sub-package
 * patches, and the comparison is not relaxed anywhere. A package without a patch
 * would have forced a weaker test; that is why the package has one.
 */
const PACKAGES = ['boost-mode', 'boost-relay', 'boost-status', 'detached-jobs', 'guard-surrogate', 'boost-channel', 'boost-context-budget', 'boost-lessons']

/**
 * The quorum preset family declared by `packages/boost-mode/cordis.patch.yml`.
 *
 * THREE rows, one per shipped harness base: the third is `preset-quorum-shell`,
 * whose base is `minimal.patch.yml` — the name records the persistent shell
 * that is all that remains of that bare base, not a claim about the preset's
 * size. Each row's `plugins` list is that base's rows PLUS the same quorum
 * queue; a preset's `config` is replaced wholesale and never deep-merged
 * (`dsh-app-boot/lib/index.js:104-107`), so the queue is duplicated verbatim in
 * the three lists. T-Q2 bounds that duplication, except for the persona, whose
 * head is per tool mode (T-P1) and whose body is shared (T-P2).
 */
const QUORUM_PRESETS = [
  { rowId: 'preset-quorum-ptc', presetId: 'quorum-ptc', baseFile: 'ptc.patch.yml', basePreset: 'preset-ptc' },
  { rowId: 'preset-quorum-standard', presetId: 'quorum-standard', baseFile: 'standard.patch.yml', basePreset: 'preset-standard' },
  { rowId: 'preset-quorum-shell', presetId: 'quorum-shell', baseFile: 'minimal.patch.yml', basePreset: 'preset-minimal' },
]
const QUORUM_PATCH = join(ROOT, 'packages', 'boost-mode', 'cordis.patch.yml')

/**
 * The queue's TOP-LEVEL entries. A group named here owns its whole subtree:
 * `planning` owns `plan-mode`, and `compaction` owns `compaction-basic`,
 * `command-compact` and `tool-result-pruner`. T-Q4 compares only rows OUTSIDE
 * this set, so a queue group may carry quorum-specific config (the 85 % compaction
 * threshold) without being mistaken for a divergence from the base.
 */
const QUORUM_QUEUE = [
  'persona', 'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs',
  'tool-fs-search', 'tool-jobs', 'skill-filesystem', 'tool-skill',
  'command-goal', 'tool-goal', 'planning', 'compaction', 'tool-ask-user',
  'tool-todo', 'tool-web', 'present', 'tool-subagent-control',
  'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork',
  'tool-subagent-investigate', 'tool-subagent-implement', 'tool-subagent-verify',
]

/**
 * The three role personae: the captain's defect, one level down. Their `persona`
 * stated the PTC program clauses in all three presets, yet only `quorum-ptc`
 * mounts PTC (T-Q3); a `quorum-standard` child told about "your programs" looks
 * for a `run_code` that is not installed. Each role is now split by its own
 * marker into a mode-specific HEAD (T-P4) and a shared BODY (T-P5), so T-Q2 must
 * not demand their rows be identical either. The marker is deliberately distinct
 * from the captain's so a scan for one never silently satisfies the other.
 */
const ROLE_IDS = ['tool-subagent-investigate', 'tool-subagent-implement', 'tool-subagent-verify']

/** The root insert: the three preset rows first, then the seven service rows. */
const ROOT_ROW_ORDER = [
  'preset-quorum-ptc', 'preset-quorum-standard', 'preset-quorum-shell',
  'boost-job-relay', 'boost-status-command', 'dsh-detached-jobs',
  'dsh-guard-surrogate', 'dsh-boost-channel', 'dsh-boost-context-budget',
  'dsh-boost-lessons',
]

/** Built by joining, so this test file does not match its own T-Q6 scan. */
const LEGACY_PRESET_ID = ['preset', 'boost'].join('-')

/** The exact custom tag the harness registers, so `!!js` resolves to its text. */
const YAML_JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value) => value }

/**
 * Load the `yaml` module the harness uses. Failing to find it is an ERROR, not
 * a skip: a check that cannot run must never look like a check that passed.
 */
function loadYaml() {
  const require = createRequire(import.meta.url)
  const candidates = []
  if (typeof process.env.DSH_YAML === 'string' && process.env.DSH_YAML !== '') candidates.push(process.env.DSH_YAML)
  candidates.push('yaml')
  if (typeof process.env.APPDATA === 'string' && process.env.APPDATA !== '') {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'yaml'))
  }
  const tried = []
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch (error) {
      tried.push(candidate + ' (' + (error.code ?? error.message) + ')')
    }
  }
  throw new Error(
    'cannot load the "yaml" parser the harness uses; tried: ' + tried.join('; ') +
    '. Set DSH_YAML to the path of the harness yaml module.'
  )
}

const YAML = loadYaml()

/** Read a patch and return the rows it inserts, in file order. */
function readPatch(patchPath) {
  const doc = YAML.parseDocument(readFileSync(patchPath, 'utf8'), { customTags: [YAML_JS_TAG] })
  const errors = doc.errors.map((error) => error.message)
  const warnings = doc.warnings.map((warning) => warning.message)
  assert.deepEqual(errors, [], patchPath + ' must parse with zero errors')
  assert.deepEqual(warnings, [], patchPath + ' must parse with zero warnings')
  const entries = doc.toJS()
  assert.ok(Array.isArray(entries), patchPath + ' must be a YAML sequence of patch entries')
  const inserts = []
  const rows = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || entry.insert === undefined) continue
    assert.ok(Array.isArray(entry.insert), patchPath + ': an insert: value must be the list of rows')
    inserts.push(entry)
    rows.push(...entry.insert)
  }
  return { patchPath, entries, inserts, rows }
}

/** Index rows by id, refusing a duplicate. */
function byId(rows, patchPath) {
  const map = new Map()
  for (const row of rows) {
    assert.equal(typeof row?.id, 'string', patchPath + ': every inserted row must carry a string id')
    assert.ok(!map.has(row.id), patchPath + ': id "' + row.id + '" is inserted more than once')
    map.set(row.id, row)
  }
  return map
}

/** Canonical JSON: key order must not make two identical configs differ. */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  }
  return JSON.stringify(value ?? null)
}

/**
 * The whole row except `name` — the ONLY key allowed to differ, because the root row names a folded
 * path (`./packages/<pkg>/lib/index.js`) where the source names a sibling module. Every OTHER key is
 * copied verbatim, and the loader honours at least one of them: `disabled: true` unmounts a row
 * silently (`dsh-app-boot/lib/index.js:2093`). Comparing `config` alone let that pass.
 */
function withoutName(row) {
  const copy = { ...row }
  delete copy.name
  return canonical(copy)
}

/** A `name` that is a path, as opposed to an npm specifier like '@scope/pkg'. */
function isPathName(name) {
  return typeof name === 'string' && (name.startsWith('./') || name.startsWith('../'))
}

/**
 * Locate the shipped preset bases the quorum rows are built from. A missing
 * base is an ERROR, not a skip: a check that cannot run must never look like a
 * check that passed.
 */
function findPresetsDir() {
  const tried = []
  const candidates = []
  if (typeof process.env.DSH_WEB_APP_PRESETS === 'string' && process.env.DSH_WEB_APP_PRESETS !== '') {
    candidates.push(process.env.DSH_WEB_APP_PRESETS)
  }
  if (typeof process.env.APPDATA === 'string' && process.env.APPDATA !== '') {
    const anchor = join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'yaml', 'package.json')
    try {
      const require = createRequire(anchor)
      candidates.push(join(dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json')), 'presets'))
    } catch (error) {
      tried.push('@deepseek-ai/dsh-web-app specifier (' + (error.code ?? error.message) + ')')
    }
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets'))
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'ptc.patch.yml'))) return candidate
    tried.push(candidate)
  }
  assert.fail('cannot locate the shipped preset bases; tried: ' + tried.join('; ') + '. Set DSH_WEB_APP_PRESETS to the presets directory.')
}

/** Flatten every declared plugin row, groups included, by id; refuse a duplicate. */
function flattenPlugins(plugins, at) {
  const map = new Map()
  const walk = (rows) => {
    for (const row of rows) {
      assert.equal(typeof row?.id, 'string', at + ': every plugin row must carry a string id')
      assert.ok(!map.has(row.id), at + ': plugin id "' + row.id + '" is declared more than once')
      map.set(row.id, row)
      if (row.group === true) {
        assert.ok(Array.isArray(row.config), at + ': group "' + row.id + '" must hold a list of plugin rows')
        walk(row.config)
      }
    }
  }
  walk(plugins)
  return map
}

/** The queue plus every row nested under a queue group. */
function queueMemberIds(plugins) {
  const index = flattenPlugins(plugins, 'quorum preset')
  const members = new Set()
  for (const id of QUORUM_QUEUE) {
    const row = index.get(id)
    assert.ok(row, 'the queue must declare "' + id + '"')
    const walk = (value) => {
      members.add(value.id)
      if (value.group === true) value.config.forEach(walk)
    }
    walk(row)
  }
  return members
}

/** Leaf rows whose id is NOT a queue member: the base's own contribution. */
function leavesOutsideQueue(plugins, members) {
  const map = new Map()
  const walk = (rows) => {
    for (const row of rows) {
      if (row.group === true) walk(row.config)
      else if (!members.has(row.id)) map.set(row.id, row)
    }
  }
  walk(plugins)
  return map
}

const root = readPatch(ROOT_PATCH)
const rootById = byId(root.rows, ROOT_PATCH)
const sources = PACKAGES.map((name) => {
  const patchPath = join(ROOT, 'packages', name, 'cordis.patch.yml')
  assert.ok(existsSync(patchPath), patchPath + ' must exist')
  return { name, patchPath, parsed: readPatch(patchPath) }
})
const sourceRows = new Map()
for (const source of sources) {
  for (const [id, row] of byId(source.parsed.rows, source.patchPath)) {
    assert.ok(!sourceRows.has(id), 'id "' + id + '" is inserted by more than one sub-package')
    sourceRows.set(id, { row, patchPath: source.patchPath })
  }
}

/** The shipped preset bases, loaded once: T-Q3 and T-Q4 compare against them. */
const PRESETS_DIR = findPresetsDir()

/** The preset row a shipped base declares, e.g. `preset-ptc` in `ptc.patch.yml`. */
function basePresetRow(baseFile, basePresetId) {
  const patchPath = join(PRESETS_DIR, baseFile)
  assert.ok(existsSync(patchPath), patchPath + ' must exist')
  const row = byId(readPatch(patchPath).rows, patchPath).get(basePresetId)
  assert.ok(row, baseFile + ' must declare preset row "' + basePresetId + '"')
  return row
}

/** The three quorum rows, parsed once from the sub-package patch. */
const quorumPatch = readPatch(QUORUM_PATCH)
const quorumById = byId(quorumPatch.rows, QUORUM_PATCH)

test('the root patch is ONE insert entry carrying the ten Quorum rows', () => {
  assert.equal(root.entries.length, 1, 'the root patch must hold exactly one top-level entry')
  assert.equal(root.inserts.length, 1, 'that entry must be the single insert: entry')
  assert.equal(root.rows.length, ROOT_ROW_ORDER.length, 'the insert: list must carry the three preset rows and the seven service rows')
  for (const source of sources) {
    assert.equal(source.parsed.inserts.length, 1, source.patchPath + ' must hold exactly one insert: entry')
  }
})

test('the root patch inserts the same ten ids as the sub-packages, each exactly once', () => {
  assert.deepEqual(
    [...rootById.keys()].sort(),
    [...sourceRows.keys()].sort(),
    'root ids must equal the union of the sub-package ids'
  )
  assert.equal(rootById.size, root.rows.length, 'no id may appear twice in the root patch')
  assert.deepEqual(
    root.rows.map((row) => row.id),
    ROOT_ROW_ORDER,
    'the root patch must list the ten rows in the documented order'
  )
})

test('every root row carries the config of its source row, compared as canonical JSON', () => {
  for (const [id, source] of sourceRows) {
    const row = rootById.get(id)
    assert.ok(row, 'the root patch must insert id "' + id + '"')
    assert.equal(
      canonical(row.config),
      canonical(source.row.config),
      'config of "' + id + '" diverged between ' + ROOT_PATCH + ' and ' + source.patchPath
    )
  }
})

test('every root row carries the ROW of its source, keys other than name included', () => {
  for (const [id, source] of sourceRows) {
    const row = rootById.get(id)
    assert.ok(row, 'the root patch must insert id "' + id + '"')
    assert.equal(
      withoutName(row),
      withoutName(source.row),
      'row "' + id + '" carries a key its source does not, or the reverse — `disabled` alone would unmount the line silently'
    )
  }
})

test('every root row name resolves to the very module its source patch names', () => {
  for (const [id, source] of sourceRows) {
    const row = rootById.get(id)
    assert.ok(row, 'the root patch must insert id "' + id + '"')
    const name = row.name
    assert.equal(typeof name, 'string', 'row "' + id + '" must carry a name')
    if (!isPathName(source.row.name)) {
      // An npm specifier is not resolved against the patch file: it must match verbatim.
      assert.equal(name, source.row.name, 'name of "' + id + '" must match its source specifier')
      continue
    }
    assert.ok(isPathName(name), 'name of "' + id + '" must stay a relative path, got ' + JSON.stringify(name))
    const target = resolve(dirname(ROOT_PATCH), name)
    assert.ok(existsSync(target), 'name of "' + id + '" points at a missing file: ' + target)
    assert.equal(
      target,
      resolve(dirname(source.patchPath), source.row.name),
      'name of "' + id + '" must resolve to the same module as in ' + source.patchPath
    )
  }
})

// ---------------------------------------------------------------------------
// T-Q1..T-Q6 — the quorum preset family and the invariant queue it duplicates
// ---------------------------------------------------------------------------

test('T-Q1 — the three preset rows exist, with the three exact ids, and each mounts @deepseek-ai/dsh-agent-preset', () => {
  assert.deepEqual(
    quorumPatch.rows.map((row) => row.id),
    QUORUM_PRESETS.map((preset) => preset.rowId),
    QUORUM_PATCH + ' must insert the three preset rows, in the documented order'
  )
  for (const preset of QUORUM_PRESETS) {
    const row = quorumById.get(preset.rowId)
    assert.ok(row, 'the patch must insert row "' + preset.rowId + '"')
    assert.equal(row.name, '@deepseek-ai/dsh-agent-preset', 'row "' + preset.rowId + '" must mount the preset plugin')
    assert.equal(row.config.id, preset.presetId, 'row "' + preset.rowId + '" must declare config.id "' + preset.presetId + '"')
    assert.ok(Array.isArray(row.config.plugins) && row.config.plugins.length > 0, 'row "' + preset.rowId + '" must declare a non-empty plugins list')
  }
})

/**
 * The four queue rows that must NOT be identical any more: `persona` — the
 * captain — and the three role personae. For each, the HEAD is a function of the
 * tool interface (`ptc` vs native) — T-P1 for the captain, T-P4 for the roles —
 * while only the BODY is the shared invariant, compared by T-P2 and T-P5.
 * Leaving any of them in this equality would make T-Q2 demand the very defect
 * this family fixes.
 */
const QUORUM_QUEUE_UNIFORM = QUORUM_QUEUE.filter((id) => id !== 'persona' && !ROLE_IDS.includes(id))

test('T-Q2 — the quorum queue is identical in the three presets, persona excluded', () => {
  const queues = QUORUM_PRESETS.map((preset) => {
    const index = flattenPlugins(quorumById.get(preset.rowId).config.plugins, preset.rowId)
    return QUORUM_QUEUE_UNIFORM.map((id) => {
      const row = index.get(id)
      assert.ok(row, preset.rowId + ': the queue must declare "' + id + '"')
      return id + ' = ' + canonical(row)
    })
  })
  assert.deepEqual(queues[0], queues[1], 'the quorum queue diverged between quorum-ptc and quorum-standard')
  assert.deepEqual(queues[0], queues[2], 'the quorum queue diverged between quorum-ptc and quorum-shell')
})

// ---------------------------------------------------------------------------
// T-P1..T-P3 — the orchestrator persona: one HEAD per tool mode, one shared BODY
//
// The defect these pin: the persona described Programmatic Tool Calling in all
// three presets, yet only `quorum-ptc` mounts `tool-presentation {mode: ptc}`
// (T-Q3); `quorum-standard` and `quorum-shell` call their tools natively. A
// preset whose persona describes an interface it does not have is broken: the
// model reaches for a `run_code` that is not installed. The persona is now
// split by a marker line — above it everything that depends on the tool
// interface, below it the mode-independent protocol. T-P2 compares the bodies
// by extraction, so a PTC clause left in the middle of the body fails it.
// ---------------------------------------------------------------------------

/** The line that separates the mode-specific HEAD from the shared BODY. */
const PERSONA_MARKER = '--- FIELD NOTES ---'

/**
 * The tool interface each preset actually mounts. The ptc base carries
 * `tool-presentation {mode: ptc}` and the standard / minimal bases carry no
 * presentation row at all (T-Q3), so two presets share the native head.
 */
const PERSONA_MODE = {
  'preset-quorum-ptc': 'ptc',
  'preset-quorum-standard': 'native',
  'preset-quorum-shell': 'native',
}

/** The persona prefix the preset declares — a string, never undefined. */
function personaPrefix(preset) {
  const index = flattenPlugins(quorumById.get(preset.rowId).config.plugins, preset.rowId)
  const row = index.get('persona')
  assert.ok(row, preset.rowId + ': the queue must declare "persona"')
  assert.equal(typeof row.config?.prefix, 'string', preset.rowId + ': persona config.prefix must be a string')
  return row.config.prefix
}

/** Split a persona at the marker; refuse zero or several markers (see T-P3). */
function splitPersona(preset) {
  const prefix = personaPrefix(preset)
  const lines = prefix.split('\n')
  const hits = []
  lines.forEach((line, index) => { if (line.trim() === PERSONA_MARKER) hits.push(index) })
  assert.equal(hits.length, 1, preset.rowId + ' must carry exactly one marked HEAD/BODY boundary, got ' + hits.length)
  const at = hits[0]
  return { head: lines.slice(0, at).join('\n'), body: lines.slice(at).join('\n') }
}

test('T-P1 — the persona HEAD is per tool mode: ptc differs, and no native head promises run_code', () => {
  const heads = {}
  for (const preset of QUORUM_PRESETS) heads[preset.rowId] = splitPersona(preset).head

  // One head per MODE: same mode => same head, different mode => different head.
  const byMode = new Map()
  for (const preset of QUORUM_PRESETS) {
    const mode = PERSONA_MODE[preset.rowId]
    assert.ok(mode, preset.rowId + ' must declare a tool mode in PERSONA_MODE')
    if (byMode.has(mode)) assert.equal(heads[preset.rowId], heads[byMode.get(mode)], 'two presets on mode ' + mode + ' must share one head')
    else byMode.set(mode, preset.rowId)
  }
  assert.equal(byMode.size, 2, 'the quorum family mounts exactly two tool modes')

  // The case that proves the fix: the ptc head is not the native head.
  assert.notEqual(heads['preset-quorum-ptc'], heads['preset-quorum-standard'], 'the ptc head and the standard head must differ: only quorum-ptc mounts mode: ptc')
  assert.notEqual(heads['preset-quorum-ptc'], heads['preset-quorum-shell'], 'the ptc head and the shell head must differ: its minimal base carries no presentation row either')

  // One head per mode. The two native presets share theirs, which is what makes
  // a head mutated in ONE of them visible here.
  assert.equal(heads['preset-quorum-standard'], heads['preset-quorum-shell'], 'the two native presets must carry the SAME head')

  for (const token of ['Programmatic Tool Calling (PTC)', 'only `run_code` is directly callable', 'generated SDK', 'process.env', 'Array.from(s).slice(0, n)', 'timeoutMs']) {
    assert.ok(heads['preset-quorum-ptc'].includes(token), 'the ptc head must state ' + JSON.stringify(token))
  }
  for (const id of ['preset-quorum-standard', 'preset-quorum-shell']) {
    // 'generated SDK' alone is too weak: a native head may name it in a
    // negation ("no generated SDK"), which is exactly what this head does.
    for (const token of ['only `run_code` is directly callable', 'Programmatic Tool Calling', 'read the generated SDK']) {
      assert.ok(!heads[id].includes(token), id + ' has no PTC interface, so its head must not promise ' + JSON.stringify(token))
    }
    for (const token of ['DIRECTLY', 'schema', 'timeoutMs']) {
      assert.ok(heads[id].includes(token), id + ' must state the native interface: ' + JSON.stringify(token))
    }
  }
})

test('T-P2 — the persona BODY is identical in the three presets', () => {
  const bodies = QUORUM_PRESETS.map((preset) => splitPersona(preset).body)
  assert.deepEqual(bodies[1], bodies[0], 'the persona body diverged between quorum-ptc and quorum-standard')
  assert.deepEqual(bodies[2], bodies[0], 'the persona body diverged between quorum-ptc and quorum-shell')
  // A body equal to the empty string would satisfy the lines above and prove
  // nothing, so the mode-independent protocol must actually be in there.
  for (const token of ['Tools MEASURE', 'You do not do the deep work yourself', 'PHASE 1 — STRATEGY', 'PHASE 2 — PARALLEL EXECUTION', 'PHASE 3 — VERIFICATION AND DELIVERY']) {
    assert.ok(bodies[0].includes(token), 'the shared body must carry ' + JSON.stringify(token))
  }
  // The equal-body check alone would pass a body that still described PTC in
  // all three presets — the very defect, moved below the marker. A PTC-only
  // clause must reach the native presets through NO shared text.
  for (const token of ['run_code', 'TypeScript', 'Programmatic Tool Calling', 'process.env', 'generated SDK', 'Promise.all']) {
    assert.ok(!bodies[0].includes(token), 'the shared body must carry no PTC-only clause: ' + JSON.stringify(token))
  }
})

test('T-P3 — the marker is present exactly once in each persona, so T-P2 compares non-empty bodies', () => {
  const counts = []
  for (const preset of QUORUM_PRESETS) {
    counts.push(personaPrefix(preset).split('\n').filter((line) => line.trim() === PERSONA_MARKER).length)
    const { head, body } = splitPersona(preset)
    assert.ok(head.trim().length > 0, preset.rowId + ': the head must not be empty')
    assert.ok(body.trim().length > PERSONA_MARKER.length, preset.rowId + ': the body must not be the marker alone')
  }
  assert.deepEqual(counts, [1, 1, 1], 'each preset must carry the marker exactly once')
})

// ---------------------------------------------------------------------------
// T-P4..T-P6 — the three role personae: the captain's defect, one level down
//
// The same defect, measured one level lower: each role's `persona` carried the
// PTC program clauses ("In your own programs: no import/export, process.env
// starts empty...") identically in all three presets, so `quorum-standard` and
// `quorum-shell` — whose tools are called natively — told a child to look for a
// `run_code` that does not exist. Each role persona is now split by its own
// marker into a mode-specific HEAD and a shared BODY, exactly like the captain.
// ---------------------------------------------------------------------------

/**
 * The roles' marker. Deliberately a DIFFERENT string from the captain's: the role
 * personae had no equivalent marker of their own, and reusing the captain's
 * would let one marker scan silently satisfy the other.
 */
const ROLE_PERSONA_MARKER = '--- ROLE FIELD NOTES ---'

/** The role row's persona string — the role equivalent of `personaPrefix`. */
function rolePersona(preset, roleId) {
  const index = flattenPlugins(quorumById.get(preset.rowId).config.plugins, preset.rowId)
  const row = index.get(roleId)
  assert.ok(row, preset.rowId + ': the queue must declare "' + roleId + '"')
  assert.equal(typeof row.config?.persona, 'string', preset.rowId + ' / ' + roleId + ': config.persona must be a string')
  return row.config.persona
}

/** Split a role persona at its marker; refuse zero or several markers (T-P6). */
function splitRolePersona(preset, roleId) {
  const persona = rolePersona(preset, roleId)
  const lines = persona.split('\n')
  const hits = []
  lines.forEach((line, index) => { if (line.trim() === ROLE_PERSONA_MARKER) hits.push(index) })
  assert.equal(hits.length, 1, preset.rowId + ' / ' + roleId + ' must carry exactly one marked HEAD/BODY boundary, got ' + hits.length)
  const at = hits[0]
  return { head: lines.slice(0, at).join('\n'), body: lines.slice(at).join('\n') }
}

test('T-P4 — each role persona HEAD is per tool mode: ptc differs, and no native head promises run_code', () => {
  for (const roleId of ROLE_IDS) {
    const heads = {}
    for (const preset of QUORUM_PRESETS) heads[preset.rowId] = splitRolePersona(preset, roleId).head

    // One head per MODE: same mode => same head, different mode => different head.
    const byMode = new Map()
    for (const preset of QUORUM_PRESETS) {
      const mode = PERSONA_MODE[preset.rowId]
      assert.ok(mode, preset.rowId + ' must declare a tool mode in PERSONA_MODE')
      if (byMode.has(mode)) assert.equal(heads[preset.rowId], heads[byMode.get(mode)], roleId + ': two presets on mode ' + mode + ' must share one head')
      else byMode.set(mode, preset.rowId)
    }
    assert.equal(byMode.size, 2, 'the quorum family mounts exactly two tool modes')

    assert.notEqual(heads['preset-quorum-ptc'], heads['preset-quorum-standard'], roleId + ': the ptc head and the standard head must differ: only quorum-ptc mounts mode: ptc')
    assert.notEqual(heads['preset-quorum-ptc'], heads['preset-quorum-shell'], roleId + ': the ptc head and the shell head must differ')
    assert.equal(heads['preset-quorum-standard'], heads['preset-quorum-shell'], roleId + ': the two native presets must carry the SAME head')

    for (const token of ['Programmatic Tool Calling (PTC)', 'only `run_code` is directly callable', 'generated SDK', 'process.env']) {
      assert.ok(heads['preset-quorum-ptc'].includes(token), roleId + ': the ptc head must state ' + JSON.stringify(token))
    }
    for (const id of ['preset-quorum-standard', 'preset-quorum-shell']) {
      // 'generated SDK' alone is too weak: the native head names it in a negation
      // ("no generated SDK"), which is exactly what it must say.
      for (const token of ['run_code', 'Programmatic Tool Calling', 'read the generated SDK']) {
        assert.ok(!heads[id].includes(token), roleId + ' / ' + id + ' has no PTC interface, so its head must not promise ' + JSON.stringify(token))
      }
      for (const token of ['DIRECTLY', 'JSON arguments', 'schema']) {
        assert.ok(heads[id].includes(token), roleId + ' / ' + id + ' must state the native interface: ' + JSON.stringify(token))
      }
    }
  }
})

test('T-P5 — each role persona BODY is identical in the three presets', () => {
  for (const roleId of ROLE_IDS) {
    const bodies = QUORUM_PRESETS.map((preset) => splitRolePersona(preset, roleId).body)
    assert.deepEqual(bodies[1], bodies[0], roleId + ': the persona body diverged between quorum-ptc and quorum-standard')
    assert.deepEqual(bodies[2], bodies[0], roleId + ': the persona body diverged between quorum-ptc and quorum-shell')

    // The equal-body check alone would pass a body that still described PTC in
    // all three presets — the very defect, moved below the marker. A PTC-only
    // clause must reach the native presets through NO shared text.
    for (const token of ['run_code', 'TypeScript', 'Programmatic Tool Calling', 'process.env', 'generated SDK', 'Promise.all']) {
      assert.ok(!bodies[0].includes(token), roleId + ': the shared body must carry no PTC-only clause: ' + JSON.stringify(token))
    }
  }

  // A body equal to the empty string would satisfy the lines above and prove
  // nothing, so each role's mode-independent mission must actually be in there.
  const mission = {
    'tool-subagent-investigate': ['Tools MEASURE', 'READ-ONLY', 'HYPOTHESIS', 'EVIDENCE', 'RULED OUT'],
    'tool-subagent-implement': ['Tools MEASURE', 'bounded file set', 'Deliver a candidate solution', 'TESTS RUN', 'WHAT CHANGED'],
    'tool-subagent-verify': ['Tools MEASURE', 'falsify', 'VERDICT', 'RAW EVIDENCE', 'COUNTEREXAMPLES'],
  }
  for (const roleId of ROLE_IDS) {
    const body = splitRolePersona(QUORUM_PRESETS[0], roleId).body
    for (const token of mission[roleId]) {
      assert.ok(body.includes(token), roleId + ': the shared body must carry ' + JSON.stringify(token))
    }
  }
})

test('T-P6 — the role marker is present exactly once in each role persona, so T-P5 compares non-empty bodies', () => {
  for (const roleId of ROLE_IDS) {
    for (const preset of QUORUM_PRESETS) {
      const count = rolePersona(preset, roleId).split('\n').filter((line) => line.trim() === ROLE_PERSONA_MARKER).length
      assert.equal(count, 1, preset.rowId + ' / ' + roleId + ' must carry the marker exactly once, got ' + count)
      const { head, body } = splitRolePersona(preset, roleId)
      assert.ok(head.trim().length > 0, preset.rowId + ' / ' + roleId + ': the head must not be empty')
      assert.ok(body.trim().length > ROLE_PERSONA_MARKER.length, preset.rowId + ' / ' + roleId + ': the body must not be the marker alone')
    }
  }
})

test('T-Q3 — quorum-ptc carries tool-presentation {mode: ptc} and quorum-standard does not', () => {
  const ptcBase = flattenPlugins(basePresetRow('ptc.patch.yml', 'preset-ptc').config.plugins, 'preset-ptc')
  const standardBase = flattenPlugins(basePresetRow('standard.patch.yml', 'preset-standard').config.plugins, 'preset-standard')
  const ptc = flattenPlugins(quorumById.get('preset-quorum-ptc').config.plugins, 'preset-quorum-ptc')
  const standard = flattenPlugins(quorumById.get('preset-quorum-standard').config.plugins, 'preset-quorum-standard')

  const presentation = ptc.get('tool-presentation')
  assert.ok(presentation, 'quorum-ptc must carry the ptc presentation row')
  assert.equal(presentation.name, '@deepseek-ai/dsh-agent-tool-presentation', 'tool-presentation must be the presentation plugin')
  assert.equal(presentation.config.mode, 'ptc', 'quorum-ptc must declare mode: ptc')
  assert.ok(ptcBase.has('tool-presentation'), 'the ptc base must carry this row: it is what makes the ptc preset PTC')

  assert.equal(standard.get('tool-presentation'), undefined, 'quorum-standard must NOT carry a presentation row: that absence is the measured discriminant against quorum-ptc')
  assert.equal(standardBase.get('tool-presentation'), undefined, 'the standard base must not carry a presentation row either')
})

test('T-Q4 — quorum-standard carries the standard base tool rows outside the queue', () => {
  const standardBase = basePresetRow('standard.patch.yml', 'preset-standard')
  const members = queueMemberIds(quorumById.get('preset-quorum-standard').config.plugins)
  const fromBase = leavesOutsideQueue(standardBase.config.plugins, members)
  const fromQuorum = leavesOutsideQueue(quorumById.get('preset-quorum-standard').config.plugins, members)

  assert.ok(fromBase.size > 0, 'the comparison must not be vacuous: the standard base must declare rows outside the queue')
  for (const [id, row] of fromBase) {
    const carried = fromQuorum.get(id)
    assert.ok(carried, 'quorum-standard drops the standard base row "' + id + '"')
    assert.equal(canonical(carried), canonical(row), 'row "' + id + '" diverged between the standard base and quorum-standard')
  }
  for (const id of fromQuorum.keys()) {
    assert.ok(fromBase.has(id), 'quorum-standard carries "' + id + '", which the standard base does not declare')
  }
})

test('T-Q5 — the root patch recopies the three quorum preset rows from packages/boost-mode', () => {
  assert.equal(quorumPatch.rows.length, QUORUM_PRESETS.length, QUORUM_PATCH + ' must insert exactly the three preset rows')
  for (const preset of QUORUM_PRESETS) {
    const fromRoot = rootById.get(preset.rowId)
    const fromSource = quorumById.get(preset.rowId)
    assert.ok(fromRoot, 'the root patch must insert "' + preset.rowId + '"')
    assert.ok(fromSource, QUORUM_PATCH + ' must insert "' + preset.rowId + '"')
    assert.equal(withoutName(fromRoot), withoutName(fromSource), 'row "' + preset.rowId + '" diverged between the root patch and ' + QUORUM_PATCH)
    assert.equal(fromRoot.name, fromSource.name, 'name of "' + preset.rowId + '" must match between the root patch and ' + QUORUM_PATCH)
  }
})

test('T-Q6 — no legacy ' + LEGACY_PRESET_ID + ' id survives in the owned files', () => {
  const owned = [
    ROOT_PATCH,
    QUORUM_PATCH,
    join(ROOT, 'packages', 'boost-mode', 'README.md'),
    join(ROOT, 'packages', 'boost-mode', 'lib', 'index.js'),
    join(ROOT, 'packages', 'boost-mode', 'package.json'),
    fileURLToPath(import.meta.url),
  ]
  for (const file of owned) {
    assert.ok(existsSync(file), file + ' must exist')
    const text = readFileSync(file, 'utf8')
    const at = text.indexOf(LEGACY_PRESET_ID)
    assert.equal(at, -1, file + ' still carries ' + LEGACY_PRESET_ID + ' at offset ' + at)
  }
})

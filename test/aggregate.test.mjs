/**
 * Anti-drift test: the aggregate patch at the repository root must be exactly
 * the union of the five package patches it claims to aggregate.
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

/** The five sub-packages, in the order the root patch lists their rows. */
const PACKAGES = ['boost-mode', 'boost-relay', 'boost-status', 'detached-jobs', 'guard-surrogate']

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

/** A `name` that is a path, as opposed to an npm specifier like '@scope/pkg'. */
function isPathName(name) {
  return typeof name === 'string' && (name.startsWith('./') || name.startsWith('../'))
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

test('the root patch is ONE insert entry carrying the five Boost rows', () => {
  assert.equal(root.entries.length, 1, 'the root patch must hold exactly one top-level entry')
  assert.equal(root.inserts.length, 1, 'that entry must be the single insert: entry')
  assert.equal(root.rows.length, 5, 'the insert: list must carry exactly five rows')
  for (const source of sources) {
    assert.equal(source.parsed.inserts.length, 1, source.patchPath + ' must hold exactly one insert: entry')
  }
})

test('the root patch inserts the same five ids as the sub-packages, each exactly once', () => {
  assert.deepEqual(
    [...rootById.keys()].sort(),
    [...sourceRows.keys()].sort(),
    'root ids must equal the union of the sub-package ids'
  )
  assert.equal(rootById.size, root.rows.length, 'no id may appear twice in the root patch')
  assert.deepEqual(
    root.rows.map((row) => row.id),
    ['preset-boost', 'boost-job-relay', 'boost-status-command', 'dsh-detached-jobs', 'dsh-guard-surrogate'],
    'the root patch must list the five rows in the documented order'
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

// Reader for DSH session logs ($DSH_HOME/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd).
//
// Why this exists: the on-disk file is NOT one zstd stream. DSH appends one
// independent zstd frame per flush, so a session log is a concatenation of
// hundreds of frames. Node's one-shot `zstdDecompressSync` and its streaming
// `createZstdDecompress` both stop after the first frame (verified on
// 0.1.7-rc.2 / Node 22.23.2: a 317 KB / 148-frame log decodes to 267 bytes).
// Decoding therefore requires splitting on the zstd frame magic and inflating
// each frame separately.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Inflate a concatenation of zstd frames.
 *
 * Frame boundaries are found by scanning for the frame magic. A magic byte
 * sequence can also occur inside compressed payload, so a candidate segment
 * that fails to inflate is merged with the following segment and retried
 * rather than dropped: losing a record would silently corrupt the report.
 * @param {Buffer} buf raw file bytes
 * @returns {{ records: unknown[], frames: number, bytes: number, skipped: number }}
 */
export function decodeFrames(buf) {
  const offsets = []
  let at = buf.indexOf(FRAME_MAGIC)
  while (at !== -1) {
    offsets.push(at)
    at = buf.indexOf(FRAME_MAGIC, at + 4)
  }
  const chunks = []
  let frames = 0
  let bytes = 0
  let skipped = 0
  let lastFrameBytes = -1
  for (let i = 0; i < offsets.length; i++) {
    let decoded
    let end = i + 1
    for (; end <= offsets.length; end++) {
      const from = offsets[i]
      const to = end < offsets.length ? offsets[end] : buf.length
      try {
        decoded = zstdDecompressSync(buf.subarray(from, to))
        break
      } catch {
        // Either a false magic inside payload, or a truncated tail frame.
        decoded = undefined
      }
    }
    if (decoded === undefined) {
      skipped++
      continue
    }
    frames++
    bytes += decoded.length
    lastFrameBytes = decoded.length
    chunks.push(decoded)
    i = end - 1
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const records = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      skipped++
    }
  }
  return {
    records,
    frames,
    bytes,
    skipped,
    frameCount: offsets.length,
    /**
     * True when the FINAL frame contributed nothing.
     *
     * A live session log is appended frame by frame, so a reader can catch one
     * mid-flush. `zstdDecompressSync` does not throw on a truncated frame — it
     * returns whatever prefix it could decode, frequently empty — so a partial
     * tail is otherwise indistinguishable from a log that simply ends there, and
     * the newest record goes missing without a word. A caller reporting on a live
     * session must surface this instead of treating the log as complete.
     */
    emptyTail: frames > 0 && lastFrameBytes === 0,
  }
}

/** Read one session log file. */
export function readSessionLog(file) {
  const { records, frames, bytes, skipped } = decodeFrames(readFileSync(file))
  return { file, records, frames, bytes, skipped }
}

/** Read one session directory (`.../<session-id>/`). */
export function readSessionDir(dir) {
  const file = join(dir, 'session.v4.jsonl.zstd')
  const { records, frames, bytes, skipped } = decodeFrames(readFileSync(file))
  return { dir, file, records, frames, bytes, skipped }
}

/**
 * Resolve `$DSH_HOME/sessions`.
 * @param {string|undefined} home override; defaults to DSH_HOME or ~/.dsh
 */
export function sessionsRoot(home) {
  const base = home ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  return join(base, 'sessions')
}

/** List every session directory under a sessions root, newest first. */
export function listSessionDirs(root = sessionsRoot()) {
  const out = []
  for (const workspace of safeReaddir(root)) {
    const workspacePath = join(root, workspace)
    if (!isDir(workspacePath)) continue
    for (const session of safeReaddir(workspacePath)) {
      const dir = join(workspacePath, session)
      const file = join(dir, 'session.v4.jsonl.zstd')
      if (!isDir(dir)) continue
      try {
        out.push({ dir, file, workspace, id: session, mtime: statSync(file).mtimeMs })
      } catch {
        // No log file yet (session created but never flushed).
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** First record of a log (the header) or undefined. */
export function headerOf(records) {
  return records.find((r) => r && r.type === 'session')
}

/**
 * Build the delegation tree rooted at `rootId` from headers on disk.
 * Children record `parentSession` and `delegationDepth` in their header, so the
 * tree is recoverable without asking the runtime.
 */
export function buildTree(rootId, dirs = listSessionDirs()) {
  const byId = new Map()
  for (const entry of dirs) {
    try {
      const header = headerOf(readSessionDir(entry.dir).records)
      if (header) byId.set(entry.id, { ...entry, header })
    } catch {
      // Unreadable or empty log: skip, it cannot be part of a report.
    }
  }
  const children = new Map()
  for (const [id, entry] of byId) {
    const parent = entry.header.parentSession
    if (parent === undefined) continue
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(id)
  }
  const order = []
  const walk = (id, depth) => {
    const entry = byId.get(id)
    if (!entry) return
    order.push({ ...entry, depth })
    for (const child of (children.get(id) ?? []).sort((a, b) => (byId.get(a).header.createdAt ?? 0) - (byId.get(b).header.createdAt ?? 0))) {
      walk(child, depth + 1)
    }
  }
  walk(rootId, 0)
  return { root: byId.get(rootId), nodes: order, byId, children }
}

/**
 * Whether a session log already contains a turn, reading as few frames as
 * possible. Used to skip sessions that were created and never used, which would
 * otherwise win a newest-first pick.
 * @param {string} file session log path
 * @param {number} maxFrames frames to inflate before giving up
 */
export function hasTurn(file, maxFrames = 40) {
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    return false
  }
  const offsets = []
  let at = buf.indexOf(FRAME_MAGIC)
  while (at !== -1 && offsets.length <= maxFrames) {
    offsets.push(at)
    at = buf.indexOf(FRAME_MAGIC, at + 4)
  }
  for (let i = 0; i < offsets.length && i <= maxFrames; i++) {
    const from = offsets[i]
    const to = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try {
      if (zstdDecompressSync(buf.subarray(from, to)).toString('utf8').includes('"turn/start"')) return true
    } catch {
      // False magic inside payload, or a truncated tail frame: keep scanning.
    }
  }
  return false
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

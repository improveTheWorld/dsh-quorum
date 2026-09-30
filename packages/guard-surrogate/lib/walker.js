/**
 * Total, stateless walker that removes unpaired UTF-16 surrogates from a text
 * block.
 *
 * A well-formed UTF-16 string keeps every BMP code unit plus every HIGH
 * (U+D800-U+DBFF) + LOW (U+DC00-U+DFFF) pair. The only ill-formed units are a
 * high surrogate not followed by a low one and a low surrogate not preceded by
 * a high one. The scan below visits code units once, in order, and decides each
 * surrogate from its neighbour: no regular expression, no lastIndex, nothing
 * shared between calls.
 *
 * REPLACEMENT, not deletion: an unpaired half becomes U+FFFD REPLACEMENT
 * CHARACTER. Reasons, in order of weight:
 *
 *   1. it is the standard Unicode/WHATWG treatment of an ill-formed sequence
 *      (U+FFFD is what a conforming UTF-8 encoder emits), so the model sees the
 *      same damage marker every other toolchain would produce;
 *   2. it is VISIBLE. A silent deletion makes a tool output look intact while
 *      text has moved; U+FFFD preserves position and tells a reader, human or
 *      model, that a code unit was lost;
 *   3. it cannot merge two neighbouring strings across the gap, which deletion
 *      can.
 *
 * Only text blocks (type === 'text') with a string text are touched: every other
 * block is passed through by reference, and a content array with nothing to
 * repair is returned as the SAME array, so the caller can decide on identity
 * alone.
 *
 * @module @local/dsh-guard-surrogate/walker
 */

/** First code unit of the high-surrogate range. */
const HIGH_MIN = 0xd800
/** Last code unit of the high-surrogate range. */
const HIGH_MAX = 0xdbff
/** First code unit of the low-surrogate range. */
const LOW_MIN = 0xdc00
/** Last code unit of the low-surrogate range. */
const LOW_MAX = 0xdfff

/** What one unpaired half becomes. See the module docstring. */
export const REPLACEMENT = '\uFFFD'

/**
 * Whether the text contains any code unit in the surrogate range.
 *
 * @param text - the string to test.
 * @returns true when at least one code unit is in U+D800..U+DFFF.
 */
export function hasSurrogate(text) {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= HIGH_MIN && code <= LOW_MAX) return true
  }
  return false
}

/**
 * Repair one string.
 *
 * A valid pair is copied code unit for code unit, so an emoji survives bit for
 * bit. A half with no partner becomes REPLACEMENT. The result can never contain
 * a half: every surrogate that is not part of a copied pair was replaced.
 *
 * @param text - the string to repair.
 * @returns the same string when it is already well-formed (same reference, no
 *   allocation), otherwise a repaired copy, plus the number of halves replaced.
 */
export function repairText(text) {
  if (!hasSurrogate(text)) return { text, replaced: 0 }
  let out = ''
  let copied = 0
  let replaced = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < HIGH_MIN || code > LOW_MAX) continue
    if (code <= HIGH_MAX) {
      const next = text.charCodeAt(index + 1)
      if (next >= LOW_MIN && next <= LOW_MAX) {
        // A valid pair: skip its low half and let the slice copy both units.
        index += 1
        continue
      }
    }
    out += text.slice(copied, index) + REPLACEMENT
    copied = index + 1
    replaced += 1
  }
  return { text: out + text.slice(copied), replaced }
}

/**
 * Repair a content array.
 *
 * Inertness is the contract: a block whose type is not 'text', or whose text is
 * not a string, is kept by reference and never inspected further.
 *
 * @param content - the content blocks of a tool result or decision.
 * @returns the repaired array - the SAME reference when nothing changed - the
 *   number of halves replaced, and the number of blocks rebuilt.
 */
export function repairContent(content) {
  let replaced = 0
  let blocks = 0
  let changed = false
  const next = content.map((block) => {
    if (block === null || typeof block !== 'object' || block.type !== 'text') return block
    if (typeof block.text !== 'string') return block
    const repaired = repairText(block.text)
    if (repaired.replaced === 0) return block
    changed = true
    blocks += 1
    replaced += repaired.replaced
    return { ...block, text: repaired.text }
  })
  return { content: changed ? next : content, replaced, blocks, changed }
}

/**
 * Total code-unit length of every text block in the content, for the journal.
 *
 * @param content - the content blocks.
 * @returns the summed length of the string text fields of text blocks.
 */
export function textLength(content) {
  let total = 0
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') total += block.text.length
  }
  return total
}

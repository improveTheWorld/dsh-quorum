/**
 * Patch-only bundle: this module intentionally exports no runtime API.
 *
 * All behaviour of the `quorum` family is declared by `cordis.patch.yml` (the
 * three `preset-quorum-*` rows and the plugin rows they mount). A later
 * milestone may add a host plugin here for a shared prompt section, a
 * `/quorum` command, and mechanical delegation guardrails; none of that is
 * required for the presets to work, so this module stays empty.
 */
export {}

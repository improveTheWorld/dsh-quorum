/**
 * Patch-only bundle: this module intentionally exports no runtime API.
 *
 * All behaviour of the `boost` mode is declared by `cordis.patch.yml` (the
 * `preset-boost` row and the plugin rows it mounts). A later milestone may add
 * a host plugin here for a shared prompt section, a `/boost` command, and
 * mechanical delegation guardrails; none of that is required for the mode to
 * work, so this module stays empty.
 */
export {}

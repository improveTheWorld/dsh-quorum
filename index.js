/**
 * Aggregate bundle entry point: this module intentionally exports no runtime API.
 *
 * Every line this bundle mounts is declared by `cordis.patch.yml` — ONE
 * `insert:` entry carrying the five Boost rows — so no host plugin lives here.
 * The runtime identity of the package is the patch; this module exists because
 * `package.json` names it as `main`, exactly like `packages/boost-mode/lib/index.js`.
 */
export {}

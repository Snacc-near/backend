# src/oracle — versioned copy from `oracle-tee`

Source: `oracle-tee` repo commit `21ddaeb` (`src/redact.ts`, `src/pipeline.ts`, `src/enclave-client.ts`).
The backend is deployed from a standalone clone of this repo (0 runtime dependencies), so `oracle-tee` cannot be imported
as an external package; files are copied **verbatim** except:

- `enclave-client.ts`: the `RES-101` section (`@nearai/inference-sdk` path) is omitted — it requires a
  runtime dependency that the backend intentionally omits. The direct HTTP path (`runGenomeExperiment`) still
  verifies `signed_text` + ed25519 locally.

`test/oracle-sync.test.ts` compares this copy against `../oracle-tee/src` whenever the sibling repo is present
(automatically skipped in a standalone clone) to catch drift. Do not edit files here independently; update
`oracle-tee` first, then re-copy and update the commit hash above.

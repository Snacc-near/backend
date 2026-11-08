import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// dist/test/*.js -> backend/ -> ../oracle-tee (repo sibling di checkout payung)
const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, "..", "..");
const vendored = join(backendRoot, "src", "oracle");
const upstream = join(backendRoot, "..", "oracle-tee", "src");

const skip = !existsSync(join(upstream, "redact.ts"));

test("src/oracle sama dengan oracle-tee (redact, pipeline; enclave-client tanpa bagian SDK RES-101)", { skip }, () => {
  for (const f of ["redact.ts", "pipeline.ts"]) {
    assert.equal(readFileSync(join(vendored, f), "utf8"), readFileSync(join(upstream, f), "utf8"), `${f} drift`);
  }
  const up = readFileSync(join(upstream, "enclave-client.ts"), "utf8");
  const cut = up.indexOf("// ---------------------------------------------------------------------------\n// `RES-101`");
  assert.ok(cut > 0, "penanda RES-101 hilang di oracle-tee; perbarui salinan");
  assert.equal(readFileSync(join(vendored, "enclave-client.ts"), "utf8").trimEnd(), up.slice(0, cut).trimEnd(), "enclave-client.ts drift");
});

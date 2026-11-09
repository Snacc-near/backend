import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// dist/test/*.js -> backend/ -> ../oracle-tee (sibling repo in umbrella checkout)
const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, "..", "..");
const vendored = join(backendRoot, "src", "oracle");
const upstream = join(backendRoot, "..", "oracle-tee", "src");

const skip = !existsSync(join(upstream, "redact.ts"));

test("src/oracle matches oracle-tee (redact, pipeline; enclave-client without RES-101 SDK section)", { skip }, () => {
  for (const f of ["redact.ts", "pipeline.ts"]) {
    assert.equal(readFileSync(join(vendored, f), "utf8"), readFileSync(join(upstream, f), "utf8"), `${f} drift`);
  }
  const up = readFileSync(join(upstream, "enclave-client.ts"), "utf8");
  const cut = up.indexOf("// ---------------------------------------------------------------------------\n// `RES-101`");
  assert.ok(cut > 0, "RES-101 marker missing in oracle-tee; update vendored copy");
  assert.equal(readFileSync(join(vendored, "enclave-client.ts"), "utf8").trimEnd(), up.slice(0, cut).trimEnd(), "enclave-client.ts drift");
});

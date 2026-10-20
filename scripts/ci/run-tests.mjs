// Runs every `test:*` npm script of the checked-out branch (new suites are picked up automatically), keeps each suite's FULL output in a file
// (the app logs a lot while the tests run), and reports per suite: a table in the job summary and, for a failing suite, an error annotation with
// the failing tests and the error text (app timing lines filtered). Exit code 1 if any suite fails. No secrets, no network.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Suites that do not belong to a branch's deliverable. `test:memory-repair` belongs to an abandoned design (needs a workflow file and a git history).
const SKIP = new Set(["test:memory-repair"]);
const NOISE = /^\[(VaultIO|Vault|DB)\] /;
const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts ?? {};
const suites = Object.keys(scripts).filter((k) => k.startsWith("test:") && !SKIP.has(k));
const dir = join(process.env.RUNNER_TEMP ?? ".", "ci-test-logs");
mkdirSync(dir, { recursive: true });

const count = (log, name) => {
  const lines = log.split("\n").filter((l) => new RegExp(`^(# |ℹ )${name} [0-9]+`).test(l));
  const last = lines[lines.length - 1];
  return last ? Number(last.replace(/[^0-9]*([0-9]+).*/, "$1")) : null;
};
const esc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

const rows = [];
let failed = 0;
for (const name of suites) {
  const r = spawnSync("npm", ["run", name], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, shell: process.platform === "win32" });
  const log = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  writeFileSync(join(dir, `${name.replace(/[^a-z0-9-]/gi, "_")}.log`), log);
  const c = Object.fromEntries(["tests", "pass", "fail", "skipped", "cancelled", "todo"].map((k) => [k, count(log, k)]));
  let why = "";
  if (r.status !== 0) why = `exit code ${r.status}`;
  else if (Object.values(c).some((v) => v === null)) why = "summary incomplete";
  else if (c.tests <= 0 || c.pass <= 0) why = "no passing tests";
  else if (c.fail !== 0) why = `fail=${c.fail}`;
  else if (c.cancelled !== 0) why = `cancelled=${c.cancelled}`;
  else if (c.pass + c.skipped + c.todo !== c.tests) why = "pass+skipped+todo != tests";
  rows.push({ name, ...c, ok: why === "" });
  console.log(`RESULT ${name} exit=${r.status} tests=${c.tests ?? "?"} pass=${c.pass ?? "?"} fail=${c.fail ?? "?"} skipped=${c.skipped ?? "?"} cancelled=${c.cancelled ?? "?"} todo=${c.todo ?? "?"}${why ? ` FAIL(${why})` : ""}`);
  if (why) {
    failed++;
    const lines = log.split("\n").filter((l) => !NOISE.test(l));
    const failing = lines.filter((l) => /^\s*(not ok|✖)/.test(l)).slice(0, 30);
    const tail = lines.slice(-80);
    console.log(`::error title=${esc(name)} failed (${esc(why)})::${esc([...failing, "---", ...tail].join("\n").slice(0, 6000))}`);
  }
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = ["| suite | tests | pass | fail | skipped | cancelled | todo | |", "|---|---|---|---|---|---|---|---|",
    ...rows.map((x) => `| ${x.name} | ${x.tests ?? "?"} | ${x.pass ?? "?"} | ${x.fail ?? "?"} | ${x.skipped ?? "?"} | ${x.cancelled ?? "?"} | ${x.todo ?? "?"} | ${x.ok ? "ok" : "FAILED"} |`)].join("\n");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
}
console.log(failed === 0 ? `ALL ${rows.length} SUITES PASSED` : `${failed} OF ${rows.length} SUITES FAILED`);
process.exit(failed === 0 ? 0 : 1);

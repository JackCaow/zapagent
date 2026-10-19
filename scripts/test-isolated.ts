import { readdirSync } from "node:fs";
import { join } from "node:path";

// A separate Bun process per file avoids leaking module mocks between suites.
// Keep a hard process deadline: a synchronous loop cannot honor Bun's timer.
function discover(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? discover(path) : path.endsWith(".test.ts") ? [path] : [];
  }).sort();
}

const files = [...discover("tests"), ...discover("zapsdk/tests")];
const failures: string[] = [];
let passed = 0;
let skipped = 0;
let cursor = 0;

await Promise.all(Array.from({ length: 2 }, async () => {
  while (cursor < files.length) {
    const file = files[cursor++];
    const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", file], {
      stdout: "pipe", stderr: "pipe", env: process.env,
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    clearTimeout(timer);
    const output = stdout + stderr;
    passed += Number(output.match(/\n\s*(\d+) pass\b/)?.[1] ?? 0);
    skipped += Number(output.match(/\n\s*(\d+) skip\b/)?.[1] ?? 0);
    console.log(`${code === 0 ? "PASS" : "FAIL"} ${file}`);
    if (code !== 0) { failures.push(file); console.error(output); }
  }
}));
console.log(JSON.stringify({ files: files.length, passed, skipped, failures }));
process.exitCode = failures.length === 0 ? 0 : 1;

import { writeFileSync, chmodSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, basename } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { prdPath, progressPath } from "./state.js";

/**
 * Ralph-style runner generator. Produces three files in the supertask state
 * directory:
 *   - PLANNER_BRIEF.md   prompt for iteration 0 (creates prd.json)
 *   - ITER_BRIEF.md      prompt for every subsequent iteration (does ONE story)
 *   - run.sh             self-contained bash loop that re-invokes zap headless
 *
 * The bash script is the "external loop" — the deterministic outer driver
 * that real Ralph requires. Each `zap -p` call inside is a fresh process
 * with no memory of prior iterations; all state flows through prd.json,
 * progress.txt, and git history in the project repo.
 */

export const RALPH_DEFAULT_MAX_ITER = 30;
export const RALPH_MAX_TURNS_PER_ITER = 80;

export interface RalphConfig {
  stateDir: string;
  projectDir: string;
  desc: string;
  maxIter?: number;
  maxTurnsPerIter?: number;
  /** Path to the node/bun interpreter (process.execPath in callers). */
  zapInterp?: string;
  /** Path to the zap entry script (process.argv[1] in callers). */
  zapScript?: string;
  /** Override the active model per iter (e.g. "claude-haiku-4.5" for cheap
   *  smoke runs). Omit to use whatever zap's config has set as active. */
  model?: string;
}

export interface RalphArtifacts {
  scriptPath: string;
  plannerBriefPath: string;
  iterBriefPath: string;
  logPath: string;
  maxIter: number;
  maxTurnsPerIter: number;
}

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_EXEC_MODE = 0o700;
const PRIVATE_DIR_MODE = 0o700;

function chmodBestEffort(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try { chmodSync(path, mode); } catch {}
}

function writePrivateFile(path: string, content: string, mode = PRIVATE_FILE_MODE): void {
  writeFileSync(path, content, { mode });
  chmodBestEffort(path, mode);
}

/** Materialize PLANNER_BRIEF.md + ITER_BRIEF.md + run.sh in the state dir. */
export function generateRalphArtifacts(cfg: RalphConfig): RalphArtifacts {
  const maxIter = cfg.maxIter ?? RALPH_DEFAULT_MAX_ITER;
  const maxTurnsPerIter = cfg.maxTurnsPerIter ?? RALPH_MAX_TURNS_PER_ITER;
  const zapInterp = cfg.zapInterp ?? process.execPath;
  const zapScript = cfg.zapScript ?? (process.argv[1] || "");
  if (!zapScript) {
    throw new Error("ralph-runner: cannot resolve zap entry script — pass cfg.zapScript explicitly");
  }
  // Recursion guard. If the caller didn't pass zapScript explicitly and
  // process.argv[1] points at a file that isn't zap itself (e.g. a test
  // harness, an external launcher), the generated run.sh would invoke that
  // script as a "headless zap" and silently fork-bomb. We learned this the
  // hard way during the first smoke test — hundreds of supertasks created
  // in seconds. Sniff the script's first KB for a zap marker; if missing,
  // refuse to generate and ask the caller to be explicit.
  if (cfg.zapScript === undefined) {
    assertLooksLikeZapEntry(zapScript);
  }

  const plannerBriefPath = join(cfg.stateDir, "PLANNER_BRIEF.md");
  const iterBriefPath = join(cfg.stateDir, "ITER_BRIEF.md");
  const scriptPath = join(cfg.stateDir, "run.sh");
  const logPath = join(cfg.stateDir, "runner.log");

  chmodBestEffort(cfg.stateDir, PRIVATE_DIR_MODE);
  writePrivateFile(plannerBriefPath, buildPlannerBrief(cfg));
  writePrivateFile(iterBriefPath, buildIterBrief(cfg));
  writePrivateFile(
    scriptPath,
    buildRunScript({
      stateDir: cfg.stateDir,
      projectDir: cfg.projectDir,
      desc: cfg.desc,
      maxIter,
      maxTurnsPerIter,
      zapInterp,
      zapScript,
      logPath,
      model: cfg.model,
    }),
    PRIVATE_EXEC_MODE,
  );

  return { scriptPath, plannerBriefPath, iterBriefPath, logPath, maxIter, maxTurnsPerIter };
}

/** POSIX single-quote escape: 'foo' → ''\''foo''\''' (safe for sh -c). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Throws if the given path doesn't look like zap's entry point. Used to
 *  guard against the recursion footgun (see `generateRalphArtifacts`). */
function assertLooksLikeZapEntry(scriptPath: string): void {
  let resolved = scriptPath;
  try { resolved = realpathSync(scriptPath); } catch { /* keep original */ }
  // index.tsx + index.js are the source/build entries; the npm bin name is
  // "zap" / "zapcode" which symlinks back to one of them.
  const base = basename(resolved);
  if (base === "index.tsx" || base === "index.js" || base === "zap" || base === "zapcode") {
    return;
  }
  // Last-resort content check: zap's entry has unique strings. Cheap (≤1KB).
  if (existsSync(resolved)) {
    try {
      const head = readFileSync(resolved, "utf-8").slice(0, 4096);
      if (head.includes("runHeadlessFromArgv") || head.includes("zapcode v")) return;
    } catch { /* fall through */ }
  }
  throw new Error(
    `ralph-runner: process.argv[1] (${scriptPath}) does not look like zap's entry — ` +
    `pass cfg.zapScript explicitly to avoid spawning a fork-bomb. ` +
    `(Use the absolute path to zap's index.tsx or the installed bin shim.)`,
  );
}

function buildPlannerBrief(cfg: RalphConfig): string {
  return `You are seeding a Ralph-style long-horizon supertask. Goal:

${cfg.desc}

# Your job THIS turn

Produce a PRD file at ${prdPath(cfg.stateDir)}. Do NOT modify any project source files this turn.

# Steps

1. Briefly explore ${cfg.projectDir} — read README, top-level dir listing, manifest files (package.json, Cargo.toml, pyproject.toml, go.mod, etc.) — just enough to understand what the project is.
2. Decompose the goal into 5–20 atomic stories. Each story must:
   - Be completable in ONE iteration: one fresh agent, one context window, ≤${cfg.maxTurnsPerIter ?? RALPH_MAX_TURNS_PER_ITER} tool calls.
   - Have a concrete acceptance criterion an agent can verify (a test path, a build command, a grep, a file that must exist).
   - Be ordered by priority — priority 1 is highest, executed first.
   - Be SELF-CONTAINED. Don't write "do step 3 of US-002 here" — each story stands alone.
3. Write the PRD to ${prdPath(cfg.stateDir)} with EXACTLY this schema (use write_file or similar tool):

\`\`\`json
{
  "project": "<short project name>",
  "description": ${JSON.stringify(cfg.desc)},
  "userStories": [
    {
      "id": "US-001",
      "title": "<≤60 chars>",
      "description": "<1-2 sentences: what + why>",
      "acceptanceCriteria": ["<check 1>", "<check 2>"],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
\`\`\`

4. Stop. Do NOT implement any story this turn — that's the next iteration's job.

# Constraints

- 5–20 stories. Fewer if the goal is small; more is a sign you should split the goal.
- Keep titles short and scannable. Detail goes in description + acceptanceCriteria.
- Priorities should reflect dependency order: foundational work first.
`;
}

function buildIterBrief(cfg: RalphConfig): string {
  return `You are ONE iteration of a Ralph-style supertask loop. Each invocation is a fresh process with NO memory of prior iterations — your only context is on disk.

# READ THIS FIRST: you are not in a conversation

There is no human reading your output mid-turn. No one will answer questions. Your stdout/stderr are captured to a file and a script parses them. Specifically:

- NEVER end your turn with a question ("what should I do next?" — there's no one to ask).
- NEVER end your turn waiting for input or confirmation ("Waiting for the build to complete." is not an acceptable last line — see step 6).
- Your turn MUST end with EITHER:
  (a) a successful commit + passes:true flip on YOUR story, OR
  (b) a progress.txt entry explaining what blocked you (FAIL or PARTIAL), with passes left at false.
- If you've done enough work to commit, commit it. Don't pause to ask if it's "ready".
- The runner re-invokes you immediately with the same brief; you iterate via fresh turns, NOT via mid-turn dialogue.

# State files

- PRD:      ${prdPath(cfg.stateDir)}
- Progress: ${progressPath(cfg.stateDir)}
- Project:  ${cfg.projectDir}    (your --cwd; git lives here)

# Your task THIS iteration — exactly ONE story, end to end

1. ORIENT yourself FIRST (do not skip):
   a. \`git -C ${cfg.projectDir} log --oneline -20\` — what have prior iters already done? (If git reports "does not have any commits yet", that's normal for iter 1.)
   b. Read ${prdPath(cfg.stateDir)} — what's the queue look like?
   c. Read the last ~80 lines of ${progressPath(cfg.stateDir)} — what did prior iters discover or get stuck on?

2. CHECK COMPLETION. Count stories where \`passes: true\`. If that equals \`userStories.length\`, print exactly \`<promise>COMPLETE</promise>\` on its own line and stop. Otherwise DO NOT print the sentinel — the runner verifies against prd.json and rejects false claims.

3. RECONCILE git vs PRD before doing new work. If a story is marked \`passes: false\` in prd.json but git already shows a commit like \`[supertask] [<that-story-id>]\` (a prior iter did the work but didn't update the flag — common failure mode), JUST flip its flag in prd.json, commit the flag change with \`git commit -m "[supertask] [<story.id>] mark passes"\`, append a one-line PASS entry to progress.txt (see 7a), and STOP. That counts as your iter — DO NOT also start a new story in the same turn.

4. OTHERWISE pick a story to do: lowest priority-number among \`passes: false\`. This is YOUR story for this iter.

5. IMPLEMENT it. Read code, edit files, run shell, use git — you have full access. Follow existing project conventions.

6. SHELL DISCIPLINE. Any single shell command must complete in <120s. ALWAYS wrap potentially-long commands (\`./gradlew\`, \`npm install\`, \`cargo build\`, \`docker build\`, etc.) with a timeout: \`timeout 120 <cmd>\`. If it times out, that is NOT a checks failure — go to step 7c (PARTIAL). The phrase "Waiting for the build to complete." in your output means you broke this rule; the runner will treat the iter as failed.

7. RUN QUALITY CHECKS, scaled to the project:
   - Has a test suite (bun test / cargo test / pytest / go test / ...): run it.
   - Else has a build (./gradlew assembleDebug / npm run build / tsc --noEmit): run that (with timeout 120).
   - Else (truly greenfield, fresh-init project, no tests or build yet): a successful commit + the files declared in the story's acceptance criteria existing on disk counts as checks passing. Don't refuse to flip passes:true just because there's no test suite yet.

8. RESOLVE THIS ITER — exactly one of these three branches:
   a. PASS (checks ran clean, or greenfield rule applied):
      - \`git add -A && git commit -m "[supertask] [<story.id>] <story.title>"\`
      - Update ${prdPath(cfg.stateDir)}: set \`passes: true\` ONLY on YOUR story; preserve every other field of every other story exactly.
      - APPEND to ${progressPath(cfg.stateDir)} (MANDATORY — see contract below):
        \`\`\`
        ## <ISO timestamp> · <story.id> · PASS
        - implemented: <one-line summary>
        - files: <changed files, comma-separated>
        - checks: <commands run + their results>
        - learnings: <gotcha worth remembering — or omit the line>
        ---
        \`\`\`
      - If after the prd update ALL stories now have \`passes: true\`, print \`<promise>COMPLETE</promise>\` on its own line.
   b. FAIL (checks ran and returned non-zero / red output):
      - DO NOT commit. DO NOT flip passes.
      - APPEND to ${progressPath(cfg.stateDir)} (MANDATORY):
        \`\`\`
        ## <ISO timestamp> · <story.id> · FAIL
        - tried: <what you did>
        - failed: <command + exit code + first error line / file:line>
        - next: <one-line hint for the next iter>
        ---
        \`\`\`
   c. PARTIAL / TIMED OUT (couldn't reach pass-or-fail: long build, missing tool, ran out of turns):
      - DO NOT commit incomplete work; either revert your edits or \`git stash\` them.
      - APPEND to ${progressPath(cfg.stateDir)} (MANDATORY):
        \`\`\`
        ## <ISO timestamp> · <story.id> · PARTIAL
        - did: <what got done>
        - blocked: <what you ran into (command timed out / tool missing / etc.)>
        - next: <one-line hint for the next iter>
        ---
        \`\`\`

# Contract (the runner enforces these)

- ONE story per iteration. Never chain two. (Doing more does NOT speed things up — the runner re-invokes you for the next.)
- EVERY iter must append at least one entry to ${progressPath(cfg.stateDir)}. An iter that ends without a new progress.txt entry is logged as a contract violation by the runner. No exceptions — even iter 1 on an empty repo writes a PASS / FAIL / PARTIAL entry.
- Never commit broken code. Never flip \`passes:true\` if checks failed.
- ${progressPath(cfg.stateDir)} is APPEND-ONLY. Read it freely; never rewrite or truncate.
- Don't touch other stories' \`passes\` flags. Only flip your own story (or the one you reconciled in step 3).
- Don't print \`<promise>COMPLETE</promise>\` unless you have JUST verified by re-reading prd.json that EVERY story has \`passes: true\`. The runner verifies and rejects false claims.
- If a story is genuinely impossible (not a bug you can fix): append a PARTIAL entry, set \`notes\` on the story explaining the block, leave passes:false. The next iter will see it.

# Tone

Be terse. progress.txt is for future iterations of yourself — write what you wish you'd known.
`;
}

interface ScriptCtx {
  stateDir: string;
  projectDir: string;
  desc: string;
  maxIter: number;
  maxTurnsPerIter: number;
  zapInterp: string;
  zapScript: string;
  logPath: string;
  model?: string;
}

function buildRunScript(ctx: ScriptCtx): string {
  const sq = shellQuote;
  // First line of desc, sanitised for a comment.
  const descLine = ctx.desc.split("\n")[0]!.slice(0, 100).replace(/[\r\n]/g, " ");
  return `#!/usr/bin/env bash
# Ralph-style supertask runner — generated by zapcode /supertask
# Desc: ${descLine}
#
# Driver loop: invokes \`zap -p\` repeatedly with a fresh context per iter.
# The LLM never sees the loop; all state lives in prd.json + progress.txt +
# git history. Survives terminal close (detached + nohup-style).
set -u
umask 077

STATE_DIR=${sq(ctx.stateDir)}
PROJECT_DIR=${sq(ctx.projectDir)}
LOG=${sq(ctx.logPath)}
MAX_ITER=${ctx.maxIter}
MAX_TURNS=${ctx.maxTurnsPerIter}
ZAP_INTERP=${sq(ctx.zapInterp)}
ZAP_SCRIPT=${sq(ctx.zapScript)}
ZAP_MODEL=${sq(ctx.model ?? "")}

# Empty model = let zap use its configured active model.
# Note: macOS ships bash 3.2, which under \`set -u\` aborts on the bare
# array-expansion form when MODEL_ARG is empty. Call sites use the
# alternate-expansion idiom (':+') to expand only when populated.
MODEL_ARG=()
if [ -n "$ZAP_MODEL" ]; then
  MODEL_ARG=(--model "$ZAP_MODEL")
fi

mkdir -p "$STATE_DIR"
echo $$ > "$STATE_DIR/runner.pid"

log() {
  printf '[runner %s] %s\\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"
}

cleanup_pid() {
  rm -f "$STATE_DIR/runner.pid"
}

# Convert meta.status (read-modify-write via a tiny inline node script — avoids
# adding jq as a hard dependency). The interpreter is whatever zap uses; if
# even that's broken, fall back to leaving meta.json alone (the dispatcher
# already tolerates stale status).
set_meta_status() {
  local new_status="$1"
  "$ZAP_INTERP" -e "
    const fs=require('fs');
    const p='$STATE_DIR/meta.json';
    try {
      const m=JSON.parse(fs.readFileSync(p,'utf-8'));
      m.status='$new_status';
      fs.writeFileSync(p, JSON.stringify(m,null,2)+'\\n');
      try { fs.chmodSync(p, 0o600); } catch {}
    } catch(e) { process.stderr.write('meta-update failed: '+e.message+'\\n'); }
  " >> "$LOG" 2>&1 || true
}

# Returns 0 (true) if prd.json exists and every story has passes:true.
# Echoes a "P/T" pass-count summary to stdout for the logging path.
# Don't trust the agent's <promise>COMPLETE</promise> alone — haiku-class
# models have been observed printing it prematurely. Always verify.
verify_all_pass() {
  "$ZAP_INTERP" -e "
    const fs=require('fs');
    try {
      const p=JSON.parse(fs.readFileSync('$STATE_DIR/prd.json','utf-8'));
      const total=p.userStories.length;
      const passed=p.userStories.filter(s=>s.passes===true).length;
      process.stdout.write(passed+'/'+total);
      process.exit(total>0 && passed===total ? 0 : 1);
    } catch(e) { process.stderr.write('verify failed: '+e.message+'\\n'); process.exit(2); }
  "
}

# Capture any in-progress uncommitted work in the project repo before the
# runner exits in a non-success state (STUCK / max_iter). The empirical
# failure mode this guards against: agent does real work in an iter, runs
# a long shell command, hits max_turns, exits WITHOUT git commit. Without
# salvage, /supertask resume's next iter sees a dirty working tree it
# doesn't know how to attribute, and the work is one ill-timed git reset
# from disappearing. Skipping intentional-abort paths (signal trap, planner
# fail) — those are user/system intent to discard, not accidental loss.
#
# Salvage commit is UN-tagged with [US-XXX] on purpose: the salvage may
# span multiple stories or be exploration cruft, and ITER_BRIEF's step-3
# reconciliation matches on \`[US-XXX]\` tags. Untagged ⇒ no auto-flip;
# next iter (or human) must inspect.
salvage_uncommitted() {
  local reason="\$1"
  local iter_num="\$2"
  if ! git -C "$PROJECT_DIR" rev-parse --git-dir > /dev/null 2>&1; then
    return 0
  fi
  if git -C "$PROJECT_DIR" diff --quiet 2>/dev/null && \\
     git -C "$PROJECT_DIR" diff --cached --quiet 2>/dev/null && \\
     [ -z "\$(git -C "$PROJECT_DIR" ls-files --others --exclude-standard 2>/dev/null)" ]; then
    return 0
  fi
  log "salvaging uncommitted work before \$reason"
  git -C "$PROJECT_DIR" add -A >> "$LOG" 2>&1 || true
  if git -C "$PROJECT_DIR" commit -m "[supertask] salvage uncommitted work before \$reason (iter \$iter_num)" >> "$LOG" 2>&1; then
    local sha
    sha=\$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null)
    log "salvage commit \$sha created"
    {
      printf '\\n## %s · SALVAGE\\n' "\$(date '+%Y-%m-%dT%H:%M:%S%z')"
      printf -- '- runner committed uncommitted work as %s before %s (iter %s)\\n' "\$sha" "\$reason" "\$iter_num"
      printf -- '- next iter: inspect that commit, decide which story it completes, then commit a [supertask] [US-XXX] mark passes flag-flip\\n'
      printf -- '---\\n'
    } >> "$STATE_DIR/progress.txt"
  else
    log "salvage commit failed (probably missing user.email or signing config); work remains staged"
  fi
}

trap 'log "INTERRUPTED (signal)"; set_meta_status aborted; cleanup_pid; exit 130' INT TERM

# ── Phase 1: planning (skip if prd.json already exists — resume case) ───
if [ ! -f "$STATE_DIR/prd.json" ]; then
  log "Phase 1: generating PRD"
  "$ZAP_INTERP" "$ZAP_SCRIPT" \\
    -p "$(cat "$STATE_DIR/PLANNER_BRIEF.md")" \\
    --cwd "$PROJECT_DIR" \\
    --permission-mode bypassPermissions \\
    --max-turns 60 \\
    --quiet \\
    --no-devtools \\
    "\${MODEL_ARG[@]:+\${MODEL_ARG[@]}}" \\
    >> "$LOG" 2>&1
  PLAN_STATUS=$?
  if [ ! -f "$STATE_DIR/prd.json" ]; then
    log "FATAL planner did not produce prd.json (exit $PLAN_STATUS)"
    set_meta_status failed
    cleanup_pid
    exit 2
  fi
  log "Phase 1 complete (planner exit $PLAN_STATUS)"
fi

# ── Phase 2: Ralph loop ─────────────────────────────────────────────────
ITER_BRIEF_CONTENT=$(cat "$STATE_DIR/ITER_BRIEF.md")
LAST_COUNTS=""
STUCK=0
STUCK_LIMIT=3
for i in $(seq 1 $MAX_ITER); do
  echo "$i" > "$STATE_DIR/iter.txt"
  log "=== iter $i/$MAX_ITER ==="
  ITER_OUT="$STATE_DIR/$(printf 'iter_%02d.out' $i)"
  # Snapshot progress.txt size BEFORE the iter so we can detect contract
  # violations afterwards. ITER_BRIEF requires every iter to append a
  # PASS / FAIL / PARTIAL entry; an iter that ends with byte-size unchanged
  # is a strong signal the agent didn't follow the brief (e.g. asked a
  # question and stopped). Use wc -c rather than the platform-specific
  # stat flag forms — those differ between BSD (macOS) and GNU coreutils.
  PROGRESS_BYTES_BEFORE=$(wc -c < "$STATE_DIR/progress.txt" 2>/dev/null || echo 0)
  # Intentionally NOT suppressing zap's stderr progress here: \`/supertask
  # watch\` tails iter_NN.out for its "recent activity" pane. Suppressing it
  # left the file empty until the iter exited, so the user had no liveness
  # signal between iter boundaries (often 5-30+ min). Cost: iter outputs
  # grow with tool-call lines; the runner truncates via tail -n 30 when
  # mirroring into runner.log.
  "$ZAP_INTERP" "$ZAP_SCRIPT" \\
    -p "$ITER_BRIEF_CONTENT" \\
    --cwd "$PROJECT_DIR" \\
    --permission-mode bypassPermissions \\
    --max-turns $MAX_TURNS \\
    --no-devtools \\
    "\${MODEL_ARG[@]:+\${MODEL_ARG[@]}}" \\
    > "$ITER_OUT" 2>&1
  ITER_STATUS=$?
  log "iter $i exit $ITER_STATUS"
  # Mirror the tail into the main log so \`tail -f runner.log\` is enough.
  echo "--- iter $i tail ---" >> "$LOG"
  tail -n 30 "$ITER_OUT" >> "$LOG" 2>/dev/null || true
  echo "--- end iter $i ---" >> "$LOG"

  # Contract check: progress.txt MUST grow each iter. Don't fail the loop
  # on this alone — just surface it as a warning so users can see in
  # /supertask watch + runner.log that the agent isn't following the brief.
  # (The pass-count STUCK guard is still the hard abort signal.)
  PROGRESS_BYTES_AFTER=$(wc -c < "$STATE_DIR/progress.txt" 2>/dev/null || echo 0)
  if [ "$PROGRESS_BYTES_BEFORE" = "$PROGRESS_BYTES_AFTER" ]; then
    log "⚠ iter $i did NOT append to progress.txt — agent likely violated ITER_BRIEF contract"
  fi

  # Completion check — runner-side, never trust the agent alone.
  SAW_SENTINEL=no
  grep -q '<promise>COMPLETE</promise>' "$ITER_OUT" && SAW_SENTINEL=yes
  COUNTS=$(verify_all_pass)
  VERIFY_RC=$?
  log "iter $i progress: $COUNTS passed · sentinel=$SAW_SENTINEL"
  if [ "$VERIFY_RC" = "0" ]; then
    log "🎉 all stories pass per prd.json ($COUNTS) at iter $i"
    touch "$STATE_DIR/done.flag"
    set_meta_status done
    cleanup_pid
    exit 0
  fi
  if [ "$SAW_SENTINEL" = "yes" ]; then
    log "⚠ agent claimed COMPLETE but prd.json shows $COUNTS — continuing loop"
  fi

  # No-progress guard: if the pass-count doesn't move for STUCK_LIMIT iters
  # in a row, give up. Otherwise a buggy agent can ride out max_iter without
  # actually advancing the queue (spinning on the same story).
  if [ "$COUNTS" = "$LAST_COUNTS" ]; then
    STUCK=$((STUCK + 1))
    log "no progress: $STUCK consecutive iter(s) at $COUNTS"
    if [ "$STUCK" -ge "$STUCK_LIMIT" ]; then
      log "⚠ stuck at $COUNTS for $STUCK iter(s) — aborting as blocked"
      salvage_uncommitted "STUCK abort" "$i"
      set_meta_status blocked
      cleanup_pid
      exit 3
    fi
  else
    STUCK=0
  fi
  LAST_COUNTS="$COUNTS"
done

log "⚠ reached max_iter ($MAX_ITER) without COMPLETE"
salvage_uncommitted "max_iter" "$MAX_ITER"
set_meta_status max_iter
cleanup_pid
exit 1
`;
}

// ──────────────────────────────────────────────────────────────────────
// Launching the script as a detached subprocess.

export interface SpawnResult {
  pid: number;
  scriptPath: string;
  logPath: string;
}

/** Spawn run.sh as a detached, fully background bash process. Returns the
 *  child pid (also written to runner.pid by the script itself). The child
 *  inherits no stdio and runs in its own process group, so it survives the
 *  parent zap session quitting. */
export function spawnRunnerDetached(artifacts: RalphArtifacts): SpawnResult {
  const child = spawn("bash", [artifacts.scriptPath], {
    detached: true,
    stdio: "ignore",
    // Inherit env so $PATH / API key vars flow into nested `zap -p` calls.
    env: process.env,
  });
  child.unref();
  if (!child.pid) {
    throw new Error(`failed to spawn ${basename(artifacts.scriptPath)}`);
  }
  return { pid: child.pid, scriptPath: artifacts.scriptPath, logPath: artifacts.logPath };
}

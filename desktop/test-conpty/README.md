# test-conpty — Probing the live Claude Code TUI

This directory contains harnesses that drive the real `claude` binary through `node-pty` and observe its behavior end-to-end. They exist because Claude Code's TUI is an opaque black box — its paste classification, render scheduling, echo behavior, and other observable contracts have no public spec, so the only way to know what they do is to run the binary and watch.

The original use case was the chat → CC submit reliability investigation in April 2026 (see `docs/superpowers/investigations/2026-04-24-chat-to-pty-submit-reliability.md`). The same techniques transfer directly to any future question about CC's PTY input/output behavior, Ink internals, JSONL flush timing, or any place YouCoded couples to CC through the byte-stream layer.

This README is the "how to write more of these" guide. Read it before adding a new probe — most of the surprises listed below cost real time the first time around.

## What's here today

| File | Purpose |
|------|---------|
| `cc-snapshot.mjs` | Captures CC version, paste-classification length threshold (bisected), input-bar echo behavior. Writes a versioned JSON snapshot to `snapshots/cc-<version>.json` for diff'ing across releases. |
| `test-multiline-submit.mjs` | Six end-to-end submit scenarios against real `claude` — atomic short writes, atomic long writes (the bug repro), bug-state recovery via bare `\r`, etc. |
| `test-worker-submit.mjs` | End-to-end test of the actual `pty-worker.js` (forked the same way `session-manager.ts` does in production). Verifies all three submit paths in `case 'input'` against real CC. |
| `harness.mjs` + `child.mjs` | Bracketed-paste viability probe on Windows ConPTY. Empirical disproof of the marker-based-submit path. Kept for reference; only re-run if someone proposes resurrecting bracketed paste. |
| `snapshots/` | Versioned JSON snapshots from `cc-snapshot.mjs`. Diff to detect drift on each CC bump. |
| `multiline-*.log`, `worker-*.log` | Per-scenario stdout traces from past runs. Inspectable evidence; safe to delete. |

## The testing model

Every harness here follows the same shape:

1. Spawn `claude` via `node-pty` with a pre-trusted temp cwd.
2. Wait for the welcome screen to render in stdout.
3. Send a controlled input sequence (via direct PTY write OR via the forked worker process).
4. Observe stdout for a known signal that proves the desired thing happened.
5. Kill `claude` before it produces meaningful tokens.

The whole thing runs in 5–60 seconds depending on how many CC spawns the probe needs, and costs a handful of input tokens at most because we kill before the assistant turn streams.

## Helpers you'll want to copy

These appear in nearly every harness; standardizing them avoids subtle differences between probes. (They aren't extracted into a shared module yet because the harnesses have stayed small and self-contained — feel free to extract once a third probe needs the same shape.)

### `resolveClaudeCommand()`

Find `claude` on `PATH`, returning an absolute path. Mirrors `pty-worker.js:resolveCommand` — Windows ConPTY needs absolute paths because it can't shell-resolve.

```js
function resolveClaudeCommand() {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, 'claude' + ext);
      if (fs.existsSync(full)) return full;
    }
  }
  throw new Error('claude not found on PATH');
}
```

### `pretrustCwd(cwd)`

Pre-mark the cwd as trusted in `~/.claude.json` so spawning CC doesn't show the workspace-trust prompt. The trust prompt is the dominant source of test flakiness — it intercepts your test input and varies in timing across runs. **Do not skip this.**

The trust state is stored at `cfg.projects[<forward-slash-path>].hasTrustDialogAccepted = true`. Note the path is stored with **forward slashes regardless of OS** — `C:\Users\<username>\foo` is stored as `C:/Users/<username>/foo`.

```js
function pretrustCwd(cwd) {
  const cfgPath = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(cfgPath)) return;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.projects = cfg.projects || {};
  const fwd = cwd.replace(/\\/g, '/');
  cfg.projects[fwd] = { ...(cfg.projects[fwd] || {}), hasTrustDialogAccepted: true };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}
```

### `stripAnsi(s)`

Strip CSI / OSC / single-escape sequences so the output buffer is plain text suitable for substring matching. CC's TUI uses a lot of cursor-positioning and color escapes interspersed with literal characters; without stripping, you cannot find the body bytes in the echo.

```js
function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')             // CSI
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')   // OSC
    .replace(/\x1b./g, '');                              // stray two-byte
}
```

### Project-slug calculation

CC writes transcript JSONL files to `~/.claude/projects/<slug>/<session-id>.jsonl`. The slug is derived from the cwd by replacing `\`, `/`, and `:` with `-`. Verified against observed dirs (`C:\Users\<username>` → `C--Users-<username>`):

```js
function projectSlug(cwd) {
  return cwd.replace(/[\\/:]/g, '-');
}
```

## Detecting "ready"

You cannot reliably write input until CC's stdin handler is attached AND the welcome screen has rendered. A naive "wait 4 seconds" will frequently fire too early on cold start (welcome takes 5–15 s to appear in some runs) and too late on warm starts.

### The right signal

ANSI-strip stdout into a rolling buffer. Look for distinctive welcome-screen text:

```js
if (/Welcome|Tips|Recent\s*activity/i.test(buffer)) { /* ready */ }
```

After you see the marker, **wait an additional 2–3 s**. CC's render of the welcome screen and CC's stdin-handler attachment are not simultaneous on Windows — empirically the listener attaches several seconds later. Your input will be silently lost otherwise.

### Watch out for cursor-forward escapes between words

CC renders space-separated words in the TUI as `word1\x1b[1Cword2` (cursor-forward by 1) instead of `word1 word2`. After ANSI stripping, that becomes `word1word2` (no space). So `/trust this folder/` won't match — use single distinctive tokens (`/trust/i && /folder/i`) or accept that multi-word phrases need looser matching.

### The trust-prompt detour

If `pretrustCwd()` is missing or stale, CC will show a workspace-trust prompt before the welcome screen. Detect it (`/trust/i && /folder/i`) and resolve it by writing `\r`. **Then wait again** — welcome rendering after trust acceptance takes another ~3 s.

## Detecting submission

Three options ordered by reliability and speed:

### 1. Spinner suffix in stdout (best)

CC prints a randomized `<gerund>ing…` spinner immediately after a turn starts. Examples observed in real traces: `Forming…`, `Mustering…`, `Gusting…`, `Pondering…`, `Crafting…`, `Skedaddling…`, `Perambulating…`, `Reticulating…`, `Metamorphosing…`, `Accomplishing…`. The vocabulary changes randomly, but **all share the `<word>ing…` shape** with a U+2026 HORIZONTAL ELLIPSIS suffix.

```js
const turnRegex = /([A-Za-z]+ing)…/;
```

This is the FAST signal — fires within ~1 s of submit on a warm session, ~7 s on cold start.

**Don't list specific gerund words in your regex.** They drift; my first version had nine specific words and immediately missed `Gusting` on a real run.

### 2. Body re-render in input bar

After submit, the body text appears as a user-message bubble above the input bar. This is visible in stdout via cursor-positioning escapes followed by the body bytes. Useful as a sanity check (proves what was submitted, not just that something was), but harder to parse.

### 3. JSONL transcript file (avoid for speed-sensitive checks)

CC writes user-message entries to `~/.claude/projects/<slug>/<uuid>.jsonl` only AFTER the assistant turn has begun streaming, NOT on submit. This can be 7+ s after the spinner first appears. Useful for verifying the message *content* once you know it submitted, but a poor "did this submit" signal because of the long delay.

The `~/.claude/projects/<slug>/` directory itself isn't created until CC writes its first JSONL line — so `fs.existsSync` on the slug dir is also a slow signal.

## Detecting "stuck" (the bug state)

When the body+`\r` write is paste-classified, CC leaves the body in the input bar with a literal `\n` and the cursor on the next line. Detect this in stdout via the cursor-position escapes around the body:

```
[<row>;<col>HBODY\r\n  [7m [27m
                ^                ^^^^^^^^^^^^^^^^^^
                body on row N    cursor (reverse-video space) on row N+1
```

If you see `BODY\r\n  ` followed by the reverse-video cursor `[7m [27m`, the bug state is reproduced. (Distinct from a normal end-of-content cursor, which renders on the same line as the body.)

For the canonical capture of the literal-newline state, see `multiline-4-atomic-long.log` or `multiline-6-bug-state-plus-cr.log`.

## Cost control

These probes spawn real `claude` against the user's logged-in Anthropic plan. Token cost is small but nonzero. Conventions:

- **Use a temp cwd per probe** — `os.tmpdir()` + a unique stamp. Pre-trust it. CC won't have any project context to load.
- **Use short test inputs** when you don't care what's submitted (`'a'`, `'ATEST'`, `'x'.repeat(N)`). The probe is about behavior, not generation.
- **Kill before tokens stream.** Detect submit via the spinner suffix and `child.kill()` immediately. The handful of tokens consumed before kill amount to fractions of a cent total.
- **Don't loop probes faster than necessary.** A bisection of 7 probes × 25 s each is ~3 minutes total; that's an acceptable budget for a release-time check, not for a CI run.

## Pitfalls (real time spent on each)

These are the surprises that bit me writing the existing harnesses. Read them.

1. **Workspace-trust prompt blocks input silently.** First few harness runs sent test bytes that got consumed by the trust menu instead of the chat input bar — looked like CC was unresponsive. `pretrustCwd()` is mandatory.

2. **CC startup time is wildly variable.** 3 s on a warm machine, 14 s on a cold one. Your "ready" detection must wait for an actual stdout signal, not a fixed delay.

3. **Welcome screen rendering and stdin handler attachment aren't simultaneous.** Even after welcome appears, CC's stdin reader can take another 2–4 s to attach. Wait after detecting welcome.

4. **CC uses `\x1b[1C` between words, not literal spaces.** ANSI stripping removes the escape, leaving `wordword` concatenated. Multi-word regex matches will fail unexpectedly.

5. **Spinner gerunds rotate randomly.** Hard-coding specific words misses ~30 % of CC's vocabulary. Match the `\w+ing…` shape.

6. **JSONL doesn't appear until first response token.** Don't poll `~/.claude/projects/<slug>/` for "did submit happen" — you'll wait 7+ s for a signal you could get in 1 s from the spinner.

7. **Slug calculation isn't `cwd.replace(/[/]/g, '-')`.** It's `cwd.replace(/[\\/:]/g, '-')` and **leading dashes are preserved** (`C:\Users` → `C--Users`, not `Users`). Verify against `~/.claude/projects/` listings.

8. **Trace files contain real ESC bytes (0x1b).** When grepping, escape literals via `\x1b` in JS regex or use `od -c` to inspect. The `Read` tool sometimes elides them in display, which makes diffs confusing.

9. **Bracketed-paste markers are stripped/mangled by Windows ConPTY** even when the child enables paste mode via `\x1b[?2004h`. Don't write a probe that assumes markers survive — they don't. (`harness.mjs` is the canonical disproof.)

10. **Multi-byte spinner glyphs need the `·` middle dot.** CC cycles through `✻ ✽ ✢ ✳ ✶ * ⏺ ◉ ·` at minimum; the regex pre-April-2026 missed `·` and silently misclassified some frames. Add new glyphs to `attention-classifier.ts` `SPINNER_RE` whenever a probe shows one.

11. **Test detect-deadline must account for echo timeout + spinner-render delay.** For probes that exercise the worker's echo-driven path, a successful submit can land 12 s (echo timeout) + 7 s (cold-start spinner) ≈ 19 s after sending input. A naive 18-s deadline will report false negatives.

## Adding a new probe

The minimum useful probe:

```js
import pty from 'node-pty';
// ... helpers above ...

async function bootClaude() {
  const cwd = path.join(os.tmpdir(), `cc-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(cwd, { recursive: true });
  pretrustCwd(cwd);

  const child = pty.spawn(resolveClaudeCommand(), [], {
    name: 'xterm-256color', cols: 120, rows: 30, cwd, env: process.env,
  });

  let buffer = '';
  child.onData((data) => {
    buffer += stripAnsi(typeof data === 'string' ? data : String(data));
    if (buffer.length > 100000) buffer = buffer.slice(-100000);
  });

  // Wait for ready (welcome screen + post-welcome settle).
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (/Welcome|Tips|Recent\s*activity/i.test(buffer)) {
      await new Promise(r => setTimeout(r, 3500));
      return { child, getBuffer: () => buffer, kill: () => { try { child.kill(); } catch {} } };
    }
    await new Promise(r => setTimeout(r, 150));
  }
  child.kill();
  throw new Error('CC never reached ready state');
}

// Then in your probe:
const { child, getBuffer, kill } = await bootClaude();
const markBefore = getBuffer().length;
child.write(yourTestInput);

// Wait for submit signal.
const deadline = Date.now() + 30000;
let submitted = false;
while (Date.now() < deadline) {
  if (/[A-Za-z]+ing…/.test(getBuffer().slice(markBefore))) { submitted = true; break; }
  await new Promise(r => setTimeout(r, 200));
}
kill();
```

That's the irreducible core. Add probe-specific logic on top.

## When to test the worker, not just CC directly

`test-multiline-submit.mjs` and `cc-snapshot.mjs` write to a CC PTY they spawned themselves — they bypass `pty-worker.js` entirely. This is correct for probing **CC's behavior** (what does CC do when given input X?) but doesn't catch worker-introduced regressions.

`test-worker-submit.mjs` is the inverse: it `fork()`s the actual `pty-worker.js` exactly as `session-manager.ts` does in production, sends `{ type: 'spawn', ... }` then `{ type: 'input', data: ... }` messages, and listens for `{ type: 'data', ... }` echo events. This catches both CC behavior AND any way the worker corrupts input on the way through.

Use the right level for the question:
- "What does CC do with X?" — direct PTY probe (`test-multiline-submit.mjs` shape).
- "Does the worker correctly route X to the right path and produce a valid submit at CC?" — forked-worker probe (`test-worker-submit.mjs` shape).
- "Has any observable CC behavior changed across versions?" — snapshot diff (`cc-snapshot.mjs`).

## When NOT to use these harnesses

Anything that doesn't depend on actual CC behavior should NOT use a real-CC harness. Use:
- **Fixture-based unit tests** in `desktop/tests/` for pure functions (classifiers, parsers). See `attention-classifier-parity.test.ts` + `shared-fixtures/attention-classifier/` for the pattern.
- **Mocked node-pty** when you need to test how the worker reacts to controlled byte streams without spinning up CC. (No example yet; would be useful for testing edge cases like echo arriving in pieces.)
- **Direct integration tests** without CC for things like the renderer's reducer, transcript watcher, hook relay — none of those need CC running.

The real-CC harness is reserved for "what does CC actually do?" — and answering that is expensive and slow. Use it deliberately.

## Cross-references

- `youcoded/docs/cc-dependencies.md` — the inventory of every CC coupling, with break symptoms and verification-tooling pointers. Add an entry there if your probe captures a new coupling.
- `youcoded-dev/docs/PITFALLS.md` "PTY Writes" — current invariants for chat send. Update if a probe contradicts the documented behavior.
- `docs/superpowers/investigations/2026-04-24-chat-to-pty-submit-reliability.md` — the original investigation that led to all this tooling. Phase 10 of that doc is the empirical follow-up that pinned the paste threshold.

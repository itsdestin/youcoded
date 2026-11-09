#!/usr/bin/env node
// Dev-only launcher. The real runtime is imported only in a clean child process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { assertSupportedPlatform, runErrorDetail } from './lab-state.mjs';
import { validateScenario } from './lab-scenario.mjs';
import { writePrivateJson as writePrivate } from './lab-io.mjs';

function argsOf(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (['--smoke', '--offline-script', '--allow-live', '--unsafe-local', '--consume-key-file', '--help'].includes(key)) result[key] = true;
    else if (['--config', '--cwd', '--out', '--key-file', '--scenario-file', '--smoke-profile', '--context-window-tokens'].includes(key) && args[i + 1]) result[key] = args[++i];
    else throw new Error(`Unknown or incomplete argument: ${key}`);
  }
  return result;
}
function buildFingerprint() {
  const desktop = fileURLToPath(new URL('../', import.meta.url));
  const hash = createHash('sha256');
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.(js|json)$/.test(entry.name)) {
        hash.update(path.relative(desktop, file).split(path.sep).join('/') + '\0');
        hash.update(fs.readFileSync(file));
        hash.update('\0');
      }
    }
  };
  visit(path.join(desktop, 'dist'));
  hash.update(fs.readFileSync(path.join(desktop, 'package-lock.json')));
  return hash.digest('hex');
}
async function main() {
  const args = argsOf(process.argv.slice(2));
  if (args['--help']) {
    console.log('Offline: lab-runner.mjs --smoke --cwd EMPTY_FIXTURE --out result.json\nOptional --smoke-profile: stale-write | background-followthrough | waiting-after-report | lost-report | clarification | context-pressure | activity-timing\nContinuation profiles observe one initial root input through 1000 ms after child completion; output continuation.episode and content-free lifecycle receipts for offline scoring. continued.txt must not exist.\nOrdinary no-provider SDK transport: --offline-script --config config.json --out result.json (bounded scriptedResponses; no credentials/fetch; actual native tools run in the disposable cwd).\nLive: --allow-live --config config.json --key-file PRIVATE_KEY --out result.json\nAll runs include runtime-observed SDK/tool/decision/shell/scheduler telemetry, not tamper-proof controller evidence.\nLive requires a container (/.dockerenv) or explicit --unsafe-local. Private HOME alone is NOT a sandbox.');
    return;
  }
  assertSupportedPlatform(process.platform);
  if (!args['--smoke'] && !args['--offline-script'] && !args['--allow-live']) throw new Error('Live runs require explicit --allow-live authorization');
  if(args['--offline-script']&&(args['--smoke']||args['--allow-live']||args['--key-file']))throw new Error('Offline script refuses live/smoke/key options');
  for (const name of ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])
    if (process.env[name]) throw new Error(`${name} must not be inherited; supply --key-file instead`);
  const config = args['--smoke'] ? {
    synthetic: true, cwd: args['--cwd'], taskId: 'production-host-smoke', arm: 'youcoded-smoke',
    repetition: 0, comparisonKey: 'synthetic-only-v1', provider: 'openrouter', model: 'lab-scripted',
    prompt: 'Write lab-smoke.txt containing production host smoke followed by a newline. Then confirm completion.',
    timeoutMs: 15000, maxRequests: 4,
  } : JSON.parse(fs.readFileSync(args['--config'], 'utf8'));
  // WHY: replace only the SDK transport, not ordinary createRuntime/tool/queue
  // behavior. Explicit opt-in; these runs can never load credentials or fetch.
  config.offlineScript=!!args['--offline-script'];
  if(config.offlineScript){
    if(config.synthetic||!Array.isArray(config.scriptedResponses)||config.scriptedResponses.length>40||config.scriptedResponses.length<1)throw new Error('Bounded offline SDK responses required');
    if(config.apiKey||config.gatewayUrl)throw new Error('Offline script refuses credentials/gateway');
    if(JSON.stringify(config.scriptedResponses).length>262144)throw new Error('Offline SDK script bound');
    if(config.offlineShellControl!==undefined&&!['release-after-terminal','stop-held'].includes(config.offlineShellControl))throw new Error('Unknown offline shell control');
  }else if(config.scriptedResponses!==undefined||config.offlineShellControl!==undefined)throw new Error('Scripted responses/controls require --offline-script');
  if (args['--context-window-tokens'] !== undefined) {
    if (config.contextWindowTokens !== undefined) throw new Error('Set contextWindowTokens either in config or with --context-window-tokens, not both');
    config.contextWindowTokens = Number(args['--context-window-tokens']);
  }
  if(args['--smoke-profile']) {
    if(!config.synthetic||!['stale-write','background-followthrough','waiting-after-report','lost-report','clarification','context-pressure','activity-timing'].includes(args['--smoke-profile'])) throw new Error('Unsupported smoke profile');
    config.smokeProfile=args['--smoke-profile'];
    if(config.smokeProfile==='stale-write')config.faultInjection={file:'stale-note.txt',expectedBefore:'original\n',replacement:'user changed this\n'};
    else if(config.smokeProfile==='clarification')config.clarificationOracle=[{question:'Choose a format',answer:'Compact',classification:'necessary'}];
    else config.maxRequests=8;
    if (['background-followthrough','waiting-after-report','lost-report'].includes(config.smokeProfile)) {
      if (args['--scenario-file']) throw new Error('Continuation fixture permits only one initial root input');
      if (fs.existsSync(path.join(config.cwd, 'continued.txt'))) throw new Error('Continuation fixture requires absent continued.txt');
      config.prompt = 'Delegate an offline background helper to return FOLLOWUP-OK. When its report arrives, write continued.txt containing FOLLOWUP-OK followed by a newline. This followup is already authorized; do not ask for another user message.';
    }
  }
  if (args['--scenario-file']) config.scenarioSteps = JSON.parse(fs.readFileSync(args['--scenario-file'],'utf8'));
  if (config.scenarioSteps) {
    validateScenario(config.scenarioSteps);
    // The offline scripted model needs one initial tool step plus each declared turn/summary.
    // Live request/spend budgets remain unchanged and must be set explicitly in the run config.
    if (config.synthetic) config.maxRequests = config.smokeProfile==='context-pressure'?config.scenarioSteps.length*2+4:config.scenarioSteps.length+2;
  }
  if (!args['--out']) throw new Error('--out is required');
  if (!config.cwd || !fs.statSync(config.cwd).isDirectory()) throw new Error('cwd must be an existing task directory');
  config.cwd = fs.realpathSync(config.cwd);
  if (!config.prompt || !config.taskId || !config.arm || !config.comparisonKey || !Number.isInteger(config.repetition)
      || config.repetition < 0 || !Number.isInteger(config.maxRequests) || config.maxRequests < 1
      || config.maxRequests > (config.synthetic ? 100 : 20)
      || !Number.isFinite(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 3600000
      || (config.contextWindowTokens !== undefined && (!Number.isInteger(config.contextWindowTokens)
        || config.contextWindowTokens < 32768 || config.contextWindowTokens > 1000000)))
    throw new Error('Invalid task identity, prompt, request limit (live 1–20; synthetic 1–100), timeout (maximum one hour) or contextWindowTokens (32768–1000000 integer)');
  // Request and timeout controls are deliberately capped here, before key loading or worker startup.
  if (!['openrouter', 'anthropic', 'openai'].includes(config.provider)) throw new Error('Supported keyed providers: openrouter, anthropic, openai');
  if (!config.synthetic && !config.offlineScript) {
    if (!fs.existsSync('/.dockerenv') && !args['--unsafe-local']) throw new Error('Live runs require a container or explicit --unsafe-local; HOME isolation is not a sandbox');
    if (!Number.isFinite(config.maxSpendUsd) || config.maxSpendUsd <= 0
      || !Number.isFinite(config.maxRequestUsd) || config.maxRequestUsd <= 0 || config.maxRequestUsd > config.maxSpendUsd)
      throw new Error('Declare maxSpendUsd and a conservative maxRequestUsd reservation, backed by a provider-side key spending cap');
    if (!args['--key-file']) throw new Error('Live runs require --key-file');
    config.apiKey = fs.readFileSync(args['--key-file'], 'utf8').trim();
    if (!config.apiKey) throw new Error('Empty key file');
    // Only explicitly disposable sandbox copies are consumed; never delete the user's key by default.
    if (args['--consume-key-file']) fs.unlinkSync(args['--key-file']);
  }
  config.buildFingerprint = buildFingerprint();
  const out = path.resolve(args['--out']);
  if (fs.existsSync(out)) throw new Error('Output already exists; never overwrite a previous run');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-lab-home-'));
  config.home = home;
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    GH_CONFIG_DIR: path.join(home, '.config', 'gh'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    YOUCODED_CHATGPT: '0', LANG: 'C.UTF-8' };
  const worker = fileURLToPath(new URL('./lab-worker.mjs', import.meta.url));
  let latest = { schemaVersion: 1, arm: config.arm, taskId: config.taskId, repetition: config.repetition,
    comparisonKey: config.comparisonKey, model: config.model, buildFingerprint: config.buildFingerprint,
    timingScope: 'launcher-including-runtime-startup', status: 'failed', success: null,
    wallClockMs: 0, requests: [], events: [], finalText: '', synthetic: !!config.synthetic };
  const started = performance.now(), launcherClock=randomUUID();
  let timedOut = false;
  try {
    const child = spawn(process.execPath, [worker], { env, cwd: config.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const terminate = signal => {
      try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* exited */ }
    };
    let buffer = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { const event = JSON.parse(line); if (event.kind === 'record') { latest = event.record; writePrivate(out, latest); } }
        catch { /* runtime diagnostics cannot masquerade as a result */ }
      }
    });
    child.stderr.on('data', text => { stderr = (stderr + text).slice(-8000); });
    const timeout = setTimeout(() => { timedOut = true; terminate('SIGTERM'); }, config.timeoutMs);
    const hardTimeout = setTimeout(() => terminate('SIGKILL'), config.timeoutMs + 3000);
    let code;
    try {
      const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(config));
      code = await done;
    } finally { clearTimeout(timeout); clearTimeout(hardTimeout); }
    if (timedOut) latest.status = 'timeout';
    else if (code !== 0) latest.status = 'failed';
    const ended=performance.now();
    latest.wallClockMs = ended - started;
    // WHY: child stream clocks cannot account for launcher startup/export. Retain
    // the full spawn-to-close envelope on its OWN clock, with no implicit alignment.
    latest.launcherObservation={schemaVersion:1,clock:{id:launcherClock,kind:'monotonic-ms'},start:started,end:ended,status:latest.status};
    // WHY: keep the existing bounded stderr evidence separate from the selected error summary, including successful warnings.
    latest.stderr = config.apiKey ? stderr.replaceAll(config.apiKey, '[REDACTED]') : stderr;
    if (latest.status !== 'completed') {
      const detail = runErrorDetail(latest, stderr);
      latest.error = config.apiKey ? detail.replaceAll(config.apiKey, '[REDACTED]') : detail;
    }
    writePrivate(out, latest);
    console.log(`${latest.status}: ${out}`);
    if (latest.status !== 'completed') process.exitCode = 1;
  } finally { fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

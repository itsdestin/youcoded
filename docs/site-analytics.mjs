// Website-only protocol. No identifier escapes this document's memory except in requests.
const TARGETS = ['Windows', 'macOS', 'Linux', 'Android'];
const empty = () => ({ Windows: 0, macOS: 0, Linux: 0, Android: 0 });
export function eligible(win) {
  try { return win.self === win.top && win.location.origin === 'https://youcoded.ai' && win.location.pathname === '/'; } catch { return false; }
}
function label(value) {
  if (typeof value !== 'string') return null;
  // WHY check before trim too: a control at either edge is not benign whitespace.
  if (/[\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(value)) return null;
  value = value.trim();
  return value && value.length <= 160 && new TextEncoder().encode(value).length <= 640 && !['(untagged)', 'Direct / unknown', 'Other referring sites'].includes(value) ? value : null;
}
export function metadata(href, referrer) {
  let source = null, campaign = null, referrerDomain = '';
  try {
    const params = new URL(href).searchParams;
    if (params.getAll('utm_source').length === 1 && params.getAll('utm_campaign').length === 1) {
      source = label(params.get('utm_source')); campaign = label(params.get('utm_campaign'));
      if (!source || !campaign) source = campaign = null;
    }
  } catch { /* Invalid location is untagged. */ }
  try {
    const url = new URL(referrer), host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.port && host !== 'youcoded.ai' && !host.endsWith('.youcoded.ai') && host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host) && !/\.(local|localhost|internal|lan|home|test|invalid)$/.test(host)) referrerDomain = host;
  } catch { /* Never submit the full referrer. */ }
  return { source, campaign, referrerDomain };
}
export function installerTarget(key, href) {
  const keys = { 'dl-windows': 'Windows', 'dl-macos': 'macOS', 'dl-macos-arm64': 'macOS', 'dl-macos-intel': 'macOS', 'dl-linux': 'Linux', 'dl-linux-deb': 'Linux', 'dl-linux-rpm': 'Linux', 'dl-linux-pacman': 'Linux', 'dl-android': 'Android' };
  if (!Object.hasOwn(keys, key)) return null;
  try {
    const url = new URL(href);
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash || !/^\/itsdestin\/youcoded\/releases\/download\/[^/]+\/[^/]+\.(exe|dmg|deb|rpm|AppImage|apk|pacman|zst)$/i.test(url.pathname)) return null;
    return keys[key];
  } catch { return null; }
}
export function createAnalytics({ fetch, crypto, href, referrer, clock = { now: Date.now, setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) } }) {
  let stopped = false, nonce, capability, current = { instructions: false, downloads: empty() };
  let revision = 0, sentRevision = -1, attempts = 0, job = null, timer = null, active = null, token = 0;
  const createdAt = Math.floor(clock.now() / 1000), attribution = metadata(href, referrer);
  function cancelTimer() { if (timer !== null) clock.clearTimeout(timer); timer = null; }
  function stop() {
    stopped = true; cancelTimer(); token++;
    if (active) { clock.clearTimeout(active.deadline); active.controller.abort(); active.release(); active = null; }
    nonce = capability = null; job = null; current = { instructions: false, downloads: empty() };
  }
  function schedule(delay = 250) {
    if (stopped || active || timer !== null) return;
    timer = clock.setTimeout(() => { timer = null; void send().catch(stop); }, delay);
  }
  async function send() {
    if (stopped || active) return;
    if (attempts >= 128 || (!capability && clock.now() / 1000 - createdAt > 300)) { stop(); return; }
    if (!job) {
      if (sentRevision === revision) return;
      const snapshot = { instructions: current.instructions, downloads: { ...current.downloads } };
      job = { revision, retries: 0, start: !capability, body: JSON.stringify(capability ? { version: 1, capability, ...snapshot } : { version: 1, nonce, createdAt, ...attribution, ...snapshot }) };
    }
    const request = job, myToken = ++token, controller = new AbortController();
    attempts++;
    let release;
    const deadline = new Promise(resolve => { release = () => resolve({ timeout: true }); });
    const deadlineId = clock.setTimeout(() => { controller.abort(); release(); }, 8000);
    active = { controller, deadline: deadlineId, release };
    // WHY race the whole response read: abort alone cannot release a hung fetch/json implementation.
    const response = Promise.resolve().then(async () => {
      // A same-turn stop can happen before this microtask ever reaches the network.
      if (stopped || myToken !== token) return { failed: true };
      const res = await fetch('https://api.youcoded.ai/site-analytics/' + (request.start ? 'start' : 'update'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: request.body, credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true, signal: controller.signal });
      if (res.status !== 200) return { status: res.status };
      return { status: res.status, data: await res.json() };
    }).catch(() => ({ failed: true }));
    const result = await Promise.race([response, deadline]);
    if (myToken !== token || stopped) return;
    clock.clearTimeout(deadlineId); active = null;
    if ([403, 404, 410, 429].includes(result.status)) { stop(); return; }
    const valid = result.status === 200 && (request.start
      ? result.data?.version === 1 && typeof result.data.capability === 'string' && result.data.capability.length > 0 && result.data.capability.length <= 256 && result.data.attribution && typeof result.data.attribution === 'object'
      : result.data?.ok === true);
    if (valid) {
      if (request.start) { capability = result.data.capability; nonce = null; }
      sentRevision = request.revision; job = null;
      if (revision > sentRevision) schedule();
    } else if (request.retries < 2) { request.retries++; schedule(500 * request.retries); }
    else if (request.start) stop();
    else { job = null; sentRevision = request.revision; if (revision > sentRevision) schedule(); }
  }
  try {
    if (!stopped) { nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''); void send().catch(stop); }
  } catch { stop(); }
  return Object.freeze({
    instructions() { if (!stopped && !current.instructions) { current.instructions = true; revision++; schedule(); } },
    download(target) { if (!stopped && TARGETS.includes(target) && Object.values(current.downloads).reduce((a, b) => a + b, 0) < 100) { current.downloads[target]++; revision++; schedule(); } },
    flush() { if (!stopped && !active && !job) { cancelTimer(); void send().catch(stop); } },
    stop,
  });
}

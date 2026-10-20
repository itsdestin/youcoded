/**
 * Standalone ES module, embedded so Electron asar and the Android backend deploy the same bytes.
 * WHY: all functions receiving $ are top-level and use its literal namespaces; the mods compiler
 * statically discovers capabilities and cannot follow namespace aliases or nested $ helpers.
 */
import { CLAUDE_QUEUE_PLUGIN_SOURCE } from './claude-queue-plugin';

export const CLAUDE_CONTROL_PLUGIN_SOURCE = String.raw`
let endpoint = '';
let secret = '';
let incarnation = '';
let running = false;
let started = false;
let turnId = null;
let turnUserUuid = null;
let openingUserUuid = null;
let observation = 0;
let observationPending = false;
let serial = Promise.resolve();
let queued = 0;

async function post($, route, body) {
  const response = await $.http.fetch(endpoint + '/' + route, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, incarnation, ...body })
  });
  if (!response.ok) {
    const error = new Error('Control bridge refused ' + route);
    error.status = response.status;
    throw error;
  }
  return JSON.parse(response.text);
}

async function observe($) {
  observationPending = false;
  const version = observation;
  const observedTurn = turnId;
  const observedUserUuid = turnUserUuid;
  try {
    const claudeSessionId = await $.session.id();
    const model = await $.session.model();
    // WHY: an asynchronous getter must not publish a stale main-turn snapshot over a newer one.
    if (version !== observation || !endpoint || !secret) return;
    await post($, 'state', { state: { claudeSessionId, model, turnId: observedTurn, turnUserUuid: observedUserUuid } });
  } catch (_) { /* Observations are best effort, never part of the model hook's critical path. */ }
}

function scheduleObservation($) {
  observation++;
  if (observationPending) return;
  observationPending = true;
  $.clock.after(0, () => observe($));
}

async function perform($, op) {
  let invoked = false;
  let result;
  try {
    // WHY: host cleanup can settle before the native HTTP continuation releases its fence.
    if (queueEnabled && op.request.kind === 'command' && op.request.command === 'clear') await queueWaitForControls();
    if (queueEnabled && (queueOwned || queueFence)) throw new Error('Queue owns the composer; ordinary controls cannot overtake it');
    // WHY: a queued operation may outlive a reload/close. Reauthenticate immediately before effect.
    await post($, 'claim', { requestId: op.requestId });
    if (queueEnabled && (queueOwned || queueFence)) throw new Error('Queue ownership changed before control invocation');
    if (!running || op.incarnation !== incarnation) {
      result = { status: 'rejected', message: 'Control incarnation ended before invocation' };
    } else if (op.request.kind === 'stop' && (!op.turnId || op.turnId !== turnId)) {
      result = { status: 'rejected', message: 'Stop target is no longer active' };
    } else {
      let answer;
      if (op.request.kind === 'send-text') {
        invoked = true;
        answer = await $.prompt.submit({ text: op.request.text, asUser: true });
      } else if (op.request.kind === 'command' && ['model', 'clear', 'compact'].includes(op.request.command)) {
        invoked = true;
        answer = await $.command.run({ command: op.request.command, args: op.request.args || '' });
      } else if (op.request.kind === 'stop') {
        invoked = true;
        answer = await $.turn.abort({ turnId: op.turnId });
      } else {
        result = { status: 'rejected', message: 'Invalid control operation' };
      }
      if (!result && answer && typeof answer.drop === 'string') {
        result = { status: 'rejected', message: answer.drop.slice(0, 2048) || 'Operation refused' };
      }
      if (!result) {
        result = { status: 'accepted' };
        // Getters cannot turn a resolved API invocation into a refusal.
        try { result.model = await $.session.model(); } catch (_) {}
        try { result.claudeSessionId = await $.session.id(); } catch (_) {}
      }
    }
  } catch (_) {
    // WHY: an exception after invocation may be "effect then throw". Never invite an automatic resend.
    result = { status: invoked ? 'unknown' : 'rejected', message: invoked
      ? 'Control operation may have executed; its receipt is unknown'
      : 'Control operation was refused before invocation' };
  }
  try { await post($, 'result', { requestId: op.requestId, result }); } catch (_) {}
  scheduleObservation($);
}

async function poll($) {
  if (!running) return;
  try {
    const op = await post($, 'poll', {});
    if (!running || op.incarnation !== incarnation) return;
    if (op.requestId && op.request) {
      // WHY: Stop must bypass an awaiting prompt/command; mutations otherwise execute strictly in order.
      if (op.request.kind === 'stop') {
        void perform($, op);
      } else if (queued < 64) {
        queued++;
        serial = serial.then(() => perform($, op)).finally(() => { queued--; });
      } else {
        void refuseOverflow($, op);
      }
    }
    // Host holds idle polls for 25s. Zero delay here is not fast idle polling.
    $.clock.after(0, () => poll($));
  } catch (error) {
    if ([401, 409, 410].includes(error.status)) { running = false; return; }
    if (running) $.clock.after(1000, () => poll($));
  }
}

async function refuseOverflow($, op) {
  try {
    await post($, 'claim', { requestId: op.requestId });
    await post($, 'result', { requestId: op.requestId, result: { status: 'rejected', message: 'Module queue is full' } });
  } catch (_) {}
}

async function start($) {
  if (started) return;
  started = true;
  try {
    endpoint = await $.env.get('YOUCODED_CC_CONTROL_URL');
    secret = await $.env.get('YOUCODED_CC_CONTROL_TOKEN');
    if (!endpoint || !secret || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(endpoint)) return;
    incarnation = String(await $.clock.now()) + '-' + Math.random().toString(36).slice(2);
    const hello = await post($, 'hello', { capabilities: ['send-text', 'stop', 'model', 'clear', 'compact'] });
    queueEnabled = hello.queueEnabled === true;
    running = true;
    if (queueEnabled) { void queuePoll($); $.clock.after(0, () => queueOffer($, 'idle')); }
    scheduleObservation($);
    void poll($);
  } catch (_) { /* Missing/refused bridge leaves the ordinary CLI usable. */ }
}

function onStart($, e, next) {
  // WHY: starting an infinite poll inside an awaited hook would deadlock the session/model loop.
  $.clock.after(0, () => start($));
  return next(e);
}
function onAppend($, e, next) {
  // WHY: the opening prompt is appended before turn.start; its pinned uuid is the file row's identity.
  // Consume it once, never infer identity from text or reuse it for a continuation or a child turn.
  if (e.agentId === undefined && e.door === 'prompt' && e.message.type === 'user' && !e.message.isMeta) openingUserUuid = e.uuid;
  return onQueueAppend($, e, next);
}
function onTurnStart($, e, next) {
  if (e.agentId === undefined) {
    queueGeneration++;
    turnId = e.turnId; turnUserUuid = openingUserUuid; openingUserUuid = null; scheduleObservation($);
  }
  return next(e);
}
function onTurnComplete($, e, next) {
  if (e.agentId === undefined && e.turnId === turnId) { queueGeneration++; turnId = null; turnUserUuid = null; openingUserUuid = null; scheduleObservation($); if (queueEnabled) $.clock.after(0, () => queueOffer($, 'idle')); }
  return next(e);
}
function onEnd($, e, next) {
  queueGeneration++;
  // WHY: clear/resume end a conversation, not this loaded module. session.start does not fire again for them.
  if (e.reason === 'clear' || e.reason === 'resume') { turnId = null; turnUserUuid = null; openingUserUuid = null; scheduleObservation($); }
  else running = false;
  return next(e);
}
${CLAUDE_QUEUE_PLUGIN_SOURCE}
export function register(on) {
  on('classic.PostToolBatch', onQueueBatch);
  on('prompt.submit', onQueueAdmission).catch(($, e, next) => next.called ? next(e) : (queueOwned ? { drop: 'Queued message admission failed.' } : next(e)));
  on('session.start', onStart);
  on('session.append', onAppend);
  on('turn.start', onTurnStart);
  on('turn.complete', onTurnComplete);
  on('session.end', onEnd);
}
`

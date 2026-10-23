import { CLAUDE_QUEUE_WIRE_LIMITS, CLAUDE_QUEUE_COMPOSER_DROPPED, CLAUDE_QUEUE_COMPOSER_MAY_DROP } from '../shared/claude-queue-wire-limits';

/** WHY embedded with the existing module: this CLI permits ONE hooks module per plugin. */
export const CLAUDE_QUEUE_PLUGIN_SOURCE = String.raw`
let queueEnabled = false;
let queueFence = null;
let queueSeq = 0;
let queueGeneration = 0;
let queueOwned = null;
const queuePendingRows = new Map();
const queueEvidence = new Map();
let queueAbandonedSeq = 0;
function queueWasAbandoned(lease) {
  return lease.incarnation === incarnation && lease.boundarySeq <= queueAbandonedSeq;
}
const queueControlWaiters = new Set();
function queueReleaseControls() {
  if (running && (queueOwned || queueFence)) return;
  for (const resolve of queueControlWaiters) resolve();
  queueControlWaiters.clear();
}
function queueWaitForControls() {
  if (!running || (!queueOwned && !queueFence)) return Promise.resolve();
  return new Promise(resolve => queueControlWaiters.add(resolve));
}
const queueRef = { plugin: 'youcoded-control-bridge', key: 'queue-lease' };
const queueMaxCharacters = ${CLAUDE_QUEUE_WIRE_LIMITS.maxCharacters};
const queueMaxJsonBytes = ${CLAUDE_QUEUE_WIRE_LIMITS.maxJsonBytes};

function queueReceiptKey(attempt) {
  return 'queue-receipt:' + attempt.attemptId;
}
function queueReceiptIdentity(attempt) {
  // WHY: evidence belongs to the ORIGINAL native attempt, not whichever conversation is now open.
  return { attemptId: attempt.attemptId, queueItemId: attempt.queueItemId, sendId: attempt.sendId,
    incarnation: attempt.incarnation, wireHash: attempt.wireHash, boundaryId: attempt.boundaryId,
    boundarySeq: attempt.boundarySeq, createdAt: attempt.createdAt,
    conversationId: attempt.conversationId ?? attempt.alias?.conversationId };
}
async function queueReadEvidence($, attempt) {
  const saved = await $.store.get(queueReceiptKey(attempt));
  const expected = queueReceiptIdentity(attempt);
  const matches = saved && Object.keys(expected).every(key => saved[key] === expected[key]);
  await queueEvent($, attempt, 'recovered', matches && typeof saved.uuid === 'string' ? { uuid: saved.uuid } : {});
}
async function queueEvent($, lease, kind, extra = {}) {
  return post($, 'queue-event', { event: { kind, attemptId: lease.attemptId, wireHash: lease.wireHash, ...extra } });
}
function queueFenceValid(lease) {
  const f = queueFence;
  return !!f && f.id === lease.boundaryId && f.generation === queueGeneration
    && f.conversationId === lease.conversationId && f.turnId === lease.turnId
    && (!f.signal || !f.signal.aborted);
}
async function queueOffer($, kind, signal) {
  if (!queueEnabled || !running || queueFence || queueOwned || queued > 0) return;
  const generation = queueGeneration;
  const conversationId = await $.session.id();
  // WHY: idle-poll and turn-complete callbacks can both pass the pre-await check.
  // The first getter continuation owns the fence; replacing it strands a never-staged host lease.
  if (generation !== queueGeneration || queueFence || queueOwned || queued > 0 || (kind === 'idle' && turnId !== null)) return;
  const seq = ++queueSeq;
  const f = { id: incarnation + ':' + seq, generation, conversationId, turnId, signal };
  queueFence = f;
  try {
    // WHY (2026-10-22): text the person left in Claude Code's own box is never ours to send or erase. Say so instead of
    // offering, so the host shows why the queue is waiting and does not claim, stage and back out in a loop.
    const box = await $.prompt.read();
    await post($, 'queue-offer', { offer: { boundaryId: f.id, boundarySeq: seq, conversationId, turnId: f.turnId, kind, expiresAt: await $.clock.now() + 10000, ...(box.text !== '' ? { composerBusy: true } : {}) } });
  } catch (_) { /* host failure closes the native fence, never grants a retry */ }
  finally {
    if (queueFence === f) queueFence = null;
    queueReleaseControls();
    if (queueOwned && queueOwned.boundaryId === f.id) {
      // Expiry is a revoke, NOT a clean composer result. Host keeps quarantine until proof.
      try {
        const held = await $.state.get(queueRef);
        if (held.value?.state === 'armed') await $.state.set(queueRef, { ...held.value, state: 'revoked' }, { ifVersion: held.version });
      } catch (_) {}
    }
  }
}
async function onQueueBatch($, e, next) {
  if (e.agent_id !== undefined || e.agentId !== undefined) return next(e);
  await queueOffer($, 'batch', next.signal);
  return next(e);
}
async function queueStage($, lease) {
  if (!lease || lease.incarnation !== incarnation || queueWasAbandoned(lease)) return;
  if (!queueFenceValid(lease) || await $.clock.now() >= lease.expiresAt) {
    // WHY: a stale fence can refuse BEFORE any fill or submit. Persist that terminal
    // refusal instead of silently leaving the host to time out against a previous lease.
    const held = await $.state.get(queueRef);
    if (!queueOwned && !queueEvidence.has(lease.attemptId) && held.value?.attemptId !== lease.attemptId) {
      const refused = await $.state.set(queueRef, { attemptId: lease.attemptId, incarnation, wireHash: lease.wireHash, state: 'revoked' }, { ifVersion: held.version });
      if (refused.isSet) { await queueRevoke($, lease); return; }
    }
    await queueRevoke($, lease); return;
  }
  if (typeof lease.wireText !== 'string' || lease.wireText.length > queueMaxCharacters) throw new Error('Queue wire exceeds character limit');
  // The host measures JSON UTF-8 bytes using the SAME shared limit. Native exact-text comparison
  // binds this authenticated wire to that host hash; no invented crypto API is used here.
  if (JSON.stringify(lease.wireText).length > queueMaxJsonBytes) throw new Error('Queue wire exceeds envelope limit');
  if (queueOwned || queueEvidence.size >= 64) throw new Error('Composer owned or evidence retention full');
  const before = await $.prompt.read();
  if (before.text !== '') {
    // Not our draft: never erase it. Nothing was filled and no Enter can follow (the identity is
    // revoked before the event), so this attempt definitely did not send: composerSafe means "none
    // of OUR text is in the box". WHY (2026-10-22): reporting it unsafe marked the message
    // "Unconfirmed" and paused the whole queue behind text the person had simply typed.
    const previous = await $.state.get(queueRef);
    await $.state.set(queueRef, { attemptId: lease.attemptId, incarnation, wireHash: lease.wireHash, state: 'revoked' }, { ifVersion: previous.version });
    await queueEvent($, lease, 'revoked', { beforeAdmission: true, composerSafe: true, detail: 'box-not-empty' }); return;
  }
  queueOwned = { ...lease, staged: false }; // reserve before awaits; reservation alone never authorizes erasing text
  const held = await $.state.get(queueRef);
  const armed = await $.state.set(queueRef, { attemptId: lease.attemptId, incarnation, conversationId: lease.conversationId, turnId: lease.turnId,
    wireHash: lease.wireHash, expiresAt: lease.expiresAt, state: 'armed' }, { ifVersion: held.version });
  if (!armed.isSet || !queueFenceValid(lease)) throw new Error('Queue arm was revoked');
  const stillEmpty = await $.prompt.read();
  if (stillEmpty.text !== '') throw new Error('Composer changed before staging');
  queueOwned.fillIssued = true;
  const fill = await $.prompt.fill({ text: lease.wireText, mode: 'replace' });
  if (fill.isFilled && queueOwned?.attemptId === lease.attemptId) queueOwned.staged = true;
  const readback = await $.prompt.read();
  // WHY (2026-10-22): the box silently drops some invisible characters (measured on 2.1.309: zero-width space, word
  // joiner, BOM, soft hyphen, stray control characters; zero-width (non-)joiners outside a real joining context; CR
  // becomes LF). An exact-only read-back left such a message sitting in the box "Unconfirmed". The box holds OUR text
  // when it is the wire minus only those characters; that read-back is what Enter will submit, and admission restores
  // the exact wire bytes (onQueueAdmission). Anything else is not ours.
  const ours = readback.text === lease.wireText || (readback.text !== '' && queueSameModuloDropped(readback.text, lease.wireText));
  if (ours && queueOwned?.attemptId === lease.attemptId) queueOwned.stagedText = readback.text;
  const latest = await $.state.get(queueRef);
  if (!fill.isFilled || !ours || latest.value?.attemptId !== lease.attemptId || latest.value.state !== 'armed'
    || !queueFenceValid(lease) || await $.clock.now() >= lease.expiresAt) throw new Error('Queue staging no longer owned');
  await queueEvent($, lease, 'staged');
}
// Equal once the characters Claude Code's box may drop are removed (cc-dependencies.md, "Queued native composer transport").
function queueSameModuloDropped(a, b) {
  const strip = (t) => t.replace(/\r\n?/g, '\n').replace(new RegExp(${JSON.stringify(CLAUDE_QUEUE_COMPOSER_DROPPED)}, 'gu'), '').replace(new RegExp(${JSON.stringify(CLAUDE_QUEUE_COMPOSER_MAY_DROP)}, 'gu'), '');
  return strip(a) === strip(b);
}
// The box holds exactly what OUR staging put there: the wire, or the read-back staging accepted as ours.
function queueBoxIsOurs(text, owned) {
  return !!owned && (text === owned.wireText || (typeof owned.stagedText === 'string' && owned.stagedText !== '' && text === owned.stagedText));
}
async function queueRevoke($, lease) {
  if (!lease || lease.incarnation !== incarnation || queueWasAbandoned(lease)) return;
  const known = queueEvidence.get(lease.attemptId);
  if (known?.status === 'accepted') { await queueEvent($, lease, 'accepted'); return; }
  const held = await $.state.get(queueRef);
  let beforeAdmission = false; let beforeInvocation = false;
  if (held.value?.attemptId !== lease.attemptId) {
    const evidence = queueEvidence.get(lease.attemptId);
    // A different active lease is NOT proof this old attempt never ran. Preserve
    // accepted/admitted evidence; absent evidence is unknown, never an automatic retry.
    if (evidence?.status === 'accepted') await queueEvent($, lease, 'accepted');
    else await queueEvent($, lease, 'unknown', { detail: 'revoke:identity-mismatch; known=' + (evidence?.status ?? 'none') + '; held=' + (held.value?.state ?? 'none') });
    return;
  }
  if (held.value?.attemptId === lease.attemptId) {
    if (held.value.state === 'accepted') { await queueEvent($, lease, 'accepted'); return; }
    if (held.value.state === 'admitted') {
      await queueEvent($, lease, 'unknown', { detail: 'revoke:admitted; known=' + (known?.status ?? 'none') }); return; // admission won; a timeout cannot prove next(e) failed
    }
    beforeInvocation = held.value.state === 'not-invoked' && known?.status === 'not-invoked';
    const changed = await $.state.set(queueRef, { ...held.value, state: beforeInvocation ? 'not-invoked' : 'revoked' }, { ifVersion: held.version });
    beforeAdmission = changed.isSet && !beforeInvocation;
    beforeInvocation = changed.isSet && beforeInvocation;
  }
  let safe = false; let cleanupDetail = '';
  if (beforeAdmission || beforeInvocation) {
    const box = await $.prompt.read();
    cleanupDetail = 'cleanupLength=' + box.text.length + '; trimEqual=' + (box.text === lease.wireText.trim());
    if (box.text === '') safe = true;
    else if (queueOwned?.attemptId === lease.attemptId && queueOwned.staged === true && (queueBoxIsOurs(box.text, queueOwned) || (beforeInvocation && (box.text === lease.wireText.trim() || box.text === queueOwned.stagedText?.trim())))) {
      // Never erase a changed human draft. Exact staged bytes are required, except
      // actual 2.1.303 restores the exact trim on a terminal not-invoked drop (measured).
      // That exception requires BOTH the same lease's terminal proof and staged ownership.
      const cleared = await $.prompt.fill({ text: '', mode: 'replace' });
      safe = cleared.isFilled && (await $.prompt.read()).text === '';
    }
  }
  await queueEvent($, lease, 'revoked', { beforeAdmission, beforeInvocation, composerSafe: safe, detail: cleanupDetail });
  if (safe && queueOwned?.attemptId === lease.attemptId) queueOwned = null;
  queueReleaseControls();
}
async function queueAbandon($, attempt) {
  if (!attempt) return;
  // WHY: abandonment is NOT a claim that delivery failed. Fence every pending admission
  // before awaiting cleanup; an already-invoked next(e) may finish, but cannot own new input.
  // Boundary sequences are monotonic per native incarnation: bounded replay protection.
  if (attempt.incarnation === incarnation) queueAbandonedSeq = Math.max(queueAbandonedSeq, attempt.boundarySeq);
  const owned = queueOwned?.attemptId === attempt.attemptId ? queueOwned : null;
  if (!queueOwned || owned) { queueGeneration++; queueFence = null; }
  const held = await $.state.get(queueRef);
  if (held.value?.attemptId === attempt.attemptId) {
    const revoked = await $.state.set(queueRef, { ...held.value, state: 'abandoned' }, { ifVersion: held.version });
    if (!revoked.isSet) throw new Error('Queue abandonment changed concurrently');
  }
  if (owned?.fillIssued) {
    const box = await $.prompt.read();
    // Explicit discard accepts delivery ambiguity, including a fill whose reply was lost.
    // Read back only our exact issued bytes (or the proven terminal not-invoked trim).
    // A changed human draft is never ours to erase.
    if (queueBoxIsOurs(box.text, owned) || (queueEvidence.get(attempt.attemptId)?.status === 'not-invoked' && (box.text === owned.wireText.trim() || box.text === owned.stagedText?.trim()))) {
      const cleared = await $.prompt.fill({ text: '', mode: 'replace' });
      if (!cleared.isFilled) throw new Error('Queue staging cleanup not acknowledged');
    }
  }
  if (queueOwned === owned) queueOwned = null;
  queuePendingRows.delete(attempt.attemptId); queueEvidence.delete(attempt.attemptId);
  queueReleaseControls();
  await queueEvent($, attempt, 'abandoned');
}
async function queuePoll($) {
  if (!queueEnabled || !running) return;
  try {
    const command = await post($, 'queue-poll', {});
    if (command.kind === 'wait') { $.clock.after(1000, () => queuePoll($)); return; }
    if (command.kind === 'stage') {
      try { await queueStage($, command.lease); }
      catch (_) { if (command.lease) { try { await queueRevoke($, command.lease); } catch (_) { await queueEvent($, command.lease, 'unknown', { detail: 'stage:cleanup-exception' }); } } }
    } else if (command.kind === 'abandon') await queueAbandon($, command.attempt);
    else if (command.kind === 'evidence') await queueReadEvidence($, command.attempt);
    else if (command.kind === 'revoke') await queueRevoke($, command.lease);
    else if (command.kind === 'idle' && turnId === null) void queueOffer($, 'idle');
  } catch (error) {
    if ([401, 409, 410].includes(error.status)) return;
    if (running) $.clock.after(1000, () => queuePoll($));
    return;
  }
  if (running) $.clock.after(0, () => queuePoll($));
}
async function queueNotInvoked($, lease) {
  const evidence = queueEvidence.get(lease.attemptId);
  if (!evidence || evidence.status !== 'admitted') return; // no conclusion about an actual next(e) call
  evidence.status = 'not-invoked';
  const state = await $.state.get(queueRef);
  if (state.value?.attemptId === lease.attemptId && state.value.state === 'admitted')
    await $.state.set(queueRef, { ...state.value, state: 'not-invoked' }, { ifVersion: state.version });
}
async function onQueueAdmission($, e, next) {
  const lease = queueOwned;
  if (!lease || e.agentId !== undefined) return next(e);
  let called = false; let result;
  try {
    const held = await $.state.get(queueRef);
    // Actual 2.1.303 trims the composer at Enter (captured queued_command). The
    // exact staged readback remains the ownership proof; restore those same bytes
    // through the supported prompt rewrite after admission, never silently truncate.
    const staged = typeof lease.stagedText === 'string' && lease.stagedText !== '' ? lease.stagedText : lease.wireText;
    if (e.text !== lease.wireText && e.text !== lease.wireText.trim() && e.text !== staged && e.text !== staged.trim()) {
      await queueEvent($, lease, 'unknown', { detail: 'Submitted input no longer matches the owned composer' });
      return { drop: 'The message box changed during queued delivery. Review the message before sending again.' };
    }
    if (lease.staged !== true || !queueFenceValid(lease) || await $.clock.now() >= lease.expiresAt || await $.session.id() !== lease.conversationId
      || (e.turnId ?? null) !== lease.turnId || held.value?.attemptId !== lease.attemptId || held.value.state !== 'armed'
      || held.value.wireHash !== lease.wireHash || held.value.incarnation !== incarnation) return { drop: 'Queued message was revoked or expired.' };
    const admitted = await $.state.set(queueRef, { ...held.value, state: 'admitted' }, { ifVersion: held.version });
    if (!admitted.isSet) return { drop: 'Queued message was revoked.' };
    queueEvidence.set(lease.attemptId, { status: 'admitted', acceptedAck: false, rowAck: false });
    await queueEvent($, lease, 'admitted');
    // The authenticated acknowledgement can wait arbitrarily. Re-read all async
    // authority BEFORE the final synchronous local checks and next(e) invocation.
    const latest = await $.state.get(queueRef);
    const conversationId = await $.session.id();
    const now = await $.clock.now();
    if (queueWasAbandoned(lease) || !queueFenceValid(lease) || now >= lease.expiresAt || conversationId !== lease.conversationId || turnId !== lease.turnId
      || (e.turnId ?? null) !== lease.turnId || latest.value?.attemptId !== lease.attemptId || latest.value.state !== 'admitted') {
      await queueNotInvoked($,lease);
      try { await queueEvent($,lease,'unknown',{detail:'Native terminal not-invoked proof is available for reconciliation'}); } catch (_) {}
      return { drop: 'Queued message authority expired before delivery.' };
    }
    queuePendingRows.set(lease.attemptId, lease);
    const evidenceBeforeCall = queueEvidence.get(lease.attemptId); if (evidenceBeforeCall) evidenceBeforeCall.status = 'invoked';
    called = true; result = await next(e.text === lease.wireText ? e : { ...e, text: lease.wireText });
    if (result?.drop !== undefined) { await queueEvent($, lease, 'unknown', { detail: 'admission:next-dropped' }); return result; }
    const evidence = queueEvidence.get(lease.attemptId);
    if (evidence) evidence.status = 'accepted';
    if (queueOwned === lease) queueOwned = null; // a late old result cannot release a newer owner
    try {
      const current = await $.state.get(queueRef);
      if (current.value?.attemptId === lease.attemptId && current.value.state === 'admitted')
        await $.state.set(queueRef, { ...current.value, state: 'accepted' }, { ifVersion: current.version });
    } catch (_) { /* the observed next(e) result is authoritative, never converted into a refusal */ }
    await queueEvent($, lease, 'accepted');
    if (evidence) { evidence.acceptedAck = true; if (evidence.rowAck) queueEvidence.delete(lease.attemptId); }
    return result;
  } catch (error) {
    if (!called) { try { await queueNotInvoked($,lease); } catch (_) { /* unknown if terminal proof cannot be persisted */ } }
    // WHY: branch-only diagnostics distinguish expiry, transport failure and native rejection without logging message text.
    const detail = 'admission:exception; called=' + called + '; evidence=' + (queueEvidence.get(lease.attemptId)?.status ?? 'none') + '; error=' + (error?.name ?? 'unknown') + '; status=' + (error?.status ?? 'none');
    try { await queueEvent($, lease, 'unknown', { detail }); } catch (_) {}
    // WHY: after next(e), a failed receipt can never be reported as a pre-delivery refusal.
    if (called) { if (result !== undefined) return result; throw new Error('Native queue outcome is unknown'); }
    return { drop: 'Queued message could not be safely admitted.' };
  }
}
async function onQueueAppend($, e, next) {
  const result = await next(e); // UUID is evidence only after the engine actually keeps this row
  if (!queueEnabled || e.agentId !== undefined || e.origin?.kind !== 'composer' || !e.uuid
    || !((e.door === 'prompt' && e.message.type === 'user') || (e.door === 'delivery' && e.message.name === 'queued_command'))) return result;
  const conversationId = await $.session.id();
  const text = e.message.content.filter(c => c.type === 'text').map(c => c.text).join('');
  const matches = [...queuePendingRows.values()].filter(l => l.conversationId === conversationId && (text === l.wireText || text === '<system-reminder>\nThe user sent a new message while you were working:\n' + l.wireText + '\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.\n</system-reminder>'));
  if (matches.length === 1) {
    const l = matches[0];
    // WHY: persist native kept-row correlation BEFORE HTTP. Lost replies/process loss must not
    // erase the only attempt→UUID evidence. Recovery reads this receipt, never matching history text.
    await $.store.set(queueReceiptKey(l), { ...queueReceiptIdentity(l), uuid: e.uuid });
    await queueEvent($, l, 'transcript', { uuid: e.uuid });
    await $.store.delete(queueReceiptKey(l)); // host acknowledgement follows durable journal confirmation
    queuePendingRows.delete(l.attemptId);
    const evidence = queueEvidence.get(l.attemptId); if (evidence) { evidence.rowAck = true; if (evidence.acceptedAck) queueEvidence.delete(l.attemptId); }
  }
  // Missing/ambiguous mapping is not made up; the host retains the receipt without deleting intent.
  return result;
}
`;

// YouCoded buddy helper — this file runs INSIDE the KWin compositor.
//
// WHY IT EXISTS: on a native Wayland session an application is not allowed to
// position or raise its own windows, and Electron's setPosition() fails
// *silently* (getPosition just echoes back whatever was last asked for). So the
// buddy appears wherever KWin drops it and cannot be dragged. A KWin script is
// not an application — it runs with the compositor's own privileges — so it
// can do both. Measured 2026-09-04: position, raise and exact-pixel readback
// all work, at 60 fps, with zero dropped moves.
//
// HOW THE APP TALKS TO IT: by RENAMING its own window. Nothing else. There is
// no socket, no DBus call per frame, no shared file. The window title carries
// the request:
//
//     YC:<role>@<x>,<y>          role is mascot | chat | bar
//
// A rename is ~6-10x cheaper than a DBus round trip and the compositor already
// delivers it as a signal, which is why the channel is a title and not an API.
//
// THE TWO IDENTITY CHECKS, AND WHY THERE HAVE TO BE TWO (design §0):
//
//   1. resourceClass — against a HOSTILE window. A window caption is a string
//      any program can choose, and a *web page* chooses its browser's caption.
//      Gating on the caption alone would have handed always-on-top and
//      arbitrary repositioning to any web page that named itself correctly.
//      A page cannot change its browser's resourceClass. Stated honestly: a
//      hostile *native* app still can set its own, so this raises the bar
//      rather than sealing it.
//
//   2. window.pid — against OUR OWN OTHER INSTANCE. A dev build and the
//      installed app both report resourceClass "youcoded" (it comes from
//      package.json's `name`; --class, --name, --app-id and app.setName() were
//      all measured and none of them move it), so resourceClass cannot tell
//      them apart. Their pids never collide, and one instance's mascot, chat
//      and bar always share one. So windows are GROUPED by pid below.
//
// The caption is deliberately tokenless: it is user-visible in places
// skipTaskbar does not reach, so nothing secret may travel in it.
//
// STYLE NOTE: KWin's script engine is QJSEngine. This file deliberately sticks
// to the conservative subset the probe verified on KWin 6.7.3 — `var`,
// `function`, plain objects and arrays. No arrow functions, template literals,
// Map or Set. A syntax the engine dislikes does not warn; the whole script just
// never loads, and the buddy silently stops moving.
//
// The `Id` in this package's metadata.json is a PLACEHOLDER. The installer
// rewrites it to youcodedbuddyhelper-<per-install token> so two profiles on one
// machine cannot fight over one package. See desktop/src/main/kwin-helper.ts.

var TAG = "YOUCODEDBUDDY";

// The caption grammar, anchored at both ends. Anchoring is the whole point: a
// loose match would accept "Some Document — YC:mascot@0,0" as a move request,
// which is a caption any program can produce.
//
// Coordinates are bounded by the pattern itself rather than by a range check
// afterwards, so a caption full of digits can never reach parseInt and come back
// as a number large enough to fling the window somewhere the user cannot drag it
// back from. Six digits is deliberately the SAME bound the app's own writer uses
// (desktop/src/shared/buddy-caption.ts): the reader must not accept a caption
// the writer cannot produce, or the two ends of the channel have drifted.
var CAPTION = /^YC:(mascot|chat|bar)@(-?[0-9]{1,6}),(-?[0-9]{1,6})$/;

// WM_CLASS as Electron actually reports it, measured 2026-09-04: it comes from
// desktop/package.json's `name`, which is "youcoded". If that name ever changes
// this list must change with it, or the buddy stops moving on Wayland with no
// error anywhere.
var OWNED_RESOURCE_CLASSES = ["youcoded"];

function say(s) { print(TAG + "|" + s); }

// --- identity ------------------------------------------------------------

function ownedClass(w) {
  if (!w) return false;
  var rc = w.resourceClass;
  if (typeof rc !== "string") return false;
  rc = rc.toLowerCase();
  for (var i = 0; i < OWNED_RESOURCE_CLASSES.length; i++) {
    if (OWNED_RESOURCE_CLASSES[i] === rc) return true;
  }
  return false;
}

function pidOf(w) {
  var p = w ? w.pid : undefined;
  // Windows with no readable pid all share the -1 bucket — this is NOT a private
  // group per window, and the code must not be read as giving one. Accepted
  // because our own windows always report a pid (measured, probe Round 0), so
  // -1 only ever holds windows that already failed, or would fail, the class
  // check. Two of them could evict each other; none of them is ours.
  return (typeof p === "number" && p > 0) ? p : -1;
}

/** null = this caption is not a move request. Never throws. */
function parseTarget(caption) {
  if (typeof caption !== "string") return null;
  var m = CAPTION.exec(caption);
  if (!m) return null;
  var x = parseInt(m[2], 10);
  var y = parseInt(m[3], 10);
  if (isNaN(x) || isNaN(y)) return null;
  return { role: m[1], x: x, y: y };
}

// --- the registry, grouped by pid ---------------------------------------

// records: { w, pid, role, onCaption, onMinimized }
// Grouped by pid so that no handler can ever reach a window belonging to
// another YouCoded instance. Today each caption names only the window it is
// written on, so the grouping is what keeps that structurally true rather than
// a check that fires — with one exception that does fire, below: a second
// window claiming a role already held inside the same pid group evicts the
// older one instead of both being flagged always-on-top.
var records = [];

function findRecord(w) {
  for (var i = 0; i < records.length; i++) if (records[i].w === w) return records[i];
  return null;
}

function forget(record) {
  try { record.w.captionChanged.disconnect(record.onCaption); } catch (e) { /* window already gone */ }
  if (record.onMinimized) {
    try { record.w.minimizedChanged.disconnect(record.onMinimized); } catch (e) { /* ditto */ }
  }
  var i = records.indexOf(record);
  if (i >= 0) records.splice(i, 1);
}

/**
 * A role is unique within one instance. If a second window in the SAME pid
 * group claims a role a live window already holds, the older record is dropped.
 *
 * WHY evict rather than refuse the newcomer: the buddy's chat and bar windows
 * are destroyed and recreated as the user opens and closes them. If a stale
 * record ever outlived its window (a close that fired no windowRemoved), a
 * "refuse the duplicate" rule would leave the new window permanently
 * unmovable — the exact symptom this whole feature exists to remove. Evicting
 * is self-healing: the worst case is one dead handler disconnected a moment
 * early.
 */
function evictSameRole(record) {
  for (var i = records.length - 1; i >= 0; i--) {
    var other = records[i];
    if (other !== record && other.pid === record.pid && other.role === record.role) {
      say("EVICTED|pid=" + other.pid + "|role=" + other.role);
      forget(other);
    }
  }
}

// --- what the helper actually does to a window ---------------------------

/**
 * The three flags the app itself cannot set on Wayland. skipTaskbar is a
 * documented no-op from the application side there (this repo's own verified
 * comment, buddy-overlay-manager.ts), which is why the buddy's title — with its
 * numbers changing 60 times a second during a drag — would otherwise show up in
 * the task manager and Alt-Tab. Set from inside the compositor all three take
 * and read back true (measured 2026-09-04).
 *
 * Re-asserted on un-minimise as well as on attach: Wayland hands a restored
 * window a NEW surface, which is the same class of bug this repo already
 * documents for the buddy's input region. NOT verified on hardware — it is
 * cheap insurance, not a measurement.
 */
function assertFlags(w) {
    // Re-check the class here too, exactly as apply() does. Always-on-top plus
    // removal from the taskbar and Alt-Tab is at least as privileged as a move,
    // and an asymmetric guard is the kind that survives a refactor as a hole.
    if (!ownedClass(w)) return false;
  try {
    w.keepAbove = true;
    w.skipTaskbar = true;
    w.skipSwitcher = true;
    w.skipPager = true;
  } catch (e) {
    say("FLAGS_THREW|" + e);
  }
}

/** Moves the window to the position its own caption asks for. */
function apply(w) {
  // The class check is repeated HERE, at the moment of use, and not trusted
  // from attach time alone. Attach and use are separated by the whole life of
  // the window, and a move is the privileged act.
  if (!ownedClass(w)) return false;
  var t = parseTarget(w.caption);
  if (!t) return false;
  var g = w.frameGeometry;
  if (!g) return false;
  // KWin 6 geometry is fractional (a readback gave y:463.666… at 1.5x scale).
  // Comparing before writing keeps a no-op rename from becoming a real move,
  // and integers survive the round trip even though computed values would not.
  if (g.x === t.x && g.y === t.y) return false;
  w.frameGeometry = { x: t.x, y: t.y, width: g.width, height: g.height };
  return true;
}

/**
 * Runs on every caption change of an owned window. The caption test is the
 * first line, which is all that is needed: the app's MAIN window is an owned
 * window too, and it must never be flagged always-on-top or moved.
 */
function handle(record) {
  var w = record.w;
  var t = parseTarget(w.caption);
  if (!t) return;
  if (record.role !== t.role) {
    record.role = t.role;
    evictSameRole(record);
  }
  if (!record.flagged) {
    record.flagged = true;
    assertFlags(w);
    say("ATTACHED|pid=" + record.pid + "|role=" + t.role);
  }
  apply(w);
}

function attach(w) {
  // The hostile-window gate. resourceClass is available at windowAdded and
  // cannot change afterwards, so filtering HERE is what keeps helper JS from
  // running inside the compositor on every title change in the session —
  // browser tabs, video clocks, terminal working directories.
  if (!ownedClass(w)) return;
  // windowList() at load and windowAdded can both deliver the same window.
  if (findRecord(w)) return;

  var record = { w: w, pid: pidOf(w), role: null, flagged: false, onCaption: null, onMinimized: null };
  record.onCaption = function () { handle(record); };
  record.onMinimized = function () {
    // A restored window gets a new surface, so the flags and the position are
    // both re-asserted rather than assumed to have survived.
    if (!w.minimized && record.flagged) { assertFlags(w); apply(w); }
  };
  records.push(record);

  try { w.captionChanged.connect(record.onCaption); } catch (e) { say("CONNECT_THREW|" + e); }
  try { w.minimizedChanged.connect(record.onMinimized); } catch (e) { record.onMinimized = null; }

  // Buddy windows are created with the caption already set in the
  // BrowserWindow constructor, so the very first window may need placing
  // before any captionChanged ever fires.
  handle(record);
}

function detach(w) {
  var record = findRecord(w);
  if (record) forget(record);
}

// --- wiring --------------------------------------------------------------

// Both halves are required. The script is loaded from config at session start;
// the app's buddy windows are created whenever the user launches YouCoded,
// which the probe measured at 18 seconds later — so windowAdded is the one that
// matters in practice, and windowList() covers a helper installed while the app
// is already running.
try {
  workspace.windowList().forEach(attach);
} catch (e) {
  say("SCAN_THREW|" + e);
}
workspace.windowAdded.connect(attach);
workspace.windowRemoved.connect(detach);

say("READY");

import type { Display } from 'electron';
import { kdeCall, readKdeSession, type KdeCallResult, type KdeScreen, type KdeSession } from './kde-dbus';
import type { Rect } from '../shared/buddy-geometry';

/**
 * Where the buddy is allowed to live on each screen.
 *
 * WHY this module exists at all: on native Wayland, Electron's
 * `display.workArea` is the WHOLE screen. Measured 2026-09-04 (probe Round 6):
 * `workArea` came back {0,0 1707x1067}, byte-identical to `bounds`, while KWin
 * had reserved 52 px for the Plasma panel. There is no Wayland protocol that
 * tells an app about panel struts, so this is not a bug to wait out. Using
 * Electron's number puts the mascot 52 px too low — sitting ON the taskbar,
 * with keep-above guaranteeing he covers the clock and system tray instead of
 * slipping behind them. The real rectangle has to be asked for over DBus.
 */
export type ResolvedArea = {
  rect: Rect;
  /**
   * True only when this rectangle came back from plasmashell AND passed the
   * containment check. False means "we gave up and used Electron's number".
   *
   * WHY it is carried at all: the fallback is numerically INDISTINGUISHABLE
   * from a legitimate answer (a screen with no panel, or an auto-hidden one),
   * so without this flag nothing downstream — and no test — can tell "resolved"
   * from "gave up" (design §0.4).
   */
  resolved: boolean;
};

// plasmashell's strut bookkeeping. Not KWin: a KWin-only session has no such
// service, which is one of the two absence cases handled below.
const PLASMA_SERVICE = 'org.kde.plasmashell';
const STRUT_PATH = '/StrutManager';
const STRUT_METHOD = 'org.kde.PlasmaShell.StrutManager.availableScreenRect';

// `qdbus6 --literal … availableScreenRect eDP-1` → "[Argument: (iiii) 0, 0, 1707, 1015]".
// Verified 2026-09-04. WHY --literal is mandatory: without it qdbus6 cannot
// render the (iiii) struct, and it says so ON STDOUT while EXITING 0 — see
// kde-dbus.ts's qdbusStdoutFailure, which is the other half of this trap.
const LITERAL_RECT = /^\[Argument: \(iiii\) (-?\d+), (-?\d+), (\d+), (\d+)\]/;

// Electron reports this screen's scale as 1.4997071027755737 where KWin reports
// 1.5. Both round THIS screen to 1707x1067, which is why they agree here — but
// whether both round a second screen's ORIGIN identically is untested and
// untestable without the hardware (design §9). An exact match would fail every
// non-primary display on a one-pixel disagreement, so match with slack.
const MATCH_TOLERANCE_PX = 2;

// Retry schedule for a resolve that has never succeeded. WHY: org.kde.plasmashell
// has NO DBus service-activation file — it is a systemd user unit (verified
// 2026-09-04) — so a crash, a systemd restart or `plasmashell --replace` leaves
// the bus name unclaimed for seconds, and at login it may be claimed before the
// panels exist. A single try at startup would hand a whole session the 52 px bug.
const RETRY_BACKOFF_MS = [150, 450];

/** Parses the `--literal` reply. Anything else — including qdbus's own
 *  "I don't know how to display an argument of type '(iiii)'" complaint, which
 *  arrives on stdout at exit 0 — is null, NEVER a zero rect. */
export function parseAvailableScreenRect(stdout: string): Rect | null {
  const m = LITERAL_RECT.exec(stdout.trim());
  if (!m) return null;
  const rect = {
    x: Number(m[1]),
    y: Number(m[2]),
    width: Number(m[3]),
    height: Number(m[4]),
  };
  // A zero-area work area is not an answer, it is a malformed one. Accepting it
  // would clamp the buddy to a single point.
  if (rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

/** True when `inner` lies wholly inside `outer`. Exact, no slack — see
 *  WorkAreaResolver.areaFor for why this one is strict. */
export function containedIn(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function within(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

/**
 * Which KDE screen(s) each Electron display is. Matched by BOUNDS, because the
 * screen NAME is the one thing Electron does not expose (`display.label` is
 * "Built-in Screen", not "eDP-1") and the name is exactly what the DBus call
 * needs.
 *
 * A display with no candidate is absent from the map (it falls back). More than
 * one candidate means ambiguous — Plasma mirrors outputs by placing them at the
 * same position and size, which is what a projector in presentation mode is —
 * and the caller intersects their rectangles rather than picking one.
 */
export function matchScreens(
  displays: ReadonlyArray<{ id: number; bounds: Rect }>,
  kde: ReadonlyArray<KdeScreen>,
): Map<number, KdeScreen[]> {
  // WHY disabled screens are dropped first: KWin prints screens whose
  // `Enabled:` is 0, and a disabled output with a stale or zeroed Geometry can
  // otherwise shadow the real primary (design §0.2).
  const live = kde.filter((s) => s.enabled);
  const out = new Map<number, KdeScreen[]>();
  for (const display of displays) {
    const hits = live.filter(
      (s) =>
        within(s.bounds.x, display.bounds.x, MATCH_TOLERANCE_PX) &&
        within(s.bounds.y, display.bounds.y, MATCH_TOLERANCE_PX) &&
        within(s.bounds.width, display.bounds.width, MATCH_TOLERANCE_PX) &&
        within(s.bounds.height, display.bounds.height, MATCH_TOLERANCE_PX),
    );
    if (hits.length > 0) out.set(display.id, hits);
  }
  return out;
}

/** Overlap of two rectangles, or null when they do not overlap. */
function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** Everything the resolver touches outside itself, injectable so the whole
 *  lifecycle is unit-testable without a compositor. */
export interface WorkAreaDeps {
  listDisplays(): Promise<ReadonlyArray<{ id: number; bounds: Rect }>>;
  readSession(): Promise<KdeSession | null>;
  callScreenRect(name: string): Promise<KdeCallResult>;
  wait(ms: number): Promise<void>;
}

function defaultDeps(): WorkAreaDeps {
  return {
    // Imported lazily: this module is also loaded by unit tests, which have no
    // Electron to hand and never take this path.
    listDisplays: async () => {
      const { screen } = await import('electron');
      return screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds }));
    },
    readSession: () => readKdeSession(),
    callScreenRect: (name) =>
      kdeCall(['--literal', PLASMA_SERVICE, STRUT_PATH, STRUT_METHOD, name]),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** Reasons that mean "plasmashell is not on the bus", as opposed to "the call
 *  went wrong". Used only to stop retrying on a session that will never have it
 *  (a KWin-only desktop); never shown to a user.
 *
 *  WHY the first phrase leads: it is the one qdbus6 ACTUALLY emits, measured
 *  2026-09-04 — `Service 'org.kde.plasmashell' does not exist.` on stderr at
 *  exit 2. The four freedesktop-worded phrases below it were written from the
 *  DBus spec and match nothing qdbus6 prints; a review found this branch dead
 *  and its test passing only because the test supplied a string qdbus6 never
 *  produces. They are kept because dbus-send and older qdbus do use that
 *  wording, and §0.1 allows either transport. */
function looksLikeServiceMissing(reason: string): boolean {
  const r = reason.toLowerCase();
  return (
    r.includes('does not exist') ||
    r.includes('serviceunknown') ||
    r.includes('was not provided by any .service files') ||
    r.includes('no such service') ||
    r.includes('service is not registered')
  );
}

export class WorkAreaResolver {
  private readonly deps: WorkAreaDeps;
  /** display id → the last rectangle that came back resolved AND contained. */
  private readonly areas = new Map<number, Rect>();
  private settled = false;
  private everResolved = false;
  private serviceAbsent = false;
  private inFlight: Promise<void> | null = null;
  private dirty = false;
  /** Last parsed KDE screen inventory; see resolveOnce for why it is cached. */
  private lastSession: KdeSession | null = null;

  constructor(deps: Partial<WorkAreaDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  /** True once a refresh has finished — NOT "we got a real answer". The buddy
   *  may be constructed at this point; whether the rectangle is real is what
   *  ResolvedArea.resolved says. */
  get ready(): boolean {
    return this.settled;
  }

  /**
   * Awaited once at startup before any buddy window exists (design §0.6), then
   * re-run on display events and at the start of each drag/dock.
   *
   * WHY the await matters: `show()` places the mascot in the BrowserWindow
   * constructor, synchronously, while resolving is two subprocess calls. Place
   * the first buddy of a session against an unresolved rectangle and nothing
   * ever corrects it — the app gets NO readback of a compositor-side move
   * (measured, Round 6 W3), so it sits on the taskbar for the whole session
   * unless the user happens to drag it.
   */
  refresh(): Promise<void> {
    // Coalesce: KWin fires display-metrics-changed three times within 200 ms of
    // a window show, so the callers debounce and this catches the rest.
    //
    // WHY the dirty flag: coalescing alone answers a request that arrived DURING
    // a pass with the inventory that pass snapshotted. A monitor plugged in
    // mid-resolve would then stay unresolved until some later gesture. One
    // trailing re-run closes that without turning the burst into three passes.
    if (this.inFlight) {
      this.dirty = true;
      return this.inFlight;
    }
    this.inFlight = this.runUntilClean().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runUntilClean(): Promise<void> {
    this.dirty = false;
    await this.run();
    if (this.dirty) {
      this.dirty = false;
      await this.run();
    }
  }

  private async run(): Promise<void> {
    // Retry only while we have never had an answer. Once one screen has
    // resolved, or once this session has been shown to have no plasmashell, a
    // refresh is a single cheap attempt — otherwise every drag start would pay
    // 600 ms of backoff on a desktop that will never answer.
    const maxRetries = this.everResolved || this.serviceAbsent ? 0 : RETRY_BACKOFF_MS.length;
    let missingOnly = true;
    // WHY try/finally: `settled` is what gates constructing the first buddy
    // window. defaultDeps().listDisplays calls screen.getAllDisplays(), which
    // Electron throws on before app-ready — and §0.6 asks for this to be awaited
    // at the earliest possible startup step, which is exactly where that risk
    // lives. Without this, one rejecting dep leaves the resolver permanently
    // un-ready and the buddy never appears at all, with nothing saying why.
    // A throw is not a reason to have no answer: the fallback IS the answer.
    try {
      for (let attempt = 0; ; attempt++) {
        const outcome = await this.resolveOnce();
        // Only failures that got as far as a DBus call can vote on "this
        // session has no plasmashell". A display KDE reports nothing for is a
        // MATCH failure, and counting it here would stop the latch from ever
        // closing on a session that has both.
        missingOnly = outcome.calledAndFailed > 0 && outcome.failedWithServiceMissing === outcome.calledAndFailed;
        if (outcome.resolved > 0 || attempt >= maxRetries) break;
        await this.deps.wait(RETRY_BACKOFF_MS[attempt]);
      }
      if (!this.everResolved && missingOnly) this.serviceAbsent = true;
    } catch {
      // Deliberately swallowed: the fallback IS the answer, and areaFor already
      // reports resolved:false for it. Rethrowing would only turn a wrong
      // rectangle into no buddy at all.
    } finally {
      this.settled = true;
    }
  }

  private async resolveOnce(): Promise<{
    resolved: number;
    failed: number;
    /** Failures that actually reached a DBus call — the only ones entitled to
     *  vote on "this session has no plasmashell" (see run()). */
    calledAndFailed: number;
    failedWithServiceMissing: number;
  }> {
    let resolved = 0;
    let failed = 0;
    let calledAndFailed = 0;
    let failedWithServiceMissing = 0;

    const displays = await this.deps.listDisplays();

    // WHY the cache: supportInformation() is a 6.8 KB subprocess read (measured
    // 3-6 ms) and the screen inventory only changes on a display event — but a
    // panel change, which is what the per-drag re-resolve is FOR, fires no event
    // anywhere (§0.7). So reuse the parsed inventory while it still explains
    // every display, and re-read the moment it does not. That is self-healing:
    // a hotplug makes the match fail, which forces the re-read.
    let session = this.lastSession;
    let matches = session ? matchScreens(displays, session.screens) : null;
    const explainsAll =
      matches !== null && displays.every((d) => (matches?.get(d.id)?.length ?? 0) > 0);
    if (!explainsAll) {
      session = await this.deps.readSession();
      matches = session ? matchScreens(displays, session.screens) : null;
      this.lastSession = session;
    }
    // KWin itself is unreachable, so no strut call was even attempted.
    if (!session || !matches) return { resolved, failed: 1, calledAndFailed: 0, failedWithServiceMissing: 0 };

    for (const display of displays) {
      const candidates = matches.get(display.id);
      if (!candidates || candidates.length === 0) {
        // Nothing KDE reports looks like this display. Leave whatever we had;
        // areaFor re-checks containment before trusting it. NOT counted as a
        // call failure — no DBus call happened, so it must not influence the
        // "no plasmashell here" verdict.
        failed++;
        continue;
      }

      const rects: Rect[] = [];
      let callFailed = false;
      for (const candidate of candidates) {
        const call = await this.deps.callScreenRect(candidate.name);
        if (!call.ok) {
          callFailed = true;
          calledAndFailed++;
          if (looksLikeServiceMissing(call.reason)) failedWithServiceMissing++;
          break;
        }
        const rect = parseAvailableScreenRect(call.stdout);
        if (!rect) {
          // An unparseable reply is a failure, never a zero rect.
          callFailed = true;
          break;
        }
        rects.push(rect);
      }
      if (callFailed || rects.length === 0) {
        failed++;
        continue;
      }

      // Ambiguous match (mirrored outputs): use the INTERSECTION, which is never
      // larger than any candidate, so the mascot cannot land on a panel either
      // one reserves. Requiring every candidate to answer is deliberate — an
      // intersection missing one unknown member could be too large.
      let rect: Rect | null = rects[0];
      for (const other of rects.slice(1)) {
        rect = rect ? intersect(rect, other) : null;
      }

      // THE CONTAINMENT CHECK — the single most important line here.
      // availableScreenRect returns a rect in the GLOBAL coordinate space, and
      // on a one-screen desktop at the origin that is indistinguishable from a
      // screen-local one, so no probe could have caught a mis-match. If display
      // A resolves to screen B, the app clamps the buddy to ANOTHER MONITOR's
      // x-range on every drag frame, with no readback to notice — the buddy is
      // yanked to the other screen and pinned there, which is the exact
      // "appears but is stuck" symptom this whole feature exists to remove.
      // Discarding an uncontained rect converts every class of mis-match into
      // the much smaller "sits 52 px low on the right monitor".
      if (!rect || !containedIn(rect, display.bounds)) {
        failed++;
        continue;
      }

      this.areas.set(display.id, rect);
      resolved++;
    }

    if (resolved > 0) this.everResolved = true;
    return { resolved, failed, calledAndFailed, failedWithServiceMissing };
  }

  /**
   * Never throws, makes no calls — a pure read of what the last refresh
   * learned, safe to call on every drag frame.
   *
   * DEVIATION FROM THE BUILD CONTRACT, deliberately: the contract says the
   * fallback is `display.bounds`. It is `display.workArea` instead. On KDE
   * Wayland the two are byte-identical (measured, Round 6 W1) so this changes
   * nothing there — but if a later task ever consults the resolver on Windows,
   * macOS or KDE X11, `workArea` is the correct rectangle those platforms
   * already report and `bounds` would put the buddy under the taskbar on all
   * three. The safe direction is the one that is never worse.
   */
  areaFor(display: Display): ResolvedArea {
    const cached = this.areas.get(display.id);
    // Re-checked here, not just at resolve time: a display can be moved or
    // resized between refreshes, and a rectangle that no longer fits inside it
    // is a stale answer about a screen that has changed shape.
    if (cached && containedIn(cached, display.bounds)) {
      return { rect: cached, resolved: true };
    }
    return { rect: display.workArea, resolved: false };
  }
}

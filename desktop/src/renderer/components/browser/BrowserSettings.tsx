// Assistant settings → Browser (2026-10-13; spec docs/archive/specs/2026-10-13-assistant-browser-design.md
// §2 Screens, design review UX #4/#13/#18). The computer's own window only
// (capabilities.assistantBrowser); the page list hides it everywhere else.
//
// WHY a page of Assistant settings, not its own row in Settings (Destin, 2026-10-15,
// browser-fit-1#N-1: "it should probably be hidden under assistant settings"): the
// Browser is a tool the assistant uses, like its models and permissions, so it lives
// with them. The page only draws once picked, so merely opening Settings still never
// starts the Browser's worker process.
//
// Two plain questions instead of "modes": WHICH browser (the assistant's own,
// or My Chrome — Experimental) and whether to SHOW a window. Everything else is
// the things a person may want to undo: allowed sites, saved sign-ins.
import { useCallback, useEffect, useState } from 'react';
import type { BrowserInfo, MyChromeCheck } from '../../../shared/browser-types';
import { Button, CARD_LEVEL_1, CARD_LEVEL_2, Dialog, ErrorState, LoadingState, OneJobCard, OneJobText, ProgressBar, RadioGroup, SectionLabel, Select, SettingRow, Toggle } from '../ui';

function bridge() { return (window as any).claude.browser; }

const WHICH = ['own', 'my-chrome'] as const;

/** The page's (i) beside its title — what was the old dialog's subtitle. */
export const BROWSER_INFO = {
  label: 'About the Browser',
  body: <p>The assistant's own web browser, for sites that need clicking, typing or a sign-in.</p>,
};

export default function BrowserSettings() {
  const [info, setInfo] = useState<BrowserInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [check, setCheck] = useState<MyChromeCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoadError(null);
    void bridge().info().then(setInfo).catch((e: Error) => setLoadError(e?.message || 'The browser settings could not be read.'));
  }, []);
  useEffect(() => {
    load();
    return bridge().onInfoChanged(load);
  }, [load]);

  const run = useCallback(async (fn: () => Promise<BrowserInfo | unknown>) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'settings' in (r as object)) setInfo(r as BrowserInfo);
    } catch (e) {
      setLoadError((e as Error)?.message || 'That didn\'t work.');
    } finally { setBusy(false); }
  }, []);

  const doCheck = useCallback(async () => {
    setChecking(true);
    try { setCheck(await bridge().checkMyChrome()); } catch (e) { setCheck({ ok: false, message: (e as Error)?.message || 'Could not check.' }); }
    setChecking(false);
  }, []);

  // Showing/hiding the window or switching browsers restarts the browser for
  // EVERY chat — ask first when pages are open, like the panel does (code
  // review F13, UX review 2 U4).
  const [pending, setPending] = useState<null | { kind: 'window' | 'mychrome'; value: boolean }>(null);
  const apply = useCallback((p: { kind: 'window' | 'mychrome'; value: boolean }) => {
    setPending(null);
    void run(() => (p.kind === 'window' ? bridge().setShowWindow(p.value) : bridge().updateSettings({ useMyChrome: p.value })));
  }, [run]);
  const confirmThen = useCallback((p: { kind: 'window' | 'mychrome'; value: boolean }) => {
    if (p.kind === 'mychrome' && p.value === !!info?.settings.useMyChrome) return;
    if ((info?.sessionsWithTabs ?? 0) > 0) setPending(p); else apply(p);
  }, [info, apply]);

  const s = info?.settings;
  const which = s?.useMyChrome ? 'my-chrome' : 'own';

  return (
    <>
      {loadError && <ErrorState className="mb-3" message={loadError} onRetry={load} />}
      {!info && !loadError && <LoadingState what="browser settings" />}
      {/* WHY rebuilt on the shared pieces (2026-10-14, the new-surface check after merging master;
          design guide "Popups", "Card levels", "Headings"): this page arrived with all-caps
          spaced headings, plain grey boxes with no card outline, loose lines on the popup and a
          lone right-aligned button. Now every group is a small sentence-case label over one
          first-level card holding its rows, words and buttons — Settings → Backup & sync's shape.
          Same words, same controls, same behaviour. */}
      {info && s && (
        <div className="space-y-4">
          <section>
            <SectionLabel className="mb-2">Which browser</SectionLabel>
            <div className={`${CARD_LEVEL_1} p-3 space-y-2`}>
            <RadioGroup options={WHICH} value={which} onChange={(v) => confirmThen({ kind: 'mychrome', value: v === 'my-chrome' })} aria-label="Which browser">
              <div className="space-y-1">
              <SettingRow
                variant="item"
                title="The assistant's own browser (recommended)"
                description="Private: separate from your own browser and sign-ins. Sign-ins you make in it are remembered on this computer and shared by all your chats."
                selected={which === 'own'}
                onSelect={() => confirmThen({ kind: 'mychrome', value: false })}
                radioTabIndex={which === 'own' ? 0 : -1}
              />
              <SettingRow
                variant="item"
                title="My Chrome (Experimental)"
                description="Uses your open Chrome and your sign-ins, so the assistant can act as you. It asks before opening each new site."
                selected={which === 'my-chrome'}
                onSelect={() => confirmThen({ kind: 'mychrome', value: true })}
                radioTabIndex={which === 'my-chrome' ? 0 : -1}
              />
              </div>
            </RadioGroup>
            {s.useMyChrome && (
              <div className={`${CARD_LEVEL_2} p-3 text-xs text-fg-2 leading-relaxed space-y-2`}>
                <p>1. In Chrome, open <span className="font-mono select-text">chrome://inspect/#remote-debugging</span> and turn remote debugging on.</p>
                <p>2. The first time the assistant uses it, Chrome asks you to Allow the connection — choose Allow.</p>
                {/* A follow-up action under a group: full-width outlined (guide "Buttons"). */}
                <Button variant="secondary" size="sm" className="w-full" onClick={doCheck} disabled={checking}>{checking ? 'Checking…' : 'Check connection'}</Button>
                {check && <p className="text-xs text-fg-muted" role="status">{check.message}</p>}
              </div>
            )}
            </div>
          </section>

          {!s.useMyChrome && (
            <section>
              <SectionLabel className="mb-2">On this computer</SectionLabel>
              <div className={`${CARD_LEVEL_1} p-3 space-y-3`}>
              <SettingRow
                // item: the description is real guidance and must wrap, not cut (nav rows truncate).
                variant="item"
                header
                title="Show a browser window"
                // One sentence for both states, so the row keeps its height when switched (UX review 2, U15).
                description="On: a real window you can watch. Off: hidden — follow along in the chat's Browser panel."
                control={<Toggle checked={s.showWindow} disabled={busy} aria-label="Show a browser window" onChange={(v) => confirmThen({ kind: 'window', value: v })} />}
              />
              {info.browsers.length >= 2 ? (
                // A wide control goes below its title and hint (guide "Settings"): a dropdown beside
                // the title squeezed the title onto three lines at dialog width.
                <div className="space-y-1.5">
                  <div className="text-xs text-fg font-medium">Browser to use</div>
                  <div className="text-2xs text-fg-muted">Which browser on this computer the assistant uses.</div>
                  <Select
                    size="sm"
                    value={s.preferredBrowser ?? info.chosen?.kind ?? info.browsers[0].kind}
                    options={info.browsers.map((b) => ({ value: b.kind, label: b.label }))}
                    onChange={(v) => void run(() => bridge().updateSettings({ preferredBrowser: v }))}
                  />
                </div>
              ) : info.chosen ? (
                <p className="text-xs text-fg-muted">Using {info.chosen.label}.</p>
              ) : null}
              {!info.chosen && info.install.phase !== 'downloading' && (
                <div className="space-y-2">
                  <p className="text-xs text-fg-2 leading-relaxed">No Chrome, Edge, Chromium or Brave was found on this computer. YouCoded can download a browser just for the assistant (about 150 MB, kept inside YouCoded).</p>
                  {/* A failed action replaces its button: one plain sentence, the installer's own
                      words under Details inside the box (guide "Status and notices"). */}
                  {info.install.phase === 'failed'
                    ? <ErrorState message="The download didn't finish." details={info.install.error ?? undefined} onRetry={() => void run(() => bridge().download())} />
                    : <Button variant="primary" className="w-full" onClick={() => void run(() => bridge().download())}>Download</Button>}
                </div>
              )}
              {info.install.phase === 'downloading' && (
                <div className="space-y-2 text-xs text-fg-2" role="status">
                  <p>Downloading a browser for the assistant… {info.install.percent}%</p>
                  <ProgressBar percent={info.install.percent} />
                  <Button variant="secondary" className="w-full" onClick={() => void bridge().cancelDownload()}>Cancel</Button>
                </div>
              )}
              {/* A follow-up action under a group: full-width outlined (guide "Buttons"). */}
              {info.running && (
                <Button variant="secondary" className="w-full" onClick={() => void run(() => bridge().stop())}>Close the browser</Button>
              )}
              </div>
            </section>
          )}

          <section>
            {/* A count is the word then a smaller, fainter number (guide "Text and numbers"). */}
            <SectionLabel className="mb-2">Sites you've allowed{s.alwaysAllowedSites.length ? <span className="ml-1 text-3xs text-fg-faint">{s.alwaysAllowedSites.length}</span> : null}</SectionLabel>
            <div className={`${CARD_LEVEL_1} p-3`}>
            {s.alwaysAllowedSites.length === 0 ? (
              <p className="text-xs text-fg-muted leading-relaxed">None yet. When the browser asks, "Always allow" adds a site here. Buying, sending and deleting still ask every time.</p>
            ) : (
              <ul className="space-y-1">
                {s.alwaysAllowedSites.map((h) => (
                  <li key={h}>
                    <SettingRow title={h} control={<Button variant="secondary" size="sm" onClick={() => void run(() => bridge().removeSite(h))}>Remove</Button>} />
                  </li>
                ))}
              </ul>
            )}
            </div>
          </section>

          {!s.useMyChrome && (
            <section>
              <SectionLabel className="mb-2">Saved sign-ins</SectionLabel>
              <div className={`${CARD_LEVEL_1} p-3`}>
              <SettingRow
                variant="item"
                header
                title="Clear saved sign-ins"
                description="Signs the assistant's browser out of every site. Saved on this computer only."
                control={<Button variant="danger-outline" size="sm" disabled={busy} onClick={() => setConfirmClear(true)}>Clear</Button>}
              />
              </div>
            </section>
          )}
        </div>
      )}
      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pending?.kind === 'window' ? (pending.value ? 'Show the browser window?' : 'Hide the browser window?') : 'Switch browsers?'}
        size="panel"
        layer={3}
        noScreen="a two-button confirm inside Assistant settings → Browser; its wording is pinned by BrowserSettings.test.tsx"
      >
        {/* WHY the shared one-job card (guide "Popups": every one-job popup, short questions too). */}
        <OneJobCard actions={<>
          <Button variant="primary" onClick={() => pending && apply(pending)}>{pending?.kind === 'window' ? (pending.value ? 'Show window' : 'Hide window') : 'Switch'}</Button>
          <Button variant="secondary" onClick={() => setPending(null)}>Cancel</Button>
        </>}>
          <OneJobText><p>
            {pending?.kind === 'window'
              ? `This restarts the browser for ${info?.sessionsWithTabs ?? 0} chat${info?.sessionsWithTabs === 1 ? '' : 's'} using it. Pages reopen where they were, but anything typed and not yet sent is lost.`
              : `This closes the pages the assistant has open in ${info?.sessionsWithTabs ?? 0} chat${info?.sessionsWithTabs === 1 ? '' : 's'}.`}
          </p></OneJobText>
        </OneJobCard>
      </Dialog>
      <Dialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Sign out of every site?"
        size="panel"
        layer={3}
        destructive
        noScreen="a two-button confirm inside Assistant settings → Browser; its wording is pinned by BrowserSettings.test.tsx"
      >
        <OneJobCard actions={<>
          <Button variant="danger" onClick={() => { setConfirmClear(false); void run(() => bridge().clearSignins()); }}>Sign out of everything</Button>
          <Button variant="secondary" onClick={() => setConfirmClear(false)}>Cancel</Button>
        </>}>
          <OneJobText><p>The assistant's browser closes and forgets every sign-in. You'll need to sign in again the next time a task needs it. Your own browser isn't affected.</p></OneJobText>
        </OneJobCard>
      </Dialog>
    </>
  );
}

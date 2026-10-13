// Settings → Browser (2026-10-13; spec docs/active/specs/2026-10-13-assistant-browser-design.md
// §2 Screens, design review UX #4/#13/#18). A row in the settings list opening a
// dialog — the PerformanceButton pattern. The computer's own window only
// (capabilities.assistantBrowser); nothing renders elsewhere.
//
// Two plain questions instead of "modes": WHICH browser (the assistant's own,
// or My Chrome — Experimental) and whether to SHOW a window. Everything else is
// the things a person may want to undo: allowed sites, saved sign-ins.
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BrowserInfo, MyChromeCheck } from '../../../shared/browser-types';
import { browserSupported } from '../../state/browser-store';
import { useScreenOpen } from '../../shoot-mode';
import { Button, Dialog, ErrorState, LoadingState, ProgressBar, RadioGroup, Select, SettingRow, Toggle } from '../ui';
import { GlobeIcon } from '../Icons';

function bridge() { return (window as any).claude.browser; }

const WHICH = ['own', 'my-chrome'] as const;

export function browserSettingsSummary(info: BrowserInfo | null): string {
  if (!info) return 'The assistant\'s own web browser';
  if (info.settings.useMyChrome) return 'My Chrome (Experimental)';
  if (!info.chosen) return info.install.phase === 'downloading' ? `Downloading… ${info.install.percent}%` : 'No browser found yet';
  return `${info.chosen.label} · ${info.settings.showWindow ? 'window shown' : 'hidden'}`;
}

export function BrowserSettingsDialog({ onClose }: { onClose: () => void }) {
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
    <Dialog open onClose={onClose} title="Browser" subtitle="The assistant's own web browser, for sites that need clicking, typing or a sign-in." size="panel" screen="settings/browser">
      {loadError && <ErrorState className="mb-3" message={loadError} onRetry={load} />}
      {!info && !loadError && <LoadingState what="browser settings" />}
      {info && s && (
        <div className="space-y-5">
          <section className="space-y-2">
            <h3 className="text-2xs font-medium uppercase tracking-wide text-fg-muted">Which browser?</h3>
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
              <div className="rounded-lg bg-inset p-3 text-xs text-fg-2 space-y-2">
                <p>1. In Chrome, open <span className="font-mono select-text">chrome://inspect/#remote-debugging</span> and turn remote debugging on.</p>
                <p>2. The first time the assistant uses it, Chrome asks you to Allow the connection — choose Allow.</p>
                <div className="flex items-center justify-end gap-2">
                  {check && <span className={`flex-1 text-2xs ${check.ok ? 'text-fg-2' : 'text-fg-muted'}`} role="status">{check.message}</span>}
                  <Button variant="secondary" size="sm" onClick={doCheck} disabled={checking}>{checking ? 'Checking…' : 'Check connection'}</Button>
                </div>
              </div>
            )}
          </section>

          {!s.useMyChrome && (
            <section className="space-y-2">
              <SettingRow
                // item: the description is real guidance and must wrap, not cut (nav rows truncate).
                variant="item"
                title="Show a browser window"
                // One sentence for both states, so the row keeps its height when switched (UX review 2, U15).
                description="On: a real window you can watch. Off: hidden — follow along in the chat's Browser panel."
                control={<Toggle checked={s.showWindow} disabled={busy} aria-label="Show a browser window" onChange={(v) => confirmThen({ kind: 'window', value: v })} />}
              />
              {info.browsers.length >= 2 ? (
                // A labelled field rather than a row control: a dropdown beside the title
                // squeezed the title onto three lines at dialog width.
                <div className="rounded-lg bg-inset p-3 space-y-1.5">
                  <div className="text-sm text-fg font-medium">Browser to use</div>
                  <div className="text-2xs text-fg-muted">Which browser on this computer the assistant uses.</div>
                  <Select
                    size="sm"
                    value={s.preferredBrowser ?? info.chosen?.kind ?? info.browsers[0].kind}
                    options={info.browsers.map((b) => ({ value: b.kind, label: b.label }))}
                    onChange={(v) => void run(() => bridge().updateSettings({ preferredBrowser: v }))}
                  />
                </div>
              ) : info.chosen ? (
                <p className="text-2xs text-fg-muted px-1">Using {info.chosen.label}.</p>
              ) : null}
              {!info.chosen && info.install.phase !== 'downloading' && (
                <div className="rounded-lg bg-inset p-3 text-xs text-fg-2">
                  <p>No Chrome, Edge, Chromium or Brave was found on this computer. YouCoded can download a browser just for the assistant (about 150 MB, kept inside YouCoded).</p>
                  {info.install.phase === 'failed' && (
                    <ErrorState className="mt-2" message={`The download didn't finish: ${info.install.error}`} onRetry={() => void run(() => bridge().download())} />
                  )}
                  {info.install.phase !== 'failed' && (
                    <div className="flex justify-end mt-2">
                      <Button variant="primary" size="sm" onClick={() => void run(() => bridge().download())}>Download</Button>
                    </div>
                  )}
                </div>
              )}
              {info.install.phase === 'downloading' && (
                <div className="rounded-lg bg-inset p-3 text-xs text-fg-2" role="status">
                  <p>Downloading a browser for the assistant… {info.install.percent}%</p>
                  <ProgressBar className="mt-2" percent={info.install.percent} />
                  <div className="flex justify-end mt-2">
                    <Button variant="secondary" size="sm" onClick={() => void bridge().cancelDownload()}>Cancel</Button>
                  </div>
                </div>
              )}
            </section>
          )}

          <section className="space-y-2">
            <h3 className="text-2xs font-medium uppercase tracking-wide text-fg-muted">Sites you've allowed {s.alwaysAllowedSites.length ? <span className="text-fg-muted font-normal">{s.alwaysAllowedSites.length}</span> : null}</h3>
            {s.alwaysAllowedSites.length === 0 ? (
              <p className="text-2xs text-fg-muted px-1">None yet. When the browser asks, "Always allow" adds a site here. Buying, sending and deleting still ask every time.</p>
            ) : (
              <ul className="space-y-1">
                {s.alwaysAllowedSites.map((h) => (
                  <li key={h}>
                    <SettingRow title={h} control={<Button variant="secondary" size="sm" onClick={() => void run(() => bridge().removeSite(h))}>Remove</Button>} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {!s.useMyChrome && (
            <section className="space-y-2">
              <h3 className="text-2xs font-medium uppercase tracking-wide text-fg-muted">Saved sign-ins</h3>
              <SettingRow
                variant="item"
                title="Clear saved sign-ins"
                description="Signs the assistant's browser out of every site. Saved on this computer only."
                control={<Button variant="danger-outline" size="sm" disabled={busy} onClick={() => setConfirmClear(true)}>Clear</Button>}
              />
            </section>
          )}

          {info.running && (
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" onClick={() => void run(() => bridge().stop())}>Close the browser</Button>
            </div>
          )}
        </div>
      )}
      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pending?.kind === 'window' ? (pending.value ? 'Show the browser window?' : 'Hide the browser window?') : 'Switch browsers?'}
        size="prompt"
        layer={3}
        noScreen="a two-button confirm inside Settings → Browser; its wording is pinned by BrowserSettings.test.tsx"
      >
        <p className="text-sm text-fg-2">
          {pending?.kind === 'window'
            ? `This restarts the browser for ${info?.sessionsWithTabs ?? 0} chat${info?.sessionsWithTabs === 1 ? '' : 's'} using it. Pages reopen where they were, but anything typed and not yet sent is lost.`
            : `This closes the pages the assistant has open in ${info?.sessionsWithTabs ?? 0} chat${info?.sessionsWithTabs === 1 ? '' : 's'}.`}
        </p>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="secondary" onClick={() => setPending(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => pending && apply(pending)}>{pending?.kind === 'window' ? (pending.value ? 'Show window' : 'Hide window') : 'Switch'}</Button>
        </div>
      </Dialog>
      <Dialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Sign out of every site?"
        size="prompt"
        layer={3}
        destructive
        noScreen="a two-button confirm inside Settings → Browser; its wording is pinned by BrowserSettings.test.tsx"
      >
        <p className="text-sm text-fg-2">The assistant's browser closes and forgets every sign-in. You'll need to sign in again the next time a task needs it. Your own browser isn't affected.</p>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="secondary" onClick={() => setConfirmClear(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => { setConfirmClear(false); void run(() => bridge().clearSignins()); }}>Sign out of everything</Button>
        </div>
      </Dialog>
    </Dialog>
  );
}

export default function BrowserSettingsButton() {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<string>(browserSettingsSummary(null));
  const supported = browserSupported();
  useScreenOpen('settings/browser', () => setOpen(true), undefined, supported); // photo-only build
  // WHY no fetch until the dialog has been opened: drawing this row must not
  // start the Browser's worker process for someone who never browses.
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!supported || !seen || open) return;
    let live = true;
    void bridge().info().then((i: BrowserInfo) => { if (live) setSummary(browserSettingsSummary(i)); }).catch(() => {});
    return () => { live = false; };
  }, [supported, seen, open]);
  if (!supported) return null;
  return (
    <>
      <SettingRow
        icon={<GlobeIcon className="w-4 h-4 text-fg-muted" />}
        title="Browser"
        description={summary}
        onClick={() => { setSeen(true); setOpen(true); }}
      />
      {open && createPortal(<BrowserSettingsDialog onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

// The Browser's worker process: an Electron utilityProcess forked by
// browser-client.ts. Owns BrowserService, the settings file, the installer and
// the permission engine, and answers the main process over `parentPort`
// (browser-protocol.ts). Nothing here touches Electron APIs, so the same
// `createBrowserHost` runs under vitest with a fake port.
//
// WHY a separate process (design review 1 #6): Playwright parses every CDP
// message, builds page outlines and screencast frames — real CPU that must not
// land on the main thread every window shares. Quitting the app kills this
// process, and its launched browser exits with it (Playwright's pipe closes).
import * as path from 'path';
import { chromium } from 'playwright-core';
import { BrowserService, firstLine } from './browser-service';
import { BrowserSettings } from './browser-settings';
import { BrowserInstaller, playwrightCliPath } from './browser-installer';
import { discoverBrowsers, defaultDiscoveryEnv, pickBrowser, type FoundBrowser } from './browser-discovery';
import { BrowserPolicy, installNavigationGuard, navigationVerdict, openForPerson, runBrowserTool, type RunnerEnv } from './browser-tool-runners';
import { findMyChrome } from './browser-my-chrome';
import type { BrowserCommand, MainToWorker, WorkerToMain } from './browser-protocol';
import type { BrowserInfo } from '../../shared/browser-types';

const SHOT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export interface HostPort {
  postMessage(msg: WorkerToMain): void;
  on(event: 'message', cb: (e: { data: MainToWorker }) => void): void;
}

export interface BrowserHostOptions {
  /** Test seams. */
  forceHeadless?: boolean;
  discover?: () => Promise<FoundBrowser[]>;
  cliPath?: string;
}

export function createBrowserHost(port: HostPort, rootDir: string, hostOpts: BrowserHostOptions = {}) {
  const send = (m: WorkerToMain) => port.postMessage(m);
  const log = (level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: Record<string, unknown>) => send({ t: 'log', level, msg, data });
  const settings = new BrowserSettings(rootDir);
  const browsersDir = path.join(rootDir, 'browsers');
  let found: FoundBrowser[] | null = null;
  const discover = async (refresh = false): Promise<FoundBrowser[]> => {
    if (!found || refresh) found = await (hostOpts.discover ?? (() => discoverBrowsers(defaultDiscoveryEnv(browsersDir))))();
    return found;
  };

  const service = new BrowserService({
    rootDir,
    chromium,
    forceHeadless: hostOpts.forceHeadless,
    log,
    findMyChrome: () => findMyChrome(),
    // The page-load check (home network / metadata), for every page and iframe.
    requestGuard: (sid, url) => navigationVerdict(env, sid, url),
    guardPage: (sid, page) => installNavigationGuard(env, sid, page),
    // Closing the shown window = choosing hidden (the window doesn't come back next start).
    onWindowClosedByPerson: async () => {
      await settings.update({ showWindow: false });
      send({ t: 'info-changed' });
    },
    getLaunchConfig: async () => {
      const prefs = await settings.read();
      return { showWindow: prefs.showWindow, myChrome: prefs.useMyChrome, browser: pickBrowser(await discover(), prefs.preferredBrowser) };
    },
  });

  let cliPath: string;
  try { cliPath = hostOpts.cliPath ?? playwrightCliPath(); } catch { cliPath = ''; }
  const installer = new BrowserInstaller({
    browsersDir,
    cliPath,
    onChange: (s) => {
      service.downloadPercent = s.phase === 'downloading' ? s.percent : null;
      if (s.phase === 'done') void discover(true);
      if (s.phase === 'failed') log('WARN', 'Browser download failed', { error: s.error });
      service.emitAll();
      send({ t: 'info-changed' });
    },
  });

  const env: RunnerEnv = { service, settings, installer, policy: new BrowserPolicy() };
  service.on('state', (state) => send({ t: 'state', state }));
  service.on('frame', (frame) => send({ t: 'frame', frame }));
  void service.pruneOld(SHOT_MAX_AGE_MS);

  const calls = new Map<number, AbortController>();

  async function info(): Promise<BrowserInfo> {
    const prefs = await settings.read();
    const browsers = await discover();
    return {
      running: service.isRunning(),
      browsers,
      chosen: pickBrowser(browsers, prefs.preferredBrowser),
      install: installer.current,
      settings: prefs,
      sessionsWithTabs: service.otherSessionsWithTabs(null),
    };
  }

  async function command(c: BrowserCommand): Promise<unknown> {
    switch (c.cmd) {
      case 'state': return service.state(c.sessionId);
      case 'watch': service.watch(c.sessionId); return true;
      case 'unwatch': service.unwatch(c.sessionId); return true;
      case 'ack': service.ackFrame(c.sessionId); return true;
      case 'answer': return service.answerPrompt(c.sessionId, c.promptId, c.answer);
      case 'open-window-for-handoff':
        // The person chose to sign in in a real window; the hand-off card stays.
        await service.setWindowOverride(true);
        return true;
      case 'set-show-window': {
        await settings.update({ showWindow: c.show });
        if (service.isRunning() && !(await settings.read()).useMyChrome) await service.restart();
        send({ t: 'info-changed' });
        return info();
      }
      case 'info': return info();
      case 'update-settings': {
        const before = await settings.read();
        const after = await settings.update(c.patch);
        // Switching between the Browser's own browser and My Chrome, or picking
        // another browser, takes effect by restarting; showing/hiding too.
        const restart = before.useMyChrome !== after.useMyChrome || before.preferredBrowser !== after.preferredBrowser || before.showWindow !== after.showWindow;
        if (restart && service.isRunning()) {
          if (before.useMyChrome !== after.useMyChrome) await service.stop();
          else await service.restart();
        }
        send({ t: 'info-changed' });
        return info();
      }
      case 'remove-site': await settings.removeSite(c.host); send({ t: 'info-changed' }); return info();
      case 'clear-signins': {
        // Signing out of everything = the browser's whole storage. Stop first:
        // Chrome holds the folder open.
        const fs = await import('fs');
        // Nothing may start the browser while its folder is being removed.
        await service.withStartsBlocked(() => fs.promises.rm(path.join(rootDir, 'profile'), { recursive: true, force: true, maxRetries: 5 }));
        send({ t: 'info-changed' });
        return info();
      }
      case 'stop': await service.stop(); send({ t: 'info-changed' }); return true;
      case 'close-session':
        await service.closeSession(c.sessionId, c.forget);
        if (c.forget) env.policy.forget(c.sessionId);
        return true;
      case 'download': installer.start(); return info();
      case 'cancel-download': installer.cancel(); return true;
      case 'open': {
        // The person browsing from the panel. Their own choice of address, so a
        // home-network address needs no card (it is granted for this chat);
        // a never-openable one is still refused.
        if (c.nav) {
          try { await service.personNav(c.sessionId, c.nav); return { ok: true }; } catch (err) { return { ok: false, error: `That didn't work: ${firstLine(err)}` }; }
        }
        return openForPerson(env, c.sessionId, c.address ?? '');
      }
      case 'input': service.personInput(c.sessionId, c.event); return true;
      case 'view-size': service.setViewSize(c.sessionId, c.width, c.height); return true;
      case 'check-my-chrome': {
        const r = await findMyChrome();
        return 'error' in r ? { ok: false, message: r.error } : { ok: true, message: 'Chrome is ready. It will ask you to Allow the connection the first time the assistant uses it.' };
      }
    }
  }

  port.on('message', (e) => {
    const m = e.data;
    if (m.t === 'call') {
      const ac = new AbortController();
      calls.set(m.id, ac);
      void runBrowserTool(env, m.tool, m.args, { sessionId: m.sessionId, signal: ac.signal, vision: m.vision })
        .then((value) => send({ t: 'reply', id: m.id, ok: true, value }))
        .finally(() => calls.delete(m.id));
    } else if (m.t === 'cancel') {
      calls.get(m.id)?.abort();
    } else if (m.t === 'cmd') {
      command(m.command)
        .then((value) => send({ t: 'reply', id: m.id, ok: true, value }))
        .catch((err) => send({ t: 'reply', id: m.id, ok: false, error: firstLine(err) }));
    } else if (m.t === 'shutdown') {
      void service.dispose().finally(() => process.exit(0));
    }
  });

  return { service, env };
}

// Electron's utilityProcess gives the forked file a `parentPort` and passes
// argv; under vitest nothing runs at import.
const parentPort = (process as unknown as { parentPort?: HostPort }).parentPort;
if (parentPort && process.argv[2]) {
  createBrowserHost(parentPort, process.argv[2]);
}

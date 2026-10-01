// app.ts — the app's own settings and signals: app:restart, performance:get-config / set-config, attention:report /
// get-summary and remote:attention-changed. The computer's own windows only.
//
// WHY (2026-10-01 one-core R3-8): each was an ipcMain handler (ipc-handlers.ts, main.ts); none was ever bridged to a
// phone, so the table refuses them for a phone with the same "not available over remote access" answer the old
// default gave. (The attention SUMMARY reaches a phone through status:data, not through these.)
import { app } from 'electron';
import { IPC } from '../../shared/backend-contract';
import type { AttentionReport, AttentionSummary } from '../../shared/types';
import { loadConfigSync, writeConfig, getAppliedAtLaunch, getCachedGpu } from '../performance-config';
import { defineChannel, type MainChannelDef } from './channel-def';

/** What main hands over: the attention bookkeeping that lives beside the window list (main.ts) and the status relay that
 *  tells phones a session's attention changed (ipc-handlers.ts). */
interface AppDeps {
  /** A window reports one session's attention state; main aggregates across windows and fans the summary out. */
  reportAttention(windowId: number, payload: AttentionReport): void;
  attentionSummary(): AttentionSummary;
  /** A window says a session's attention classifier changed; phones hear it without waiting for the status timer. */
  attentionChanged(payload: { sessionId: string; state: string }): void;
}
// WHY merged: main.ts hands over the attention bookkeeping, ipc-handlers.ts the status relay. Each binds its own part.
const deps: Partial<AppDeps> = {};
export function bindApp(next: Partial<AppDeps>): void { Object.assign(deps, next); }
const need = <K extends keyof AppDeps>(key: K): AppDeps[K] => { const fn = deps[key]; if (!fn) throw new Error('app signals are not ready'); return fn; };

export const appChannels: MainChannelDef[] = [
  // Generic restart channel — reused by any setting that needs a restart to apply. relaunch() schedules the restart for
  // after exit().
  defineChannel({ name: IPC.APP_RESTART, kind: 'handle', desktopOnly: true, handler: () => { app.relaunch(); app.exit(0); } }),

  // Settings → Performance reads/writes ~/.claude/youcoded-performance.json. The Chromium force-{high,low}-power-gpu
  // switch is applied at module load in main.ts (it cannot change at runtime), so set-config only persists the value —
  // the renderer is responsible for prompting a restart.
  defineChannel({
    name: IPC.PERFORMANCE_GET_CONFIG, kind: 'handle', desktopOnly: true,
    handler: () => {
      const cfg = loadConfigSync();
      const gpu = getCachedGpu();
      return { preferPowerSaving: cfg.preferPowerSaving, appliedAtLaunch: getAppliedAtLaunch(), multiGpuDetected: gpu.multiGpuDetected, gpuList: gpu.gpuList };
    },
  }),
  defineChannel({
    name: IPC.PERFORMANCE_SET_CONFIG, kind: 'handle', desktopOnly: true,
    handler: (payload) => {
      // IPC inputs are untrusted: coerce to a strict boolean.
      writeConfig({ preferPowerSaving: payload?.preferPowerSaving === true });
      return { ok: true as const };
    },
  }),

  // Renderers push per-session attention here; main aggregates across windows (main.ts owns the map and the debounce).
  defineChannel({ name: IPC.ATTENTION_REPORT, kind: 'on', desktopOnly: true, handler: (payload, ctx) => need('reportAttention')(ctx.sender?.id ?? -1, payload) }),
  // Pull-style companion to the SESSION_ATTENTION_SUMMARY push: a window opened mid-turn draws the right dot at once.
  defineChannel({ name: IPC.ATTENTION_GET_SUMMARY, kind: 'handle', desktopOnly: true, handler: () => need('attentionSummary')() }),
  defineChannel({
    name: IPC.REMOTE_ATTENTION_CHANGED, kind: 'on', desktopOnly: true,
    handler: (payload) => need('attentionChanged')(payload),
  }),
];

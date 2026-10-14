// Messages between the main process (browser-client.ts) and the Browser's
// worker process (browser-host.ts). Plain structured-clone objects.
import type { BrowserSessionState, FrameEvent, PromptAnswer } from './browser-service';
import type { BrowserInputEvent } from '../../shared/browser-types';


export type BrowserCommand =
  | { cmd: 'state'; sessionId: string }
  | { cmd: 'watch'; sessionId: string }
  | { cmd: 'unwatch'; sessionId: string }
  | { cmd: 'ack'; sessionId: string }
  | { cmd: 'answer'; sessionId: string; promptId: string; answer: PromptAnswer }
  | { cmd: 'open-window-for-handoff'; sessionId: string }
  | { cmd: 'set-show-window'; show: boolean }
  | { cmd: 'info' }
  | { cmd: 'update-settings'; patch: unknown }
  | { cmd: 'remove-site'; host: string }
  | { cmd: 'clear-signins' }
  | { cmd: 'stop' }
  | { cmd: 'close-session'; sessionId: string; forget: boolean }
  | { cmd: 'download' }
  | { cmd: 'cancel-download' }
  | { cmd: 'check-my-chrome' }
  | { cmd: 'open'; sessionId: string; address?: string; nav?: 'back' | 'forward' | 'reload' }
  | { cmd: 'input'; sessionId: string; event: BrowserInputEvent }
  | { cmd: 'view-size'; sessionId: string; width: number; height: number };

export type MainToWorker =
  | { t: 'call'; id: number; sessionId: string; tool: string; args: unknown; vision: boolean }
  | { t: 'cancel'; id: number }
  | { t: 'cmd'; id: number; command: BrowserCommand }
  | { t: 'shutdown' };

export type WorkerToMain =
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | { t: 'reply'; id: number; ok: false; error: string }
  | { t: 'state'; state: BrowserSessionState }
  | { t: 'frame'; frame: FrameEvent }
  | { t: 'info-changed' }
  | { t: 'log'; level: 'INFO' | 'WARN' | 'ERROR'; msg: string; data?: Record<string, unknown> };

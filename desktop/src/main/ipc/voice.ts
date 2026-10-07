// voice.ts — voice typing: voice:status / download / start / stop / cancel / mic-access, and voice:audio (the stream of
// microphone slices). The computer's own microphone and speech engine only.
//
// WHY (2026-10-01 one-core R3-8): seven ipcMain registrations in voice/voice-handlers.ts. A phone's page has no access to the
// computer's microphone (the shim refuses every voice call per call), so the table refuses all seven for a phone from the
// entries with the "not available over remote access" answer the old default gave.
//
// WHY the microphone permission prompt lives HERE and not in the renderer: on macOS, Chromium does not raise the system prompt
// for us — an Electron app that touches the microphone without having asked is KILLED by the operating system, with no dialog
// and no error the user can read. So `voice:start` asks first, waits for the answer, and only then lets the microphone open.
import { systemPreferences } from 'electron';
import { IPC } from '../../shared/backend-contract';
import { getVoiceService, getVoiceVocabularyStore } from '../voice/voice-handlers';
import { MIC_REFUSED_SENTENCE, type VoiceService } from '../voice/voice-service';
import { defineChannel, type MainChannelDef } from './channel-def';

const service = (): VoiceService => { const s = getVoiceService(); if (!s) throw new Error('voice typing is not ready'); return s; };
const senderId = (ctx: { sender?: { id: number } }): number => ctx.sender?.id ?? -1;

export const voiceChannels: MainChannelDef[] = [
  // WHY: the phone has a different recognizer; never pretend it saved desktop hints.
  defineChannel({ name: IPC.VOICE_VOCABULARY_GET, kind: 'handle', desktopOnly: true, handler: () => getVoiceVocabularyStore().read() }),
  defineChannel({ name: IPC.VOICE_VOCABULARY_SAVE, kind: 'handle', desktopOnly: true, handler: ({ phrases }) => getVoiceVocabularyStore().save(phrases) }),
  defineChannel({ name: IPC.VOICE_STATUS, kind: 'handle', desktopOnly: true, handler: () => service().status() }),
  defineChannel({ name: IPC.VOICE_DOWNLOAD, kind: 'handle', desktopOnly: true, handler: (_p, ctx) => service().download(senderId(ctx)) }),
  defineChannel({
    name: IPC.VOICE_START, kind: 'handle', desktopOnly: true,
    handler: async (_p, ctx) => {
      // R21's "the system prompt comes first" half. On macOS this raises the one-time microphone dialog and waits for the
      // person to answer it; on every other platform it is skipped, because there is no such call.
      if (process.platform === 'darwin') {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        // The refusal is worded exactly once, in voice-service.ts, so this sentence and the renderer's cannot drift apart.
        if (!granted) throw new Error(MIC_REFUSED_SENTENCE);
      }
      // WHY: only the next recording sees saved changes. Read asynchronously
      // here, then service.start copies and reserves ownership without yielding.
      const phrases = await getVoiceVocabularyStore().read();
      await service().start(senderId(ctx), phrases);
    },
  }),
  defineChannel({ name: IPC.VOICE_STOP, kind: 'handle', desktopOnly: true, handler: () => { service().stop(); } }),
  defineChannel({ name: IPC.VOICE_CANCEL, kind: 'handle', desktopOnly: true, handler: () => { service().cancel(); } }),
  // What the operating system says about the microphone. Meaningful on macOS AND on Windows, whose global privacy switch
  // otherwise looks exactly like "this computer has no microphone". Linux has no such API, so the honest answer there is
  // "unknown" and the renderer falls back to asking the browser layer for the device list.
  defineChannel({
    name: IPC.VOICE_MIC_ACCESS, kind: 'handle', desktopOnly: true,
    handler: () => {
      if (process.platform !== 'darwin' && process.platform !== 'win32') return 'unknown' as const;
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status === 'granted') return 'granted' as const;
      // 'restricted' is macOS parental controls / MDM: the person cannot grant it themselves, which the user experiences as a refusal.
      if (status === 'denied' || status === 'restricted') return 'denied' as const;
      if (status === 'not-determined') return 'not-determined' as const;
      return 'unknown' as const;
    },
  }),
  // Fire-and-forget: 10 slices a second while the mic is open. `on`, not `handle`, because a reply per slice would cost more than the audio.
  defineChannel({
    name: IPC.VOICE_AUDIO, kind: 'on', desktopOnly: true,
    handler: ({ chunk, rms }, ctx) => { getVoiceService()?.pushAudio(senderId(ctx), chunk, rms); },
  }),
];

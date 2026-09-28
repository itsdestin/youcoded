import type { IpcMain } from 'electron';
import { IPC, type SessionInfo } from '../../shared/types';
import type { CreateSessionOpts } from '../session-manager';
import type { createHandoffAttempts } from './handoff-attempt';
import { validateSyncName } from '../sync-spaces/guards';

type Controller = ReturnType<typeof createHandoffAttempts<SessionInfo, CreateSessionOpts>>;
const safeId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 100 && /^[A-Za-z0-9._-]+$/.test(v) && validateSyncName(v) === null;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** WHY: Both untrusted transport payloads must pass the same boundary before the shared admission owner is reached. */
export function createHandoffTransport(controller: Controller | null) {
  const route = async (owner: string, action: string, payload: unknown) => {
    if (!controller) throw new Error('Handoff attempts are unavailable.');
    if (!owner || !record(payload)) throw new Error('Invalid handoff request.');
    if (action === 'begin') {
      const { conversationId, provider, create } = payload;
      if (!safeId(conversationId) || (provider !== 'claude' && provider !== 'native'))
        throw new Error('Invalid handoff conversation or provider.');
      return controller.begin(owner, conversationId, provider, create === undefined ? undefined : parseCreate(create, conversationId, provider));
    }
    if (!safeId(payload.id)) throw new Error('Invalid handoff attempt id.');
    const id = payload.id;
    switch (action) {
      case 'status': return controller.status(owner, id);
      case 'wait': return controller.wait(owner, id);
      case 'retry': return controller.retry(owner, id);
      case 'saved-copy':
        if (payload.consent !== true) throw new Error('Explicit saved-copy consent required.');
        return controller.savedCopy(owner, id, true);
      case 'force':
        if (payload.consent !== true || !safeId(payload.expectedHolderId))
          throw new Error('Separate force consent and expected holder required.');
        return controller.force(owner, id, true, payload.expectedHolderId);
      case 'cancel': return controller.cancel(owner, id);
      case 'create-params': return controller.setCreateParams(owner, id, parseCreate(payload.create));
      default: throw new Error('Unknown handoff action.');
    }
  };
  return Object.assign(route, { cancelOwner: (owner: string) => controller?.cancelOwner(owner) });
}

// WHY: register only the narrow transport routes here, not business logic in the oversized IPC handler.
export function registerHandoffIpc(ipcMain: IpcMain, route: ReturnType<typeof createHandoffTransport>): void {
  for (const [channel, action] of [
    [IPC.HANDOFF_BEGIN, 'begin'], [IPC.HANDOFF_STATUS, 'status'], [IPC.HANDOFF_WAIT, 'wait'],
    [IPC.HANDOFF_RETRY, 'retry'], [IPC.HANDOFF_SAVED_COPY, 'saved-copy'], [IPC.HANDOFF_FORCE, 'force'],
    [IPC.HANDOFF_CANCEL, 'cancel'], [IPC.HANDOFF_CREATE_PARAMS, 'create-params'],
  ] as const) ipcMain.handle(channel, (event, payload: unknown) => route(`window:${event.sender.id}`, action, payload));
}

// WHY: the socket may close during wait; cancellation wins and no stale result is replayed to a new connection.
export async function handleRemoteHandoff(
  route: ReturnType<typeof createHandoffTransport> | undefined, owner: string, type: string,
  payload: unknown, connected: () => boolean, respond: (value: unknown) => void,
): Promise<void> {
  try {
    if (!route || !connected()) throw new Error('Handoff attempts are unavailable.');
    const result = await route(owner, type.slice('handoff:'.length), payload);
    if (connected()) respond(result);
  } catch (error) {
    if (connected()) respond({ ok: false, error: error instanceof Error ? error.message : 'Handoff request failed.' });
  }
}

function parseCreate(value: unknown, conversationId?: string, provider?: string): CreateSessionOpts {
  if (!record(value)) throw new Error('Invalid handoff create parameters.');
  const keys = ['name', 'cwd', 'skipPermissions', 'resumeSessionId', 'provider', 'model', 'binding', 'cols', 'rows', 'preset'];
  if (Object.keys(value).some(k => !keys.includes(k)) || !safeId(value.resumeSessionId) ||
      (conversationId && value.resumeSessionId !== conversationId) ||
      (value.provider !== 'claude' && value.provider !== 'native') || (provider && value.provider !== provider) ||
      typeof value.name !== 'string' || value.name.length > 512 || typeof value.cwd !== 'string' || value.cwd.length > 4096 ||
      typeof value.skipPermissions !== 'boolean' ||
      (value.model !== undefined && (typeof value.model !== 'string' || value.model.length > 512)) ||
      (value.preset !== undefined && (typeof value.preset !== 'string' || value.preset.length > 128)) ||
      (value.cols !== undefined && (!Number.isInteger(value.cols) || (value.cols as number) < 1 || (value.cols as number) > 1000)) ||
      (value.rows !== undefined && (!Number.isInteger(value.rows) || (value.rows as number) < 1 || (value.rows as number) > 1000)) ||
      (value.binding !== undefined && (!record(value.binding) || Object.keys(value.binding).some(k => !['providerId', 'modelId'].includes(k)) ||
        typeof value.binding.providerId !== 'string' || typeof value.binding.modelId !== 'string' ||
        value.binding.providerId.length > 512 || value.binding.modelId.length > 512)))
    throw new Error('Invalid handoff create parameters.');
  // WHY: only schema-projected fields reach startup. CWD is re-resolved by the backend after admission.
  return Object.fromEntries(keys.filter(k => value[k] !== undefined).map(k => [k, value[k]])) as unknown as CreateSessionOpts;
}

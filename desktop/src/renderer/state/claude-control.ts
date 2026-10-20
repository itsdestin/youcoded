import type { ClaudeControlRequest, ClaudeControlResult } from '../../shared/claude-control-types';
import { announce } from '../utils/announce';
import { screenInputBlock } from './pty-input-gate';

/** WHY: only an explicit pre-dispatch unavailability allows a caller to use terminal input. */
export async function requestClaudeControl(sessionId: string, request: ClaudeControlRequest): Promise<ClaudeControlResult> {
  const control = window.claude.session.control;
  if (typeof control !== 'function') return { status: 'unavailable' }; // older host/workbench
  try {
    const result = await control(sessionId, request);
    if (result && ['accepted', 'unavailable', 'rejected', 'unknown'].includes(result.status)) return result;
    // A previous host that has no such channel explicitly says unsupported and cannot have dispatched it.
    if ((result as unknown as { unsupported?: boolean } | undefined)?.unsupported === true) return { status: 'unavailable' };
  } catch (error) {
    const refused = error as { code?: unknown; channel?: unknown };
    if (refused?.code === 'REMOTE_UNSUPPORTED' && refused.channel === 'session:claude-control') return { status: 'unavailable' };
    // A lost reply is not proof the operation failed.
  }
  return { status: 'unknown', message: 'Claude did not confirm this action. Check the conversation before trying again.' };
}

function routeControl(sessionId: string, request: ClaudeControlRequest, fallback: () => void): void {
  if (typeof window.claude.session.control !== 'function') { fallback(); return; }
  void requestClaudeControl(sessionId, request).then(result => {
    if (result.status === 'unavailable') {
      if (request.kind !== 'stop' && screenInputBlock(sessionId)) {
        announce('Claude’s terminal is waiting for an answer. Check it before sending this command.'); return;
      }
      fallback();
    } else if (result.status === 'rejected' || result.status === 'unknown') announce(result.message);
  }).catch(() => announce('This action could not be confirmed. Check the conversation before trying again.'));
}

/** The existing command callers opt in explicitly; raw terminal/menu bytes never call this helper. */
export function sendClaudeCommand(sessionId: string, text: string, notice?: 'model-switch'): void {
  const match = /^\/(model|clear|compact)(?:[ \t]+([^\r\n]*))?\r$/.exec(text);
  if (!match) { window.claude.session.sendInput(sessionId, text, notice); return; }
  if (match[1] === 'clear' && typeof window.claude.session.queue?.action === 'function') {
    void window.claude.session.queue.action(sessionId,{kind:'clear'}).then(r=>{
      if(r.status==='unavailable')routeControl(sessionId,{kind:'command',command:'clear'},()=>window.claude.session.sendInput(sessionId,text,notice));
      else if(r.status!=='done')announce('message'in r?r.message:'Clear was not confirmed; queued messages remain paused.');
    }).catch(()=>announce('Clear outcome is unknown. Do not repeat it without checking the conversation.'));
    return;
  }
  const request: ClaudeControlRequest = { kind: 'command', command: match[1] as 'model' | 'clear' | 'compact', ...(match[2] ? { args: match[2] } : {}), ...(notice ? { notice } : {}) };
  routeControl(sessionId, request, () => window.claude.session.sendInput(sessionId, text, notice));
}

/** Keep Claude Code's native cancellation semantics for every deliberate user Stop. */
export function stopClaudeTurn(sessionId: string): void {
  // WHY: real CLI 2.1.303 tests show turn.abort can background a running tool and later resume work.
  // Escape cancels it. This is the chosen transport, never a replay after an ambiguous mods abort.
  if(typeof window.claude.session.queue?.action==='function'){
    void window.claude.session.queue.action(sessionId,{kind:'stop'}).then(r=>{if(r.status==='unavailable')window.claude.session.sendInput(sessionId,'\x1b');else if(r.status!=='done')announce('message'in r?r.message:'Stop was not confirmed.');}).catch(()=>announce('Stop outcome is unknown. Check the conversation.'));
    return;
  }
  window.claude.session.sendInput(sessionId, '\x1b');
}

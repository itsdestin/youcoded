// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { sendToClaudeCode } from '../src/renderer/state/submit-outgoing';
import { useSubmitConfirmation } from '../src/renderer/hooks/useSubmitConfirmation';
import { makeStoreWrapper } from './helpers/chat-store-harness';
import { setConnectionMode } from '../src/renderer/platform';
import * as controls from '../src/renderer/state/claude-control';
import { APP_NOTICE_EVENT } from '../src/renderer/utils/announce';
import { screenInputBlock } from '../src/renderer/state/pty-input-gate';

// This test isolates transport choice from terminal-layout heuristics; the actual retry hook/store run.
vi.mock('../src/renderer/state/pty-input-gate', () => ({ canRetrySubmit: () => true, screenInputBlock: vi.fn(() => null) }));
const S='direct-test';
beforeEach(() => { vi.useFakeTimers(); setConnectionMode('local'); vi.mocked(screenInputBlock).mockReturnValue(null); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); delete (window as any).claude; });
function setup(result: unknown) {
  const sendInput=vi.fn(),control=vi.fn(async()=>result);
  (window as any).claude={session:{sendInput,control}};
  const {store,wrapper}=makeStoreWrapper([S]);
  const view=renderHook(()=>useSubmitConfirmation({activeSessionId:S,activeViewMode:'chat',providerForSession:()=> 'claude'}),{wrapper});
  const send=(paths:string[]=[],text='hello')=>sendToClaudeCode({sessionId:S,provider:'claude',ptyText:text,content:[...paths,text].join(' '),paths,dispatch:a=>store.dispatch(a)});
  const bubble=()=>store.getSession(S).timeline.find(e=>e.kind==='user') as any;
  return {sendInput,control,send,bubble,view};
}
describe('explicit command routing',()=>{
  it.each([['/model sonnet\r','model','sonnet'],['/clear\r','clear',undefined],['/compact keep tests\r','compact','keep tests']])('routes %s without typing it',async(text,command,args)=>{
    const sendInput=vi.fn(),control=vi.fn(async()=>({status:'accepted',requestId:'r'}));
    (window as any).claude={session:{sendInput,control}};
    expect(typeof controls.sendClaudeCommand).toBe('function');
    controls.sendClaudeCommand(S,text,'model-switch');
    await vi.advanceTimersByTimeAsync(0);
    expect(control).toHaveBeenCalledWith(S,{kind:'command',command,...(args?{args}:{}),notice:'model-switch'});
    expect(sendInput).not.toHaveBeenCalled();
  });
  it('keeps unsupported commands raw and Stop explicitly separate',async()=>{
    const sendInput=vi.fn(),control=vi.fn(async()=>({status:'accepted',requestId:'r'}));
    (window as any).claude={session:{sendInput,control}};
    expect(typeof controls.sendClaudeCommand).toBe('function');expect(typeof controls.stopClaudeTurn).toBe('function');
    controls.sendClaudeCommand(S,'/help\r');
    expect(sendInput).toHaveBeenCalledWith(S,'/help\r',undefined);
    controls.stopClaudeTurn(S);await vi.advanceTimersByTimeAsync(0);
    expect(control).not.toHaveBeenCalled();
    expect(sendInput).toHaveBeenCalledWith(S,'\x1b');
  });
  it('keeps deliberate Escape for a native popup separate from turn Stop',()=>{
    const sendInput=vi.fn(),control=vi.fn();
    (window as any).claude={session:{sendInput,control}};
    vi.mocked(screenInputBlock).mockReturnValue({kind:'popup',heading:'Switch model?'});
    controls.stopClaudeTurn(S);
    expect(sendInput).toHaveBeenCalledWith(S,'\x1b');
    expect(control).not.toHaveBeenCalled();
  });
  it('announces an ambiguous command outcome rather than replaying it',async()=>{
    const sendInput=vi.fn(),control=vi.fn(async()=>({status:'unknown',message:'Not confirmed'}));
    (window as any).claude={session:{sendInput,control}};
    const notice=vi.fn();window.addEventListener(APP_NOTICE_EVENT,notice);
    try{
      expect(typeof controls.sendClaudeCommand).toBe('function');controls.sendClaudeCommand(S,'/clear\r');
      await vi.advanceTimersByTimeAsync(0);expect(sendInput).not.toHaveBeenCalled();expect(notice).toHaveBeenCalledTimes(1);
    }finally{window.removeEventListener(APP_NOTICE_EVENT,notice);}
  });
});

describe('Claude chat transport choice',()=>{
  it('uses direct text submission and never injects CR to recover it',async()=>{
    const t=setup({status:'accepted',requestId:'r'});
    act(()=>{t.send();});
    expect(t.control).toHaveBeenCalledWith(S,{kind:'send-text',text:'hello',sendId:expect.any(String)});
    await act(async()=>{await vi.advanceTimersByTimeAsync(20000);});
    expect(t.bubble().sendTransport).toBe('direct');
    expect(t.sendInput).not.toHaveBeenCalled();
    t.view.unmount();
  });
  it('uses the existing PTY path only after definite pre-dispatch unavailability',async()=>{
    const t=setup({status:'unavailable'});act(()=>{t.send();});
    await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
    expect(t.bubble().sendTransport).toBe('pty');
    expect(t.sendInput).toHaveBeenCalledWith(S,'hello\r',undefined,expect.any(String));
    t.view.unmount();
  });
  it.each(['unknown','rejected'])('does not fall back or nudge Enter after %s',async(status)=>{
    const t=setup({status,message:'test'});act(()=>{t.send();});
    await act(async()=>{await vi.advanceTimersByTimeAsync(20000);});
    expect(t.sendInput).not.toHaveBeenCalled();
    expect(t.bubble().sendNote).toBe(status==='unknown'?'unsure':'not-sent');
    t.view.unmount();
  });
  it.each(['Summarize @notes.md', '@"folder/visit notes.md"', 'Compare @資料.md and @other.md', 'Contact ana@example.com'])('preserves CLI expansion conservatively for text containing @: %s',async(text)=>{
    const t=setup({status:'accepted',requestId:'r'});
    act(()=>{t.send([],text);});
    await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
    expect(t.control).not.toHaveBeenCalled();
    expect(t.sendInput).toHaveBeenCalledExactlyOnceWith(S,text+'\r',undefined,expect.any(String));
    expect(t.bubble().sendTransport).not.toBe('direct');
    t.view.unmount();
  });
  it('keeps attachment sends and their existing guarded CR recovery on the PTY',async()=>{
    const t=setup({status:'accepted',requestId:'r'});act(()=>{t.send(['/tmp/a.png']);});
    await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
    expect(t.control).not.toHaveBeenCalled();
    expect(t.sendInput).toHaveBeenCalledWith(S,'/tmp/a.png ');
    expect(t.sendInput).toHaveBeenCalledWith(S,'hello\r',undefined,expect.any(String));
    expect(t.sendInput).toHaveBeenCalledWith(S,'\r');
    t.view.unmount();
  });
  it('does not reinterpret other slash commands as direct chat prompts',async()=>{
    const t=setup({status:'accepted',requestId:'r'});act(()=>{t.send([],'/some-plugin:skill');});
    await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
    expect(t.control).not.toHaveBeenCalled();
    expect(t.sendInput).toHaveBeenCalledWith(S,'/some-plugin:skill\r',undefined,expect.any(String));
    t.view.unmount();
  });
});

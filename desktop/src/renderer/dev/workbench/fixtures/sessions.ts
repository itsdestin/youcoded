import type { SessionInfo } from '../../../../shared/types';

// Two live sessions: one Claude Code, one native. `provider` + `harnessId` are
// what mark a native session (shared/types.ts:67-87) — the transcript carries
// no such marker, so it has to be right here.
//
// Exported as a factory, not a const: every createStore() call needs its own
// array, or one store mutating its session list leaks into the next store built
// in the same page (a reload showing stale data).
//
// MOCKUP: extra native sessions with different providers so the model chip
// restyle (brand colors + icons) is visible across all brands at once.
export function sessions(): SessionInfo[] {
  return [
    {
      id: 'wb-1',
      name: 'fix chat scroll stick',
      cwd: '/home/destin/youcoded-dev/youcoded',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'active',
      createdAt: 1_753_800_000_000,
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    },
    {
      id: 'wb-2',
      name: 'theme contrast pass',
      cwd: '/home/destin/youcoded-dev/wecoded-themes',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_790_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'qwen2.5-coder:14b',
    },
    // --- Mockup: brand-color showcase sessions (native) ---
    {
      id: 'wb-3',
      name: 'gpt-5.6 debug session',
      cwd: '/home/destin/youcoded-dev/wecoded-marketplace',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_785_000_000,
      provider: 'native',
      harnessId: 'coder',
      // Sign in with ChatGPT (design 2026-09-04): this session is bound to the
      // ChatGPT plan's catalog (fixtures/providers.ts), so the status bar, the
      // usage card and the plan-limit card can be reviewed on a real session.
      // Was 'openai/gpt-5.6-sol' (an OpenRouter id); nothing else keyed on it.
      model: 'gpt-5.6-sol',
    },
    {
      id: 'wb-4',
      name: 'gemini flash test',
      cwd: '/home/destin/youcoded-dev/youcoded',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_780_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'google/gemini-2.5-flash',
    },
    {
      id: 'wb-5',
      name: 'claude via openrouter',
      cwd: '/home/destin/youcoded-dev/youcoded',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_775_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'anthropic/claude-sonnet-4-6',
    },
    {
      id: 'wb-6',
      name: 'grok-3 reasoning test',
      cwd: '/home/destin/youcoded-dev/youcoded',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_770_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'x-ai/grok-3',
    },
    {
      id: 'wb-7',
      name: 'kimi-k1.5 moonshot session',
      cwd: '/home/destin/youcoded-dev/youcoded',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_765_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'moonshot/kimi-k1.5',
    },
    {
      id: 'wb-8',
      name: 'deepseek r1 reasoning',
      cwd: '/home/destin/youcoded-dev/youcoded',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_760_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'deepseek/deepseek-r1',
    },
    {
      id: 'wb-9',
      name: 'llama-3.3 70b local',
      cwd: '/home/destin/youcoded-dev/youcoded',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_755_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'meta-llama/llama-3.3-70b-instruct',
    },
    {
      id: 'wb-10',
      name: 'codestral fast edit',
      cwd: '/home/destin/youcoded-dev/youcoded',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_750_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'mistralai/codestral-2501',
    },
    // Specialists 1c: a native conversation that hired helpers — drives the
    // Task-card / status-chip design (fixtures/conversations/specialists.jsonl).
    {
      id: 'wb-11',
      name: 'specialists demo',
      cwd: '/home/destin/youcoded-dev/wecoded-themes',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'active',
      createdAt: 1_753_795_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'qwen3.6-35b-a3b'
    },
  ];
}

// Landing-page embed (scenario=site): ONE native session so the first thing a
// visitor sees is a conversation with a locally running model, not a strip of
// eleven tabs. Field shape mirrors wb-2 above (provider + harnessId mark it native).
export function siteSessions(): SessionInfo[] {
  return [
    {
      id: 'site-1',
      name: 'plan my week',
      cwd: '/home/you/Documents',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'idle',
      createdAt: 1_753_790_000_000,
      provider: 'native',
      harnessId: 'coder',
      model: 'qwen3-coder-30b-a3b-instruct',
    },
  ];
}

// Promo (scenario=site&student=1): the ONE site session plus four more in the
// same student's voice, so the strip has enough pills to drag one along it.
// Only site-1 has a conversation (seed-chat.ts SESSION_FOR) — it stays FIRST so
// it is the session the app opens on, and it is the pill the promo drags, so
// the chat behind the drag never goes blank. The old take filmed the developer
// strip ("fix chat scroll stick", "gpt-5.6 debug session") and dragged an
// empty session; a viewer review sent it back on both counts.
export function studentSessions(): SessionInfo[] {
  const [planMyWeek] = siteSessions();
  const student = (id: string, name: string, cwd: string, createdAt: number, model: string): SessionInfo => ({
    id, name, cwd, createdAt, model,
    permissionMode: 'normal', skipPermissions: false, status: 'idle',
    provider: 'native', harnessId: 'coder',
  });
  return [
    planMyWeek,
    student('site-2', 'econ study guide', '/home/you/School/Econ 201', 1_753_789_000_000, 'qwen3-coder-30b-a3b-instruct'),
    student('site-3', 'club newsletter', '/home/you/Robotics Club', 1_753_788_000_000, 'anthropic/claude-sonnet-4-6'),
    student('site-4', 'compare two laptops', '/home/you/Documents', 1_753_787_000_000, 'qwen3-coder-30b-a3b-instruct'),
    student('site-5', 'cover letter', '/home/you/Job hunt', 1_753_786_000_000, 'openai/gpt-5.6-sol'),
  ];
}

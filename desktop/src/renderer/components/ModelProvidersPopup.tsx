import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscClose } from '../hooks/use-esc-close';
import ProvidersSection from './ProvidersSection';
import LocalModelsSection from './LocalModelsSection';
import type { ProviderStatus } from '../../shared/provider-types';
import { chatGptPlanLabel, type ChatGptAccountStatus } from '../../shared/chatgpt-types';
import { claudePlanLabel } from '../../shared/claude-account-types';
import { useClaudeStatus } from './model/availability';
import { AnchorTip, Button, Dialog, InputGroup, TextInput } from './ui';
import BrailleSpinner from './BrailleSpinner';
import { PlanWindows, type PlanUsage } from './plan-windows';
import { invalidateProviderTypeCache } from '../hooks/use-provider-type';

// The provider blocks of Settings → Assistant settings (2026-09-05). This file
// was the Model Providers popup — one row opening one dialog with four
// sections. That row and dialog are gone: the panel in assistant-settings/
// hosts each block on its own page (Claude Code · ChatGPT · OpenRouter · Local
// models · Web search), so the blocks are exported here and nothing else
// changed — same cards, same copy, same (i) explainers, only the frame around
// them. The file keeps its name so the ChatGPT sign-in branch, which reshapes
// these cards, merges without a rename conflict.

// Shared header for each section: bold name + an (i) explainer.
function SectionHeader({ title, info }: { title: string; info: { label: string; body: React.ReactNode } }) {
  return (
    <div className="flex items-center gap-1.5 mb-2.5">
      {/* K1: was the app's only text-sm/font-semibold section header, which read
          as a second dialog title rather than a section label. */}
      <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase">{title}</h3>
      <AnchorTip label={info.label} title={title}>{info.body}</AnchorTip>
    </div>
  );
}

// One row shape for every provider (review 2026-09-05, P-1 "all providers
// formatted similarly with neutral treatment"): name · one status line in the
// same muted grey · one action on the right · optional plan bars underneath.
// No green "connected" text and no "Default engine" badge — the status line
// says the state in words and the plan bars say how much is left.
function ProviderRow({ title, info, status, detail, action, account, children }: {
  title: string;
  /** The (i) explainer, beside the name INSIDE the card (round 3, P-1): the
   *  eyebrow heading above the card repeated the name, so it is gone. */
  info?: { label: string; body: React.ReactNode };
  status: React.ReactNode;
  /** A second line under the status: OpenAI's refusal reason, a hint. Tone
   *  'bad' is the destructive colour for a reason the user must read. */
  detail?: { text: React.ReactNode; tone?: 'muted' | 'bad' } | null;
  action?: React.ReactNode;
  /** Round 2 (R2-3): a "My Account" button, top right, that opens the
   *  provider's own account page in the browser. Only passed when signed in —
   *  an account page is no use to someone who has no account here yet. */
  account?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="bg-inset/50 rounded-lg px-3 py-2.5">
      {/* items-start: the button sits on the title line, top-right, not
          centred against however many lines the status grows to (P-1/P-2). */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-fg font-medium inline-flex items-center gap-1.5">
            {title}
            {info && <AnchorTip label={info.label} title={title}>{info.body}</AnchorTip>}
          </p>
          <p className="text-2xs mt-0.5 text-fg-muted">{status}</p>
          {detail && (
            <p className={`text-2xs mt-0.5 ${detail.tone === 'bad' ? 'text-destructive-fg' : 'text-fg-muted'}`}>{detail.text}</p>
          )}
        </div>
        {(account || action) && (
          <div className="shrink-0 flex items-center gap-1.5">
            {account && (
              <Button variant="secondary" size="sm"
                onClick={() => void (window as any).claude.shell.openExternal(account)}>
                My Account
              </Button>
            )}
            {action}
          </div>
        )}
      </div>
      {children && <div className="mt-2.5">{children}</div>}
    </div>
  );
}

/** The Claude plan's windows, as the status bar receives them on status:data.
 *  Subscribed here (not threaded from App) because this popup lives three
 *  levels down Settings and nothing else on the way needs the number. */
function useClaudePlanUsage(): PlanUsage | null {
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  useEffect(() => {
    const handler = window.claude.on.statusData((data: any) => {
      setUsage(data?.usage ?? null);
    });
    return () => { window.claude.off('status:data', handler); };
  }, []);
  return usage;
}

// ── 1. Claude Code ───────────────────────────────────────────────────────────

export function ClaudeCodeBlock({
  onOpenClaudePreferences,
  onCloseParent,
}: {
  onOpenClaudePreferences?: () => void;
  onCloseParent: () => void;
}) {
  // The LIVE sign-in, not the setup wizard's saved notes (2026-09-09). This card
  // used to read `FirstRunState.authComplete`, which is a record of what happened
  // during setup — so on every launch after the first it arrived with no auth
  // fields at all and the card said "Not set up yet" on a working install, while
  // the model menu greyed out every Claude model beside it. It also could never
  // notice a `/logout` typed in a terminal. `refresh` is passed on mount so
  // opening Settings always re-asks rather than trusting main's 60s cache.
  const { status, refresh } = useClaudeStatus();
  useEffect(() => { refresh(); }, [refresh]);

  const signedIn = status?.state === 'signed-in';

  // Same three-part shape as the ChatGPT card below — plain-word status line (no
  // ●◐○ glyphs), a detail line for the one extra thing worth saying, one action
  // on the right — because the two sit on the same Cloud providers page and
  // Destin asked for them to read as one system (2026-09-09).
  let line: React.ReactNode = 'Checking…';
  let detail: { text: React.ReactNode; tone?: 'muted' | 'bad' } | null = null;
  if (status?.state === 'signed-in') {
    // Email on the status line, plan on the detail line — the ChatGPT card's
    // layout exactly. An API-key login has neither a plan nor (usually) an
    // email, so it says which kind of connection it is instead of promising
    // limits that do not exist.
    line = status.apiKey
      ? 'Connected with an Anthropic API key'
      : status.email ? `Signed in as ${status.email}` : 'Signed in with your Claude account';
    detail = status.apiKey ? { text: 'Billed per token — no plan limits.' } : { text: claudePlanLabel(status.plan) };
  } else if (status?.state === 'signed-out') {
    line = 'Not signed in';
    detail = { text: "Your Claude plan's models, in YouCoded's assistant." };
  } else if (status?.state === 'not-installed') {
    // Never a guessed cause (docs/error-message-standards.md): the probe found
    // no `claude` on PATH, and that is exactly what this says. Signing in is
    // not the fix, so the words must not suggest it.
    line = 'Claude Code is not installed';
    detail = { text: 'Restart YouCoded to run setup again.', tone: 'bad' };
  } else if (status?.state === 'unknown') {
    // The probe ran and could not answer. We do not know, so we do not claim —
    // and everything keeps working, because "unknown" never blocks a model.
    line = "Signed-in state couldn't be read";
    detail = { text: 'Your models still work; this line will catch up.' };
  }
  const claudeUsage = useClaudePlanUsage();
  const [signOutOpen, setSignOutOpen] = useState(false);

  return (
    <>
      {/* P-1 (2026-09-05): no eyebrow heading — the card's own name is the
          label, and the (i) sits beside it. Same row as ChatGPT and OpenRouter. */}
      <ProviderRow
        title="Claude Code"
        info={{
          label: 'About Claude Code',
          body: (
            <>
              <p>
                Claude Code is Anthropic's AI coding agent — the engine YouCoded is built around. It can
                read your files, run commands, browse, and use tools. Every session runs through it
                unless you pick another provider below.
              </p>
              <p>
                You sign in with your Claude Pro or Max plan (or an Anthropic API key) — there's no extra
                account to create.
              </p>
            </>
          ),
        }}
        status={line}
        detail={detail}
        account={signedIn ? 'https://claude.ai/settings/usage' : undefined}
        action={
          <>
            {onOpenClaudePreferences && (
              <Button variant="secondary" size="sm" onClick={() => { onCloseParent(); onOpenClaudePreferences(); }}>
                Preferences
              </Button>
            )}
            {signedIn && (
              <Button variant="secondary" size="sm" onClick={() => setSignOutOpen(true)}>
                Sign out
              </Button>
            )}
          </>
        }
      >
        {/* Plan bars only for a real plan — an API-key login has no windows to draw. */}
        {status?.state === 'signed-in' && !status.apiKey && <PlanWindows usage={claudeUsage} />}
      </ProviderRow>

      {/* Round 3 (R3-5, pick a): the button stays, but nothing here signs you
          out. Claude Code owns its own login, and the app has never had a way
          to clear it — the CLI's /logout is a terminal-only screen, which is
          exactly what the command list already tells people. So this says
          where to go, in the same words. */}
      <Dialog open={signOutOpen} onClose={() => setSignOutOpen(false)} title="Sign out of Claude Code" size="prompt">
        <div className="space-y-3 text-xs text-fg leading-relaxed">
          <p>
            Open any conversation, switch it to Terminal view, and type <code className="font-mono bg-inset px-1 rounded">/logout</code>.
            That signs Claude Code out on this computer.
          </p>
          <div className="flex justify-end pt-1">
            <Button variant="secondary" onClick={() => setSignOutOpen(false)}>Got it</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

// ── 1b. ChatGPT ──────────────────────────────────────────────────────────────
// Sign in with ChatGPT (design 2026-09-04, questions deck Q-1a/Q-2a/Q-6a): the
// user's own ChatGPT plan, used by YouCoded's assistant. A sign-in, not a key —
// so this is its own block with the Claude Code and OpenRouter rows for
// neighbours, not a row in the API-key list below. The (i) carries the one
// honest sentence about the footing (Q-6a): OpenAI welcomes this out loud but
// has not written it into its terms.

/** Reads the account state through the real `chatgpt` namespace —
 *  reached with a cast like `firstRun`, until it joins the typed bridge. */
function chatGptApi(): {
  status: () => Promise<ChatGptAccountStatus>;
  signIn: () => Promise<boolean>;
  cancelSignIn: () => Promise<boolean>;
  signOut: () => Promise<boolean>;
} {
  return (window as any).claude.chatgpt;
}

export function ChatGptBlock() {
  // Kill switch (ChatGPT sign-in design §6): `YOUCODED_CHATGPT=0` makes preload
  // report `chatgpt.supported: false`, and the card must disappear with it —
  // the main side refuses the plan's models in that build, so a card offering
  // the sign-in would be a dead button. Read as `=== true` (the
  // native.supported pattern), so a shim with no `chatgpt` namespace at all
  // hides it too; the workbench mock declares `supported: true` so the review
  // rig sees it.
  //
  // WHY it lives HERE and not in the caller: master put this test in the Model
  // Providers popup, which Assistant settings deletes — the card is now mounted
  // straight onto the Cloud providers page, so the gate travels with the card
  // or it does not exist at all. Merged 2026-09-07.
  const supported = (window as any).claude?.chatgpt?.supported === true;
  const [status, setStatus] = useState<ChatGptAccountStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setStatus(await chatGptApi().status()); }
    catch (e) { setNote(e instanceof Error ? e.message : 'Could not read the ChatGPT sign-in state.'); }
  }, []);
  // Gated: a build with ChatGPT switched off must not call its IPC at all —
  // the card is gone, not merely blank (guarded by plan-windows-other.test).
  useEffect(() => { if (!supported) return; void refresh(); }, [refresh, supported]);

  // Every state change this card observes (signed-out → waiting → signed-in,
  // a sign-out, a block) changes which provider rows exist, and the status
  // bar's chips and /usage resolve a session's plan through a cached copy of
  // those rows (hooks/use-provider-type.ts). Drop that cache on the
  // transition so a session started right after signing in gets its chips
  // without an app reload (design §4.9 / review R3-4). The first read
  // (null → something) is skipped: nothing changed, the card just mounted.
  const lastState = useRef<ChatGptAccountStatus['state'] | null>(null);
  useEffect(() => {
    const next = status?.state ?? null;
    if (lastState.current !== null && next !== null && next !== lastState.current) invalidateProviderTypeCache();
    if (next !== null) lastState.current = next;
  }, [status?.state]);

  // While the browser round-trip is open, poll — the sign-in completes in a
  // tab this app does not own, so nothing else tells the row it is done.
  useEffect(() => {
    if (status?.state !== 'waiting') return;
    const t = setInterval(() => { void refresh(); }, 1000);
    return () => clearInterval(t);
  }, [status?.state, refresh]);

  const run = async (verb: () => Promise<boolean>, failText: string) => {
    setBusy(true);
    setNote(null);
    try {
      const ok = await verb();
      if (!ok) setNote(failText);
      await refresh();
      // Belt and braces with the transition effect above: a sign-out that
      // lands on the same state it left (a refused sign-in) still changed the
      // rows main will report.
      invalidateProviderTypeCache();
    } catch (e) {
      setNote(e instanceof Error ? e.message : failText);
    } finally {
      setBusy(false);
    }
  };

  // Plain-word status line — no glyphs (the app's standing rule) — and, for
  // the one state with a second thing to say, a detail line under it.
  let line: React.ReactNode = 'Checking…';
  let detail: { text: React.ReactNode; tone?: 'muted' | 'bad' } | null = null;
  if (status?.state === 'signed-in') {
    // Email on the status line, plan on the detail line: the two together
    // wrapped onto a second line beside the button (round-2 self-check).
    line = `Signed in as ${status.email}`;
    detail = { text: chatGptPlanLabel(status.plan) };
  } else if (status?.state === 'waiting') {
    line = (
      <span className="inline-flex items-center gap-1.5">
        <BrailleSpinner size="sm" />
        Waiting for the browser…
      </span>
    );
  } else if (status?.state === 'blocked') {
    // OpenAI's own words, verbatim — never a guessed cause.
    line = `Signed in as ${status.email}`;
    detail = { text: status.reason, tone: 'bad' };
  } else if (status?.state === 'signed-out') {
    line = 'Not signed in';
    detail = { text: "Your plan's models, in YouCoded's assistant." };
  }

  // One action per state (G-4): the primary is the sign-in; everything after
  // it is an outline peer.
  const action = status?.state === 'waiting' ? (
    <Button variant="secondary" size="sm" disabled={busy}
      onClick={() => void run(() => chatGptApi().cancelSignIn(), 'Could not cancel the sign-in.')}>
      Cancel
    </Button>
  ) : status?.state === 'signed-in' || status?.state === 'blocked' ? (
    <Button variant="secondary" size="sm" disabled={busy}
      onClick={() => void run(() => chatGptApi().signOut(), 'Could not sign out.')}>
      Sign out
    </Button>
  ) : (
    <Button size="sm" disabled={busy || !status}
      onClick={() => void run(() => chatGptApi().signIn(), 'Could not open the sign-in page.')}>
      Sign in with ChatGPT
    </Button>
  );

  if (!supported) return null;

  return (
    <>
      <ProviderRow
        title="ChatGPT"
        info={{
          label: 'About ChatGPT sign-in',
          body: (
            <>
              <p>
                Sign in with your ChatGPT account and YouCoded's assistant can use the models your
                plan includes — GPT-5.6 and the rest — with no API key and nothing extra to pay.
              </p>
              <p>
                It runs on your plan's limits: a five-hour window and a weekly one, the same ones
                the Codex app uses. The bars under the row, the usage card and the status bar show
                how much is left.
              </p>
              <p>
                OpenAI has publicly welcomed apps like this using your plan, but it is not written
                into their terms yet. If OpenAI ever turns it off, this row will say so plainly and
                everything else in the app keeps working.
              </p>
            </>
          ),
        }}
        status={line}
        detail={note ? { text: note, tone: 'bad' } : detail}
        account={status?.state === 'signed-in' || status?.state === 'blocked' ? 'https://chatgpt.com/#settings/Account' : undefined}
        action={action}
      >
        {status?.state === 'signed-in' && <PlanWindows usage={status.usage} />}
      </ProviderRow>
    </>
  );
}

// ── 2. OpenRouter ────────────────────────────────────────────────────────────

export function OpenRouterBlock({ keysHeading }: { keysHeading?: string } = {}) {
  // The OpenRouter builtin provider (stable id 'openrouter'). undefined = still
  // loading; null = not found (shouldn't happen — it's builtin).
  const [openrouter, setOpenrouter] = useState<ProviderStatus | null | undefined>(undefined);
  const [connectOpen, setConnectOpen] = useState(false);
  const [testNote, setTestNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await window.claude.providers.list() as ProviderStatus[];
      setOpenrouter(list.find((p) => p.id === 'openrouter' || p.type === 'openrouter') ?? null);
    } catch {
      setOpenrouter(null);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const connected = openrouter?.hasKey === true;

  const runTest = async () => {
    if (!openrouter) return;
    setTestNote(null);
    try {
      const res: any = await window.claude.providers.test(openrouter.id);
      setTestNote({ tone: res?.ok ? 'ok' : 'bad', text: res?.message ?? (res?.ok ? 'Connected.' : 'Could not verify the key.') });
    } catch (e) {
      setTestNote({ tone: 'bad', text: e instanceof Error ? e.message : 'Could not test the connection.' });
    }
  };

  return (
    <>
      {/* OpenRouter connect state — the "To connect…" instructions + key entry
          now live inside the Connect modal, not an always-on banner. */}
      {/* Same row as Claude Code and ChatGPT above (P-1, 2026-09-05); its (i)
          moved into the card with the OPENROUTER/API eyebrow's removal (round 4). */}
      <div>
        <ProviderRow
          title="OpenRouter"
          info={{
            label: 'About OpenRouter',
            body: (
              <>
                <p>
                  OpenRouter is a single gateway to hundreds of AI models — GPT, Gemini, Llama, and many
                  more — from different companies.
                </p>
                <p>
                  Instead of making a separate account with each one, you get one API key and YouCoded routes
                  your sessions through it. You pay OpenRouter directly for what you use. You can also add your
                  own direct provider keys or a custom endpoint below.
                </p>
              </>
            ),
          }}
          status={openrouter === undefined ? 'Checking…' : connected ? 'Connected' : 'Not connected'}
          account={connected ? 'https://openrouter.ai/settings/credits' : undefined}
          detail={testNote ? { text: testNote.text, tone: testNote.tone === 'ok' ? 'muted' : 'bad' } : null}
          action={connected ? (
            <Button variant="secondary" size="sm" onClick={() => { setTestNote(null); setConnectOpen(true); }}>
              Replace key
            </Button>
          ) : (
            <Button size="sm" onClick={() => { setTestNote(null); setConnectOpen(true); }}>
              Connect to OpenRouter
            </Button>
          )}
        >
          {connected && (
            <Button variant="secondary" size="sm" onClick={() => void runTest()}>
              Test
            </Button>
          )}
        </ProviderRow>
      </div>

      {/* Other API providers — direct keys (Anthropic/OpenAI/Google) + custom
          endpoints. Embedded hides the openrouter + local-engine rows.
          `keysHeading`: the Assistant settings page names the list, because
          there the OpenRouter card is the only thing above it. */}
      {keysHeading && (
        <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mt-4 mb-2">{keysHeading}</h3>
      )}
      <ProvidersSection embedded="cloud" />

      {connectOpen && openrouter && (
        <ConnectOpenRouterModal
          providerId={openrouter.id}
          hasKey={connected}
          onClose={() => setConnectOpen(false)}
          onSaved={refresh}
        />
      )}
    </>
  );
}

// Mini modal: the "how to connect" steps + the API-key textbox, opened by the
// Connect-to-OpenRouter button. Layer 3 so it stacks above the L2 Model
// Providers popup. Saving sets the key and verifies it before closing.
function ConnectOpenRouterModal({
  providerId, hasKey, onClose, onSaved,
}: {
  providerId: string;
  hasKey: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  useEscClose(true, onClose);
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const save = async () => {
    const value = keyDraft.trim();
    if (!value) return;
    setBusy(true);
    setNote(null);
    try {
      await window.claude.providers.setKey(providerId, value);
      // Verify immediately so the user gets a real Connected/failed signal.
      const res: any = await window.claude.providers.test(providerId);
      const ok = !!res?.ok;
      setNote({ tone: ok ? 'ok' : 'bad', text: res?.message ?? (ok ? 'Connected.' : 'Saved, but the key could not be verified.') });
      await onSaved();
      if (ok) { setKeyDraft(''); setTimeout(onClose, 700); } // brief success flash, then close
    } catch (e) {
      setNote({ tone: 'bad', text: e instanceof Error ? e.message : 'Could not save the key.' });
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <>
      <Dialog
        open
        onClose={onClose}
        layer={3}
        size="prompt"
        title={hasKey ? 'Replace OpenRouter key' : 'Connect OpenRouter'}
        scrollBody={false}
      >
        <div className="p-4 space-y-3">
          <ol className="text-2xs text-fg-2 leading-relaxed space-y-1 list-decimal pl-4">
            <li>
              Create a free account at{' '}
              <button
                onClick={() => void window.claude.shell.openExternal('https://openrouter.ai')}
                className="text-accent hover:underline"
              >
                openrouter.ai
              </button>
              .
            </li>
            <li>Add a little credit and create an API key.</li>
            <li>Paste the key below and press Connect.</li>
          </ol>

          {/* Change 20 only. NOT an InputGroup: Connect/Cancel sit in the modal
              footer BELOW the field, which is explicitly the shape change 77 does
              not convert. */}
          <TextInput
            type="password"
            autoFocus
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
            placeholder="Paste your OpenRouter API key"
            aria-label="OpenRouter API key"
            className="w-full"
          />

          {note && (
            <p className={`text-3xs ${note.tone === 'ok' ? 'text-green-600' : 'text-red-500'}`}>{note.text}</p>
          )}

          <div className="flex gap-2 pt-1">
            {/* Popup footer pair — md is the footer size; only the flex-1 stretch
                and the taller py-2 are genuine layout extras. */}
            <Button variant="secondary" onClick={onClose} className="flex-1 py-2">
              Cancel
            </Button>
            <Button
              onClick={() => void save()}
              disabled={busy || keyDraft.trim().length === 0}
              className="flex-1 py-2"
            >
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>,
    document.body,
  );
}

// ── 3. Local Models ──────────────────────────────────────────────────────────

export const LOCAL_MODELS_INFO = {
  label: 'About local models',
  body: (
    <>
      <p>
        Local models run entirely on this computer — no internet, no account, and no per-use cost.
        YouCoded downloads the model file and runs it with a bundled engine.
      </p>
      <p>
        Bigger, smarter models need more memory (RAM), and a good graphics card (GPU) makes them
        faster. Each model below shows whether it should run well on your hardware.
      </p>
    </>
  ),
};

// `withHeader`: the page that hosts this block already names it in its title
// line (with the same (i)), so the eyebrow is dropped there.
export function LocalModelsBlock({ withHeader = true }: { withHeader?: boolean } = {}) {
  return (
    <section>
      {withHeader && <SectionHeader title="Local Models" info={LOCAL_MODELS_INFO} />}

      {/* Embedded: no standalone header (this section supplies it). */}
      <LocalModelsSection embedded />
      {/* Custom endpoints on this computer — Ollama, LM Studio — file here,
          not under the OpenRouter card (Destin, 2026-09-05). */}
      <div className="mt-2">
        <ProvidersSection embedded="local" />
      </div>
    </section>
  );
}

// ── 4. Search Providers ──────────────────────────────────────────────────────

// Search providers (native WebSearch keyed upgrades — spec §3.2). NOT model
// providers: Tavily/Exa have no languageModel(), so they live OUTSIDE
// ProviderRegistry/ADD_TYPE_OPTIONS on their own search:* IPC + SecretsStore-backed
// key store. Free search (Exa keyless → DuckDuckGo) works with no key at all; a
// key just makes web search faster and more reliable. search:* is untyped on the
// window.claude shape (like firstRun above), so we reach it via `any` casts.
type SearchBackendId = 'tavily' | 'exa';

// Per-backend copy: a one-line "why add a key" hint + the free-signup URL. Kept
// deliberately non-committal about tiers/quotas (they change) — see the
// "never write misleading text" workspace rule.
const SEARCH_BACKEND_META: Record<SearchBackendId, { hint: string; url: string }> = {
  tavily: { hint: 'Search API tuned for AI — a key makes it the first backend used.', url: 'https://tavily.com' },
  exa: { hint: 'Neural search for AI — a key upgrades the keyless free tier.', url: 'https://exa.ai' },
};

export const WEB_SEARCH_INFO = {
  label: 'About web search',
  body: (
    <>
      <p>
        When Claude searches the web, YouCoded runs the search itself — no extra account needed.
        It works for free out of the box using open search backends.
      </p>
      <p>
        Adding a free Tavily or Exa API key is optional. It makes web search faster and more
        reliable, especially when the free backends are busy. Your key is stored encrypted on this
        computer and never leaves it.
      </p>
    </>
  ),
};

export function SearchProvidersBlock({ withHeader = true, card = false }: { withHeader?: boolean; card?: boolean } = {}) {
  const [rows, setRows] = useState<Array<{ id: SearchBackendId; label: string; hasKey: boolean }>>([]);
  // Which backend's key input is open (only one at a time).
  const [editing, setEditing] = useState<SearchBackendId | null>(null);
  // The in-flight key text. Never held beyond save(): cleared on save/cancel and
  // never logged or persisted anywhere but through search.setKey.
  const [draft, setDraft] = useState('');
  const [testMsg, setTestMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState(false);

  // hasKey comes ONLY from list() — we never infer "connected" from local state.
  const refresh = useCallback(() => (window as any).claude.search?.list()
    .then(setRows).catch(() => setRows([])), []);
  useEffect(() => { void refresh(); }, [refresh]);

  const openEditor = (id: SearchBackendId) => {
    setEditing(id);
    setDraft('');
    // Drop any stale test note for this row when reopening the editor.
    setTestMsg((m) => { const n = { ...m }; delete n[id]; return n; });
  };

  const save = async (id: SearchBackendId) => {
    const key = draft.trim();
    if (!key) return;
    setBusy(true);
    try {
      // testBackend() itself never throws, but the IPC channel underneath
      // (ipcRenderer.invoke) can still reject — so can setKey below. Catch both:
      // { ok, message } IS the logical result; a caught reject becomes an honest
      // note too. Only persist the key when the test actually passed.
      const res = await (window as any).claude.search.test(id, key) as { ok: boolean; message: string };
      if (!res.ok) {
        setTestMsg((m) => ({ ...m, [id]: { ok: false, text: res.message } }));
        return; // keep the input open with the rejection message
      }
      await (window as any).claude.search.setKey(id, key);
      // Success: the "Key saved" badge is the confirmation — drop the ok note so
      // it doesn't linger as a redundant line under the row.
      setTestMsg((m) => { const n = { ...m }; delete n[id]; return n; });
      setDraft('');
      setEditing(null);
      void refresh();
    } catch (e) {
      setTestMsg((m) => ({ ...m, [id]: { ok: false, text: e instanceof Error ? e.message : "Couldn't reach the search service." } }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: SearchBackendId) => {
    setBusy(true);
    try {
      await (window as any).claude.search.removeKey(id);
      setTestMsg((m) => { const n = { ...m }; delete n[id]; return n; });
      void refresh();
    } catch (e) {
      setTestMsg((m) => ({ ...m, [id]: { ok: false, text: e instanceof Error ? e.message : "Couldn't reach the search service." } }));
    } finally {
      setBusy(false);
    }
  };

  // `card` (round 2, R2-1: "websearch should not be a bare header, but a card
  // that contains the tavily/exa cards. tight spacing on it") — the whole block
  // becomes one card on Assistant settings → General, with its name and (i)
  // inside it and the two backend rows one surface deeper. Everywhere else the
  // block keeps the bare-section shape the Model Providers popup gave it.
  return (
    <section className={card ? 'bg-inset/50 rounded-lg px-3 py-2.5' : undefined}>
      {card ? (
        <div className="flex items-center gap-1.5">
          <p className="text-xs text-fg font-medium">Web search</p>
          <AnchorTip label={WEB_SEARCH_INFO.label} title="Web search">{WEB_SEARCH_INFO.body}</AnchorTip>
        </div>
      ) : withHeader && <SectionHeader title="Web Search" info={WEB_SEARCH_INFO} />}

      <p className={`text-3xs text-fg-muted leading-relaxed ${card ? 'mb-1.5' : 'mb-2.5'}`}>
        Web search works for free with no setup. Add an optional key to make it faster and more reliable.
      </p>

      <div className={card ? 'space-y-1.5' : 'space-y-2'}>
        {rows.map((row) => {
          const meta = SEARCH_BACKEND_META[row.id];
          const isEditing = editing === row.id;
          const note = testMsg[row.id];
          return (
            <div key={row.id} className={card ? 'bg-well rounded-md px-2.5 py-2' : 'bg-inset/50 rounded-lg px-3 py-2.5'}>
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-fg font-medium">{row.label}</p>
                  <p className="text-3xs text-fg-muted">{meta.hint}</p>
                </div>
                {row.hasKey ? (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-3xs font-medium text-green-600">Key saved</span>
                    {/* danger-outline per spec change 68: "Remove" reads the same
                        everywhere. This one was the neutral half of the
                        ProvidersSection(red)-vs-here(neutral) contradiction; it
                        deletes a stored API key, so it takes the red outline. */}
                    <Button variant="danger-outline" size="sm" onClick={() => void remove(row.id)} disabled={busy}>
                      Remove
                    </Button>
                  </div>
                ) : !isEditing ? (
                  // Disabled while ANY row's save/remove is in flight — otherwise
                  // opening this editor mid-save gets clobbered when the in-flight
                  // save resolves and clears editing/draft.
                  <Button size="sm" onClick={() => openEditor(row.id)} disabled={busy} className="shrink-0">
                    Add key
                  </Button>
                ) : null}
              </div>

              {isEditing && !row.hasKey && (
                <div className="mt-2 space-y-2">
                  {/* Change 77: Save moves INSIDE the field. Cancel stays outside
                      (one action per field), and so does the "Get a free key"
                      link, which is a navigation aid rather than a field action. */}
                  <InputGroup className="w-full">
                    <InputGroup.Field
                      type="password"
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void save(row.id); }}
                      placeholder={`Paste your ${row.label} API key`}
                      aria-label={`${row.label} API key`}
                    />
                    <Button size="sm" onClick={() => void save(row.id)} disabled={busy || draft.trim().length === 0}>
                      {busy ? 'Checking…' : 'Save'}
                    </Button>
                  </InputGroup>
                  <div className="flex items-center justify-between gap-2">
                    <button
                      onClick={() => void (window as any).claude.shell.openExternal(meta.url)}
                      className="text-3xs text-accent hover:underline"
                    >
                      Get a free key
                    </button>
                    <Button variant="secondary" size="sm" onClick={() => { setEditing(null); setDraft(''); }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {note && (
                <p className={`text-3xs mt-2 ${note.ok ? 'text-fg-muted' : 'text-red-500'}`}>
                  {note.text}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

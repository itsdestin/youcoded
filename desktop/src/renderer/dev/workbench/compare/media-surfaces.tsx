// src/renderer/dev/workbench/compare/media-surfaces.tsx
//
// Round 1 of card #267 (assistant-made pictures, sound and video): five chat surfaces,
// drawn from the app's own parts. Spread into COMPARE_SURFACES by registry.tsx.
//
// WHY a separate file: registry.tsx is 7,500 lines; this round is one feature and only
// its arrangement is new. Everything else is the real part: ToolCard's ask card through
// PendingAskBubble (the browser's approval pattern), Button (charge for money), Select,
// Menu, Callout, Chip, ProgressBar, ContextMenu, and the real DeliverablesCard.
//
// New here (nothing in the app does these jobs yet): the maker picker's rows, the
// waveform, the play/pause marks, the picture/video frames and the card arrangements.
import React from 'react';
import type { CompareSurface } from './types';
import {
  Button, Callout, Chip, ProgressBar, Select, CARD_LEVEL_2,
  Menu, MenuItem, MenuRadioItem,
} from '../../../components/ui';
import ToolCard from '../../../components/ToolCard';
import { PendingAskBubble } from '../../../components/PendingAskBubble';
import { DeliverablesCard } from '../../../components/DeliverablesCard';
import { ContextMenu } from '../../../components/context-menu/ContextMenu';
import type { MenuEntry } from '../../../components/context-menu/build-menu';
import type { ToolCallState } from '../../../../shared/types';
import pictureUrl from '../fixtures/media/picture-landscape.png';
import attachedUrl from '../fixtures/media/attached-photo.png';
import videoFrameUrl from '../fixtures/media/video-frame.png';

// ── fake makers (names, providers and prices are placeholders for the mock) ───────────
interface Maker { id: string; name: string; provider: string; price: string; strength: string }
const MAKERS: Maker[] = [
  { id: 'nb', name: 'Nano Banana 2.1', provider: 'Google', price: 'about $0.03', strength: 'cheapest' },
  { id: 'gpt', name: 'GPT Image 2.5', provider: 'OpenAI', price: 'about $0.05', strength: 'good at text in pictures' },
  { id: 'flux', name: 'FLUX 3', provider: 'Black Forest Labs', price: 'about $0.05', strength: 'lifelike photos' },
  { id: 'seed', name: 'Seedream 5', provider: 'ByteDance', price: 'about $0.04', strength: 'bold, detailed scenes' },
];
const makerLabel = (m: Maker) => `${m.name} · ${m.provider} · ${m.price}`;
const MAKER_OPTIONS = MAKERS.map((m) => ({ value: m.id, label: makerLabel(m) }));
const PROMPT = 'A quiet mountain valley at sunset, purple hills and a low orange sun';
const EDIT_PROMPT = 'Make the sky stormy and add rain';

/** The frosted assistant bubble the chat's own replies sit in (same classes as AssistantTurnBubble). */
function ReplyBubble({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="in-view flex justify-start px-4 py-0.5">
      <div className={`assistant-bubble ${wide ? 'w-[85%]' : 'max-w-[85%]'} break-words rounded-2xl rounded-bl-sm bg-inset text-sm text-fg px-5 py-3`}>{children}</div>
    </div>
  );
}

function useMaker() {
  const [id, setId] = React.useState('nb');
  return { id, setId, maker: MAKERS.find((m) => m.id === id)! };
}

// ═════════════════════════════════════════════════════════════════════════════════════
// 1. media-approval
// ═════════════════════════════════════════════════════════════════════════════════════

/** (a) Through the permission ask card, exactly like the browser's asks. Its buttons are ToolCard's own
 *  (Yes / No), so the picker and the price live in the note area, which is a ReactNode. */
function ApprovalAsk({ edit = false }: { edit?: boolean }) {
  const { id, setId, maker } = useMaker();
  const tool = React.useMemo<ToolCallState>(() => ({
    toolUseId: 'media-ask-1', toolName: 'MediaAsk', input: {}, status: 'awaiting-approval',
    requestId: 'native-media-1', permissionMode: 'ask',
  }), []);
  const ask = React.useMemo(() => ({
    label: edit ? 'Changing a picture' : 'Making a picture',
    detail: maker.price,
    question: `Make this picture? “${edit ? EDIT_PROMPT : PROMPT}”`,
    note: (
      <span className="flex flex-col gap-1.5 pt-1">
        {edit && <img src={attachedUrl} alt="The picture to change" className="h-14 w-auto self-start rounded-md border border-edge-dim" />}
        <span className="text-2xs text-fg-2">Made by</span>
        <Select size="sm" options={MAKER_OPTIONS} value={id} onChange={setId} aria-label="Who makes it" />
        <span>It costs {maker.price}, charged to your {maker.provider} account.</span>
      </span>
    ),
    noAlways: true, // money: never "always"
    answer: async () => true,
  }), [id, maker, setId, edit]);
  return <PendingAskBubble><ToolCard tool={tool} sessionId="workbench" ask={ask} /></PendingAskBubble>;
}

/** (b) A dedicated card: prompt, picker as a labelled row, price beside Approve. */
function ApprovalCard({ edit = false }: { edit?: boolean }) {
  const { id, setId, maker } = useMaker();
  return (
    <PendingAskBubble>
      <div role="group" aria-label="Make a picture?" className="w-[440px] max-w-full">
        <div className="text-sm font-medium text-fg">{edit ? 'Change this picture?' : 'Make a picture?'}</div>
        <div className={`${CARD_LEVEL_2} mt-2 flex items-start gap-2.5 p-2`}>
          {edit && <img src={attachedUrl} alt="The picture to change" className="h-12 w-16 shrink-0 rounded-md object-cover" />}
          <p className="text-xs text-fg-2 leading-relaxed">{edit ? EDIT_PROMPT : PROMPT}</p>
        </div>
        <div className="mt-2.5 flex items-center gap-3">
          <span className="text-xs text-fg-muted shrink-0">Made by</span>
          <Select size="sm" options={MAKER_OPTIONS} value={id} onChange={setId} aria-label="Who makes it" />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-fg-2">{maker.price}</span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm">Decline</Button>
            <Button variant="charge" size="sm">Approve</Button>
          </div>
        </div>
      </div>
    </PendingAskBubble>
  );
}

/** (c) One line: the picker is a small menu of makers, each with price and a strength line. */
function ApprovalCompact({ startOpen = false }: { startOpen?: boolean }) {
  const { id, setId, maker } = useMaker();
  const [open, setOpen] = React.useState(startOpen);
  return (
    <PendingAskBubble>
      <div role="group" aria-label="Make a picture?" className="w-[470px] max-w-full">
        <p className="text-xs text-fg-2 truncate">Make “{PROMPT}”?</p>
        <div className="mt-2 flex items-center gap-2">
          <Menu
            open={open} onOpenChange={setOpen} label="Who makes it" className="w-96"
            trigger={
              <Button variant="secondary" size="sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
                {maker.name} ▾
              </Button>
            }
          >
            {MAKERS.map((m) => (
              <MenuRadioItem key={m.id} checked={m.id === id} onSelect={() => setId(m.id)}
                hint={`${m.provider} · ${m.price} · ${m.strength}`}>{m.name}</MenuRadioItem>
            ))}
          </Menu>
          <span className="text-xs text-fg-muted flex-1 min-w-0 truncate">{maker.price}</span>
          <Button variant="secondary" size="sm">Decline</Button>
          <Button variant="charge" size="sm">Approve</Button>
        </div>
        {/* room for the open list, so a photo of the open state is not cut off */}
        {startOpen && <div style={{ height: 215 }} />}
      </div>
    </PendingAskBubble>
  );
}

/** No paid service connected and signed in with a ChatGPT plan only: the card becomes the notice (guide: "a problem replaces the card"). */
function ApprovalChatGptOnly() {
  return (
    <PendingAskBubble>
      <div className="w-[440px] max-w-full">
        <Callout
          tone="info"
          actionsPlacement="below"
          actions={<>
            <Button variant="secondary" size="sm">Open chatgpt.com</Button>
            <Button variant="primary" size="sm">Connect a service</Button>
          </>}
        >
          Making pictures here needs a paid service (OpenRouter, OpenAI or Google). Your ChatGPT plan includes pictures on chatgpt.com.
        </Callout>
      </div>
    </PendingAskBubble>
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════
// 2. media-picture-result
// ═════════════════════════════════════════════════════════════════════════════════════
const CAPTION = 'Nano Banana 2.1 · $0.03 · valley-sunset.png';
const FILE = '/home/you/Pictures/valley-sunset.png';

function Picture({ className = '' }: { className?: string }) {
  // Full width of the bubble, uncropped; rounded with the theme's own corner token.
  return <img src={pictureUrl} alt="A mountain valley at sunset" data-file-path={FILE} className={`block w-full rounded-lg ${className}`} />;
}

function ResultBare() {
  return (
    <ReplyBubble wide>
      <p className="mb-2.5">Here it is.</p>
      <Picture />
      <p className="mt-1.5 text-2xs text-fg-muted">{CAPTION}</p>
    </ReplyBubble>
  );
}

function ResultFooter() {
  return (
    <ReplyBubble wide>
      <p className="mb-2.5">Here it is.</p>
      <Picture />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-2xs text-fg-muted truncate min-w-0">Nano Banana 2.1 · $0.03</span>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="secondary" size="sm">Show in folder</Button>
          <Button variant="secondary" size="sm">Open</Button>
        </div>
      </div>
    </ReplyBubble>
  );
}

function ResultDeliverables() {
  // The real Deliverables card, fed the same tool call the assistant's SendUserFile makes.
  const tool = React.useMemo<ToolCallState>(() => ({
    toolUseId: 'send-1', toolName: 'SendUserFile', input: { files: [FILE] }, status: 'complete',
  } as ToolCallState), []);
  return (
    <ReplyBubble wide>
      <p className="mb-2.5">Here it is.</p>
      <Picture />
      <p className="mt-1.5 mb-2 text-2xs text-fg-muted">{CAPTION}</p>
      <DeliverablesCard tools={[tool]} sessionId="workbench" />
    </ReplyBubble>
  );
}

/** The right-click menu on the picture: the app's own ContextMenu, opened where a click on the picture would. */
function ResultMenu() {
  const wrap = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null);
  const [open, setOpen] = React.useState(true);
  React.useEffect(() => {
    const img = wrap.current?.querySelector('img');
    const place = () => {
      const r = img?.getBoundingClientRect();
      if (r && r.width > 0) setPos({ x: r.left + r.width * 0.45, y: r.top + r.height * 0.3 });
    };
    place();
    img?.addEventListener('load', place);
    return () => img?.removeEventListener('load', place);
  }, []);
  const entries: MenuEntry[] = [
    { type: 'item', id: 'copy', label: 'Copy', icon: 'copy', run: () => {} },
    { type: 'item', id: 'save', label: 'Save as…', icon: 'save', run: () => {} },
    { type: 'item', id: 'open', label: 'Open', icon: 'open', run: () => {} },
    { type: 'item', id: 'folder', label: 'Show in folder', icon: 'folder', run: () => {} },
  ];
  return (
    <div ref={wrap}>
      <ReplyBubble wide>
        <p className="mb-2.5">Here it is.</p>
        <Picture />
        <p className="mt-1.5 text-2xs text-fg-muted">{CAPTION}</p>
      </ReplyBubble>
      {open && pos && <ContextMenu x={pos.x} y={pos.y} entries={entries} onClose={() => setOpen(false)} />}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════
// 3. media-sound-card
// ═════════════════════════════════════════════════════════════════════════════════════
const PlayMark = () => <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="currentColor" aria-hidden><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>;
const PauseMark = () => <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="currentColor" aria-hidden><rect x="6" y="5" width="4.5" height="14" rx="1.2" /><rect x="13.5" y="5" width="4.5" height="14" rx="1.2" /></svg>;

// A fixed, gentle-looking set of bar heights (0-1) so the pictures are repeatable.
const BARS = Array.from({ length: 56 }, (_, i) => 0.25 + 0.75 * Math.abs(Math.sin(i * 0.9) * Math.cos(i * 0.31 + 1)));

/** The waveform: bars up to `progress` are filled with the accent, the rest stay quiet. */
function Waveform({ progress, height, tone = 'normal', count }: { progress: number; height: number; tone?: 'normal' | 'on-accent'; count?: number }) {
  const bars = count ? BARS.slice(0, count) : BARS;
  const filledCls = tone === 'on-accent' ? 'bg-on-accent' : 'bg-accent';
  const restCls = tone === 'on-accent' ? 'bg-on-accent/35' : 'bg-fg-faint';
  return (
    <div role="slider" aria-label="Position" aria-valuenow={Math.round(progress * 100)} className="flex flex-1 min-w-0 items-center gap-[2px]" style={{ height }}>
      {bars.map((b, i) => (
        <span key={i} className={`flex-1 rounded-full ${i / bars.length < progress ? filledCls : restCls}`} style={{ height: `${Math.round(b * 100)}%`, minWidth: 2 }} />
      ))}
    </div>
  );
}

const Time = ({ now, total, cls = 'text-fg-muted' }: { now: string; total: string; cls?: string }) => (
  <span className={`text-2xs tabular-nums shrink-0 ${cls}`}>{now} / {total}</span>
);

function SoundPill({ playing, progress }: { playing: boolean; progress: number }) {
  return (
    <ReplyBubble wide>
      <div className="flex items-center gap-2.5">
        <Button variant="primary" size="icon" aria-label={playing ? 'Pause' : 'Play'}>{playing ? <PauseMark /> : <PlayMark />}</Button>
        <Waveform progress={progress} height={22} count={40} />
        <Time now={playing ? '0:12' : '0:00'} total="0:31" />
      </div>
    </ReplyBubble>
  );
}

function SoundCard({ playing, progress }: { playing: boolean; progress: number }) {
  return (
    <ReplyBubble wide>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-fg truncate">Rain on a tin roof</span>
        <Time now={playing ? '0:12' : '0:00'} total="0:31" />
      </div>
      <p className="text-2xs text-fg-muted mt-0.5">Lyria 3 · Google · $0.04 · rain-on-a-tin-roof.mp3</p>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="primary" size="icon" aria-label={playing ? 'Pause' : 'Play'}>{playing ? <PauseMark /> : <PlayMark />}</Button>
        <Waveform progress={progress} height={44} />
      </div>
      <div className="mt-2.5 flex justify-end gap-2">
        <Button variant="secondary" size="sm">Show in folder</Button>
      </div>
    </ReplyBubble>
  );
}

/** A voice recording the user sent: right side, the user's own bubble colours (UserMessage's classes). */
function SoundSent({ playing, progress }: { playing: boolean; progress: number }) {
  return (
    <div className="flex justify-end px-4 py-2">
      <div className="user-bubble w-[70%] break-words rounded-2xl rounded-br-sm bg-accent px-4 py-3 text-sm text-on-accent">
        <div className="flex items-center gap-2.5">
          <Button variant="on-accent" size="icon" aria-label={playing ? 'Pause' : 'Play'}>{playing ? <PauseMark /> : <PlayMark />}</Button>
          <Waveform progress={progress} height={24} tone="on-accent" count={36} />
          <Time now={playing ? '0:07' : '0:00'} total="0:18" cls="text-on-accent/70" />
        </div>
      </div>
    </div>
  );
}

function Stacked({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-1">{children}</div>;
}
const Label = ({ children }: { children: React.ReactNode }) => <p className="px-4 pt-2 text-2xs text-fg-muted">{children}</p>;

// ═════════════════════════════════════════════════════════════════════════════════════
// 4. media-video-card
// ═════════════════════════════════════════════════════════════════════════════════════
const VIDEO_META = 'Veo 4 · Google · $0.80';

function VideoMaking({ layout }: { layout: 'card' | 'row' }) {
  const stop = <Button variant="secondary" size="sm">Stop</Button>;
  if (layout === 'row') {
    return (
      <ReplyBubble wide>
        <div className="flex items-center gap-3">
          <div className="h-[54px] w-24 shrink-0 rounded-md bg-well border border-edge-dim" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-fg">Making your video…</p>
            <ProgressBar className="mt-1.5" percent={45} aria-label="Video progress" />
            <p className="mt-1 text-2xs text-fg-muted">About 2 minutes left. You can keep chatting.</p>
          </div>
          {stop}
        </div>
      </ReplyBubble>
    );
  }
  return (
    <ReplyBubble wide>
      <p className="text-sm text-fg">Making your video…</p>
      <ProgressBar className="mt-2" percent={45} aria-label="Video progress" />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-2xs text-fg-muted">About 2 minutes left. You can keep chatting.</span>
        {stop}
      </div>
    </ReplyBubble>
  );
}

function VideoDone({ layout }: { layout: 'card' | 'row' | 'poster' }) {
  if (layout === 'row') {
    return (
      <ReplyBubble wide>
        <div className="flex items-center gap-3">
          <img src={videoFrameUrl} alt="First frame" className="h-[54px] w-24 shrink-0 rounded-md object-cover" />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-fg truncate">ocean-loop.mp4</p>
            <p className="text-2xs text-fg-muted truncate">0:08 · {VIDEO_META}</p>
          </div>
          <Button variant="secondary" size="sm">Open</Button>
        </div>
      </ReplyBubble>
    );
  }
  if (layout === 'poster') {
    return (
      <ReplyBubble wide>
        <p className="mb-2.5">Your video is ready.</p>
        <div className="relative">
          <img src={videoFrameUrl} alt="First frame of the video" className="block w-full rounded-lg" />
          <Chip className="absolute left-2 bottom-2">0:08</Chip>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-2xs text-fg-muted truncate min-w-0">{VIDEO_META} · ocean-loop.mp4</span>
          <Button variant="primary" size="sm">Open</Button>
        </div>
      </ReplyBubble>
    );
  }
  // card: first frame on the left, facts and the one button on the right
  return (
    <ReplyBubble wide>
      <div className="flex gap-3">
        <img src={videoFrameUrl} alt="First frame of the video" className="w-44 shrink-0 self-start rounded-lg" />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="text-sm font-medium text-fg truncate">ocean-loop.mp4</p>
          <div className="mt-1.5 flex gap-1.5"><Chip>0:08</Chip><Chip>Veo 4</Chip></div>
          <p className="mt-1.5 text-2xs text-fg-muted">Google · $0.80</p>
          <div className="mt-auto flex flex-col gap-1.5 pt-3">
            <p className="text-2xs text-fg-muted">Opens in your video player.</p>
            <Button variant="primary" size="sm" className="self-end">Open</Button>
          </div>
        </div>
      </div>
    </ReplyBubble>
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════
// 5. media-limit-card
// ═════════════════════════════════════════════════════════════════════════════════════
const LIMIT_OPTIONS = ['$10', '$15', '$20', '$25', '$30'].map((v) => ({ value: v, label: v }));

function LimitAsk() {
  const [to, setTo] = React.useState('$10');
  const tool = React.useMemo<ToolCallState>(() => ({
    toolUseId: 'media-limit-1', toolName: 'MediaLimit', input: {}, status: 'awaiting-approval',
    requestId: 'native-limit-1', permissionMode: 'ask',
  }), []);
  const ask = React.useMemo(() => ({
    label: 'Spending limit reached',
    detail: '$5.00 of $5.00',
    question: 'This chat has spent its $5 limit on pictures, sound and video. Raise the limit and keep going?',
    note: (
      <span className="flex items-center gap-2 pt-1">
        <span className="text-2xs text-fg-2 shrink-0">Raise this chat’s limit to</span>
        <Select size="sm" options={LIMIT_OPTIONS} value={to} onChange={setTo} className="w-24" aria-label="New limit" />
      </span>
    ),
    noAlways: true,
    answer: async () => true,
  }), [to]);
  return <PendingAskBubble><ToolCard tool={tool} sessionId="workbench" ask={ask} /></PendingAskBubble>;
}

function LimitCard() {
  const [to, setTo] = React.useState('$10');
  return (
    <PendingAskBubble>
      <div role="group" aria-label="Spending limit reached" className="w-[440px] max-w-full">
        <div className="text-sm font-medium text-fg">This chat reached its spending limit</div>
        <p className="mt-1 text-xs text-fg-2">You’ve spent $5.00 of $5.00 on pictures, sound and video in this chat.</p>
        <ProgressBar className="mt-2" percent={100} aria-label="Spent" />
        <div className="mt-3 flex items-center gap-3">
          <span className="text-xs text-fg-muted shrink-0">Raise this chat’s limit to</span>
          <Select size="sm" options={LIMIT_OPTIONS} value={to} onChange={setTo} className="w-24" aria-label="New limit" />
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" size="sm">Stop</Button>
          <Button variant="charge" size="sm">Continue</Button>
        </div>
      </div>
    </PendingAskBubble>
  );
}

function LimitNotice() {
  const [to, setTo] = React.useState('$10');
  return (
    <PendingAskBubble>
      <div className="w-[470px] max-w-full">
        <Callout
          tone="warning"
          actionsPlacement="below"
          actions={<>
            <Select size="sm" options={LIMIT_OPTIONS} value={to} onChange={setTo} className="w-24" aria-label="New limit" />
            <Button variant="secondary" size="sm">Stop</Button>
            <Button variant="charge" size="sm">Raise and continue</Button>
          </>}
        >
          This chat has spent $5.00 of its $5.00 limit on pictures, sound and video.
        </Callout>
      </div>
    </PendingAskBubble>
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════
export const MEDIA_SURFACES: CompareSurface[] = [
  {
    id: 'media-approval', label: 'Making a picture: the approval card',
    question: 'How should the chat ask before it spends money on a picture?',
    frame: 'canvas', paneWidth: 620,
    rounds: [{ n: 1, candidates: [
      { id: 'a-ask', label: 'Through the permission card', note: 'The browser\'s own ask card (Yes / No); maker picker and price in its note area.', render: () => <ApprovalAsk /> },
      { id: 'b-card', label: 'Its own card', note: 'Prompt, "Made by" picker row, price beside Decline and an orange Approve.', render: () => <ApprovalCard /> },
      { id: 'b-card-edit', label: 'Its own card, changing a picture', note: 'Same card with a thumbnail of the attached picture.', render: () => <ApprovalCard edit /> },
      { id: 'b-chatgpt-only', label: 'Its own card, ChatGPT plan only', note: 'No paid service: the card becomes a notice pointing to chatgpt.com.', render: () => <ApprovalChatGptOnly /> },
      { id: 'c-compact', label: 'One line', note: 'A maker button, the price, Decline and Approve on one line.', render: () => <ApprovalCompact /> },
      { id: 'c-compact-open', label: 'One line, list open', note: 'The maker list: name, provider, price and a strength line.', render: () => <ApprovalCompact startOpen /> },
    ] }],
  },
  {
    id: 'media-picture-result', label: 'A finished picture in the reply',
    question: 'How does a made picture arrive in the chat?',
    frame: 'canvas', paneWidth: 620,
    rounds: [{ n: 1, candidates: [
      { id: 'bare', label: 'Picture and a caption', note: 'Full width, one small caption line under it.', render: () => <ResultBare /> },
      { id: 'footer', label: 'Picture with a footer', note: 'Caption on the left; Show in folder and Open on the right.', render: () => <ResultFooter /> },
      { id: 'deliverables', label: 'Picture plus the Deliverables card', note: 'The real Deliverables card under the picture.', render: () => <ResultDeliverables /> },
      { id: 'menu', label: 'Right-click menu', note: 'Copy, Save as…, Open, Show in folder in the app\'s own picture menu.', render: () => <ResultMenu /> },
    ] }],
  },
  {
    id: 'media-sound-card', label: 'A sound in the chat',
    question: 'What does a sound look like in the chat?',
    frame: 'canvas', paneWidth: 620,
    rounds: [{ n: 1, candidates: [
      { id: 'pill', label: 'Compact row', note: 'Play, a small waveform and the time on one line.', render: () => (
        <Stacked><Label>Paused</Label><SoundPill playing={false} progress={0} /><Label>Playing</Label><SoundPill playing progress={0.4} /></Stacked>) },
      { id: 'card', label: 'Card', note: 'Name and maker line, a large waveform, Show in folder.', render: () => (
        <Stacked><Label>Paused</Label><SoundCard playing={false} progress={0} /><Label>Playing</Label><SoundCard playing progress={0.4} /></Stacked>) },
      { id: 'sent', label: 'In your own bubble', note: 'A recording you sent, in the right-hand bubble.', render: () => (
        <Stacked><Label>Paused</Label><SoundSent playing={false} progress={0} /><Label>Playing</Label><SoundSent playing progress={0.4} /></Stacked>) },
    ] }],
  },
  {
    id: 'media-video-card', label: 'A video in the chat',
    question: 'How does a made video show up, while it is made and when it is done?',
    frame: 'canvas', paneWidth: 620,
    rounds: [{ n: 1, candidates: [
      { id: 'card', label: 'Side-by-side card', note: 'First frame left; length, maker and Open right.', render: () => (
        <Stacked><Label>Making it</Label><VideoMaking layout="card" /><Label>Finished</Label><VideoDone layout="card" /></Stacked>) },
      { id: 'row', label: 'Slim row', note: 'A small first frame, the name and length, Open at the right.', render: () => (
        <Stacked><Label>Making it</Label><VideoMaking layout="row" /><Label>Finished</Label><VideoDone layout="row" /></Stacked>) },
      { id: 'poster', label: 'Big first frame', note: 'The first frame full width with its length; Open under it.', render: () => (
        <Stacked><Label>Finished</Label><VideoDone layout="poster" /></Stacked>) },
    ] }],
  },
  {
    id: 'media-limit-card', label: 'The chat\'s spending limit',
    question: 'What does the chat say when it has used its $5?',
    frame: 'canvas', paneWidth: 620,
    rounds: [{ n: 1, candidates: [
      { id: 'ask', label: 'Through the permission card', note: 'Beside approval (a): the same ask card; the dropdown in its note area.', render: () => <LimitAsk /> },
      { id: 'card', label: 'Its own card', note: 'Beside approval (b): amount spent, a full bar, the dropdown, Stop and an orange Continue.', render: () => <LimitCard /> },
      { id: 'notice', label: 'One warning box', note: 'The app\'s warning notice with the dropdown and both buttons inside it.', render: () => <LimitNotice /> },
    ] }],
  },
];

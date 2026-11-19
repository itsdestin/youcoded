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
import { ChatImage } from '../../../components/MarkdownContent';
import { buildContextMenu } from '../../../components/context-menu/build-menu';
import { PanelIcon, PanelIconButton } from '../../../components/panel-icon-button';
import { PlayIcon } from '../../../components/project-view/detail-tool-icons';
import pictureData from '../fixtures/media/picture-landscape.png?inline';
import attachedData from '../fixtures/media/attached-photo.png?inline';
import frameData from '../fixtures/media/video-frame.png?inline';
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
// ROUND 2 (Destin, 2026-11-18: "doesn't feel native to youcoded")
// Everything below is the app's own in-chat container: ToolCard's frame for asks (the real component, extended with
// optional `body` / `money` fields), and DeliverablesCard's frame (rounded-lg border border-edge bg-well; icon | divider |
// label | detail; actions at the right) for results. Pictures go through the real ChatImage and the real picture menu.
// ═════════════════════════════════════════════════════════════════════════════════════
const G = ({ children, size = 14 }: { children: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);
// Drawn in the app's own icon style (24px box, 2px round stroke, currentColor) because Icons.tsx has no picture / sound / video mark.
const ImageGlyph = () => <G><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" /></G>;
const SoundGlyph = () => <G><path d="M11 5 6 9H2v6h4l5 4V5Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" /></G>;
const VideoGlyph = () => <G><rect x="2" y="5" width="14" height="14" rx="2" /><path d="m22 8-6 4 6 4V8Z" /></G>;
const PauseGlyph = () => <G><path d="M8 5v14M16 5v14" /></G>;
const BoxIcon = ({ children }: { children: React.ReactNode }) => <span className="shrink-0 inline-flex text-fg-dim">{children}</span>;

/** The in-bubble container (DeliverablesCard's frame). */
function NativeBox({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 rounded-lg border border-edge bg-well overflow-hidden">{children}</div>;
}
/** Its header line: icon | divider | label | detail ... right-hand actions (ToolCard / DeliverablesCard header classes). */
function NativeHeader({ icon, label, detail, right }: { icon: React.ReactNode; label: string; detail?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 select-none">
      <BoxIcon>{icon}</BoxIcon>
      <span aria-hidden className="w-px h-3.5 bg-edge shrink-0" />
      <span className="text-xs font-medium text-fg-2 shrink-0">{label}</span>
      {detail && <span className="text-xs text-fg-muted truncate flex-1 min-w-0">· {detail}</span>}
      {!detail && <span className="flex-1" />}
      {right && <span className="flex items-center gap-1 shrink-0">{right}</span>}
    </div>
  );
}
/** A reply bubble with a line of text above, at chat width. */
function Reply({ text, children, width = 'w-[88%]' }: { text: string; children: React.ReactNode; width?: string }) {
  return (
    <div className="in-view flex justify-start px-4 py-0.5">
      <div className={`assistant-bubble ${width} break-words rounded-2xl rounded-bl-sm bg-inset text-sm text-fg px-5 py-3`}>
        <p>{text}</p>
        {children}
      </div>
    </div>
  );
}
const OpenBtn = () => <PanelIconButton name="external" title="Open" onClick={() => {}} />;
const FolderBtn = () => <PanelIconButton name="folder" title="View in folder" onClick={() => {}} />;

const PICTURE_NAME = 'valley-sunset.png';
const MadePicture = () => <ChatImage src={pictureData} alt="A mountain valley at sunset" data-file-path={`/home/you/Generated Content/${PICTURE_NAME}`} />;

// ── approval: ToolCard's own ask frame ─────────────────────────────────────────────
function MoneyAsk({ where = 'body', edit = false, chatgptOnly = false }: { where?: 'body' | 'header'; edit?: boolean; chatgptOnly?: boolean }) {
  const { id, setId, maker } = useMaker();
  const tool = React.useMemo<ToolCallState>(() => ({
    toolUseId: 'media-ask-2', toolName: 'MediaAsk', input: {}, status: 'awaiting-approval', requestId: 'native-media-2', permissionMode: 'ask',
  }), []);
  const picker = (cls: string) => <Select size="sm" options={MAKER_OPTIONS} value={id} onChange={setId} className={cls} aria-label="Who makes it" />;
  const ask = React.useMemo(() => {
    if (chatgptOnly) return {
      label: 'Making a picture',
      question: 'Your ChatGPT plan only includes image generation on chatgpt.com. To generate images here, please connect a paid image provider.',
      money: { approve: 'Connect a provider', approveVariant: 'primary' as const, decline: 'Open chatgpt.com' },
      answer: async () => true,
    };
    return {
      label: edit ? 'Changing a picture' : 'Making a picture',
      detail: where === 'header' ? <span className="flex items-center gap-1.5"><span>·</span>{picker('w-80')}</span> : `· ${maker.name} · ${maker.price}`,
      question: `“${edit ? EDIT_PROMPT : PROMPT}”`,
      body: (where === 'body' || edit) ? (
        <div className="flex flex-col gap-2">
          {edit && <img src={attachedData} alt="The picture to change" className="h-14 w-auto self-start rounded-md border border-edge-dim" />}
          {where === 'body' && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-fg-muted shrink-0">Made by</span>
              {picker('flex-1')}
            </div>
          )}
        </div>
      ) : undefined,
      note: `It costs ${maker.price}, charged to your ${maker.provider} account. “Allow for this chat” covers more pictures up to this chat’s $5.00 limit.`,
      money: { approve: 'Approve', decline: 'Decline', chat: 'Allow for this chat' },
      answer: async () => true,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, maker, where, edit, chatgptOnly]);
  return <PendingAskBubble><div className="w-[580px] max-w-full"><ToolCard tool={tool} sessionId="workbench" ask={ask} /></div></PendingAskBubble>;
}

// ── limit: the same frame ──────────────────────────────────────────────────────────
const LIMIT_OPTIONS2 = ['$10', '$15', '$20', '$25', '$30'].map((v) => ({ value: v, label: `Raise to ${v}` }));
function LimitAsk2({ rich }: { rich: boolean }) {
  const [to, setTo] = React.useState('$10');
  const tool = React.useMemo<ToolCallState>(() => ({
    toolUseId: 'media-limit-2', toolName: 'MediaLimit', input: {}, status: 'awaiting-approval', requestId: 'native-limit-2', permissionMode: 'ask',
  }), []);
  const ask = React.useMemo(() => ({
    label: 'Spending limit reached',
    detail: rich ? '· $5.00 of $5.00' : undefined,
    question: 'This chat has spent its $5.00 limit.',
    note: rich ? 'The limit covers pictures, sound and video.' : undefined,
    money: {
      approve: 'Continue', decline: 'Stop',
      lead: <Select size="sm" options={LIMIT_OPTIONS2} value={to} onChange={setTo} className="w-36 py-1" aria-label="New limit" />,
    },
    answer: async () => true,
  }), [to, rich]);
  return <PendingAskBubble><div className="w-[580px] max-w-full"><ToolCard tool={tool} sessionId="workbench" ask={ask} /></div></PendingAskBubble>;
}

// ── picture: ChatImage + container ─────────────────────────────────────────────────
const META = 'Nano Banana 2.1 · $0.03';
function PictureRow() {
  return (
    <Reply text="Here’s your picture.">
      <MadePicture />
      <NativeBox>
        <NativeHeader icon={<ImageGlyph />} label={PICTURE_NAME} detail={META} right={<><OpenBtn /><FolderBtn /></>} />
      </NativeBox>
    </Reply>
  );
}
function PictureFold({ open }: { open: boolean }) {
  return (
    <Reply text="Here’s your picture.">
      <MadePicture />
      <NativeBox>
        <NativeHeader icon={<ImageGlyph />} label={PICTURE_NAME} detail={META} right={<ChevronOpen open={open} />} />
        {open && (
          <div className="flex justify-end gap-2 px-3 pb-2">
            <Button variant="secondary" size="sm"><PanelIcon name="folder" size={12} /> View in folder</Button>
            <Button variant="secondary" size="sm"><PanelIcon name="external" size={12} /> Open</Button>
          </div>
        )}
      </NativeBox>
    </Reply>
  );
}
function ChevronOpen({ open }: { open: boolean }) {
  return <span className="inline-flex text-fg-muted"><G size={14}><path d={open ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'} /></G></span>;
}

/** The REAL menu build-menu draws for a picture the assistant made (built from the live element, not hand-listed). */
function PictureMenu() {
  const wrap = React.useRef<HTMLDivElement>(null);
  const [state, setState] = React.useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  React.useEffect(() => {
    // The workbench has no computer behind it: give the menu the two calls it asks about, so it offers what the desktop would.
    const w = window as any;
    w.claude = w.claude ?? {};
    w.claude.shell = { ...(w.claude.shell ?? {}), pictureAction: w.claude.shell?.pictureAction ?? (async () => ({ ok: true })) };
    const img = wrap.current?.querySelector('img');
    const place = () => {
      if (!img) return;
      const r = img.getBoundingClientRect();
      if (r.width === 0) return;
      const entries = buildContextMenu(img as HTMLElement);
      if (entries) setState({ x: r.left + r.width * 0.4, y: r.top + r.height * 0.25, entries });
    };
    place();
    img?.addEventListener('load', place);
    return () => img?.removeEventListener('load', place);
  }, []);
  return (
    <div ref={wrap} className="chat-scroll">
      <Reply text="Here’s your picture."><MadePicture /></Reply>
      {state && <ContextMenu x={state.x} y={state.y} entries={state.entries} onClose={() => setState(null)} />}
    </div>
  );
}

// ── sound / video: container in the bubble ─────────────────────────────────────────
const Play = ({ playing }: { playing: boolean }) => <PanelIconButton title={playing ? 'Pause' : 'Play'} onClick={() => {}} glyph={playing ? <PauseGlyph /> : <PlayIcon size={14} />} />;
function SoundOneLine({ playing, progress }: { playing: boolean; progress: number }) {
  return (
    <NativeBox>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Play playing={playing} />
        <Waveform progress={progress} height={20} count={48} />
        <Time now={playing ? '0:12' : '0:00'} total="0:31" />
        <FolderBtn />
      </div>
    </NativeBox>
  );
}
function SoundHeader({ playing, progress }: { playing: boolean; progress: number }) {
  return (
    <NativeBox>
      <NativeHeader icon={<SoundGlyph />} label="Sound" detail="Rain on a tin roof · Lyria 3 · $0.04" right={<FolderBtn />} />
      <div className="flex items-center gap-2 px-3 pb-2">
        <Play playing={playing} />
        <Waveform progress={progress} height={28} />
        <Time now={playing ? '0:12' : '0:00'} total="0:31" />
      </div>
    </NativeBox>
  );
}
const OpenButton = () => <Button variant="secondary" size="sm" className="shrink-0"><PanelIcon name="external" size={12} /> Open</Button>;
const StopButton = () => <Button variant="secondary" size="sm" className="shrink-0">Stop</Button>;
/** A: header line + full-width first frame. */
function VideoStacked({ done }: { done: boolean }) {
  return done ? (
    <NativeBox>
      <NativeHeader icon={<VideoGlyph />} label="ocean-loop.mp4" detail="0:08 · Veo 4 · $0.80" right={<><OpenBtn /><FolderBtn /></>} />
      <img src={frameData} alt="First frame of the video" className="block w-full border-t border-edge" />
    </NativeBox>
  ) : (
    <NativeBox>
      <NativeHeader icon={<VideoGlyph />} label="Making your video" detail="About 2 minutes left. You can keep chatting." right={<StopButton />} />
      <div className="px-3 pb-2.5"><ProgressBar percent={45} aria-label="Video progress" /></div>
    </NativeBox>
  );
}
/** B: first frame at the left, facts in the middle, one button flush right; all one height. */
function VideoSide({ done }: { done: boolean }) {
  return (
    <NativeBox>
      <div className="flex items-center gap-3 p-2">
        {done
          ? <img src={frameData} alt="First frame of the video" className="h-16 w-28 shrink-0 rounded-md object-cover" />
          : <div className="h-16 w-28 shrink-0 rounded-md bg-inset border border-edge-dim flex items-center justify-center text-fg-dim"><VideoGlyph /></div>}
        <div className="min-w-0 flex-1">
          {done ? (<>
            <p className="text-xs font-medium text-fg-2 truncate">ocean-loop.mp4</p>
            <p className="text-xs text-fg-muted truncate">0:08 · Veo 4 · $0.80</p>
          </>) : (<>
            <p className="text-xs font-medium text-fg-2">Making your video</p>
            <ProgressBar className="my-1.5" percent={45} aria-label="Video progress" />
            <p className="text-xs text-fg-muted truncate">About 2 minutes left. You can keep chatting.</p>
          </>)}
        </div>
        {done ? <OpenButton /> : <StopButton />}
      </div>
    </NativeBox>
  );
}
const Cap = ({ children }: { children: React.ReactNode }) => <p className="px-4 pt-3 text-2xs text-fg-muted">{children}</p>;


// ═════════════════════════════════════════════════════════════════════════════════════
// ROUND 3 (Destin's picks: approval b-header, picture row, limit ask-slim; no orange; the same two icon actions on every box)
// ═════════════════════════════════════════════════════════════════════════════════════
/** Approval, b-header, in its final states. No orange: the generic ask's own pills (see ToolCard's money branch). */
function Approval3({ state }: { state: 'normal' | 'edit' | 'chatgpt-only' | 'no-provider' }) {
  const { id, setId, maker } = useMaker();
  const tool = React.useMemo<ToolCallState>(() => ({
    toolUseId: 'media-ask-3', toolName: 'MediaAsk', input: {}, status: 'awaiting-approval', requestId: 'native-media-3', permissionMode: 'ask',
  }), []);
  const ask = React.useMemo(() => {
    if (state === 'chatgpt-only' || state === 'no-provider') return {
      label: 'Making a picture',
      question: state === 'chatgpt-only'
        ? 'Your ChatGPT plan only includes image generation on chatgpt.com. To generate images here, please connect a paid image provider.'
        : 'Making images here needs a paid image provider. Connect one to continue.',
      money: state === 'chatgpt-only'
        ? { approve: 'Connect a provider', approveVariant: 'primary' as const, decline: 'Open chatgpt.com' }
        : { approve: 'Connect a provider', approveVariant: 'primary' as const, decline: 'Not now' },
      answer: async () => true,
    };
    const edit = state === 'edit';
    return {
      label: edit ? 'Changing a picture' : 'Making a picture',
      detail: <span className="flex items-center gap-1.5"><span>·</span><Select size="sm" options={MAKER_OPTIONS} value={id} onChange={setId} className="w-80" aria-label="Who makes it" /></span>,
      question: `“${edit ? EDIT_PROMPT : PROMPT}”`,
      body: edit ? <img src={attachedData} alt="The picture to change" className="h-14 w-auto self-start rounded-md border border-edge-dim" /> : undefined,
      note: `It costs ${maker.price}, charged to your ${maker.provider} account. “Allow for this chat” covers more pictures up to this chat’s $5.00 limit.`,
      money: { approve: 'Approve', decline: 'Decline', chat: 'Allow for this chat' },
      answer: async () => true,
    };
  }, [id, maker, state, setId]);
  return <PendingAskBubble><div className="w-[580px] max-w-full"><ToolCard tool={tool} sessionId="workbench" ask={ask} /></div></PendingAskBubble>;
}

function Limit3() {
  const [to, setTo] = React.useState('$10');
  const tool = React.useMemo<ToolCallState>(() => ({
    toolUseId: 'media-limit-3', toolName: 'MediaLimit', input: {}, status: 'awaiting-approval', requestId: 'native-limit-3', permissionMode: 'ask',
  }), []);
  const ask = React.useMemo(() => ({
    label: 'Spending limit reached',
    question: 'This chat has reached its $5 spending limit for image, video and audio generation.',
    money: { approve: 'Continue', decline: 'Stop', lead: <Select size="sm" options={LIMIT_OPTIONS2} value={to} onChange={setTo} className="w-36 py-1" aria-label="New limit" /> },
    answer: async () => true,
  }), [to]);
  return <PendingAskBubble><div className="w-[580px] max-w-full"><ToolCard tool={tool} sessionId="workbench" ask={ask} /></div></PendingAskBubble>;
}

// One action set for every made-thing box: Open and View in folder, icon buttons, at the right of the top / info line.
const Actions = () => <><OpenBtn /><FolderBtn /></>;

/** Sound (a): one box, info line on top (icon | name · maker · cost, actions), a tight player line under it. */
function SoundA({ playing, progress }: { playing: boolean; progress: number }) {
  return (
    <NativeBox>
      <NativeHeader icon={<SoundGlyph />} label="Rain on a tin roof" detail="Lyria 3 · $0.04" right={<Actions />} />
      <div className="flex items-center gap-2 px-3 pb-1.5">
        <Play playing={playing} />
        <Waveform progress={progress} height={18} />
        <Time now={playing ? '0:12' : '0:00'} total="0:31" />
      </div>
    </NativeBox>
  );
}
/** Sound (b): one line; the middle column is the name over a thin wave. */
function SoundB({ playing, progress }: { playing: boolean; progress: number }) {
  return (
    <NativeBox>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Play playing={playing} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-fg-2 truncate">Rain on a tin roof</p>
          <Waveform progress={progress} height={10} />
        </div>
        <Time now={playing ? '0:12' : '0:00'} total="0:31" />
        <Actions />
      </div>
    </NativeBox>
  );
}
/** Sound (c): one line like round 2's one-line; name · maker · cost as small text under the wave. */
function SoundC({ playing, progress }: { playing: boolean; progress: number }) {
  return (
    <NativeBox>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Play playing={playing} />
        <div className="min-w-0 flex-1">
          <Waveform progress={progress} height={18} />
          <p className="mt-0.5 text-2xs text-fg-muted truncate">Rain on a tin roof · Lyria 3 · $0.04</p>
        </div>
        <Time now={playing ? '0:12' : '0:00'} total="0:31" />
        <Actions />
      </div>
    </NativeBox>
  );
}

/** Video: making = header + bar (round 2 stacked); finished = frame beside the facts (round 2 side), actions at the top right of the info line. */
function VideoMaking3() {
  return (
    <NativeBox>
      <NativeHeader icon={<VideoGlyph />} label="Making your video" detail="About 2 minutes left. You can keep chatting." right={<StopButton />} />
      <div className="px-3 pb-2.5"><ProgressBar percent={45} aria-label="Video progress" /></div>
    </NativeBox>
  );
}
function VideoDone3() {
  // Info line on top (icon | name · length · maker · cost, icon actions right), the first frame full width under it, one box.
  return (
    <NativeBox>
      <NativeHeader icon={<VideoGlyph />} label="ocean-loop.mp4" detail="0:08 · Veo 4 · $0.80" right={<Actions />} />
      <img src={frameData} alt="First frame of the video" className="block w-full border-t border-edge" />
    </NativeBox>
  );
}

/** Video, round 4. WHY: Destin wanted round 2's SMALL finished card ("frame beside the facts"), not the
 *  full-width frame; round 3 misread his pick. Small first frame at the left, name and details in the middle,
 *  and the same two icon buttons every other made-thing box carries, in place of the pill Open button. */
function VideoDone4() {
  return (
    <NativeBox>
      <div className="flex items-center gap-3 p-2">
        <img src={frameData} alt="First frame of the video" className="h-16 w-28 shrink-0 rounded-md object-cover" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-fg-2 truncate">ocean-loop.mp4</p>
          <p className="text-xs text-fg-muted truncate">0:08 · Veo 4 · $0.80</p>
        </div>
        <div className="flex shrink-0 items-center"><Actions /></div>
      </div>
    </NativeBox>
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════
export const MEDIA_SURFACES: CompareSurface[] = [
  {
    id: 'media-approval', label: 'Making a picture: the approval card',
    question: 'How should the chat ask before it spends money on a picture?',
    frame: 'canvas', paneWidth: 760,
    rounds: [{ n: 1, candidates: [
      { id: 'a-ask', label: 'Through the permission card', note: 'The browser\'s own ask card (Yes / No); maker picker and price in its note area.', render: () => <ApprovalAsk /> },
      { id: 'b-card', label: 'Its own card', note: 'Prompt, "Made by" picker row, price beside Decline and an orange Approve.', render: () => <ApprovalCard /> },
      { id: 'b-card-edit', label: 'Its own card, changing a picture', note: 'Same card with a thumbnail of the attached picture.', render: () => <ApprovalCard edit /> },
      { id: 'b-chatgpt-only', label: 'Its own card, ChatGPT plan only', note: 'No paid service: the card becomes a notice pointing to chatgpt.com.', render: () => <ApprovalChatGptOnly /> },
      { id: 'c-compact', label: 'One line', note: 'A maker button, the price, Decline and Approve on one line.', render: () => <ApprovalCompact /> },
      { id: 'c-compact-open', label: 'One line, list open', note: 'The maker list: name, provider, price and a strength line.', render: () => <ApprovalCompact startOpen /> },
    ] },
      { n: 2, basis: "Round 1, redrawn as ToolCard's own ask frame (header line, question, buttons flush right). ToolCardAsk gained optional body and money fields.", candidates: [
        { id: 'a-body', label: 'Picker in the card', note: 'Header: maker and price. Body: question, then a "Made by" picker on its own aligned line. Decline, Allow for this chat, orange Approve at the right.', render: () => <MoneyAsk where="body" /> },
        { id: 'b-header', label: 'Picker in the header', note: 'The maker picker sits in the header line, in place of the detail text; the body is just the question.', render: () => <MoneyAsk where="header" /> },
        { id: 'a-body-edit', label: 'Changing a picture', note: 'Candidate a with the attached picture shown.', render: () => <MoneyAsk where="body" edit /> },
        { id: 'a-body-chatgpt-only', label: 'ChatGPT plan only', note: 'No paid provider: the same frame carries Destin\'s sentence; Open chatgpt.com outlined, Connect a provider filled.', render: () => <MoneyAsk chatgptOnly /> },
      ] },
      { n: 3, basis: "Round 2 b-header (picked). No orange: the generic ask's own button pills. New states: no image provider connected, ChatGPT plan only.", candidates: [
        { id: 'b-header', label: 'Maker in the header', note: 'Round 2 b-header with the normal approval-card button pills.', render: () => <Approval3 state="normal" /> },
        { id: 'b-header-edit', label: 'Changing a picture', note: 'The attached picture shown under the question.', render: () => <Approval3 state="edit" /> },
        { id: 'b-header-chatgpt-only', label: 'ChatGPT plan only', note: 'His sentence; Open chatgpt.com outlined, Connect a provider filled.', render: () => <Approval3 state="chatgpt-only" /> },
        { id: 'b-header-no-provider', label: 'No image provider connected', note: 'For a chat with no image service (Claude has none): one sentence and Connect a provider.', render: () => <Approval3 state="no-provider" /> },
      ] },
    ],
  },
  {
    id: 'media-picture-result', label: 'A finished picture in the reply',
    question: 'How does a made picture arrive in the chat?',
    frame: 'canvas', paneWidth: 760,
    rounds: [{ n: 1, candidates: [
      { id: 'bare', label: 'Picture and a caption', note: 'Full width, one small caption line under it.', render: () => <ResultBare /> },
      { id: 'footer', label: 'Picture with a footer', note: 'Caption on the left; Show in folder and Open on the right.', render: () => <ResultFooter /> },
      { id: 'deliverables', label: 'Picture plus the Deliverables card', note: 'The real Deliverables card under the picture.', render: () => <ResultDeliverables /> },
      { id: 'menu', label: 'Right-click menu', note: 'Copy, Save as…, Open, Show in folder in the app\'s own picture menu.', render: () => <ResultMenu /> },
    ] },
      { n: 2, basis: "Round 1, redrawn: the picture is the app's ChatImage; actions live in the in-bubble container; the menu is the real one build-menu makes.", candidates: [
        { id: 'row', label: 'Container row under the picture', note: 'Image icon | file name · maker · cost, with Open and View in folder icon buttons at the right.', render: () => <PictureRow /> },
        { id: 'header-menu', label: 'Caption folded into a header', note: 'The same header with a chevron; opened, it holds the two actions as outlined buttons.', render: () => <PictureFold open /> },
        { id: 'menu', label: 'Right-click menu', note: 'The real picture menu for a made picture: Copy image, Save image as…, Open file, View in folder, Ask about this.', render: () => <PictureMenu /> },
      ] },
      { n: 3, basis: 'Round 2 row (picked). The same two icon actions now sit on every made-thing box.', candidates: [
        { id: 'row', label: 'Box row under the picture', note: 'Round 2 row, unchanged: Open and View in folder icon buttons at the right.', render: () => <PictureRow /> },
      ] },
    ],
  },
  {
    id: 'media-sound-card', label: 'A sound in the chat',
    question: 'What does a sound look like in the chat?',
    frame: 'canvas', paneWidth: 760,
    rounds: [{ n: 1, candidates: [
      { id: 'pill', label: 'Compact row', note: 'Play, a small waveform and the time on one line.', render: () => (
        <Stacked><Label>Paused</Label><SoundPill playing={false} progress={0} /><Label>Playing</Label><SoundPill playing progress={0.4} /></Stacked>) },
      { id: 'card', label: 'Card', note: 'Name and maker line, a large waveform, Show in folder.', render: () => (
        <Stacked><Label>Paused</Label><SoundCard playing={false} progress={0} /><Label>Playing</Label><SoundCard playing progress={0.4} /></Stacked>) },
      { id: 'sent', label: 'In your own bubble', note: 'A recording you sent, in the right-hand bubble.', render: () => (
        <Stacked><Label>Paused</Label><SoundSent playing={false} progress={0} /><Label>Playing</Label><SoundSent playing progress={0.4} /></Stacked>) },
    ] },
      { n: 2, basis: "Round 1, redrawn inside the in-bubble container (DeliverablesCard's frame) with the app's panel icon buttons.", candidates: [
        { id: 'one-line', label: 'One-line container', note: 'Play, waveform, time and View in folder on one line.', render: () => (
          <div><Cap>Paused</Cap><Reply text="Here’s your sound."><SoundOneLine playing={false} progress={0} /></Reply>
          <Cap>Playing</Cap><Reply text="Here’s your sound."><SoundOneLine playing progress={0.4} /></Reply></div>) },
        { id: 'with-header', label: 'Header, then the player', note: 'Header line: sound icon | Sound · name · maker · cost, with View in folder; the player under it.', render: () => (
          <div><Cap>Paused</Cap><Reply text="Here’s your sound."><SoundHeader playing={false} progress={0} /></Reply>
          <Cap>Playing</Cap><Reply text="Here’s your sound."><SoundHeader playing progress={0.4} /></Reply></div>) },
      ] },
      { n: 3, basis: 'Round 2 one-line and with-header: three halfway options, all with Open and View in folder at the right.', candidates: [
        { id: 'a-two-lines', label: 'Info line, then a tight player', note: 'Sound icon | name · maker · cost and actions on top; play, wave and time under it, tighter than with-header.', render: () => (
          <div><Cap>Paused</Cap><Reply text="Here’s your sound."><SoundA playing={false} progress={0} /></Reply>
          <Cap>Playing</Cap><Reply text="Here’s your sound."><SoundA playing progress={0.4} /></Reply></div>) },
        { id: 'b-name-over-wave', label: 'One line, name over a thin wave', note: 'Play, then the name over a thin wave, then time and actions.', render: () => (
          <div><Cap>Paused</Cap><Reply text="Here’s your sound."><SoundB playing={false} progress={0} /></Reply>
          <Cap>Playing</Cap><Reply text="Here’s your sound."><SoundB playing progress={0.4} /></Reply></div>) },
        { id: 'c-details-under', label: 'One line, details under the wave', note: 'Play, the wave with name · maker · cost in small text under it, then time and actions.', render: () => (
          <div><Cap>Paused</Cap><Reply text="Here’s your sound."><SoundC playing={false} progress={0} /></Reply>
          <Cap>Playing</Cap><Reply text="Here’s your sound."><SoundC playing progress={0.4} /></Reply></div>) },
      ] },
    ],
  },
  {
    id: 'media-video-card', label: 'A video in the chat',
    question: 'How does a made video show up, while it is made and when it is done?',
    frame: 'canvas', paneWidth: 760,
    rounds: [{ n: 1, candidates: [
      { id: 'card', label: 'Side-by-side card', note: 'First frame left; length, maker and Open right.', render: () => (
        <Stacked><Label>Making it</Label><VideoMaking layout="card" /><Label>Finished</Label><VideoDone layout="card" /></Stacked>) },
      { id: 'row', label: 'Slim row', note: 'A small first frame, the name and length, Open at the right.', render: () => (
        <Stacked><Label>Making it</Label><VideoMaking layout="row" /><Label>Finished</Label><VideoDone layout="row" /></Stacked>) },
      { id: 'poster', label: 'Big first frame', note: 'The first frame full width with its length; Open under it.', render: () => (
        <Stacked><Label>Finished</Label><VideoDone layout="poster" /></Stacked>) },
    ] },
      { n: 2, basis: 'Round 1, redrawn inside the in-bubble container; every control flush right.', candidates: [
        { id: 'stacked', label: 'Header, then the first frame', note: 'Making: header with Stop and a bar. Finished: header with Open and View in folder, the first frame full width.', render: () => (
          <div><Cap>Making it</Cap><Reply text="Making your video now."><VideoStacked done={false} /></Reply>
          <Cap>Finished</Cap><Reply text="Your video is ready."><VideoStacked done /></Reply></div>) },
        { id: 'side', label: 'Frame beside the facts', note: 'First frame at the left, facts in the middle, Open (or Stop) flush right on the same height.', render: () => (
          <div><Cap>Making it</Cap><Reply text="Making your video now."><VideoSide done={false} /></Reply>
          <Cap>Finished</Cap><Reply text="Your video is ready."><VideoSide done /></Reply></div>) },
      ] },
      { n: 3, basis: 'Round 2: making = stacked, finished = side; Open is now the shared icon button.', candidates: [
        { id: 'making-then-done', label: 'Making, then finished', note: 'Making: header, Stop and a bar. Finished: info line with Open and View in folder icon buttons, the first frame full width under it.', render: () => (
          <div><Cap>Making it</Cap><Reply text="Making your video now."><VideoMaking3 /></Reply>
          <Cap>Finished</Cap><Reply text="Your video is ready."><VideoDone3 /></Reply></div>) },
      ] },
      { n: 4, basis: 'Round 2: making = stacked, finished = side (the small card); Open and View in folder as the shared icon buttons.', candidates: [
        { id: 'making-then-small', label: 'Making, then the small finished card', note: 'Making: header, Stop and a bar. Finished: small first frame, name and details, the two icon buttons at the right.', render: () => (
          <div><Cap>Making it</Cap><Reply text="Making your video now."><VideoMaking3 /></Reply>
          <Cap>Finished</Cap><Reply text="Your video is ready."><VideoDone4 /></Reply></div>) },
      ] },
    ],
  },
  {
    id: 'media-limit-card', label: 'The chat\'s spending limit',
    question: 'What does the chat say when it has used its $5?',
    frame: 'canvas', paneWidth: 760,
    rounds: [{ n: 1, candidates: [
      { id: 'ask', label: 'Through the permission card', note: 'Beside approval (a): the same ask card; the dropdown in its note area.', render: () => <LimitAsk /> },
      { id: 'card', label: 'Its own card', note: 'Beside approval (b): amount spent, a full bar, the dropdown, Stop and an orange Continue.', render: () => <LimitCard /> },
      { id: 'notice', label: 'One warning box', note: 'The app\'s warning notice with the dropdown and both buttons inside it.', render: () => <LimitNotice /> },
    ] },
      { n: 2, basis: 'Round 1 candidate a (Destin: best, but too busy and oddly aligned), simplified: one sentence, one aligned line of controls.', candidates: [
        { id: 'ask', label: 'Ask frame, with the amount', note: 'Header shows $5.00 of $5.00; one sentence; the raise-to list, Stop and orange Continue on one line.', render: () => <LimitAsk2 rich /> },
        { id: 'ask-slim', label: 'Ask frame, slimmest', note: 'No amount in the header and no note: just the sentence and the one line of controls.', render: () => <LimitAsk2 rich={false} /> },
      ] },
      { n: 3, basis: 'Round 2 ask-slim (picked), with his sentence and the normal button pills.', candidates: [
        { id: 'ask-slim', label: 'Ask frame, slimmest', note: 'His sentence; the raise-to list, Stop and Continue on one line at the right.', render: () => <Limit3 /> },
      ] },
    ],
  },
];

// The icon sheet — every shared hand-drawn icon at 48px, in one picture (`shoot dev/icons`).
//
// WHY (marketplace-detail friction, proposal 8): the theme page's heart was a malformed drawing
// — its right lobe flattened — and it passed every check and every 1× picture review, because at
// 12px a broken heart still reads as "a heart-ish mark". At 48px a drawing's shape is plain to
// see. The app has no icon set (every icon is a one-off SVG in its own file), so this sheet lists
// the exported ones by hand. Icons drawn inline inside a component (not exported) are not on it.
//
// Photo-only build only: index.tsx mounts this beside the app when `__SHOOT__` is true, so it
// never ships. It opens by name (`dev/icons`) like every other screen.
import React, { useEffect, useState } from 'react';
import { useScreenOpen, ScreenMark } from '../../shoot-mode';
import * as Icons from '../../components/Icons';
import * as ProjectIcons from '../../components/project-view/icons';
import * as DetailToolIcons from '../../components/project-view/detail-tool-icons';
import * as TypeIcons from '../../components/marketplace/type-icons';
import { MenuIcon, type MenuIconName } from '../../components/context-menu/menu-icons';
import { ProviderIcon } from '../../components/ProviderIcon';
import type { ProviderIconKey } from '../../components/provider-brand';
import { PageGlyph, PagesIcon } from '../../components/pages/page-icons';
import { PinIcon } from '../../components/tags/PinIcon';
import { PencilIcon } from '../../components/EditPencilButton';
import { ThumbIcon } from '../../components/marketplace/FeedbackSection';
import { ShieldIcon } from '../../components/marketplace/TrustBadges';
import { HeartIcon } from '../../components/marketplace/LikeButton';
import { StarIcon, ShareIcon } from '../../components/marketplace/MarketplaceDetailOverlay';
import { ModelIcon } from '../../components/model/ModelPicker';
import { PluginIcon, PaletteIcon } from '../../components/ui/SegmentedTabs';
import type { PageIcon } from '../../../shared/pages-types';
import type { CapabilityKind } from '../../../shared/catalog-types';
import type { FileKind } from '../../../shared/artifacts/categorization';

type Entry = [label: string, node: React.ReactNode];

// The keyed icons, by every key their type allows (kept in step with those types by hand).
const MENU: MenuIconName[] = ['rename', 'copy', 'cut', 'paste', 'select-all', 'ask', 'comment', 'code', 'open', 'link', 'folder', 'path'];
const PROVIDERS: ProviderIconKey[] = ['openai', 'anthropic', 'claudecode', 'google', 'qwen', 'grok', 'kimi', 'deepseek', 'meta', 'mistral', 'cohere', 'perplexity', 'claude', 'openrouter'];
const PAGES: PageIcon[] = ['page', 'timer', 'notes', 'paint', 'chart', 'calendar', 'list', 'game', 'office'];
const CAPS: CapabilityKind[] = ['shell', 'network', 'secret', 'files', 'auto', 'adds'];
const FILES: FileKind[] = ['image', 'sheet', 'document', 'code', 'text', 'markdown', 'pdf', 'audio', 'video', 'archive', 'unknown'];

/** Every exported function in a module whose name ends in "Icon" and that draws with no props. */
function bare(prefix: string, mod: Record<string, unknown>, skip: string[] = []): Entry[] {
  return Object.entries(mod)
    .filter(([name, f]) => /^[A-Z]/.test(name) && name.endsWith('Icon') && typeof f === 'function' && !skip.includes(name))
    .map(([name, f]) => [`${prefix}${name}`, React.createElement(f as React.FC)]);
}

function entries(): Entry[] {
  return [
    ...bare('', Icons),
    ...bare('project/', ProjectIcons, ['FileKindIcon']),
    ...bare('detail/', DetailToolIcons),
    ...bare('type/', TypeIcons, ['OriginIcon', 'CapabilityIcon', 'typeIcon']),
    ...FILES.map((k): Entry => [`file/${k}`, <ProjectIcons.FileKindIcon kind={k} />]),
    ...CAPS.map((k): Entry => [`can/${k}`, <TypeIcons.CapabilityIcon kind={k} />]),
    ...(['youcoded', 'verified', 'community'] as const).map((t): Entry => [`origin/${t}`, <TypeIcons.OriginIcon tier={t} />]),
    ...(['checked', 'caution', 'unchecked'] as const).map((st): Entry => [`shield/${st}`, <ShieldIcon status={st} />]),
    ...MENU.map((n): Entry => [`menu/${n}`, <MenuIcon name={n} />]),
    ...PROVIDERS.map((k): Entry => [`provider/${k}`, <ProviderIcon icon={k} />]),
    ...PAGES.map((k): Entry => [`page/${k}`, <PageGlyph icon={k} />]),
    ['PagesIcon', <PagesIcon />],
    ['PinIcon', <PinIcon />], ['PinIcon filled', <PinIcon filled />],
    ['PencilIcon', <PencilIcon />],
    ['ThumbIcon', <ThumbIcon />], ['ThumbIcon down', <ThumbIcon down />],
    ['HeartIcon', <HeartIcon filled={false} />], ['HeartIcon filled', <HeartIcon filled />],
    ['StarIcon', <StarIcon filled={false} />], ['StarIcon filled', <StarIcon filled />],
    ['ShareIcon', <ShareIcon />],
    ['ModelIcon', <ModelIcon />],
    ['PluginIcon', <PluginIcon />], ['PaletteIcon', <PaletteIcon />],
  ];
}

export default function IconSheet() {
  const [open, setOpen] = useState(false);
  useScreenOpen('dev/icons', () => setOpen(true));
  // Escape closes it like any layer (shoot --check presses Escape once on every screen). A
  // capture-phase listener, not the app's Escape stack: this sits OUTSIDE the app's tree, so
  // the app's own Escape handlers (registered later) would otherwise be on top of it.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  if (!open) return null;
  return (
    <div className="icon-sheet fixed inset-0 overflow-auto bg-canvas text-fg p-4" style={{ zIndex: 100000 }} role="dialog" aria-label="Icon sheet">
      <ScreenMark name="dev/icons" />
      {/* Every icon forced to 48px whatever size it asks for: the shape is what is checked. */}
      <style>{'.icon-sheet svg { width: 48px !important; height: 48px !important; }'}</style>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))' }}>
        {entries().map(([label, node]) => (
          <div key={label} className="flex flex-col items-center gap-1 p-2 rounded-md border border-edge-dim">
            <div className="w-12 h-12 flex items-center justify-center">{node}</div>
            <div className="text-3xs text-fg-muted text-center break-all">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

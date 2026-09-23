import React from 'react';
import MarketplaceDetailOverlay, { type DetailTarget } from '../../../components/marketplace/MarketplaceDetailOverlay';
import { SkillProvider } from '../../../state/skill-context';
import { MarketplaceProvider, useMarketplace } from '../../../state/marketplace-context';
import { MarketplaceStatsProvider } from '../../../state/marketplace-stats-context';
import { AccountProvider } from '../../../state/account-context';
import { ThemeBg } from '../../../components/ThemeBg';
import { Button } from '../../../components/ui';
import './MarketplaceDetailHeaderDemo.css';

function LoadedDetail({ target, open, onClose }: {
  target: DetailTarget; open: boolean; onClose(): void;
}) {
  const marketplace = useMarketplace();
  // WHY: this stand-alone dev candidate mounts before the async registry is
  // loaded, unlike the real Marketplace screen. Never flash false "not found".
  const entryReady = target.kind === 'skill'
    ? marketplace.skillEntries.some((entry) => entry.id === target.id)
    : marketplace.themeEntries.some((entry) => entry.slug === target.slug);
  return open && entryReady && <MarketplaceDetailOverlay target={target} onClose={onClose} />;
}

/** WHY: both candidates show the real Marketplace detail component with actual
 * fixture entries and theme backing. Only Today restores old styling in dev CSS;
 * the proposed variant uses the approved production header and scroll hook. */
export function MarketplaceDetailHeaderDemo({ kind, treatment }: {
  kind: 'skill' | 'theme'; treatment: 'today' | 'proposed';
}) {
  const [open, setOpen] = React.useState(true);
  const target = kind === 'skill'
    ? { kind: 'skill' as const, id: 'civic-report' }
    : { kind: 'theme' as const, slug: 'golden-sunbreak' };
  return <div className="marketplace-detail-header-review p-4" data-treatment={treatment} data-kind={kind}>
    <ThemeBg />
    <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Open Marketplace details</Button>
    <AccountProvider><MarketplaceStatsProvider><SkillProvider><MarketplaceProvider>
      <LoadedDetail target={target} open={open} onClose={() => setOpen(false)} />
    </MarketplaceProvider></SkillProvider></MarketplaceStatsProvider></AccountProvider>
  </div>;
}

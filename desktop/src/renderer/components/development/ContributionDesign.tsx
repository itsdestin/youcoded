import { Button, Dialog } from '../ui';
import { useEscClose } from '../../hooks/use-esc-close';
import { ContributionWalkthrough } from './ContributionWalkthrough';

export function ContributionDesign({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEscClose(open, onClose);
  // WHY: the setup proposal needs one next step, not technical status or demo controls.
  return <Dialog open={open} onClose={onClose} size="panel" title="Contribute to YouCoded">
    <div className="p-4 space-y-4">

      <p className="text-sm text-fg-2">You don’t need to know how to code. Describe a change to your assistant and try it in a separate project. Your installed app and existing folders stay untouched.</p>
      <ContributionWalkthrough />
      {/* WHY: match the app's own dialog action — full width, primary, no prototype caption.
          It must never reach the legacy installer; that is pinned by DevelopmentDesign.test.tsx. */}
      <Button className="w-full py-2.5">Set up development workspace</Button>
    </div>
  </Dialog>;
}

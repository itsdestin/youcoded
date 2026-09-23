import React from 'react';
import SettingsPanel from '../../../components/SettingsPanel';
import { Button } from '../../../components/ui';
import { ThemeBg } from '../../../components/ThemeBg';
import { AccountProvider } from '../../../state/account-context';
import './SettingsTaperDemo.css';

type Taper = 'shipping' | 'quick' | 'balanced' | 'gradual';
type ScrollEdge = 'current' | 'quiet' | 'none' | 'surface';
type FadeStrength = 'original' | 'strong' | 'deep' | 'requested';
type MaskCurve = 'linear' | 'firmer' | 'strongest';
type MaskWidth = 'current' | 'wider' | 'widest';

/** WHY: each live review pane runs the real Settings drawer and its real scroll hook.
 * Only the proposed title-divider and top-edge paint change; no fake list, copied
 * settings rows or altered global component behaviour can bias Destin's verdict. */
export function SettingsTaperDemo({ taper, scrollEdge = 'current', fadeStrength = 'original', maskCurve = 'linear', maskWidth = 'current' }: {
  taper: Taper;
  scrollEdge?: ScrollEdge;
  fadeStrength?: FadeStrength;
  maskCurve?: MaskCurve;
  maskWidth?: MaskWidth;
}) {
  const [open, setOpen] = React.useState(true);
  return (
    <div className="settings-taper-demo p-4" style={{ height: 596 }} data-taper={taper} data-scroll-edge={scrollEdge} data-fade-strength={fadeStrength} data-mask-curve={maskCurve} data-mask-width={maskWidth}>
      {/* WHY: wallpaper themes need the app's actual background behind the glass drawer;
          otherwise the opaque preview canvas hides the mismatch under review. */}
      <ThemeBg />
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Open Settings</Button>
      {/* WHY: the real app mounts this drawer under AccountProvider, but the
          standalone comparison route does not. Keep its context honest here. */}
      <AccountProvider>
        <SettingsPanel
          open={open}
          onClose={() => setOpen(false)}
          onSendInput={() => {}}
          hasActiveSession={false}
        />
      </AccountProvider>
    </div>
  );
}

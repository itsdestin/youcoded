import PluginTurnedOffNotice from './PluginTurnedOffNotice';
import SettingsRepairNotice from './SettingsRepairNotice';

// The one-time heads-ups raised at start-up, mounted together so App.tsx stays under its line budget.
// Each renders nothing itself; it raises a toast once (plugin turned off, damaged settings file replaced).
export default function StartupNotices() {
  return <><PluginTurnedOffNotice /><SettingsRepairNotice /></>;
}

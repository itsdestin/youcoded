// Round 2 of the "Notify user" review (deck notify-user-review N-1): three
// candidate looks for a reply that holds a new notification, compared on one
// Choice slide. `outline` is the default; the workbench's `?notifyStyle=` picks
// another for its pictures. TEMPORARY — once Destin picks one, the winner's CSS
// stays (globals.css, `.notify-bubble`) and this switch is deleted.
export type NotifyStyle = 'outline' | 'tint' | 'tab';

function readStyle(): NotifyStyle {
  if (typeof location === 'undefined') return 'outline';
  const params = new URLSearchParams(location.search);
  if (params.get('mode') !== 'workbench') return 'outline';
  const v = params.get('notifyStyle');
  return v === 'tint' || v === 'tab' ? v : 'outline';
}

export const NOTIFY_STYLE: NotifyStyle = readStyle();

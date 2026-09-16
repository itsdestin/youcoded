// A one-line notice from anywhere in the renderer to the app's one <Toast>.
//
// WHY: App.tsx owns the toast state, and the components that most need to say
// "that worked" — the file drawer's Download and Copy path, the too-big card —
// sit several layers below it with no prop path. The first phone tester
// (2026-09-10, U1/U2/U5) pressed Download and Copy path and saw nothing at all,
// and could not tell whether a copy of the file had reached the phone. A
// window event is the same mechanism RemoteUnsupportedNotice already uses for
// its refusals; App subscribes once and routes the words into the toast.
export const APP_NOTICE_EVENT = 'youcoded:notice';

export interface AppNoticeDetail {
  message: string;
  /** Longer for a message with more to read; the toast's default is 3 s. */
  durationMs?: number;
}

export function announce(message: string, durationMs?: number): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AppNoticeDetail>(APP_NOTICE_EVENT, { detail: { message, durationMs } }));
}

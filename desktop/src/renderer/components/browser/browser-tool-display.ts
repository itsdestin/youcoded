// The Browser's tool-card wording (2026-10-13), shared by native ("BrowserAct")
// and Claude Code ("mcp__youcoded-browser-<id>__BrowserAct") calls — ToolCard's
// friendlyToolDisplay hands every Browser call here (shared/browser-types.ts
// browserToolOf). Past tense once done, "-ing" while running, like every card.

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Plain-language card labels for the Browser's steps. Typed text is never
 *  shown when the field looks like a password, card number or other secret
 *  (design review UX #16) — the card says "(hidden)" instead. */
export function browserToolDisplay(name: string, input: Record<string, unknown>, active: boolean): { label: string; detail: string } {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const hostOfUrl = (u: string) => { try { return new URL(/^[a-z]+:/i.test(u) ? u : `https://${u}`).host; } catch { return u; } };
  const el = str(input.element);
  const quoted = el ? `"${truncate(el, 50)}"` : '';
  switch (name) {
    case 'BrowserNavigate': {
      const go = str(input.go);
      if (go) return { label: active ? `Going ${go}` : `Went ${go}`, detail: '' };
      const host = hostOfUrl(str(input.url));
      return { label: active ? `Opening ${host}` : `Opened ${host}`, detail: '' };
    }
    case 'BrowserSnapshot': return { label: active ? 'Looking at the page' : 'Looked at the page', detail: '' };
    case 'BrowserScreenshot': return { label: active ? 'Taking a picture of the page' : 'Took a picture of the page', detail: '' };
    case 'BrowserWait': return { label: active ? 'Waiting for the page' : 'Waited for the page', detail: '' };
    case 'BrowserAskUser': return { label: active ? 'Waiting for you in the browser' : 'Asked you to help in the browser', detail: `· ${truncate(str(input.message), 60)}` };
    case 'BrowserTabs': {
      const a = str(input.action);
      const label = a === 'close_all' ? (active ? 'Closing the browser tabs' : 'Closed the browser tabs')
        : a === 'close' ? (active ? 'Closing a tab' : 'Closed a tab')
        : a === 'select' ? (active ? 'Switching tabs' : 'Switched tabs')
        : (active ? 'Listing tabs' : 'Listed tabs');
      return { label, detail: '' };
    }
    case 'BrowserAct': {
      const a = str(input.action);
      if (a === 'type') {
        const secret = /pass|pin\b|cvv|cvc|card|security code|ssn|social security|one-time|otp|2fa|verification code/i.test(el);
        const text = str(input.text);
        return {
          label: active ? `Typing into ${quoted || 'a field'}` : `Typed into ${quoted || 'a field'}`,
          detail: secret ? '· (hidden)' : text ? `· ${truncate(text, 50)}` : '',
        };
      }
      if (a === 'select') return { label: active ? `Choosing in ${quoted || 'a list'}` : `Chose in ${quoted || 'a list'}`, detail: '' };
      if (a === 'press_key') return { label: active ? `Pressing ${str(input.key)}` : `Pressed ${str(input.key)}`, detail: '' };
      if (a === 'hover') return { label: active ? `Pointing at ${quoted || 'an element'}` : `Pointed at ${quoted || 'an element'}`, detail: '' };
      return { label: active ? `Clicking ${quoted || 'an element'}` : `Clicked ${quoted || 'an element'}`, detail: '' };
    }
  }
  return { label: name, detail: '' };
}


import { OUTFIT_WOFF2_BASE64 } from './callback-page-assets';

/**
 * The page a browser tab lands on after signing in to ChatGPT or OpenRouter (deck
 * first-run-2 P2-4, Destin 2026-10-04: "also want to fix our callback screens in the
 * browser"). Before, both were a grey page with one line of system text; now they wear
 * setup's brand surface: lavender, the stacked name and tagline (setup's logo, deck
 * first-run-6 P6-2), a white card with a title and one line.
 *
 * Everything is inline (the font as data, no external requests): the page is served
 * by a short-lived localhost listener that closes right after, and nothing on it may load
 * from elsewhere. `title` and `text` are always escaped; callers pass fixed strings, never
 * anything from the callback's query (attacker-influenced — chatgpt-auth.ts §3).
 */
export type CallbackTone = 'done' | 'failed';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const CHECK = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12.5l4 4 9-9"/></svg>';
const STOP = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 6v7.5M12 18h.01"/></svg>';

const STYLE = `
@font-face{font-family:'Outfit';font-weight:400 600;font-display:block;src:url(data:font/woff2;base64,${OUTFIT_WOFF2_BASE64}) format('woff2')}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{font-family:'Outfit',system-ui,sans-serif;color:#21152C;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;padding:24px;
  background:radial-gradient(70% 55% at 50% 0%,#FBF6FD 0%,rgba(251,246,253,0) 70%),radial-gradient(60% 50% at 85% 100%,rgba(210,90,160,.10) 0%,rgba(210,90,160,0) 70%),radial-gradient(60% 50% at 10% 90%,rgba(157,91,208,.12) 0%,rgba(157,91,208,0) 70%),#F4ECF8}
.logo{display:flex;flex-direction:column;align-items:center;font-size:clamp(40px,12vw,64px);line-height:normal}
.name{font-weight:600;font-size:1em;letter-spacing:-.035em;line-height:1}
.tag{margin-top:-.1667em;font-size:.4444em;line-height:normal}
.tag span{display:inline-block;font-weight:600;font-size:.765em;letter-spacing:-.005em;color:#8A7B96}
.you{background:linear-gradient(100deg,#9D5BD0,#D25AA0);-webkit-background-clip:text;background-clip:text;color:transparent;padding-right:.02em}
.card{width:100%;max-width:420px;background:rgba(255,255,255,.86);border:1px solid rgba(255,255,255,.95);border-radius:18px;padding:24px;
  box-shadow:0 1px 2px rgba(60,20,100,.06),0 12px 32px -8px rgba(60,20,100,.16);display:flex;align-items:center;gap:16px}
.mark{flex-shrink:0;width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center}
.done .mark{color:#1F7A4D;background:#E3F5EA;box-shadow:inset 0 0 0 1px #C6E9D3}
.failed .mark{color:#C2410C;background:#FDEDE4;box-shadow:inset 0 0 0 1px #F8D4C2}
h1{margin:0;font-weight:500;font-size:20px;letter-spacing:-.015em}
p{margin:2px 0 0;font-size:14px;color:#574A63;line-height:1.4}
`;

export function callbackPage(tone: CallbackTone, title: string, text: string): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${escapeHtml(title)} · YouCoded</title><style>${STYLE}</style></head>`
    + '<body><div class="logo" role="img" aria-label="YouCoded"><span class="name"><span class="you">you</span>coded</span>'
    + '<div class="tag"><span>agents for everyone</span></div></div>'
    + `<main class="card ${tone}"><span class="mark" aria-hidden="true">${tone === 'done' ? CHECK : STOP}</span>`
    + `<div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></div></main></body></html>`;
}

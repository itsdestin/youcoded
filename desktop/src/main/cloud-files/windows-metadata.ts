/**
 * Pathname observation, NOT content-read authorization. There is no
 * atomic check/open interval here and no no-recall read capability. path-access
 * uses it for conservative preflight, separately from the stable-identity adapter;
 * a pathname is
 * deliberately not returned as identity. No provider is inferred from names.
 */
export interface MetadataObservation {
  kind: 'observed' | 'not-found' | 'error' | 'unsupported';
  residency: 'local' | 'partial' | 'unknown';
  entryType: 'file' | 'directory' | 'unknown';
  attributes: number | null;
  reason: 'ordinary-attributes' | 'recall-on-data-access' | 'directory-recall-on-data-access'
    | 'offline' | 'unrecognized-reparse-point' | 'not-found' | 'access-denied'
    | 'native-query-failed' | 'native-unavailable' | 'platform-unsupported'
    | 'owned-worker-required' | 'invalid-path' | 'invalid-batch';
  identityCapability: 'unavailable';
}

interface KoffiBinding {
  load(library: string): { func(signature: string): (...args: string[]) => number };
}

interface ProbeHost {
  /**
   * Trusted host injection, NEVER an IPC/request flag. The eventual worker entry
   * must attest it is an owned isolated I/O process (not Electron main/renderer).
   * Guarded on every probe; the production io-worker owns this attestation.
   * Deadlines/termination belong to that worker's supervisor: Win32 may block.
   */
  isOwnedWorker(): boolean;
  platform?: string;
  loadKoffi?: () => KoffiBinding;
}

const INVALID_FILE_ATTRIBUTES = 0xffffffff;
const DIRECTORY = 0x10;
const REPARSE_POINT = 0x400;
const OFFLINE = 0x1000;
const RECALL_ON_DATA_ACCESS = 0x400000;
const MAX_PATH_UNITS = 32766; // UTF-16 units, leaving room for the native NUL.
const MAX_BATCH = 64;
const MAX_BATCH_PATH_UNITS = 131072;

function unavailable(kind: MetadataObservation['kind'], reason: MetadataObservation['reason']): MetadataObservation {
  return { kind, residency: 'unknown', entryType: 'unknown', attributes: null, reason, identityCapability: 'unavailable' };
}

function validPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.length || value.length > MAX_PATH_UNITS || value.includes('\0')) return false;
  // Explicit absolute filesystem paths only; never expand globs or device names.
  const path = value.startsWith('\\\\?\\UNC\\') ? `\\\\${value.slice(8)}`
    : value.startsWith('\\\\?\\') ? value.slice(4) : value;
  if (/[?*]/.test(path) || path.startsWith('\\\\.\\')) return false;
  const drive = /^[a-z]:[\\/]/i.test(path);
  if (!drive && !/^\\\\[^\\/]+\\[^\\/]+(?:\\|$)/.test(path)) return false;
  // WHY: DOS device aliases remain special under ordinary paths and extensions,
  // not just \\.\ prefixes. Exclude them before calling even metadata APIs.
  const components = path.split(/[\\/]/).slice(drive ? 1 : 4);
  return !components.some(component => /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)$/i
    .test(component.split(/[.:]/, 1)[0].replace(/ +$/, '')));
}

function classify(attributes: number): MetadataObservation {
  const entryType = attributes & DIRECTORY ? 'directory' : 'file';
  // WHY: Microsoft file attribute constants document RECALL_ON_DATA_ACCESS as
  // not fully local (including directory metadata). OFFLINE also means data is
  // not immediately available. Neither bit distinguishes all-cloud from partial,
  // so use partial conservatively. PINNED/UNPINNED express intent, not residency.
  // https://learn.microsoft.com/en-us/windows/win32/fileio/file-attribute-constants
  // RECALL_ON_OPEN (0x40000) is enumeration-only and aliases FILE_ATTRIBUTE_EA:
  // DO NOT interpret that bit from GetFileAttributesW as recall evidence.
  let residency: MetadataObservation['residency'] = 'local';
  let reason: MetadataObservation['reason'] = 'ordinary-attributes';
  if (attributes & RECALL_ON_DATA_ACCESS) {
    residency = 'partial';
    reason = entryType === 'directory' ? 'directory-recall-on-data-access' : 'recall-on-data-access';
  } else if (attributes & OFFLINE) {
    residency = 'partial';
    reason = 'offline';
  } else if (attributes & REPARSE_POINT) {
    // No safe tag query in this slice: never guess the target or provider.
    residency = 'unknown';
    reason = 'unrecognized-reparse-point';
  }
  return { kind: 'observed', residency, entryType, attributes, reason, identityCapability: 'unavailable' };
}

/**
 * Lazy Windows-only consumer metadata capability. The only filesystem operation
 * bound is GetFileAttributesW on the supplied exact path, with no data handle,
 * enumeration, Node stat/read fallback, or availability test by opening content.
 * This does not establish absence of provider metadata population/hydration on a
 * real Windows machine, nor permission to enumerate even an observed directory.
 */
export function createWindowsMetadataProbe(host: ProbeHost) {
  let native: { query(path: string): number; lastError(): number } | null | undefined;
  const platform = host.platform ?? process.platform;

  function probe(path: unknown): MetadataObservation {
    if (!validPath(path)) return unavailable('error', 'invalid-path');
    if (platform !== 'win32') return unavailable('unsupported', 'platform-unsupported');
    try {
      if (!host.isOwnedWorker()) return unavailable('unsupported', 'owned-worker-required');
    } catch {
      return unavailable('unsupported', 'owned-worker-required');
    }
    if (native === undefined) {
      try {
        const koffi: KoffiBinding = host.loadKoffi ? host.loadKoffi() : require('koffi');
        const kernel32 = koffi.load('kernel32.dll');
        // WHY: DWORD is unsigned 32-bit even on Win64; LPCWSTR is UTF-16, not
        // host wchar_t. Explicit stdcall also covers Win32. Source signatures:
        // https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileattributesw
        // https://learn.microsoft.com/en-us/windows/win32/api/errhandlingapi/nf-errhandlingapi-getlasterror
        native = {
          query: kernel32.func('uint32_t __stdcall GetFileAttributesW(const char16_t *lpFileName)'),
          lastError: kernel32.func('uint32_t __stdcall GetLastError(void)'),
        };
      } catch {
        // Native exception strings can contain user paths; do not log/return them.
        native = null;
      }
    }
    if (!native) return unavailable('unsupported', 'native-unavailable');
    try {
      const attributes = native.query(path);
      if (attributes === INVALID_FILE_ATTRIBUTES) {
        // Synchronous same-thread call immediately after failure; no intervening
        // native operation/logging that could overwrite the thread's last error.
        const error = native.lastError();
        if (error === 2 || error === 3) return unavailable('not-found', 'not-found');
        return unavailable('error', error === 5 ? 'access-denied' : 'native-query-failed');
      }
      if (!Number.isInteger(attributes) || attributes < 0 || attributes > INVALID_FILE_ATTRIBUTES) {
        return unavailable('error', 'native-query-failed');
      }
      return classify(attributes);
    } catch {
      return unavailable('error', 'native-query-failed');
    }
  }

  function probeBatch(paths: unknown): { kind: 'batch'; observations: MetadataObservation[] } | MetadataObservation {
    // Validate the entire bounded request before any native query (no partial
    // work for malformed batches). Limits also bound allocation and response size.
    if (!Array.isArray(paths) || paths.length > MAX_BATCH) return unavailable('error', 'invalid-batch');
    let units = 0;
    for (const path of paths) {
      if (!validPath(path)) return unavailable('error', 'invalid-batch');
      units += path.length;
      if (units > MAX_BATCH_PATH_UNITS) return unavailable('error', 'invalid-batch');
    }
    return { kind: 'batch', observations: paths.map(probe) };
  }

  return { probe, probeBatch };
}

// Shared platform-code → display-name helpers.
//
// Used everywhere user-facing text might otherwise leak raw Node
// `process.platform` codes (e.g. "darwin"). Also shared between desktop main
// process, renderer (React), and Android WebView via the React bundle.

const NAMES: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
  android: 'Android',
};

export function platformDisplayName(code: string): string {
  return NAMES[code] ?? code;
}

// Human-readable join. Examples:
//   ['darwin']                   -> 'macOS'
//   ['darwin', 'linux']          -> 'macOS or Linux'
//   ['darwin', 'linux', 'win32'] -> 'macOS, Linux, or Windows'
export function platformListDisplay(codes: string[]): string {
  const names = codes.map(platformDisplayName);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
}

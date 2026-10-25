// A manifest corpus covering every connection kind and every option that rides a
// fingerprint, used to pin parse → fingerprint/covers/methodAllowed across the kind-registry
// refactor (pages-finish step 1). Each entry is one page's raw `connections` list.
export const CORPUS: Record<string, unknown[]> = {
  youcoded: [{ id: 'a', kind: 'youcoded' }],
  youcodedWrite: [{ id: 'a', kind: 'youcoded', writePaths: ['/campaigns/', '/b', 'bad path', '/a/../x'] }],
  open: [{ id: 'o', kind: 'open' }, { id: 's', kind: 'session' }],
  openPlusKey: [{ id: 'o', kind: 'open' }, { id: 'k', kind: 'key', service: 'X', address: 'api.x.com' }],
  github: [{ id: 'g', kind: 'github', access: 'full' }, { id: 'h', kind: 'github' }],
  public: [{ id: 'p', kind: 'public', address: 'Feeds.BBCI.co.uk.' }, { id: 'q', kind: 'public', address: '10.0.0.1' }],
  key: [{ id: 'k', kind: 'key', service: 'Todoist', address: 'api.todoist.com', access: 'full', keyHelp: { steps: ['a'] } }],
  keyLookup: [{ id: 'k', kind: 'key', service: 'OpenWeather', address: 'api.openweathermap.org', access: 'lookup', keyIn: 'query', keyParam: 'appid' }],
  keyHeader: [{ id: 'k', kind: 'key', service: 'S', address: 'api.s.com', keyIn: 'header', keyParam: 'X-Api-Key', keyScheme: 'none' }],
  keyToken: [{ id: 'k', kind: 'key', service: 'S', address: 'api.s.com', keyScheme: 'token' }],
  device: [{ id: 'd', kind: 'device', service: 'Home Assistant', address: '192.168.1.20:8123', access: 'full', keyPage: '/profile/security',
    socketHello: '{"type":"auth","access_token":"{{key}}"}', socketReady: 'auth_ok', socketAuthFailed: 'auth_invalid', socketDeny: ['config/', 'Auth/'],
    videoProfile: { targetPrefix: 'camera.', send: '{"type":"camera/webrtc/offer"}', answer: 'event.answer', candidate: 'event.candidate', failed: 'event.error' } }],
  deviceNoKey: [{ id: 'd', kind: 'device', service: 'Printer', address: 'printer.local', needsKey: false }],
  deviceBadReady: [{ id: 'd', kind: 'device', service: 'X', address: '192.168.1.2', socketReady: 'has space' }],
  plaid: [{ id: 'p', kind: 'plaid', environment: 'sandbox' }, { id: 'q', kind: 'plaid', environment: 'production' }],
  plaidProd: [{ id: 'p', kind: 'plaid', environment: 'production' }],
  chats: [{ id: 'c', kind: 'chats' }],
  chatsProjects: [{ id: 'c', kind: 'chats', access: 'full', scope: { projects: ['b', 'a', 'a'] } }],
  chatsTag: [{ id: 'c', kind: 'chats', scope: { tag: 'work' } }],
  chatsBad: [{ id: 'c', kind: 'chats', scope: { projects: [] } }],
  program: [{ id: 'p', kind: 'program', file: 'work-items.mjs' }, { id: 'q', kind: 'program', file: 'page.json' }, { id: 'r', kind: 'program', file: 'work-items.mjs' }],
  dupIds: [{ id: 'x', kind: 'open' }, { id: 'x', kind: 'session' }, { kind: 'session' }, { id: 'y', kind: 'nope' }],
};

export const TARGETS = [
  'api.todoist.com', 'api.youcoded.ai', 'api.github.com', 'feeds.bbci.co.uk', 'api.x.com.evil.test',
  'http://192.168.1.20:8123/api/states', 'http://192.168.1.20:9000/', 'http://printer.local/', 'https://api.openweathermap.org/data',
];

export const METHODS: Array<[string, string]> = [
  ['GET', '/'], ['HEAD', '/'], ['POST', '/'], ['DELETE', '/x'], ['POST', '/campaigns'], ['POST', '/campaigns/1'],
  ['POST', '/campaignsX'], ['PUT', '/b/%2e%2e'], ['PATCH', '/b'], ['TRACE', '/'],
];

// ios-undici.ts — what `import … from 'undici'` resolves to inside the iPhone bundle.
//
// WHY (2026-11-25, iPhone app, card #89): undici (the library behind Node's fetch) parses HTTP with WebAssembly, and
// the iPhone's Node has none, so undici itself cannot run there. Backend code that reaches for undici directly does
// so for one thing: a fetch whose connections go only to addresses a guard has approved (an `Agent` with a
// connect-time `lookup`, harness/tools/net-guard.ts). This offers exactly that pair on top of ios-fetch.ts, which
// applies the same lookup to every connection it opens, redirects included. The build aliases the module name
// (ios/runtime/build-backend.mjs); nothing on a computer or on Android ever loads this file.
import { iosFetch, type ConnectLookup } from './ios-fetch';

interface AgentOptions { connect?: { lookup?: ConnectLookup } }

/** Holds the options a caller built; `fetch` below reads the lookup from it. No sockets are pooled here: Node's own
 *  http agent already keeps connections alive. */
export class Agent {
  constructor(public readonly options: AgentOptions = {}) {}
  close(): Promise<void> { return Promise.resolve(); }
  destroy(): Promise<void> { return Promise.resolve(); }
}

export function fetch(input: string | URL | Request, init: (RequestInit & { dispatcher?: unknown }) = {}): Promise<Response> {
  const { dispatcher, ...rest } = init;
  const lookup = dispatcher instanceof Agent ? dispatcher.options.connect?.lookup : undefined;
  return iosFetch(input, rest, { lookup });
}

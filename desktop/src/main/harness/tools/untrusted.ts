// The <untrusted-content> framing for text that came from outside (web pages,
// fetched documents, MCP servers). ONE implementation, used by defineTool's
// `untrusted` option (registry.ts) and by the Browser tools, which build their
// result text once for both session kinds (assistant-browser/browser-tool-runners.ts).
//
// WHY neutralise look-alike tags inside the text (design review 1 #2): the
// frame is plain concatenation, so a page containing "</untrusted-content>"
// would END the frame early and everything after it would read as the app's
// own words — the exact confusion the frame exists to prevent. A zero-width
// space after "<" or "</" keeps the text readable for the model and the
// person while making it impossible to match the real closing tag.
const TAG_LOOKALIKE = /<(\/?)(untrusted-content)/gi;

export function neutraliseUntrustedTags(text: string): string {
  return text.replace(TAG_LOOKALIKE, '<$1​$2');
}

export function wrapUntrusted(source: string, text: string): string {
  return `<untrusted-content source="${source}">\n${neutraliseUntrustedTags(text)}\n</untrusted-content>`;
}

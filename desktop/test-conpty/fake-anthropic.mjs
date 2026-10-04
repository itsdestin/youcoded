// fake-anthropic.mjs — a stand-in for the Anthropic Messages API that streams
// SCRIPTED replies, so the real `claude` TUI can be driven through busy
// situations (streaming text, tool calls, permission menus, AskUserQuestion,
// plan approval) for free and the same way every run.
//
// WHY: the pop-up detector must be tested against screens Claude Code itself
// draws mid-turn — a reply that quotes a menu, a numbered list streaming in, a
// permission menu arriving while text is still on screen. A real model costs
// usage and never says the same thing twice; this server says exactly what the
// scenario asks. Point Claude Code at it with
//   ANTHROPIC_BASE_URL=<url>  ANTHROPIC_AUTH_TOKEN=anything
// (an auth TOKEN, not an API key: a custom key needs a one-time approval
// dialog, a token does not).
//
// A script is a list of TURNS. Each main-conversation request takes the next
// turn; side requests (title generation, summaries — anything sent with few or
// no tools) get a one-word reply and do not consume a turn. A turn:
//   { text?, wordMs?, delayMs?, thinking?, tools?: [{name, input}],
//     status?, errorBody?, usage? }
// A turn may also be a function (requestBody) => turn, for replies that depend
// on what Claude Code sent (e.g. answering its tool result).

import http from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is this the main conversation (the one with Claude Code's full tool list)? */
function isMainRequest(body) {
  return Array.isArray(body.tools) && body.tools.length > 5;
}

/**
 * Start the server on a free port. Returns { url, requests, close }.
 * `requests` records every call (method, path, main?, first 300 chars) so a
 * scenario can check what Claude Code actually asked for.
 */
export async function startFakeApi(script, { onRequest } = {}) {
  let turn = 0;
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* HEAD / GET probes */ }
      const main = isMainRequest(body);
      requests.push({ method: req.method, path: req.url, main, head: raw.slice(0, 300) });
      onRequest?.(req, body);
      if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      let step = main ? (script[turn++] ?? { text: 'Done.' }) : { text: 'Title' };
      if (typeof step === 'function') step = step(body) ?? { text: 'Done.' };
      if (step.delayMs) await sleep(step.delayMs);
      if (step.status) {
        res.writeHead(step.status, { 'content-type': 'application/json', ...(step.headers ?? {}) });
        res.end(JSON.stringify(step.errorBody ?? { type: 'error', error: { type: 'api_error', message: 'scripted failure' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify({ type: ev, ...data })}\n\n`);
      send('message_start', {
        message: {
          id: `msg_fake_${Date.now()}`, type: 'message', role: 'assistant', model: body.model,
          content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1, ...(step.usage ?? {}) },
        },
      });
      let idx = 0;
      if (step.thinking) {
        send('content_block_start', { index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } });
        send('content_block_delta', { index: idx, delta: { type: 'thinking_delta', thinking: step.thinking } });
        send('content_block_delta', { index: idx, delta: { type: 'signature_delta', signature: 'fake' } });
        send('content_block_stop', { index: idx });
        idx++;
      }
      if (step.text) {
        send('content_block_start', { index: idx, content_block: { type: 'text', text: '' } });
        for (const w of step.text.split(/(?<=\s)/)) {
          send('content_block_delta', { index: idx, delta: { type: 'text_delta', text: w } });
          await sleep(step.wordMs ?? 10);
        }
        send('content_block_stop', { index: idx });
        idx++;
      }
      for (const [n, tool] of (step.tools ?? []).entries()) {
        send('content_block_start', {
          index: idx,
          content_block: { type: 'tool_use', id: `toolu_fake_${Date.now()}_${n}`, name: tool.name, input: {} },
        });
        send('content_block_delta', { index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } });
        send('content_block_stop', { index: idx });
        idx++;
      }
      send('message_delta', {
        delta: { stop_reason: step.tools?.length ? 'tool_use' : (step.stopReason ?? 'end_turn') },
        usage: { output_tokens: 5, ...(step.usage ?? {}) },
      });
      send('message_stop', {});
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get turnsUsed() { return turn; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/** The env that points `claude` at a fake server. */
export function fakeApiEnv(url) {
  return { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: 'fake-token-for-local-capture' };
}

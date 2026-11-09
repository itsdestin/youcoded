export function gatewayFetch(originalFetch, gatewayUrl) {
  const base = new URL(gatewayUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
    throw new Error('Invalid gateway origin');
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://api.anthropic.com') return originalFetch(input, init);
    const target = new URL(url.pathname + url.search, base).href;
    // Only transport changes; all clients share the gate's declared model/budget policy.
    return originalFetch(input instanceof Request ? new Request(target, input) : target, { ...init, redirect: 'error' });
  };
}

export async function configureKeyedProvider(registry, provider, key, gatewayUrl) {
  if (!['openrouter', 'anthropic', 'openai'].includes(provider)) throw new Error('Unsupported keyed provider');
  let baseUrl;
  if(gatewayUrl&&provider==='openrouter'){
    gatewayFetch(()=>{},gatewayUrl); // reuse strict origin-only validation without making a request
    baseUrl=new URL('/v1',gatewayUrl).href;
  }
  // Preserve the production OpenRouter adapter/cache/usage implementation; change only its endpoint.
  await registry.upsert({ id: provider, type: provider, label: provider, enabled: true, ...(baseUrl?{baseUrl}:{}) });
  await registry.setKey(provider, key);
}

export function failureDetail(workerError, stderr) {
  return [workerError, stderr].filter(value => typeof value === 'string' && value.trim()).join('\n')
    || 'Worker exited without a diagnostic';
}

export function runErrorDetail(record, stderr) {
  if (record.status === 'completed') return undefined;
  // WHY: a native terminal failure is already described in transcript events; an unrelated SDK warning is not its cause.
  const event = (record.events ?? []).findLast(event => event.type === 'session-error'
    && !event.data?.agentId && !event.data?.parentAgentToolUseId
    && typeof event.data?.text === 'string' && event.data.text.trim());
  return [event?.data.text, record.error, stderr].find(value => typeof value === 'string' && value.trim())?.slice(0, 8000)
    ?? 'Worker exited without a diagnostic';
}

export function assertSupportedPlatform(platform) {
  if (platform === 'win32') throw new Error('Windows lab execution is not supported yet: timeout cleanup requires process-tree termination. Use a Linux Harbor container.');
}

export function canSettle({ terminal, idle, delegations, shells }) {
  // A completed child is NOT a delivered report. Read the durable ledger, not its UI projection.
  return terminal && idle && !shells.some(r => r.status === 'running')
    && !delegations.some(r => r.status === 'running' || (r.background && !r.delivered));
}

/** Consumes native LIVE delta events, not already-coalesced transcript rows. */
export function finalAnswer(events, sessionId) {
  const parts = new Map();
  for (const event of events) {
    if (event.sessionId !== sessionId || event.data?.agentId || event.data?.parentAgentToolUseId) continue;
    if (event.type === 'user-message' || event.type === 'tool-use') parts.clear();
    if (event.type === 'assistant-thinking' && event.data?.dropPart) {
      for (const id of event.data.dropPart.partIds) parts.delete(String(id));
    }
    if (event.type === 'assistant-text') {
      const key = String(event.data.partId ?? event.uuid ?? 'unkeyed');
      parts.set(key, (parts.get(key) ?? '') + (event.data.text ?? ''));
    }
  }
  return [...parts.values()].join('');
}

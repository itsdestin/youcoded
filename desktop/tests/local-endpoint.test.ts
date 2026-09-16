import { describe, expect, it } from 'vitest';
import { isLocalEndpoint } from '../src/shared/provider-types';

// A custom endpoint files under Local Models only when its address is this
// computer (Destin, 2026-09-05: Ollama "wouldn't that be local?"). Pinned so a
// future "helpful" broadening does not drag a remote server under Local.
describe('isLocalEndpoint', () => {
  it('is true for this computer, in every spelling', () => {
    for (const u of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080', 'http://0.0.0.0:11434', 'http://ollama.localhost/v1']) {
      expect(isLocalEndpoint(u), u).toBe(true);
    }
  });
  it('is false for a server elsewhere, an empty address, or garbage', () => {
    for (const u of ['https://api.groq.com/openai/v1', 'http://192.168.1.20:11434/v1', 'http://my-nas.local:1234', '', undefined, null, 'not a url']) {
      expect(isLocalEndpoint(u), String(u)).toBe(false);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const server = read('../src/main/remote-server.ts');
const panel = read('../src/renderer/components/SettingsPanel.tsx');

describe('the indicator reports the listener, not the setting', () => {
  it('the server reports listening, stopped or failed, and keeps the reason', () => {
    // isRunning() existed here all along with no caller outside tests: the state was
    // knowable and simply never asked for.
    expect(server).toContain("state: 'listening'");
    expect(server).toContain("state: 'failed'");
    expect(server).toContain('this.lastStartError = err.message;');
    expect(server).toContain('onStatusChange');
  });

  it('the panel derives green from the status, never from config.enabled', () => {
    // The whole defect: the light went green because the switch was on, so a server whose
    // port never bound still said Connected and the reason sat in a log nobody reads.
    expect(panel).toContain("const listening = status?.state === 'listening';");
    expect(panel).not.toContain('config?.enabled && tailscale?.installed && tailscale?.connected');
  });

  it('a failure shows the reason the OS gave, and does not invent one', () => {
    // Interpolated in the panel; matched here without writing a template expression of our
    // own, which the lint rule bans in a plain string.
    expect(panel).toMatch(/Not running: .\{status\.reason\}/);
    expect(panel).toContain("'Not running.'");
  });
});

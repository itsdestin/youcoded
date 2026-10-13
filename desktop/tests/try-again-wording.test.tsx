// @vitest-environment jsdom
// Every retry button reads exactly "Try again" (Destin, small-fixes-1#SF-1, 2026-10-12: "just
// "try again". as we just did everywhere else. the entire purpose of this work is consistency").
// An earlier sweep had made variants — "Try again now", "Try installing again", "Try the download
// again", "Download failed — Try again" — and each read as a different button. This pins both the
// words in the source and the shared failed-install box's shape.
import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { render, screen, fireEvent } from '@testing-library/react';
import { InstallFailed } from '../src/renderer/components/marketplace/DetailPage';

const SRC = join(__dirname, '..', 'src');
const ANDROID = join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin');
// Button labels, not sentences: "Try saving again." inside a message is ordinary prose. A
// failure glued to the button ("Download failed — Try again") is matched only inside quotes.
const VARIANT = /Try again now|Try installing again|Try the download again|['"`][^'"`]*— Try again|Try Again/;

function files(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, exts));
    else if (exts.some((e) => name.endsWith(e)) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe('"Try again" has no variants', () => {
  it('no app source writes a variant of the retry button (desktop, and Android when present)', () => {
    const scan = [...files(SRC, ['.ts', '.tsx'])];
    try { scan.push(...files(ANDROID, ['.kt'])); } catch { /* desktop-only checkout */ }
    const hits: string[] = [];
    for (const f of scan) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        // Comments may quote the retired words when they explain why they went.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (VARIANT.test(line)) hits.push(`${f.slice(f.indexOf('src'))}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('a failed install says what failed in one sentence, "Try again" inside, the reason under Details', () => {
    const retry = vi.fn();
    render(<InstallFailed name="Google Workspace" message="Plugin not found in marketplace: google-workspace" onRetry={retry} />);
    expect(screen.getByText('Google Workspace couldn’t be installed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
    // The installer's own words are kept, one click away — never dropped.
    expect(screen.queryByText(/Plugin not found/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByText(/Plugin not found in marketplace/)).toBeTruthy();
  });
});

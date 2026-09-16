// @vitest-environment jsdom
//
// The phone's Download notice (contract R18: "a refusal says why"). The host
// answers a code; this pins that each code is put into words that match what
// the host actually decided, and that nothing is guessed (T7 review, finding 8:
// "outside the folders remote access can read" was shown for a private file
// inside a project, a folder, and a file with no stable identity).
//
// Also pins finding 9: the too-big card passes the project and the record, so
// the host can authorize a tracked file through its record.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { APP_NOTICE_EVENT } from '../src/renderer/utils/announce';
import { downloadFile } from '../src/renderer/components/artifact-views/download-file';
import { RemoteFileCard } from '../src/renderer/components/artifact-views/RemoteFileCard';

const saved = (window as any).claude;
afterEach(() => { (window as any).claude = saved; });

async function noticeFor(answer: unknown): Promise<string> {
  const messages: string[] = [];
  const listen = (e: Event) => messages.push((e as CustomEvent).detail.message);
  window.addEventListener(APP_NOTICE_EVENT, listen);
  (window as any).claude = { artifacts: { download: vi.fn(async () => answer) } };
  try {
    await downloadFile('/home/me/proj/report.pdf');
  } finally {
    window.removeEventListener(APP_NOTICE_EVENT, listen);
  }
  expect(messages).toHaveLength(1);
  return messages[0];
}

describe('the Download notice says what the computer decided', () => {
  it('a started download says it is saving', async () => {
    expect(await noticeFor({ ok: true, url: 'http://h/download/t/report.pdf' })).toBe('Saving report.pdf to this device…');
  });

  it('each refusal code gets its own words', async () => {
    expect(await noticeFor({ ok: false, error: 'sensitive' })).toMatch(/private location/);
    expect(await noticeFor({ ok: false, error: 'outside-roots' })).toMatch(/outside the folders/);
    expect(await noticeFor({ ok: false, error: 'not-a-file' })).toMatch(/isn’t a file/);
    expect(await noticeFor({ ok: false, error: 'orphan' })).toMatch(/no longer on the computer/);
    expect(await noticeFor({ ok: false, error: 'busy' })).toMatch(/two downloads are already running/);
  });

  it('the general refusal names no cause, and an unknown code is shown as the host gave it', async () => {
    const general = await noticeFor({ ok: false, error: 'not-allowed' });
    expect(general).not.toMatch(/outside|private|folder/);
    expect(await noticeFor({ ok: false, error: 'EIO: i/o error' })).toContain('EIO: i/o error');
  });
});

describe('the too-big card downloads through the record when it has one', () => {
  it('passes projectRoot and artifactId along with the path', () => {
    const download = vi.fn(async () => ({ ok: true }));
    (window as any).claude = { artifacts: { download } };
    const view = render(React.createElement(RemoteFileCard, {
      path: '/home/me/proj/docs/annual.pdf', sizeBytes: 24 * 1024 * 1024, reason: 'too-large',
      projectRoot: '/home/me/proj', artifactId: 'art-9',
    }));
    fireEvent.click(view.getByRole('button', { name: 'Download' }));
    expect(download).toHaveBeenCalledWith('/home/me/proj/docs/annual.pdf', { projectRoot: '/home/me/proj', artifactId: 'art-9' });
  });
});

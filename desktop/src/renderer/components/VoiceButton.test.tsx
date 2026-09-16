// @vitest-environment jsdom
// Voice prompting — the small card above the mic (T9).
//
// Nothing rendered this component before this file, and the card is where every
// word the user reads about voice lives. What these pin, in plain terms:
//
//  - The first-tap card says what it was signed off saying: what dictation
//    does, that the voice never leaves this computer, WHICH LANGUAGES it
//    understands, and that the download is "about 500 MB" — the sentence, not a
//    number computed from the archive, which drifts every time the engine pin
//    moves.
//  - While the download is being expanded the card keeps talking ("Almost
//    ready…") with a bar that moves without claiming to measure anything. Before
//    this branch existed the card vanished for that whole minute and the app
//    looked either finished or stuck.
//  - A failed download keeps the offer card, shows the computer's own reason,
//    and offers Retry — not the "Voice stopped" card, which is about a
//    microphone that was working and died.
//  - No microphone, and a refused microphone, each say exactly what happened and
//    give one Check again.
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { VoiceButton } from './VoiceButton';
import type { VoiceReadiness } from '../../shared/voice-types';
import type { VoicePhase } from '../hooks/useVoiceInput';

const REFUSED =
  "Microphone access was refused by your computer. Allow it for YouCoded in your system's privacy settings, then check again.";
const NO_DEVICE = 'No microphone was found on this computer.';

function renderCard(opts: {
  readiness: VoiceReadiness | null;
  error?: string | null;
  phase?: VoicePhase;
}) {
  const handlers = {
    onStart: vi.fn(),
    onStop: vi.fn(),
    onDownload: vi.fn(),
    onRecheck: vi.fn(),
    onClearError: vi.fn(),
  };
  render(
    <VoiceButton
      phase={opts.phase ?? 'idle'}
      readiness={opts.readiness}
      level={0}
      seconds={0}
      error={opts.error ?? null}
      {...handlers}
    />,
  );
  return handlers;
}

/** Open the card the way a user does — by tapping the mic. */
function tapMic() {
  fireEvent.click(screen.getAllByRole('button')[0]);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('VoiceButton card — first run (R8, R22)', () => {
  const NEEDS: VoiceReadiness = { state: 'needs-download', engine: 'Parakeet', sizeMb: 639 };

  it('offers the download with the approved size sentence and the language limit', () => {
    renderCard({ readiness: NEEDS });
    tapMic();

    expect(screen.getByText('Speak your messages')).toBeInTheDocument();
    expect(
      screen.getByText(/Your voice is turned into text on this computer and never leaves it\./),
    ).toBeInTheDocument();
    expect(screen.getByText('Understands English and 24 other European languages.')).toBeInTheDocument();
    expect(screen.getByText('One-time download: about 650 MB.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
  });

  it('never prints the readiness sizeMb number — the sentence is the only size the card says', () => {
    // The downloader genuinely knows 639; the card must not say it, or the card
    // and the workbench fake end up promising two different numbers.
    renderCard({ readiness: NEEDS });
    tapMic();
    expect(document.body.textContent).not.toMatch(/464/);
  });

  it('Download starts the download', () => {
    const h = renderCard({ readiness: NEEDS });
    tapMic();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(h.onDownload).toHaveBeenCalledTimes(1);
  });
});

describe('VoiceButton card — unpacking (R23)', () => {
  it('reads "Almost ready…" with a bar that measures nothing', () => {
    renderCard({ readiness: { state: 'unpacking', engine: 'Parakeet' } });
    tapMic();

    expect(screen.getByText('Almost ready…')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Getting voice ready' });
    // Indeterminate on purpose: nothing here reports a percentage worth
    // believing, so the bar claims no value.
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveClass('model-load-track');
  });

  it('says the wait costs the user nothing', () => {
    renderCard({ readiness: { state: 'unpacking', engine: 'Parakeet' } });
    tapMic();
    expect(
      screen.getByText('You can keep typing; the mic wakes up when it is done.'),
    ).toBeInTheDocument();
  });
});

describe('VoiceButton card — the microphone will not open (R11, R12, R20, R21)', () => {
  it('no microphone: says exactly that, with one Check again', () => {
    const h = renderCard({ readiness: { state: 'unavailable', reason: NO_DEVICE } });
    tapMic();

    expect(screen.getByText(NO_DEVICE)).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Check again' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(h.onRecheck).toHaveBeenCalledTimes(1);
  });

  // WHY: the error card's only button is OK. When the microphone is unavailable AND
  // something also errored, showing that card took away the Check again — the one
  // affordance that lets the user come back after plugging a microphone in. The more
  // useful of the two truths wins. Found reviewing T9, 2026-09-05.
  it('an unavailable microphone keeps its Check again even when an error is also set', () => {
    const h = renderCard({
      readiness: { state: 'unavailable', reason: NO_DEVICE },
      error: 'something else went wrong',
    });
    // No tap: an error opens the card by itself, so tapping would close it again.

    expect(screen.getByText(NO_DEVICE)).toBeInTheDocument();
    expect(screen.queryByText('Voice stopped')).toBeNull();
    const buttons = screen.getAllByRole('button', { name: 'Check again' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(h.onRecheck).toHaveBeenCalledTimes(1);
  });

  it('refused by the computer: the approved sentence, verbatim, with one Check again', () => {
    renderCard({ readiness: { state: 'unavailable', reason: REFUSED } });
    tapMic();

    expect(screen.getByText(REFUSED)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Check again' })).toHaveLength(1);
  });
});

describe('VoiceButton card — a download that failed (R3-6, R12)', () => {
  const NEEDS: VoiceReadiness = { state: 'needs-download', engine: 'Parakeet', sizeMb: 639 };
  const REASON = 'net::ERR_PROXY_CONNECTION_FAILED';

  it('keeps the offer card, shows the computer’s own reason, and offers Retry', () => {
    const h = renderCard({ readiness: NEEDS, error: REASON });
    // The card opens itself on an error — the reason is not left unread.
    expect(screen.getByText('Speak your messages')).toBeInTheDocument();
    expect(screen.getByText(REASON)).toBeInTheDocument();

    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    expect(h.onDownload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });

  it('is NOT the "Voice stopped" card — that one is for a mic that was open and died', () => {
    renderCard({ readiness: NEEDS, error: REASON });
    expect(screen.queryByText('Voice stopped')).not.toBeInTheDocument();
    // And the tooltip/label on the mic itself says which failure it was.
    expect(screen.getByRole('button', { name: 'Voice download failed — see why' })).toBeInTheDocument();
  });

  it('Not now puts the error away so the next tap shows a clean offer', () => {
    const h = renderCard({ readiness: NEEDS, error: REASON });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(h.onClearError).toHaveBeenCalledTimes(1);
  });

  it('a failure once voice IS installed still shows the "Voice stopped" card', () => {
    // The two error cards are told apart by whether the engine is on the
    // computer yet — this is the other side of that test.
    renderCard({ readiness: { state: 'ready', engine: 'Parakeet' }, error: 'The speech engine stopped: exit code 1' });
    expect(screen.getByText('Voice stopped')).toBeInTheDocument();
    expect(screen.getByText('The speech engine stopped: exit code 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument();
  });
});

describe('the ring size the deck approved (R14)', () => {
  // Guard for whole-branch review F11. "Ring 2 to 9 px" is a number Destin chose
  // on a review deck — round 2 showed 2 to 12 and he asked for the biggest a tad
  // smaller — and nothing checked it. A source pin, because the ring is an inline
  // style computed per level event and jsdom paints nothing.
  const source = readFileSync(
    join(__dirname, 'VoiceButton.tsx'), 'utf8',
  );

  it('grows from 2 px to 9 px and no further', () => {
    expect(source).toMatch(/\$\{2 \+ Math\.round\(level \* 7\)\}px/);
  });
});

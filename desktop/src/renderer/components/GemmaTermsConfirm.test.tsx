// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { gemmaNoticeFor } from '../../shared/gemma-terms';
import { useGemmaTermsGate } from './GemmaTermsConfirm';

afterEach(cleanup);

// Card #45: which models get the popup, and that Cancel really does not download.
describe('gemmaNoticeFor', () => {
  it('knows the three curated Gemma 4 builds (Apache 2.0, checked on their Hugging Face pages)', () => {
    for (const r of ['unsloth/gemma-4-E4B-it-GGUF', 'unsloth/gemma-4-12b-it-GGUF', 'unsloth/gemma-4-26B-A4B-it-GGUF']) expect(gemmaNoticeFor(r)?.kind).toBe('apache');
  });
  it('flags other Gemma builds as unchecked, and says nothing for other models', () => {
    expect(gemmaNoticeFor('google/gemma-3-27b-it-GGUF')?.kind).toBe('unchecked');
    expect(gemmaNoticeFor('Qwen/Qwen3-4B-GGUF')).toBeNull();
  });
});

function Probe({ repo, go }: { repo: string; go: () => void }) {
  const gate = useGemmaTermsGate(repo);
  return <><button onClick={() => gate.ask(go)}>start</button>{gate.dialog}</>;
}

describe('useGemmaTermsGate', () => {
  it('Cancel starts nothing; Download starts it once', () => {
    const go = vi.fn();
    render(<Probe repo="unsloth/gemma-4-E4B-it-GGUF" go={go} />);
    fireEvent.click(screen.getByText('start'));
    expect(go).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Cancel'));
    expect(go).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('start'));
    fireEvent.click(screen.getByText('Download'));
    expect(go).toHaveBeenCalledTimes(1);
  });
  it('a non-Gemma model starts at once with no popup', () => {
    const go = vi.fn();
    render(<Probe repo="Qwen/Qwen3-4B-GGUF" go={go} />);
    fireEvent.click(screen.getByText('start'));
    expect(go).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Cancel')).toBeNull();
  });
});

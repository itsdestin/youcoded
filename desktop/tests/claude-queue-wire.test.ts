import { describe, expect, it } from 'vitest';
import { formatQueueWire, parseQueueWire } from '../src/shared/claude-queue-wire';

describe('Claude queue wire wording', () => {
  it('takes its own additions back off what Claude Code recorded', () => {
    const wire = formatQueueWire('Compare "/p/notes.md"\nplease', ['/p/notes.md'], ['/q/shot one.png', '/q/b.txt']);
    expect(parseQueueWire(wire)).toEqual({ text: 'Compare "/p/notes.md"\nplease', attached: ['/q/shot one.png', '/q/b.txt'] });
    expect(parseQueueWire(formatQueueWire('', [], ['/q/a.png']))).toEqual({ text: '', attached: ['/q/a.png'] });
    expect(parseQueueWire(formatQueueWire('hi', ['/p/a.md'], []))).toEqual({ text: 'hi', attached: [] });
  });
  it('leaves an ordinary message that merely looks similar exactly as typed', () => {
    for (const text of ['Attached: "/x.png"\nsee above', 'notes\nAttached: "/x.png"', 'Read this entire file: please', 'hello\n\nAttached: not-a-path'])
      expect(parseQueueWire(text)).toEqual({ text, attached: [] });
  });
});

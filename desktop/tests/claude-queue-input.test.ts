import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareClaudeQueueInput } from '../src/main/claude-queue-input';

let cwd: string;
beforeEach(async () => { cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-queue-input-')); });
afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); });
const put = async (name: string) => { const p = path.join(cwd, name); await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, 'file contents'); return p; };

describe('Claude queue file instructions', () => {
  it('keeps ordinary multiline Unicode text unchanged', async () => {
    const text = 'First line\n第二行 café 🧪';
    expect(await prepareClaudeQueueInput({ text, attachments: [], cwd })).toEqual({ wireText: text, files: [] });
  });
  it('replaces existing relative and quoted mentions with paths and explicit Read instructions', async () => {
    const a = await put('notes.md'); const b = await put('folder/visit notes.md');
    const r = await prepareClaudeQueueInput({ text: 'Compare @notes.md and @"folder/visit notes.md".', attachments: [], cwd });
    expect(r.files).toEqual([a, b]);
    expect(r.wireText).toContain('Read this entire file: ' + JSON.stringify(a));
    expect(r.wireText).toContain('Compare ' + JSON.stringify(a) + ' and ' + JSON.stringify(b) + '.');
    expect(r.wireText).not.toContain('@notes.md');
  });
  it('preserves punctuation and resolves Unicode and absolute paths', async () => {
    const a = await put('資料.md'); const b = await put('other.txt');
    const r = await prepareClaudeQueueInput({ text: `Use @資料.md, then @${b}.`, attachments: [], cwd });
    expect(r.files).toEqual([a, b]);
    expect(r.wireText).toContain(`Use ${JSON.stringify(a)}, then ${JSON.stringify(b)}.`);
  });
  it('deduplicates attachment and mention paths without mutating caller data', async () => {
    const a = await put('image.png'); const attachments = [a, a];
    const r = await prepareClaudeQueueInput({ text: 'Describe @image.png', attachments, cwd });
    expect(r.files).toEqual([a]); expect(attachments).toEqual([a, a]);
    expect(r.wireText.startsWith('Read this entire file:')).toBe(true);
    expect(r.wireText).toContain('Do not assume the file contents were supplied automatically.');
  });
  it('does not reinterpret email addresses, code examples, or nonexistent mentions', async () => {
    await put('example.com'); await put('code.py');
    const text = 'Email ana@example.com. Example: `@code.py`\n```python\n@code.py\n```\n@missing.md';
    expect(await prepareClaudeQueueInput({ text, attachments: [], cwd })).toEqual({ wireText: text, files: [] });
  });
  it('does not rewrite mentions inside an unfinished code fence', async () => {
    await put('code.py'); const text = 'Example:\n```python\n@code.py';
    expect((await prepareClaudeQueueInput({ text, attachments: [], cwd })).wireText).toBe(text);
  });
  it('preserves matching delimiter runs for inline code and longer fences', async () => {
    await put('notes.md');
    for (const text of ['``@notes.md``', '````markdown\n```\n@notes.md\n```\n````', '~~~~\n~~~\n@notes.md\n~~~\n~~~~']) {
      expect(await prepareClaudeQueueInput({ text, attachments: [], cwd })).toEqual({ wireText: text, files: [] });
    }
  });
  it('refuses prepared output that exceeds the transport budget without truncating the source', async () => {
    const a = await put('notes.md'); const text = 'x'.repeat(262_144);
    await expect(prepareClaudeQueueInput({ text, attachments: [a], cwd })).rejects.toThrow(/prepared.*too large/i);
    expect(text.length).toBe(262_144);
    const mentions = '@notes.md '.repeat(20);
    await expect(prepareClaudeQueueInput({ text: mentions + 'x'.repeat(262_144 - mentions.length), attachments: [], cwd })).rejects.toThrow(/prepared.*too large/i);
    await expect(prepareClaudeQueueInput({ text: '"'.repeat(262_144), attachments: [], cwd })).rejects.toThrow(/prepared.*too large/i);
  });
  it('puts attached files at the end as plain lines and keeps the read instruction for @ mentions only', async () => {
    const shot = await put('shot.png'); const notes = await put('notes.md');
    const attached = await prepareClaudeQueueInput({ text: 'What is this?', attachments: [shot], cwd });
    expect(attached).toEqual({ wireText: 'What is this?\n\nAttached: ' + JSON.stringify(shot), files: [shot] });
    const both = await prepareClaudeQueueInput({ text: 'Compare @notes.md', attachments: [shot, notes], cwd });
    expect(both.wireText.startsWith('Read this entire file: ' + JSON.stringify(notes) + '\n')).toBe(true);
    // A file that is both attached and mentioned is listed once, as a mention.
    expect(both.wireText.endsWith('Compare ' + JSON.stringify(notes) + '\n\nAttached: ' + JSON.stringify(shot))).toBe(true);
    expect(await prepareClaudeQueueInput({ text: '', attachments: [shot], cwd })).toEqual({ wireText: 'Attached: ' + JSON.stringify(shot), files: [shot] });
  });
  it('removes characters Claude Code\'s box always drops, keeping joiners that real text needs', async () => {
    const r = await prepareClaudeQueueInput({ text: 'a\u200Bb\u2060c\uFEFF\r\nd 👨\u200D👩 می\u200Cخواهم', attachments: [], cwd });
    expect(r.wireText).toBe('abc\nd 👨\u200D👩 می\u200Cخواهم');
    await expect(prepareClaudeQueueInput({ text: '\u200B\u2060', attachments: [], cwd })).rejects.toThrow(/nothing to send/i);
  });
  it('refuses an unavailable explicit attachment instead of claiming its contents are present', async () => {
    await expect(prepareClaudeQueueInput({ text: 'Read it', attachments: [path.join(cwd, 'gone.pdf')], cwd })).rejects.toThrow(/attachment.*unavailable/i);
  });
  it('does not treat a directory as an attached file', async () => {
    await expect(prepareClaudeQueueInput({ text: 'Read it', attachments: [cwd], cwd })).rejects.toThrow(/not a file/i);
  });
  it('bounds file references and rejects invalid inputs before filesystem work', async () => {
    await expect(prepareClaudeQueueInput({ text: 'x', attachments: Array(33).fill('a'), cwd })).rejects.toThrow(/too many/i);
    await expect(prepareClaudeQueueInput({ text: 'x\0y', attachments: [], cwd })).rejects.toThrow(/invalid/i);
    await expect(prepareClaudeQueueInput({ text: 'x', attachments: [], cwd: 'relative' })).rejects.toThrow(/absolute/i);
  });
});

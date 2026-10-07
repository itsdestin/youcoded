import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VoiceVocabularyStore } from '../src/main/voice/voice-vocabulary';
import { voiceChannels } from '../src/main/ipc/voice';
import type { MainChannelCtx } from '../src/main/ipc/channel-def';

const start = vi.hoisted(() => vi.fn(async (_id: number, _phrases: readonly string[]) => {}));
vi.mock('electron', () => ({ systemPreferences: { askForMediaAccess: async () => true } }));
vi.mock('../src/main/voice/voice-handlers', () => ({ getVoiceService: () => ({ start }), getVoiceVocabularyStore: () => store }));

let root: string;
let store: VoiceVocabularyStore;
beforeEach(async () => { start.mockClear(); root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-vocabulary-')); store = new VoiceVocabularyStore(root); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); });

describe('saved voice vocabulary', () => {
  it('serves persisted vocabulary through desktop-only IPC channels', async () => {
    const get = voiceChannels.find((channel) => channel.name === 'voice:vocabulary-get');
    const save = voiceChannels.find((channel) => channel.name === 'voice:vocabulary-save');
    expect(get?.desktopOnly).toBe(true);
    expect(save?.desktopOnly).toBe(true);
    await save!.handler({ phrases: ['IPC phrase'] }, {} as MainChannelCtx);
    expect(await get!.handler(undefined, {} as MainChannelCtx)).toEqual(['IPC phrase']);
  });
  it('reads saved phrases before starting recording and propagates corrupt-file errors without starting', async () => {
    const channel = voiceChannels.find((entry) => entry.name === 'voice:start')!;
    await store.save(['Destin', 'two words']);
    await channel.handler(undefined, { sender: { id: 42 } } as MainChannelCtx);
    expect(start).toHaveBeenLastCalledWith(42, ['Destin', 'two words']);
    await store.save([]);
    await channel.handler(undefined, { sender: { id: 42 } } as MainChannelCtx);
    expect(start).toHaveBeenLastCalledWith(42, []);
    start.mockClear();
    await fs.writeFile(path.join(root, 'voice-vocabulary.json'), '{broken');
    await expect(channel.handler(undefined, {} as MainChannelCtx)).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
  });
  it('starts empty when no file exists', async () => { expect(await store.read()).toEqual([]); });
  it('persists trimmed Unicode phrases and keeps the first spelling of duplicates', async () => {
    await store.save([' YouCoded ', 'youcoded', 'Zoë', 'Côte d’Ivoire', '', '   ']);
    expect(await new VoiceVocabularyStore(root).read()).toEqual(['YouCoded', 'Zoë', 'Côte d’Ivoire']);
  });
  it('clears saved hints with an empty list', async () => {
    await store.save(['YouCoded']); await store.save([]); expect(await store.read()).toEqual([]);
  });
  it.each([null, {}, 'word', [4], ['word\nother'], ['word/other'], ['word :100'], ['\u0000word'], ['x'.repeat(257)], Array.from({ length: 2001 }, (_, n) => `word ${n}`)])('refuses invalid or excessive input without changing saved phrases', async (input) => {
    await store.save(['Existing']);
    await expect(store.save(input)).rejects.toThrow();
    expect(await store.read()).toEqual(['Existing']);
  });
  it.each(['{broken', '{"version":2,"phrases":[]}', '{"version":1,"phrases":[false]}'])('reports corrupt or unsupported stored data rather than showing a false empty list', async (raw) => {
    await fs.writeFile(path.join(root, 'voice-vocabulary.json'), raw);
    await expect(store.read()).rejects.toThrow();
  });
  it('refuses to overwrite corrupt stored data', async () => {
    const file = path.join(root, 'voice-vocabulary.json'); await fs.writeFile(file, '{broken');
    await expect(store.save(['New'])).rejects.toThrow(); expect(await fs.readFile(file, 'utf8')).toBe('{broken');
  });
  it('serializes concurrent writes into complete documents', async () => {
    await Promise.all([store.save(['First']), new VoiceVocabularyStore(root).save(['Second'])]);
    expect([['First'], ['Second']]).toContainEqual(await store.read());
    expect(await fs.readdir(root)).toEqual(['voice-vocabulary.json']);
  });
  it('rejects invalid UTF-8 on reads and saves without overwriting the original bytes', async () => {
    const file = path.join(root, 'voice-vocabulary.json');
    const raw = Buffer.concat([Buffer.from('{"version":1,"phrases":["'), Buffer.from([0xc3, 0x28]), Buffer.from('"]}')]);
    await fs.writeFile(file, raw);
    await expect(store.read()).rejects.toThrow();
    await expect(store.save(['New'])).rejects.toThrow();
    expect(await fs.readFile(file)).toEqual(raw);
  });
  it('refuses to read an oversized current document through the unbounded write helper', async () => {
    const file = path.join(root, 'voice-vocabulary.json');
    await fs.writeFile(file, ' '.repeat(524289));
    const readFile = vi.spyOn(fs, 'readFile');
    await expect(store.save(['New'])).rejects.toThrow(/too large/);
    expect(readFile).not.toHaveBeenCalled();
    readFile.mockRestore();
  });
  it('refuses an oversized saved file before parsing its content', async () => {
    await fs.writeFile(path.join(root, 'voice-vocabulary.json'), ' '.repeat(524289));
    await expect(store.read()).rejects.toThrow(/too large/);
  });
});

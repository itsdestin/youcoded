import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { migrateBarJsonFiles } from '../src/main/theme-migration';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-migration-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('migrateBarJsonFiles', () => {
  it('moves a bare .json file into a slug folder as manifest.json', () => {
    const json = JSON.stringify({ name: 'Test', slug: 'test-theme', dark: true, tokens: {} });
    fs.writeFileSync(path.join(tmpDir, 'test-theme.json'), json);

    const count = migrateBarJsonFiles(tmpDir);

    expect(count).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, 'test-theme', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'test-theme.json'))).toBe(false);
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'test-theme', 'manifest.json'), 'utf-8'));
    expect(content.name).toBe('Test');
  });

  it('skips directories that already exist', () => {
    fs.mkdirSync(path.join(tmpDir, 'existing-theme'));
    fs.writeFileSync(path.join(tmpDir, 'existing-theme', 'manifest.json'), '{}');

    const count = migrateBarJsonFiles(tmpDir);
    expect(count).toBe(0);
  });

  it('migrates multiple bare JSON files', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.json'), JSON.stringify({ name: 'A', slug: 'a', dark: true, tokens: {} }));
    fs.writeFileSync(path.join(tmpDir, 'b.json'), JSON.stringify({ name: 'B', slug: 'b', dark: false, tokens: {} }));

    const count = migrateBarJsonFiles(tmpDir);
    expect(count).toBe(2);
    expect(fs.existsSync(path.join(tmpDir, 'a', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'b', 'manifest.json'))).toBe(true);
  });

  it('creates assets subdirectory in migrated themes', () => {
    fs.writeFileSync(path.join(tmpDir, 'my-theme.json'), JSON.stringify({ name: 'My', slug: 'my-theme', dark: true, tokens: {} }));

    migrateBarJsonFiles(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'my-theme', 'assets'))).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfigSync, writeConfig, _setConfigPathForTesting } from './performance-config';

const TMP = path.join(os.tmpdir(), `yc-perf-${Date.now()}-${Math.random()}`);
const FILE = path.join(TMP, 'youcoded-performance.json');

beforeEach(() => {
  fs.mkdirSync(TMP, { recursive: true });
  _setConfigPathForTesting(FILE);
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('performance-config', () => {
  it('returns default when file is missing', () => {
    const cfg = loadConfigSync();
    expect(cfg.preferPowerSaving).toBe(false);
    expect(cfg.raw).toEqual({});
  });

  it('returns default when file is unparseable JSON', () => {
    fs.writeFileSync(FILE, '{ not valid json');
    const cfg = loadConfigSync();
    expect(cfg.preferPowerSaving).toBe(false);
    expect(cfg.raw).toEqual({});
  });

  it('reads valid preferPowerSaving=true', () => {
    fs.writeFileSync(FILE, JSON.stringify({ preferPowerSaving: true }));
    const cfg = loadConfigSync();
    expect(cfg.preferPowerSaving).toBe(true);
  });

  it('reads valid preferPowerSaving=false', () => {
    fs.writeFileSync(FILE, JSON.stringify({ preferPowerSaving: false }));
    const cfg = loadConfigSync();
    expect(cfg.preferPowerSaving).toBe(false);
  });

  it('coerces non-boolean preferPowerSaving to false', () => {
    fs.writeFileSync(FILE, JSON.stringify({ preferPowerSaving: 'yes' }));
    const cfg = loadConfigSync();
    expect(cfg.preferPowerSaving).toBe(false);
  });

  it('preserves unknown keys on the raw object', () => {
    fs.writeFileSync(FILE, JSON.stringify({ preferPowerSaving: true, futureKey: 'keep me' }));
    const cfg = loadConfigSync();
    expect(cfg.raw).toEqual({ preferPowerSaving: true, futureKey: 'keep me' });
  });

  it('writeConfig merges into existing raw and persists', () => {
    fs.writeFileSync(FILE, JSON.stringify({ futureKey: 'keep me', preferPowerSaving: false }));
    writeConfig({ preferPowerSaving: true });
    const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    expect(onDisk).toEqual({ futureKey: 'keep me', preferPowerSaving: true });
  });

  it('writeConfig creates the file when missing', () => {
    writeConfig({ preferPowerSaving: true });
    const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    expect(onDisk).toEqual({ preferPowerSaving: true });
  });
});

// Replays a REAL Claude Code plan-menu capture (tests/fixtures/plan-menu/*.json,
// recorded by test-conpty/capture-plan-menu.mjs) through a headless xterm and
// reads it back with the app's own serializer (terminal-registry.getVisibleScreenText).
//
// WHY through the real serializer: the plan parser never sees raw bytes in the
// app — it sees what getVisibleScreenText makes of xterm's buffer (rows joined,
// trailing blanks trimmed, EMPTY ROWS DROPPED). Parsing anything else would
// test a screen the app never reads.
import fs from 'fs';
import path from 'path';
import { Terminal } from '@xterm/headless';
import { registerTerminal, unregisterTerminal, getVisibleScreenText } from '../../src/renderer/hooks/terminal-registry';

export const PLAN_FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'plan-menu');

export interface PlanFixture {
  ccVersion: string;
  variant: string;
  cols: number;
  rows: number;
  chunks: { t: number; b64: string }[];
  marks: { t: number; label: string; chunkIndex: number }[];
  flags: Record<string, unknown>;
  outcome: Record<string, unknown>;
}

/** Startup-dialog captures (test-conpty/capture-startup-dialogs.mjs) share the
 *  plan captures' shape — raw chunks + marks — so the same terminal replays them. */
export const STARTUP_FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'startup-dialogs');

export function listPlanFixtures(dir = PLAN_FIXTURE_DIR): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
}

export function loadPlanFixture(file: string, dir = PLAN_FIXTURE_DIR): PlanFixture {
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
}

export function markIndex(fx: PlanFixture, label: string): number {
  const m = fx.marks.find((x) => x.label === label);
  if (!m) throw new Error(`fixture ${fx.variant} has no mark "${label}"`);
  return m.chunkIndex;
}

let seq = 0;

/** A headless terminal fed a fixture's bytes up to a chosen point. */
export class FixtureTerminal {
  readonly id = `plan-fixture-${++seq}`;
  private term: Terminal;
  private next = 0;
  private resize: { at: number; cols: number; rows: number } | null = null;

  constructor(private fx: PlanFixture) {
    this.term = new Terminal({ cols: fx.cols, rows: fx.rows, allowProposedApi: true, scrollback: 1000 });
    registerTerminal(this.id, this.term as never);
    const r = fx.marks.find((m) => m.label.startsWith('resize '));
    if (r) {
      const [cols, rows] = r.label.split(' ')[1].split('x').map(Number);
      this.resize = { at: r.chunkIndex, cols, rows };
    }
  }

  get chunkCount(): number { return this.fx.chunks.length; }
  get position(): number { return this.next; }

  /** Feed chunks [position, end) — resolves once xterm has parsed them. */
  async advanceTo(end: number): Promise<void> {
    for (; this.next < Math.min(end, this.fx.chunks.length); this.next++) {
      if (this.resize && this.next === this.resize.at) this.term.resize(this.resize.cols, this.resize.rows);
      await new Promise<void>((res) => this.term.write(Buffer.from(this.fx.chunks[this.next].b64, 'base64'), res));
    }
  }

  async advanceToMark(label: string): Promise<void> {
    await this.advanceTo(markIndex(this.fx, label));
  }

  screen(): string {
    return getVisibleScreenText(this.id) ?? '';
  }

  /** The visible rows padded to the terminal width — the shape Android's
   *  PtyBridge.readScreenText hands its parser (every cell, one row per line). */
  androidScreen(): string {
    const b = this.term.buffer.active;
    const out: string[] = [];
    for (let i = b.viewportY; i < b.viewportY + this.term.rows; i++) {
      out.push((b.getLine(i)?.translateToString(true) ?? '').padEnd(this.term.cols, ' '));
    }
    return out.join('\n') + '\n';
  }

  dispose(): void {
    unregisterTerminal(this.id);
    this.term.dispose();
  }
}

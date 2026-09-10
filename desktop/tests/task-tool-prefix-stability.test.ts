// The Task tool's definition sits at the FRONT of every provider request (tools
// render before the system prompt and the conversation), so a byte that changes
// in it re-bills the entire conversation once. syncTaskTool rebuilds the tool
// from the live specialist catalog every turn, and the catalog is re-read from
// disk whenever Settings opens or a hire card mounts. Today that is safe only
// because the roster is read sorted and rendered deterministically — a
// de-facto property, not a guarded one (cache follow-ups item 7). This test
// makes it a guarded one: a reload with NO roster change must leave the
// serialized tool byte-identical, and a REAL change must not (or the first
// assertion would prove nothing).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { asSchema } from 'ai';
import { NativeHome } from '../src/main/native-home';
import { SpecialistCatalog } from '../src/main/harness/specialists/catalog';
import { createTaskTool } from '../src/main/harness/tools/task';

function personalFile(id: string): string {
  return `---\ndescription: Specialist ${id}.\nid: ${id}\n---\nDo ${id} things.\n`;
}

/** Everything about the tool a provider serializes into the request. */
function wireBytes(catalog: SpecialistCatalog, cwd: string): string {
  const tool = createTaskTool(catalog.roster(cwd));
  return JSON.stringify({
    description: tool.description,
    shortDescription: tool.shortDescription,
    schema: asSchema(tool.inputSchema).jsonSchema,
  });
}

describe('Task tool — prefix stability across catalog reloads', () => {
  let homeRoot: string; let claudeUserDir: string; let cwd: string;
  beforeEach(() => {
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-taskpin-home-'));
    claudeUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-taskpin-ccuser-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-taskpin-cwd-'));
    const personalDir = path.join(homeRoot, '.youcoded', 'specialists');
    fs.mkdirSync(personalDir, { recursive: true });
    // Written out of alphabetical order on purpose: the roster must not depend
    // on directory enumeration order.
    fs.writeFileSync(path.join(personalDir, 'zeta-helper.md'), personalFile('zeta-helper'));
    fs.writeFileSync(path.join(personalDir, 'alpha-helper.md'), personalFile('alpha-helper'));
  });
  afterEach(() => {
    for (const d of [homeRoot, claudeUserDir, cwd]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('a reload with no roster change leaves the serialized tool byte-identical', async () => {
    const catalog = new SpecialistCatalog({ home: new NativeHome(homeRoot), claudeUserDir });
    await catalog.ensureFresh(cwd);
    const before = wireBytes(catalog, cwd);
    expect(before).toContain('alpha-helper');
    expect(before).toContain('zeta-helper');
    // What Settings' Refresh and every hire-card mount do mid-session.
    await catalog.reload(cwd);
    await catalog.reload(cwd);
    expect(wireBytes(catalog, cwd)).toBe(before);
  });

  it('a real roster change DOES change the bytes — so the assertion above is not vacuous', async () => {
    const catalog = new SpecialistCatalog({ home: new NativeHome(homeRoot), claudeUserDir });
    await catalog.ensureFresh(cwd);
    const before = wireBytes(catalog, cwd);
    fs.writeFileSync(path.join(homeRoot, '.youcoded', 'specialists', 'new-hire.md'), personalFile('new-hire'));
    await catalog.reload(cwd);
    const after = wireBytes(catalog, cwd);
    expect(after).not.toBe(before);
    expect(after).toContain('new-hire');
  });
});

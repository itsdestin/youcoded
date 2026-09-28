import { useArtifactSelectorOptional } from '../state/ArtifactContext';
import { asString } from '../utils/tool-input';
import { useDelegatedModels, useSpecialistDefinition, useSpecialistRunByChild } from '../hooks/useSpecialists';
import type { SpecialistDefinitionView, ToolCallState } from '../../shared/types';

/** ToolCard's entry: resolves the roster + target for the awaiting Task card.
 *  Task 10: cwd is computed HERE (not inside SpecialistEnvelope) because
 *  useSpecialistDefinition needs it too — the per-cwd cache is keyed on it,
 *  and a Task card that never passes cwd would silently miss every one of
 *  the session's OWN project specialists. */
export function TaskConsentBlock({ tool, sessionId }: { tool: ToolCallState; sessionId?: string }) {
  // Narrow selector: redraws only when this session's cwd changes.
  const cwd = useArtifactSelectorOptional((s) => (sessionId ? s.sessionCwd?.[sessionId] : undefined));
  const agent = asString(tool.input.agent) || undefined;
  const definition = useSpecialistDefinition(cwd, agent);
  const taskId = asString(tool.input.task_id);
  const target = useSpecialistRunByChild(sessionId, taskId || undefined);
  // Destin's 2026-08-26/27 copy review: narrative consent block — the card no
  // longer prints a separate provenance line (definedBy), because the lead
  // sentence now says where the helper comes from inside the sentence that
  // says what it may do. definedBy still serves the Settings roster.
  return (
    <div className="px-3 pt-2">
      <SpecialistEnvelope
        input={tool.input}
        definition={definition}
        targetTitle={target?.title}
        targetRunning={target ? target.status === 'running' : undefined}
        cwd={cwd}
      />
    </div>
  );
}

/** Last segment of a path, either separator. */
function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * The consent envelope (spec §5: approving the launch IS the grant). Says, in
 * plain words, exactly what saying Yes lets this helper do — where it came
 * from, charter, tools, folder, model — rendered from the MAPPED definition the
 * child will actually get, never from the model's prose. A `task_id` call reads
 * as what it is: a note, a resume, or a stop, and grants nothing new.
 *
 * Destin's 2026-08-26/27 copy review: narrative consent block. One lead
 * sentence carries origin + charter + folder together (the old "What Yes
 * allows" heading, the separate provenance line, and the "X working in Y —
 * description" bullet all went); a file-defined helper gains an amber trust
 * line, and the footer differs by charter.
 */
export function SpecialistEnvelope({ input, definition, targetTitle, targetRunning, cwd }: {
  input: Record<string, unknown>;
  definition?: SpecialistDefinitionView;
  targetTitle?: string;
  targetRunning?: boolean;
  /** Task 10: the CALLER's cwd, not a sessionId to re-derive it from — the
   *  caller (TaskConsentBlock) already needs cwd for useSpecialistDefinition,
   *  so recomputing it here a second time would just be a second read of the
   *  same ArtifactContext value. */
  cwd?: string;
}) {
  const folder = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : undefined;
  const workDir = asString(input.work_dir);
  const where = workDir && workDir !== '.' && workDir !== './' ? workDir : (folder ? `${folder}/` : 'this folder');
  const taskId = asString(input.task_id);
  const [tiers] = useDelegatedModels();

  if (taskId) {
    const who = targetTitle ?? 'this specialist';
    const line = input.interrupt === true
      ? `Yes stops ${who}. Its work so far is kept, and the assistant can resume it later.`
      : targetRunning === false
        ? `Yes sends ${who} back to work with this brief, under the limits you already approved. Nothing new is granted.`
        : `Yes passes this note to ${who} at its next step. Nothing new is granted.`;
    return (
      <div className="rounded-lg border border-edge bg-inset/40 px-3 py-2 text-xs text-fg-dim" data-testid="specialist-envelope">
        {line}
      </div>
    );
  }

  const agent = asString(input.agent) || 'specialist';
  const name = definition?.displayName ?? agent;
  const charter = definition?.charter;
  const tools = definition?.allowedTools ?? [];
  const canShell = tools.includes('Bash');
  const file = definition?.path ? fileName(definition.path) : undefined;

  // The half-sentence every origin ends on, so read-only and read-write read
  // identically no matter which folder the helper came from. A helper with no
  // Bash grant never claims it can run commands.
  const scope = charter === 'read-only'
    ? <>is being hired with <span className="text-fg-2">read-only</span> access to {where}.</>
    : <>is being hired to <span className="text-fg-2">edit files{canShell ? ' and run commands' : ''}</span> in {where}.</>;

  // The lead: origin + charter + folder in ONE sentence. The unknown branch is
  // the only one that promises nothing, because nothing is known.
  const lead = !definition
    ? <><span className="text-fg-2">{agent}</span> could not be looked up, so its tools and limits are unknown. Approve only if you know this specialist.</>
    : definition.source === 'builtin'
      ? <><span className="text-fg-2">The {name}</span> is built into YouCoded and {scope}</>
      : definition.source === 'personal'
        ? <><span className="text-fg-2">{name}</span> comes from your specialists folder ({file}) and {scope}</>
        : definition.grantScope === 'project'
          ? <><span className="text-fg-2">{name}</span> comes from this project's <span className="text-fg-2">.claude/agents/{file}</span> and {scope}</>
          : <><span className="text-fg-2">{name}</span> comes from your ~/.claude/agents/{file} and {scope}</>;

  // What it may do, then the one thing it cannot — the exact tools, named.
  const capability = charter === 'read-only'
    ? <>Cannot edit files or run commands.{tools.length > 0 ? <> It reads and searches using {tools.join(', ')}.</> : null}</>
    : charter === 'read-write'
      ? (canShell
          ? <>Can edit files and run commands without asking again{tools.length > 0 ? <>, using {tools.join(', ')}</> : null}.</>
          : <>Can edit files without asking again{tools.length > 0 ? <>, using {tools.join(', ')}</> : null}. Cannot run commands.</>)
      : null;

  const modelReq = asString(input.model);
  const modelLine = modelReq === 'budget' || modelReq === 'frontier'
    ? (tiers?.[modelReq]
        ? `Runs on the ${modelReq} model from Settings (${tiers[modelReq]!.label}).`
        : `Runs on the ${modelReq} model — none is set in Settings, so it uses this conversation's model.`)
    : modelReq
      ? `Runs on ${modelReq}, which the assistant chose.`
      : definition?.modelPreference && definition.modelPreference !== 'parent'
        ? (tiers?.[definition.modelPreference]
            ? `Runs on the ${definition.modelPreference} model from Settings (${tiers[definition.modelPreference]!.label}) — this specialist prefers it.`
            : `Runs on this conversation's model (it prefers the ${definition.modelPreference} tier, which is not set).`)
        : "Runs on this conversation's model.";

  // Amber, the same tone the held-ask and stale-run lines use: a helper whose
  // instructions YouCoded did not write is the one fact on this card the app
  // cannot vouch for. Built-ins get no line — there is nothing to warn about.
  const trust = !definition || definition.source === 'builtin'
    ? null
    : definition.grantScope === 'project'
      ? 'Its instructions come from a file in this project, not from YouCoded. Only approve it if you trust where this project came from.'
      : "Its instructions come from a file on your computer, not from YouCoded. Open the file if you're not sure what it does.";

  // Tailored per charter: a read-only helper cannot delete anything, so listing
  // deletion among the things that still come to you would be noise.
  const footer = charter === 'read-only'
    ? `Secrets and anything outside ${where} still come to you.`
    : `Deleting things, secrets, and anything outside ${where} still come to you.`;

  return (
    <div className="rounded-lg border border-edge bg-inset/40 px-3 py-2 text-xs space-y-1" data-testid="specialist-envelope">
      <div className="text-fg-dim">{lead}</div>
      <ul className="list-disc pl-4 space-y-0.5 text-fg-dim">
        {capability && <li>{capability}</li>}
        <li>{modelLine}</li>
      </ul>
      {trust && <div className="text-amber-700">{trust}</div>}
      <div className="text-fg-muted">{footer}</div>
    </div>
  );
}

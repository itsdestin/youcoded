// Delegated model tiers — two global user overrides, 'budget' and
// 'frontier', plus curated provider-matched defaults when an override is unset.
// DELIBERATE NON-GOAL: no automatic price heuristic. Reviewed model ids are
// explicit below, and every automatic choice must still exist in the live
// catalog before a specialist can start.
import type { CatalogModel, ModelBinding } from '../../../shared/provider-types';
import type { NativeHome } from '../../native-home';
import type { DelegatedModelsView } from '../../../shared/types';

export type DelegatedTier = 'budget' | 'frontier';

// WHY these are explicit provider-native ids rather than a price heuristic:
// recommendation changes need review, while a heuristic can silently drift to
// a newly-listed premium model. The live catalog still has to confirm the row.
const AUTOMATIC_DELEGATED_MODELS: Record<string, Record<DelegatedTier, string>> = {
  chatgpt: { budget: 'gpt-5.6-terra', frontier: 'gpt-5.6-sol' },
  openrouter: { budget: 'deepseek/deepseek-v4-flash-0731', frontier: 'moonshotai/kimi-k3' },
};

const FILE = 'delegated-models.json';
type DelegatedModelsFile = { v: 1; budget?: ModelBinding; frontier?: ModelBinding };
const EMPTY: DelegatedModelsFile = { v: 1 };

/** Storage for the two designated tiers, one flat file at
 *  ~/.youcoded/delegated-models.json — { v: 1, budget?: ModelBinding,
 *  frontier?: ModelBinding }. Mirrors PermissionStore's shape: NativeHome
 *  owns the file lock, this class owns the read/mutate calls, and reads are
 *  synchronous (NativeHome.readJson) because the Task tool's resolution path
 *  needs the answer before it can even validate the rest of the call. */
export class DelegatedModels {
  constructor(private home: NativeHome) {}

  /** The tier's designated binding, or null when the user has not set one.
   *  The resolver then tries a catalog-confirmed provider default; it never
   *  treats null as permission to inherit the parent model. */
  get(tier: DelegatedTier): ModelBinding | null {
    const data = (this.home.readJson(FILE) as DelegatedModelsFile | null) ?? EMPTY;
    return data[tier] ?? null;
  }

  /** Set (or clear, with null) one tier's designated binding. The Settings UI
   *  (1c) is the only production caller — this class has no opinion on WHERE
   *  the binding came from, only on persisting it. Read-modify-write under
   *  NativeHome's file lock so a concurrent write to the other tier can't
   *  clobber this one. */
  async set(tier: DelegatedTier, binding: ModelBinding | null): Promise<void> {
    await this.home.mutateJson(FILE, (cur) => {
      const data = (cur as DelegatedModelsFile | null) ?? EMPTY;
      if (binding === null) {
        // Destructure-omit rather than `delete data[tier]` — never mutate the
        // value mutateJson handed us (same discipline as permission-store.ts's
        // removeProject: an in-place delete would also corrupt a retry's view
        // of the file).
        const { [tier]: _dropped, ...rest } = data;
        return { ...rest, v: 1 };
      }
      return { ...data, v: 1, [tier]: binding };
    });
  }
}

/** Task 8 — Settings' two tier rows read this. Resolves each set tier's
 *  binding to a display LABEL from the live catalog (never a bare id); a row
 *  whose catalog entry can no longer be found (model removed/renamed since
 *  it was designated) still shows something readable, falling back to the
 *  raw modelId rather than an empty label. An unset tier stays null so the
 *  renderer can show that YouCoded will choose automatically. */
export function delegatedModelsView(designated: DelegatedModels, catalog: CatalogModel[] | null): DelegatedModelsView {
  const rowFor = (tier: DelegatedTier): DelegatedModelsView['budget'] => {
    const binding = designated.get(tier);
    if (!binding) return null;
    const label = catalog?.find((m) => m.id === binding.modelId && m.providerId === binding.providerId)?.label ?? binding.modelId;
    return { providerId: binding.providerId, modelId: binding.modelId, label };
  };
  return { budget: rowFor('budget'), frontier: rowFor('frontier') };
}

/** Priority ordering for what a Task call runs on: the Task-call arg (a user
 *  directive, expressed in the tool call itself) wins over the specialist
 *  definition's own modelPreference (an author-time default), which wins
 *  over the implicit Budget tier. The literal 'parent' is an explicit escape
 *  hatch, never the fallback. A raw string that isn't literally "budget"/"frontier"/"parent" is
 *  treated as a user-directed specific model id, never guessed at or
 *  normalized — resolveDelegatedBinding is what validates it against the
 *  live catalog. */
export function resolveRequestedModel(
  argModel: string | undefined,
  specialistPreference: 'parent' | DelegatedTier | undefined,
): 'parent' | DelegatedTier | { modelId: string } {
  // Fix pass (Finding 2): this function's own return type documents 'parent'
  // as reachable from EITHER input channel — the specialistPreference branch
  // below already honored it, but an explicit `model: "parent"` ARGUMENT was
  // falling through to the specific-id branch and getting looked up as a
  // model literally named "parent" (always refused). Handling it here, next
  // to the tier check, keeps every literal the arg channel recognizes in one
  // place instead of splitting "parent" off into its own branch below.
  if (argModel === 'budget' || argModel === 'frontier' || argModel === 'parent') return argModel;
  if (argModel) return { modelId: argModel };
  if (specialistPreference === 'budget' || specialistPreference === 'frontier' || specialistPreference === 'parent') return specialistPreference;
  // WHY implicit delegation starts at budget: inheriting an expensive parent
  // was invisible and could multiply its cost with every specialist launch.
  return 'budget';
}

/** Thrown by resolveDelegatedBinding when a user-directed specific model id
 *  cannot be confirmed against the live catalog. Distinguishable from a plain
 *  Error so tools/task.ts can render its message directly as the model-facing
 *  refusal instead of a generic "Task failed: ..." wrapper. */
export class DelegatedModelRefused extends Error {}

/** Structured refusal consumed by the Task card's recovery UI. */
export class DelegatedModelUnavailable extends Error {
  constructor(readonly tier: DelegatedTier) {
    super(`SPECIALIST_MODEL_UNAVAILABLE:${tier}`);
  }
}

/** Pure resolver: given the explicit request or the Budget tier selected by
 *  resolveRequestedModel for an implicit call, produce the ModelBinding that
 *  actually launches the child.
 *
 *  A configured tier is a global override. Otherwise the resolver tries the
 *  curated model for the parent's provider and confirms it against the live
 *  catalog. If that safe model cannot be confirmed, delegation REFUSES: it
 *  never substitutes the potentially expensive parent. A user-directed
 *  specific model id is also catalog-validated and refused when unavailable.
 */
export function resolveDelegatedBinding(i: {
  requested: 'parent' | DelegatedTier | { modelId: string };
  parent: ModelBinding;
  designated: DelegatedModels;
  /** For specific-id validation ONLY — a tier lookup never touches this.
   *  null means "catalog not loaded", which is treated identically to "id
   *  not found": an override that cannot be confirmed is refused, never
   *  trusted on faith. */
  catalog: CatalogModel[] | null;
}): { binding: ModelBinding; fellBack: boolean; automatic?: boolean; reason?: string } {
  const { requested, parent, designated, catalog } = i;

  if (requested === 'parent') {
    return { binding: parent, fellBack: false };
  }

  if (requested === 'budget' || requested === 'frontier') {
    const designatedBinding = designated.get(requested);
    if (designatedBinding) return { binding: designatedBinding, fellBack: false };

    const automaticId = AUTOMATIC_DELEGATED_MODELS[parent.providerId]?.[requested];
    const automatic = automaticId
      ? catalog?.find((model) => model.providerId === parent.providerId && model.id === automaticId)
      : undefined;
    if (automatic) {
      return {
        binding: { providerId: automatic.providerId, modelId: automatic.id },
        fellBack: false,
        automatic: true,
      };
    }

    // WHY fail closed: an absent catalog row may mean the provider changed its
    // offering. Falling back to the parent here recreates the accidental-cost
    // path this resolver exists to prevent.
    throw new DelegatedModelUnavailable(requested);
  }

  // requested is { modelId }: a user-directed override, validated against the
  // live catalog. A null catalog (not loaded) and a catalog that simply
  // doesn't list this id read identically here — both mean "cannot confirm
  // this model exists", and an unconfirmed override is refused, not guessed at.
  const matches = catalog?.filter((m) => m.id === requested.modelId) ?? [];
  if (matches.length !== 1) {
    if (matches.length > 1) {
      throw new DelegatedModelRefused(
        `Refused: "${requested.modelId}" is available from multiple providers, so the provider would be ambiguous. Use "budget"/"frontier" or assign the intended provider model to a tier in Settings.`,
      );
    }
    throw new DelegatedModelRefused(
      `Refused: "${requested.modelId}" is not an available model. Use ModelSearch to find the exact id, or use "budget"/"frontier".`,
    );
  }
  const [found] = matches;
  return { binding: { providerId: found.providerId, modelId: found.id }, fellBack: false };
}

// Decides whether a model chosen for chat naming may be saved, against the live model list.
//
// WHY its own file (R-1 batch 1, code review 2026-11-18): the handler used `.catch(() => null)` on the list and then
// skipped the check when the list was null, so a model list that could not load made every pick pass UNCHECKED —
// "a model we cannot see is refused, never quietly swapped for another" (the rule the handler's own comment states)
// held only while the network worked. Here a list that could not load refuses the pick, with a plain sentence that
// states only what is true.
import { reportFailure } from './report-failure';

type CatalogEntry = { id: string; providerId: string };

/** The refusal sentence, or null when the choice may be saved. `catalog` is null when the list could not be loaded. */
function namingModelProblem(
  catalog: readonly CatalogEntry[] | null,
  choice: { providerId: string; modelId: string },
): string | null {
  if (catalog === null) return 'Couldn’t check the model list right now. Try again in a moment.';
  if (!catalog.some((m) => m.id === choice.modelId && m.providerId === choice.providerId)) {
    return `"${choice.modelId}" isn’t in the model list right now — pick it from the list.`;
  }
  return null;
}

/** Loads the list (a failure is logged with its real cause, then counts as "could not be loaded") and decides. */
export async function checkNamingModel(
  load: () => Promise<readonly CatalogEntry[]>,
  choice: { providerId: string; modelId: string },
): Promise<string | null> {
  let catalog: readonly CatalogEntry[] | null = null;
  try { catalog = await load(); }
  catch (cause) { reportFailure({ what: 'load the model list to check the naming model', cause, where: 'naming.set' }); }
  return namingModelProblem(catalog, choice);
}

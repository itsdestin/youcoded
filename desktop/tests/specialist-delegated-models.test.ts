// DelegatedModels + resolveDelegatedBinding (Task 14) — the storage for the
// two user-designated tiers (budget/frontier) and the pure resolver that
// decides what a Task delegation actually runs on. Real filesystem (temp dir
// per test), same fixture style as permission-store.test.ts / delegation-
// ledger.test.ts: NativeHome(dir) against a fresh temp root, no fs mocking.
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import {
  DelegatedModels, resolveDelegatedBinding, resolveRequestedModel, DelegatedModelRefused,
  DelegatedModelUnavailable, delegatedModelsView,
} from '../src/main/harness/specialists/delegated-models';
import type { CatalogModel } from '../src/shared/provider-types';

let home: NativeHome; let designated: DelegatedModels; let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegated-models-'));
  home = new NativeHome(dir);
  designated = new DelegatedModels(home);
});

const PARENT = { providerId: 'openrouter', modelId: 'parent-model' };
const BUDGET_BINDING = { providerId: 'openrouter', modelId: 'cheap-model' };
const FRONTIER_BINDING = { providerId: 'anthropic', modelId: 'claude-opus-5' };

describe('DelegatedModels — storage', () => {
  it('get() returns null for an unset tier', () => {
    expect(designated.get('budget')).toBeNull();
    expect(designated.get('frontier')).toBeNull();
  });

  it('set/get round-trips a tier through a temp NativeHome', async () => {
    await designated.set('budget', BUDGET_BINDING);
    expect(designated.get('budget')).toEqual(BUDGET_BINDING);
    // The other tier is untouched.
    expect(designated.get('frontier')).toBeNull();

    await designated.set('frontier', FRONTIER_BINDING);
    expect(designated.get('frontier')).toEqual(FRONTIER_BINDING);
    // Setting frontier didn't clobber budget.
    expect(designated.get('budget')).toEqual(BUDGET_BINDING);
  });

  it('a fresh DelegatedModels instance over the same home reads what an earlier one wrote', async () => {
    await designated.set('budget', BUDGET_BINDING);
    const reopened = new DelegatedModels(new NativeHome(dir));
    expect(reopened.get('budget')).toEqual(BUDGET_BINDING);
  });

  it('set(tier, null) clears a previously-designated tier', async () => {
    await designated.set('budget', BUDGET_BINDING);
    expect(designated.get('budget')).toEqual(BUDGET_BINDING);
    await designated.set('budget', null);
    expect(designated.get('budget')).toBeNull();
  });
});

describe('delegatedModelsView — Task 8', () => {
  it('delegatedModelsView resolves labels from the catalog and falls back to the model id', async () => {
    await designated.set('budget', BUDGET_BINDING); // { providerId: 'openrouter', modelId: 'cheap-model' } — no catalog row for it
    await designated.set('frontier', FRONTIER_BINDING); // { providerId: 'anthropic', modelId: 'claude-opus-5' }
    const catalog: CatalogModel[] = [
      { id: 'claude-opus-5', providerId: 'anthropic', label: 'Claude Opus 5' },
    ];
    const view = delegatedModelsView(designated, catalog);
    // frontier's binding has a matching catalog row — label comes from it.
    expect(view.frontier).toEqual({ providerId: 'anthropic', modelId: 'claude-opus-5', label: 'Claude Opus 5' });
    // budget's binding has NO matching catalog row — label falls back to the raw modelId.
    expect(view.budget).toEqual({ providerId: 'openrouter', modelId: 'cheap-model', label: 'cheap-model' });
  });

  it('an unset tier stays null regardless of the catalog', () => {
    const view = delegatedModelsView(designated, [{ id: 'x', providerId: 'openrouter', label: 'X' }]);
    expect(view).toEqual({ budget: null, frontier: null });
  });

  it('a null catalog (not loaded) falls back to the raw modelId for every set tier', async () => {
    await designated.set('budget', BUDGET_BINDING);
    const view = delegatedModelsView(designated, null);
    expect(view.budget).toEqual({ providerId: 'openrouter', modelId: 'cheap-model', label: 'cheap-model' });
  });
});

describe('resolveDelegatedBinding — tier resolution', () => {
  it('a configured tier resolves to the designated binding, no fallback', async () => {
    await designated.set('budget', BUDGET_BINDING);
    const r = resolveDelegatedBinding({ requested: 'budget', parent: PARENT, designated, catalog: null });
    expect(r).toEqual({ binding: BUDGET_BINDING, fellBack: false });
  });

  it('an unset ChatGPT Plan tier uses its same-provider curated model', () => {
    const parent = { providerId: 'chatgpt', modelId: 'gpt-5.6-fable' };
    const catalog: CatalogModel[] = [
      { id: 'gpt-5.6-terra', providerId: 'chatgpt', label: 'GPT-5.6 Terra' },
    ];
    const r = resolveDelegatedBinding({ requested: 'budget', parent, designated, catalog });
    expect(r).toEqual({
      binding: { providerId: 'chatgpt', modelId: 'gpt-5.6-terra' },
      fellBack: false,
      automatic: true,
    });
  });

  it('an unset ChatGPT Plan frontier tier uses Sol', () => {
    const parent = { providerId: 'chatgpt', modelId: 'gpt-5.6-fable' };
    const catalog: CatalogModel[] = [
      { id: 'gpt-5.6-sol', providerId: 'chatgpt', label: 'GPT-5.6 Sol' },
    ];
    const r = resolveDelegatedBinding({ requested: 'frontier', parent, designated, catalog });
    expect(r.binding).toEqual({ providerId: 'chatgpt', modelId: 'gpt-5.6-sol' });
  });

  it('an unset OpenRouter frontier tier uses Kimi K3', () => {
    const parent = { providerId: 'openrouter', modelId: 'openai/gpt-5.6-fable' };
    const catalog: CatalogModel[] = [
      { id: 'moonshotai/kimi-k3', providerId: 'openrouter', label: 'Kimi K3' },
    ];
    const r = resolveDelegatedBinding({ requested: 'frontier', parent, designated, catalog });
    expect(r.binding).toEqual({ providerId: 'openrouter', modelId: 'moonshotai/kimi-k3' });
    expect(r.automatic).toBe(true);
  });

  it('an unset OpenRouter budget tier uses DeepSeek V4 Flash 0731', () => {
    const parent = { providerId: 'openrouter', modelId: 'openai/gpt-5.6-fable' };
    const catalog: CatalogModel[] = [
      { id: 'deepseek/deepseek-v4-flash-0731', providerId: 'openrouter', label: 'DeepSeek V4 Flash 0731' },
    ];
    const r = resolveDelegatedBinding({ requested: 'budget', parent, designated, catalog });
    expect(r.binding).toEqual({ providerId: 'openrouter', modelId: 'deepseek/deepseek-v4-flash-0731' });
  });

  it('refuses instead of falling back to the parent when the curated model is unavailable', () => {
    expect(() => resolveDelegatedBinding({
      requested: 'budget',
      parent: { providerId: 'chatgpt', modelId: 'gpt-5.6-fable' },
      designated,
      catalog: [],
    })).toThrow(DelegatedModelUnavailable);
    try {
      resolveDelegatedBinding({
        requested: 'budget',
        parent: { providerId: 'chatgpt', modelId: 'gpt-5.6-fable' },
        designated,
        catalog: [],
      });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe('SPECIALIST_MODEL_UNAVAILABLE:budget');
    }
  });

  it('"parent" passes the parent binding straight through, no fallback flag', () => {
    const r = resolveDelegatedBinding({ requested: 'parent', parent: PARENT, designated, catalog: null });
    expect(r).toEqual({ binding: PARENT, fellBack: false });
  });
});

describe('resolveDelegatedBinding — specific model id (user-directed override)', () => {
  const CATALOG: CatalogModel[] = [
    { id: 'gpt-5', providerId: 'openai', label: 'GPT-5' },
    { id: 'claude-opus-5', providerId: 'anthropic', label: 'Claude Opus 5' },
  ];

  it('a known specific id resolves to that model\'s binding', () => {
    const r = resolveDelegatedBinding({
      requested: { modelId: 'gpt-5' }, parent: PARENT, designated, catalog: CATALOG,
    });
    expect(r).toEqual({ binding: { providerId: 'openai', modelId: 'gpt-5' }, fellBack: false });
  });

  it('a specific id shared by providers refuses instead of choosing the first account', () => {
    const catalog: CatalogModel[] = [
      { id: 'shared-model', providerId: 'openai', label: 'Shared' },
      { id: 'shared-model', providerId: 'chatgpt', label: 'Shared' },
    ];
    expect(() => resolveDelegatedBinding({
      requested: { modelId: 'shared-model' }, parent: PARENT, designated, catalog,
    })).toThrow(DelegatedModelRefused);
  });

  it('an unknown specific id REFUSES — the typed shape, never a silent substitution', () => {
    expect(() => resolveDelegatedBinding({
      requested: { modelId: 'not-a-real-model' }, parent: PARENT, designated, catalog: CATALOG,
    })).toThrow(DelegatedModelRefused);
    try {
      resolveDelegatedBinding({ requested: { modelId: 'not-a-real-model' }, parent: PARENT, designated, catalog: CATALOG });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DelegatedModelRefused);
      expect((err as Error).message).toBe(
        'Refused: "not-a-real-model" is not an available model. Use ModelSearch to find the exact id, or use "budget"/"frontier".',
      );
    }
  });

  it('a null catalog (not loaded) refuses too — an override that cannot be confirmed is never trusted on faith', () => {
    expect(() => resolveDelegatedBinding({
      requested: { modelId: 'gpt-5' }, parent: PARENT, designated, catalog: null,
    })).toThrow(DelegatedModelRefused);
  });
});

describe('resolveRequestedModel — priority ordering', () => {
  it('a Task-call arg beats the specialist definition\'s own preference', () => {
    expect(resolveRequestedModel('frontier', 'budget')).toBe('frontier');
  });

  it('the definition\'s preference beats "parent" when no Task-call arg was given', () => {
    expect(resolveRequestedModel(undefined, 'budget')).toBe('budget');
  });

  it('uses the budget tier when neither the caller nor specialist picked a model', () => {
    expect(resolveRequestedModel(undefined, undefined)).toBe('budget');
  });

  it('keeps an author-directed parent preference explicit', () => {
    expect(resolveRequestedModel(undefined, 'parent')).toBe('parent');
  });

  it('a Task-call arg that is not "budget"/"frontier" is a specific model id, regardless of the definition\'s preference', () => {
    expect(resolveRequestedModel('gpt-5', 'budget')).toEqual({ modelId: 'gpt-5' });
    expect(resolveRequestedModel('gpt-5', undefined)).toEqual({ modelId: 'gpt-5' });
  });

  // Fix pass, Finding 2: an explicit `model: "parent"` ARGUMENT (not just an
  // unset arg falling through to the definition's preference) must resolve
  // to the literal 'parent' passthrough, same as the specialistPreference
  // channel already does above — never fall into the specific-id branch and
  // get looked up as a model literally named "parent" (which would always
  // refuse: "parent" is not an available model).
  it('an explicit model: "parent" ARGUMENT resolves to \'parent\', not a specific-id lookup', () => {
    expect(resolveRequestedModel('parent', undefined)).toBe('parent');
    // The arg still wins over a configured definition preference, exactly
    // like the budget/frontier arg-wins-over-preference case above.
    expect(resolveRequestedModel('parent', 'budget')).toBe('parent');
  });
});

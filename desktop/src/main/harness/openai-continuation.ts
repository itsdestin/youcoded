import type { LanguageModel, ModelMessage } from 'ai';

const CONTINUATION = Symbol('youcoded.openaiContinuation');
const MODEL_BINDING = new WeakMap<object, string | (() => string)>();

export interface ContinuationSizing {
  reasoningTokens?: number;
  reasoningEstimateIncomplete: boolean;
}

type TaggedAssistantMessage = ModelMessage & {
  [CONTINUATION]?: ContinuationSizing;
};

interface OpenAIOptions {
  itemId?: string;
  phase?: 'commentary' | 'final_answer' | null;
  reasoningEncryptedContent?: string | null;
  parallelToolCall?: {
    itemId: string;
    toolCallId: string;
    toolName: string;
    input: string;
    index: number;
    count: number;
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function openAIOptions(value: unknown, kind: 'text' | 'reasoning' | 'tool-call'): OpenAIOptions | undefined {
  const source = record(record(value)?.openai);
  if (!source) return undefined;
  const itemId = string(source.itemId);
  if (kind !== 'tool-call' && !itemId) return undefined;

  if (kind === 'text') {
    const phase = source.phase;
    return {
      itemId: itemId!,
      ...(phase === 'commentary' || phase === 'final_answer' || phase === null ? { phase } : {}),
    };
  }
  if (kind === 'reasoning') {
    const encrypted = source.reasoningEncryptedContent;
    return {
      itemId: itemId!,
      ...(typeof encrypted === 'string' || encrypted === null ? { reasoningEncryptedContent: encrypted } : {}),
    };
  }

  const parallel = record(source.parallelToolCall);
  const validatedParallel = parallel
    && string(parallel.itemId)
    && string(parallel.toolCallId)
    && string(parallel.toolName)
    && string(parallel.input)
    && Number.isInteger(parallel.index)
    && Number.isInteger(parallel.count)
    && Number(parallel.index) >= 0
    && Number(parallel.count) > Number(parallel.index)
    ? {
      itemId: string(parallel.itemId)!, toolCallId: string(parallel.toolCallId)!,
      toolName: string(parallel.toolName)!, input: string(parallel.input)!,
      index: Number(parallel.index), count: Number(parallel.count),
    }
    : undefined;
  if (!itemId && !validatedParallel) return undefined;
  return { ...(itemId ? { itemId } : {}), ...(validatedParallel ? { parallelToolCall: validatedParallel } : {}) };
}

function providerOptions(options: OpenAIOptions | undefined): { openai: OpenAIOptions } | undefined {
  return options ? { openai: options } : undefined;
}

/**
 * Copies only completed assistant content understood by the pinned Responses
 * converter. Tool messages are deliberately rejected: the harness owns local
 * execution and adds exactly one result for each accepted call.
 */
export function openAIContinuationMessages(responseMessages: ModelMessage[], reasoningTokens: number | undefined): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const message of responseMessages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const content: any[] = [];
    for (const part of message.content as any[]) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        const options = providerOptions(openAIOptions(part.providerOptions ?? part.providerMetadata, 'text'));
        content.push({ type: 'text', text: part.text, ...(options ? { providerOptions: options } : {}) });
      } else if (part?.type === 'reasoning' && typeof part.text === 'string') {
        const options = providerOptions(openAIOptions(part.providerOptions ?? part.providerMetadata, 'reasoning'));
        if (options) content.push({ type: 'reasoning', text: part.text, providerOptions: options });
      } else if (part?.type === 'tool-call'
        && typeof part.toolCallId === 'string' && typeof part.toolName === 'string') {
        // WHY: ai@7 can leave the item id and expanded-wrapper ownership on
        // different metadata aliases. Validate each alias independently, then
        // copy only the converter-supported fields into providerOptions.
        const fromOptions = openAIOptions(part.providerOptions, 'tool-call');
        const fromMetadata = openAIOptions(part.providerMetadata, 'tool-call');
        const merged = fromOptions || fromMetadata ? {
          ...(fromOptions?.itemId ? { itemId: fromOptions.itemId } : fromMetadata?.itemId ? { itemId: fromMetadata.itemId } : {}),
          ...(fromOptions?.parallelToolCall
            ? { parallelToolCall: fromOptions.parallelToolCall }
            : fromMetadata?.parallelToolCall ? { parallelToolCall: fromMetadata.parallelToolCall } : {}),
        } : undefined;
        const options = providerOptions(merged);
        content.push({
          type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName,
          input: part.input,
          ...(options ? { providerOptions: options } : {}),
        });
      }
    }
    if (content.length === 0) continue;
    const tagged = { role: 'assistant', content } as TaggedAssistantMessage;
    const hasReasoning = content.some(part => part.type === 'reasoning');
    if (hasReasoning) {
      // WHY: ciphertext bytes are opaque storage, not tokens. This private,
      // non-enumerable tag keeps the per-step provider count beside the accepted
      // message without leaking into SDK provider options or public transcript data.
      Object.defineProperty(tagged, CONTINUATION, {
        value: {
          ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
          reasoningEstimateIncomplete: reasoningTokens === undefined,
        } satisfies ContinuationSizing,
      });
    }
    out.push(tagged);
  }
  return out;
}

function visibleCharSize(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return 8;
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + visibleCharSize(child), 2);
  if (typeof value !== 'object') return 8;
  let sum = 2;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'providerOptions' || key === 'providerMetadata') continue;
    sum += key.length + visibleCharSize(child);
  }
  return sum;
}

export function durableContinuationSizing(message: ModelMessage): ContinuationSizing | null {
  const sizing = (message as TaggedAssistantMessage)[CONTINUATION];
  return sizing ? { ...sizing } : null;
}

export function restoreContinuationSizing(message: ModelMessage, sizing: ContinuationSizing): void {
  // WHY: the durable manifest is private, while the live association remains
  // non-enumerable so SDK serialization and public transcript paths cannot see it.
  Object.defineProperty(message as TaggedAssistantMessage, CONTINUATION, { value: { ...sizing } });
}

export function continuationEstimate(message: ModelMessage): { tokens: number; incomplete: boolean } | null {
  const sizing = durableContinuationSizing(message);
  if (!sizing || !Array.isArray(message.content)) return null;
  let visibleChars = 0;
  for (const part of message.content as any[]) {
    if (part?.type !== 'reasoning') visibleChars += visibleCharSize(part);
  }
  const visibleTokens = Math.ceil(visibleChars / 4);
  if (sizing.reasoningTokens !== undefined) {
    return { tokens: visibleTokens + sizing.reasoningTokens, incomplete: false };
  }
  const reasoningChars = (message.content as any[])
    .filter(part => part?.type === 'reasoning')
    .reduce((sum, part) => sum + (typeof part.text === 'string' ? part.text.length : 0), 0);
  return { tokens: visibleTokens + Math.ceil(reasoningChars / 4), incomplete: true };
}

/** Associates a live non-secret provider/model/account/auth-generation owner. */
export function bindOpenAIContinuationModel<T extends LanguageModel>(model: T, bindingIdentity: string | (() => string)): T {
  MODEL_BINDING.set(model as object, bindingIdentity);
  return model;
}

export function openAIContinuationBinding(model: LanguageModel): string | undefined {
  const binding = MODEL_BINDING.get(model as object);
  return typeof binding === 'function' ? binding() : binding;
}

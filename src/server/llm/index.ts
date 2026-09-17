// ---------------------------------------------------------------------------
// LLM layer. complete(messages, { schema }) picks a provider from LLM_PROVIDER:
//   openai_compatible (default) | sap_ai_core | mock
// Providers implement the same interface; sap_ai_core is loaded lazily so a
// missing SAP credential can never break `npm run dev`.
// ---------------------------------------------------------------------------
import type { ZodTypeAny, infer as ZInfer } from 'zod';
import { makeLogger } from '../log.js';
import { completeOpenAiCompatible, probeProvider } from './openai.js';
import { completeMock } from './mock.js';

const log = makeLogger('LLM');

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteResult<T> {
  value: T;
  raw: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costUsd: number;
  fallback: boolean;
}

export interface ResolvedProvider {
  provider: string;
  model: string;
  baseUrl?: string;
}

let resolved: ResolvedProvider | null = null;

// Operator-facing "model" label chosen from the UI dropdown. This overrides the
// model name surfaced to the UI (getResolvedProvider / llm:info) so the demo can
// showcase picking a model, while the underlying provider dispatch is unchanged.
let displayModel: string | null = null;

export function setDisplayModel(model: string | null) {
  displayModel = model && model.trim() ? model.trim() : null;
}

export function getDisplayModel(): string | null {
  return displayModel;
}

// Default per-1k-token prices (USD). Roughly GPT-4o-mini list pricing, so the
// demo shows a plausible non-zero cost out of the box. Override with the env
// vars for real provider pricing.
const DEFAULT_PRICE_PER_1K_INPUT = 0.00015;
const DEFAULT_PRICE_PER_1K_OUTPUT = 0.0006;

function pricePer1k(): { input: number; output: number } {
  const inEnv = process.env.LLM_PRICE_PER_1K_INPUT;
  const outEnv = process.env.LLM_PRICE_PER_1K_OUTPUT;
  return {
    input: inEnv != null && inEnv !== '' ? Number(inEnv) : DEFAULT_PRICE_PER_1K_INPUT,
    output: outEnv != null && outEnv !== '' ? Number(outEnv) : DEFAULT_PRICE_PER_1K_OUTPUT,
  };
}

export function estimateCost(tokensIn: number, tokensOut: number): number {
  const p = pricePer1k();
  return Number(((tokensIn / 1000) * p.input + (tokensOut / 1000) * p.output).toFixed(5));
}

/** Detect the active provider/model at startup and log it. */
export async function resolveProvider(): Promise<ResolvedProvider> {
  if (resolved) return resolved;
  const provider = (process.env.LLM_PROVIDER || 'openai_compatible').trim();

  if (provider === 'mock') {
    resolved = { provider: 'mock', model: 'mock-campaigner' };
    log.info('llm provider resolved', resolved);
    return resolved;
  }

  if (provider === 'sap_ai_core') {
    try {
      const { resolveSapProvider } = await import('./sapAiCore.js');
      resolved = await resolveSapProvider();
      log.info('llm provider resolved', resolved);
      return resolved;
    } catch (e) {
      log.warn('sap_ai_core unavailable, falling back to mock', { error: String(e) });
      resolved = { provider: 'mock', model: 'mock-campaigner' };
      return resolved;
    }
  }

  // openai_compatible: use explicit config, else probe local proxies.
  const explicitBase = process.env.LLM_BASE_URL;
  if (explicitBase) {
    const model = process.env.LLM_MODEL || (await probeProvider(explicitBase))?.models?.[0] || 'unknown';
    resolved = { provider: 'openai_compatible', model, baseUrl: explicitBase };
    log.info('llm provider resolved (explicit base)', resolved);
    return resolved;
  }

  const candidates = [
    'http://localhost:4000/v1', // LiteLLM
    'http://localhost:8000/v1',
    'http://localhost:1234/v1', // LM Studio
    'http://localhost:11434/v1', // Ollama
  ];
  for (const base of candidates) {
    const probe = await probeProvider(base);
    if (probe) {
      const model = process.env.LLM_MODEL || probe.models[0] || 'unknown';
      resolved = { provider: 'openai_compatible', model, baseUrl: base };
      log.info('llm proxy answered', { base, models: probe.models });
      log.info('llm provider resolved', resolved);
      return resolved;
    }
  }

  log.warn('no openai-compatible proxy answered on any probe port; using mock provider');
  resolved = { provider: 'mock', model: 'mock-campaigner' };
  return resolved;
}

export function getResolvedProvider(): ResolvedProvider {
  const base = resolved ?? { provider: 'mock', model: 'mock-campaigner' };
  return displayModel ? { ...base, model: displayModel } : base;
}

/** Force a provider to be re-resolved (used on reset / config change). */
export function clearResolved() {
  resolved = null;
}

/**
 * Complete against the active provider. If a zod schema is supplied, the raw
 * text is parsed as JSON and validated; on failure the caller retries.
 */
export async function complete<S extends ZodTypeAny>(
  messages: LlmMessage[],
  opts: { schema?: S; temperature?: number } = {},
): Promise<CompleteResult<S extends ZodTypeAny ? ZInfer<S> : string>> {
  const p = await resolveProvider();
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 45000);

  if (p.provider === 'mock') {
    return completeMock(messages, opts) as never;
  }
  if (p.provider === 'sap_ai_core') {
    const { completeSap } = await import('./sapAiCore.js');
    return completeSap(messages, { ...opts, timeoutMs }) as never;
  }
  return completeOpenAiCompatible(messages, {
    ...opts,
    baseUrl: p.baseUrl!,
    model: p.model,
    apiKey: process.env.LLM_API_KEY,
    timeoutMs,
  }) as never;
}

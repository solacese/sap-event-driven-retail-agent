// ---------------------------------------------------------------------------
// SAP AI Core provider via @sap-ai-sdk/orchestration. Optional at build time:
// this module is imported lazily so a missing AICORE_SERVICE_KEY cannot break
// `npm run dev`. See docs/SAP_AI_SDK.md for the env a SAP prospect must set.
//
// What changes on screen when this provider is active: nothing except the
// header chip. That is the co-sell point.
// ---------------------------------------------------------------------------
import type { ZodTypeAny } from 'zod';
import { makeLogger } from '../log.js';
import { estimateCost, type LlmMessage, type ResolvedProvider } from './index.js';
import { extractJson } from './openai.js';

const log = makeLogger('LLM');

export async function resolveSapProvider(): Promise<ResolvedProvider> {
  if (!process.env.AICORE_SERVICE_KEY) {
    throw new Error('AICORE_SERVICE_KEY not set');
  }
  const model = process.env.AICORE_MODEL || 'gpt-4o';
  return { provider: 'sap_ai_core', model };
}

export async function completeSap(
  messages: LlmMessage[],
  opts: { schema?: ZodTypeAny; temperature?: number; timeoutMs: number },
) {
  const started = Date.now();
  // Lazy import: the package is an optionalDependency and may be absent.
  let OrchestrationClient: any;
  try {
    ({ OrchestrationClient } = await import('@sap-ai-sdk/orchestration'));
  } catch (e) {
    throw new Error(`@sap-ai-sdk/orchestration not installed: ${String(e)}`);
  }

  const model = process.env.AICORE_MODEL || 'gpt-4o';
  const client = new OrchestrationClient({
    llm: { model_name: model, model_params: { temperature: opts.temperature ?? 0.3 } },
    templating: {
      template: messages.map((m) => ({ role: m.role, content: m.content })),
    },
  });

  const response = await client.chatCompletion();
  const raw: string = response.getContent?.() ?? '';
  const usage = response.getTokenUsage?.() ?? {};
  const tokensIn = usage.prompt_tokens ?? Math.ceil(messages.map((m) => m.content).join(' ').length / 4);
  const tokensOut = usage.completion_tokens ?? Math.ceil(raw.length / 4);
  const latencyMs = Date.now() - started;
  const costUsd = estimateCost(tokensIn, tokensOut);

  log.info('sap ai core completion', { model, tokensIn, tokensOut, latencyMs });

  if (!opts.schema) {
    return { value: raw, raw, tokensIn, tokensOut, latencyMs, costUsd, fallback: false };
  }
  const parsed = opts.schema.parse(extractJson(raw));
  return { value: parsed, raw, tokensIn, tokensOut, latencyMs, costUsd, fallback: false };
}

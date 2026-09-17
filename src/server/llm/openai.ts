// ---------------------------------------------------------------------------
// OpenAI-compatible provider (LiteLLM, LM Studio, Ollama, vLLM, ...). Uses the
// /chat/completions endpoint with JSON response format. No SDK dependency.
// ---------------------------------------------------------------------------
import type { ZodTypeAny } from 'zod';
import { makeLogger } from '../log.js';
import { estimateCost, type LlmMessage } from './index.js';

const log = makeLogger('LLM');

export async function probeProvider(
  baseUrl: string,
): Promise<{ models: string[] } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      signal: ctrl.signal,
      headers: authHeader(process.env.LLM_API_KEY),
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    const models = (json.data || []).map((m) => m.id);
    return { models };
  } catch {
    return null;
  }
}

function authHeader(key?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (key) h.authorization = `Bearer ${key}`;
  return h;
}

export async function completeOpenAiCompatible(
  messages: LlmMessage[],
  opts: {
    schema?: ZodTypeAny;
    temperature?: number;
    baseUrl: string;
    model: string;
    apiKey?: string;
    timeoutMs: number;
  },
) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);

  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    temperature: opts.temperature ?? 0.3,
    stream: false,
  };
  // Ask for JSON when a schema is expected. Harmless for providers that ignore it.
  if (opts.schema) body.response_format = { type: 'json_object' };

  let res: globalThis.Response;
  try {
    res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: authHeader(opts.apiKey),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`llm http ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const raw = json.choices?.[0]?.message?.content ?? '';
  const tokensIn = json.usage?.prompt_tokens ?? estimateTokens(messages.map((m) => m.content).join(' '));
  const tokensOut = json.usage?.completion_tokens ?? estimateTokens(raw);
  const latencyMs = Date.now() - started;
  const costUsd = estimateCost(tokensIn, tokensOut);

  log.info('llm completion', { model: opts.model, tokensIn, tokensOut, latencyMs });

  if (!opts.schema) {
    return { value: raw, raw, tokensIn, tokensOut, latencyMs, costUsd, fallback: false };
  }
  const parsed = opts.schema.parse(extractJson(raw));
  return { value: parsed, raw, tokensIn, tokensOut, latencyMs, costUsd, fallback: false };
}

// Some local models wrap JSON in prose or fences; pull out the first object.
export function extractJson(text: string): unknown {
  // Strip reasoning-model thinking blocks (Qwen3, DeepSeek R1, etc.) first.
  const noThink = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '');
  const fenced = noThink.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : noThink;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));
  }
  return JSON.parse(candidate);
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

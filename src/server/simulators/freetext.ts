// ---------------------------------------------------------------------------
// Free-text scenario synthesis. A user types a scenario in plain language
// ("heatwave plus a music festival in Lyon", "supplier recall, weather tool is
// flaky"); we ask the active LLM to turn it into a bounded ScenarioPatch that
// the world simulator can apply. When the provider is the mock (or the model
// returns something unusable), we fall back to a deterministic keyword
// heuristic so the demo still does the sensible thing offline.
// ---------------------------------------------------------------------------
import { z } from 'zod';
import { complete, getResolvedProvider, type LlmMessage } from '../llm/index.js';
import type { ScenarioPatch } from './world.js';
import { makeLogger } from '../log.js';

const log = makeLogger('SIMULATOR');

// The schema the LLM must fill. Kept small and safe; the world clamps numbers.
const patchSchema = z.object({
  weatherGood: z.boolean().describe('true if the weather favours grilling/outdoor demand'),
  nationalEvent: z.boolean().describe('true if a major national event drives at-home demand'),
  weatherToolDown: z.boolean().describe('true if the scenario implies the weather tool is unavailable'),
  marketingConsented: z
    .number()
    .int()
    .min(0)
    .max(1104)
    .describe('addressable customers who allow marketing, out of ~1104 total'),
  discountPct: z.number().int().min(1).max(90).describe('markdown percentage on the perishable SKU'),
  item: z.string().max(80).describe('the product being marked down'),
  reason: z.string().max(160).describe('one-line business reason for the markdown'),
});

const SYSTEM = [
  'You translate a retail demo scenario written in plain language into a JSON',
  'object describing world state for a discount agent. The base product is a',
  'perishable fresh item in France. Infer each field from the prompt:',
  '- weatherGood: warm/dry/sunny => true; rain/storm/cold => false.',
  '- nationalEvent: a holiday, final, World Cup, festival, etc. => true.',
  '- weatherToolDown: only if the prompt says a tool/service/API is down or flaky.',
  '- marketingConsented: 0..1104. Small/low-consent audience => ~120-200;',
  '  broad/high-consent => ~900-1000; otherwise ~700.',
  '- discountPct: 1..90, a believable markdown (default ~30).',
  '- item: the product if named, else "Artisan Pork Sausage 500g".',
  '- reason: a short business rationale for the markdown.',
  'Reply with ONLY the JSON object.',
].join(' ');

/**
 * Turn free text into a ScenarioPatch. Uses the LLM when one is configured;
 * always resolves (never throws) so the caller can run the scenario regardless.
 */
export async function synthesiseScenario(text: string): Promise<{ patch: ScenarioPatch; source: 'llm' | 'heuristic' }> {
  const prompt = text.trim().slice(0, 500);
  const provider = getResolvedProvider();

  if (provider.provider !== 'mock') {
    try {
      const messages: LlmMessage[] = [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ];
      const r = await complete(messages, { schema: patchSchema });
      const v = r.value;
      const patch: ScenarioPatch = {
        weatherGood: v.weatherGood,
        nationalEvent: v.nationalEvent,
        weatherToolDown: v.weatherToolDown,
        marketingConsented: v.marketingConsented,
        consentWithheld: 1104 - v.marketingConsented,
        discountPct: v.discountPct,
        item: v.item,
        reason: v.reason,
      };
      log.info('scenario synthesised via llm', { prompt, patch });
      return { patch, source: 'llm' };
    } catch (e) {
      log.warn('llm scenario synthesis failed, using heuristic', { error: String(e) });
    }
  }

  return { patch: heuristic(prompt), source: 'heuristic' };
}

/** Deterministic keyword parse used in mock mode or when the LLM is unusable. */
export function heuristic(text: string): ScenarioPatch {
  const t = text.toLowerCase();
  const has = (...words: string[]) => words.some((w) => t.includes(w));

  const bad = has('rain', 'storm', 'cold', 'snow', 'wet', 'wind');
  const good = has('sun', 'sunny', 'warm', 'hot', 'heat', 'bbq', 'barbecue', 'grill', 'clear');
  const weatherGood = good || !bad; // default optimistic unless clearly bad
  const nationalEvent = has(
    'world cup',
    'cup',
    'final',
    'match',
    'festival',
    'holiday',
    'olympic',
    'event',
    'concert',
    'game',
  );
  // Only treat the weather tool as down on an explicit tool/outage phrase;
  // bare "down"/"api" tripped on ordinary prompts.
  const weatherToolDown = has('tool', 'outage', 'flaky', 'unavailable', 'times out', 'timeout', 'is down', 'goes down');
  const lowConsent = has('consent', 'opt-out', 'unsubscrib', 'small audience', 'few customers');

  const discountPct = parseDiscount(t);
  const item = parseItem(text);

  const patch: ScenarioPatch = {
    weatherGood,
    nationalEvent,
    weatherToolDown,
    marketingConsented: lowConsent ? 150 : nationalEvent ? 960 : 720,
    consentWithheld: lowConsent ? 954 : nationalEvent ? 144 : 384,
    discountPct: discountPct ?? 30,
    reason: text.trim().slice(0, 160) || 'Perishable clearance',
  };
  if (item) patch.item = item;
  return patch;
}

/** First believable "NN%" / "NN percent" / "NN pct" in the prompt, clamped 1..90. */
function parseDiscount(t: string): number | null {
  const m = t.match(/(\d{1,3})\s*(?:%|percent|pct)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(90, Math.round(n));
}

/**
 * Best-effort product extraction for offline mode. Tries the common phrasings
 * a user types ("orange juice has too much stock", "overstocked ice cream",
 * "too much orange juice"), then a small curated keyword map. Returns a
 * Title-Cased phrase or null when nothing is confidently found.
 */
function parseItem(text: string): string | null {
  const t = text.toLowerCase();

  // Curated known items first - precise multi-word phrases (longest match wins)
  // beat the looser regexes, which otherwise clip "ice cream" to "ice".
  const known = [
    'orange juice',
    'apple juice',
    'ice cream',
    'pork sausage',
    'strawberries',
    'strawberry',
    'lager',
    'beer',
    'sausage',
    'chicken',
    'salmon',
    'cheese',
    'yoghurt',
    'yogurt',
    'milk',
  ];
  const hit = known
    .filter((k) => t.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  if (hit) return titleCase(hit);

  // Otherwise capture a noun phrase from the common overstock/clearance phrasings.
  const patterns: RegExp[] = [
    /([a-z][a-z\s]{2,40}?)\s+(?:has|have|is|are)\s+(?:too much|excess|surplus|overstock)/,
    /(?:overstock(?:ed)?|surplus|excess|too much)\s+(?:of\s+)?([a-z][a-z\s]{2,40}?)(?:\s+(?:stock|inventory|in\b))?[,.]?/,
    /(?:clear|markdown|discount|sell)\s+(?:the\s+)?([a-z][a-z\s]{2,40}?)(?:\s+(?:stock|inventory))?[,.]?/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[1]) {
      const phrase = cleanItem(m[1]);
      if (phrase) return phrase;
    }
  }
  return null;
}

// Strip filler words and stray articles, drop noise, and title-case the result.
function cleanItem(raw: string): string | null {
  const stop = new Set(['the', 'a', 'an', 'some', 'our', 'my', 'of', 'and', 'with', 'that']);
  const words = raw
    .trim()
    .split(/\s+/)
    .filter((w) => w && !stop.has(w));
  // Keep the last 1-3 words - the head noun usually sits at the end
  // ("way too much orange juice" -> "orange juice").
  const tail = words.slice(-3);
  if (tail.length === 0) return null;
  const phrase = tail.join(' ');
  if (phrase.length < 3 || phrase.length > 40) return null;
  return titleCase(phrase);
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

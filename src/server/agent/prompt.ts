// ---------------------------------------------------------------------------
// Prompt builders. The system prompt frames the agent as a retail pricing
// specialist that must respect consent and can say "hold". The user prompt
// embeds a compact context JSON (the same shape the mock provider reads) so the
// campaign is grounded in the gathered signals.
// ---------------------------------------------------------------------------
import type { LlmMessage } from '../llm/index.js';
import type {
  PriceUpdated,
  WeatherReply,
  NewsReply,
  InventoryReply,
  CustomerInterestReply,
} from './schema.js';

export interface GatheredSignals {
  price: PriceUpdated;
  weather?: WeatherReply;
  news?: NewsReply;
  inventory?: InventoryReply;
  customerInterest?: CustomerInterestReply;
  signalsUsed: string[];
  signalsUnavailable: string[];
  /** Consent-filtered audience size, computed in code before the LLM sees it. */
  consentedCount: number;
}

const SYSTEM = `You are Pricing Bot, a dynamic-pricing and marketing agent for a European grocer.
You react to price/updated events on an event mesh - driven by weather, news, inventory and demand signals - and draft a compliant micro-campaign proposing the move to a human.

The move can go three ways, given by "direction":
- "decrease": a markdown (clear perishable/overstocked lines). offer.type "percentage", offer.value like "20%".
- "increase": a temporary surge (scarce stock + a demand spike, e.g. a rainy weekend and low umbrella stock). offer.type "price_increase", offer.value like "+15% for 72h". Frame it as a short, fair, temporary adjustment - never gouging.
- "bundle": pair the item with an affinity product (e.g. ube spread + butter biscuits when both trend). offer.type "bundle", offer.value like "Ube + Biscuits for €9", and list the paired product in bundleWith.

Hard rules you must obey:
- Only target customers who have given explicit marketing consent. The audience size is provided already filtered to consented customers. Never propose a larger audience.
- You may decline. If conditions do not support the move (poor weather for a grill item, a national-event conflict, or no consented audience), set "recommendation" to "hold" and lower confidence.
- Keep headline within 60 characters and body within 240 characters. Make the copy fun and specific - reference the real reason (the rain, the viral trend, the show).
- Every rationale bullet must reference a specific signal you used (price, weather, news, inventory, customer_interest).
- Do not invent stores or customers beyond what the context provides.

Respond with a single JSON object only, matching the campaign schema. No prose, no markdown fences.`;

/** A compact, model-friendly context object embedded in the user prompt. */
export function buildContextJson(s: GatheredSignals) {
  const grillReady = (s.price.tags || []).includes('grill_ready');
  // precipProbability may arrive as a 0..1 probability or a 0..100 percentage;
  // normalise so "good weather" means low rain chance under either convention.
  const rainChance = (d: { precipProbability: number }) =>
    d.precipProbability > 1 ? d.precipProbability / 100 : d.precipProbability;
  const weatherGood = s.weather
    ? s.weather.outlook.every((d) => rainChance(d) < 0.4)
    : undefined;
  const nationalEventConflict = s.news ? s.news.nationalEvents.length > 0 : false;
  const targetStores = s.inventory?.stores.map((st) => st.storeId).slice(0, 8) ?? [];

  const changePct = s.price.changePct ?? -s.price.discountPct;
  const direction =
    s.price.direction ?? (changePct > 0 ? 'increase' : changePct < 0 ? 'decrease' : 'bundle');

  return {
    sku: s.price.sku,
    item: s.price.item,
    category: s.price.category,
    tags: s.price.tags,
    country: s.price.country,
    previousPrice: s.price.previousPrice,
    newPrice: s.price.newPrice,
    currency: s.price.currency,
    discountPct: s.price.discountPct,
    // Signed move + direction so the model/mock can write surge/bundle copy, not
    // just markdown copy. `bundle` carries the paired product for a bundle.
    changePct,
    direction,
    bundle: s.price.bundle ?? null,
    shelfLifeDaysRemaining: s.price.shelfLifeDaysRemaining,
    grillReady,
    weatherGood,
    weatherSummary: s.weather?.summary ?? null,
    nationalEventConflict,
    topNews: s.news?.notable?.[0]?.headline ?? null,
    atRiskUnits: s.inventory?.atRiskUnits ?? null,
    storesWithStock: s.inventory?.storesWithStock ?? null,
    targetStores,
    consentedCount: s.consentedCount,
    topAffinities: s.customerInterest?.topAffinities ?? [],
    signalsUsed: s.signalsUsed,
    signalsUnavailable: s.signalsUnavailable,
  };
}

export function buildMessages(s: GatheredSignals): LlmMessage[] {
  const ctx = buildContextJson(s);
  const user = `A price change event triggered a run. Draft the campaign.

Context (already gathered from the mesh; audience is pre-filtered to consented customers):
${JSON.stringify(ctx, null, 2)}

Produce the campaign JSON now.`;
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

/** Append a validation error and re-ask (single retry). */
export function buildRetryMessages(base: LlmMessage[], validationError: string): LlmMessage[] {
  return [
    ...base,
    {
      role: 'user',
      content: `Your previous response failed schema validation: ${validationError}. Return corrected JSON only, matching the schema exactly.`,
    },
  ];
}

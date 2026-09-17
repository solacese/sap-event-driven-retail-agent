// ---------------------------------------------------------------------------
// Mock provider: deterministic, no network. Reads the compact context JSON that
// the prompt builder embeds in the final user message and produces a plausible
// campaign that respects consent and weather. Used for offline demos and tests.
// ---------------------------------------------------------------------------
import type { ZodTypeAny } from 'zod';
import { estimateCost, type LlmMessage } from './index.js';

interface MockCtx {
  sku?: string;
  item?: string;
  category?: string;
  tags?: string[];
  country?: string;
  previousPrice?: number;
  newPrice?: number;
  discountPct?: number;
  changePct?: number;
  direction?: 'increase' | 'decrease' | 'bundle';
  bundle?: { withSku: string; withItem: string; bundlePrice: number } | null;
  consentedCount?: number;
  weatherGood?: boolean;
  nationalEventConflict?: boolean;
  topNews?: string | null;
  topAffinities?: string[];
  targetStores?: string[];
  atRiskUnits?: number;
  signalsUsed?: string[];
  signalsUnavailable?: string[];
}

export async function completeMock(
  messages: LlmMessage[],
  opts: { schema?: ZodTypeAny; temperature?: number },
) {
  const started = Date.now();
  const ctx = extractCtx(messages);
  const value = buildCampaign(ctx);
  const raw = JSON.stringify(value, null, 2);
  const tokensIn = 400;
  const tokensOut = 260;
  // Small delay so the "reasoning" state is visible on stage.
  await new Promise((r) => setTimeout(r, 350));
  const result = {
    value: opts.schema ? opts.schema.parse(value) : raw,
    raw,
    tokensIn,
    tokensOut,
    latencyMs: Date.now() - started,
    // Price the synthetic tokens so the demo reports a plausible non-zero cost.
    costUsd: estimateCost(tokensIn, tokensOut),
    fallback: false,
  };
  return result;
}

function extractCtx(messages: LlmMessage[]): MockCtx {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!last) return {};
  try {
    const start = last.content.indexOf('{');
    const end = last.content.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(last.content.slice(start, end + 1)) as MockCtx;
    }
  } catch {
    /* fall through */
  }
  return {};
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildCampaign(ctx: MockCtx) {
  const item = ctx.item || 'product';
  const consented = ctx.consentedCount ?? 0;
  const grill = (ctx.tags || []).includes('grill_ready');
  const changePct = ctx.changePct ?? -(ctx.discountPct ?? 0);
  const direction: 'increase' | 'decrease' | 'bundle' =
    ctx.direction ?? (changePct > 0 ? 'increase' : changePct < 0 ? 'decrease' : 'bundle');
  const badWeatherForGrill = grill && ctx.weatherGood === false;
  // Only a markdown of a grill item is undermined by bad weather. A rainy-day
  // umbrella surge is *helped* by rain, so it must not be held for it.
  const hold =
    (direction === 'decrease' && badWeatherForGrill) ||
    ctx.nationalEventConflict === true ||
    consented === 0;
  const affinities = ctx.topAffinities?.slice(0, 3) ?? [];
  const now = new Date();
  const startsAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const endsAt = new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString();

  const expectedUnitsMoved = Math.min(ctx.atRiskUnits || 520, Math.round(consented * 0.55));
  const copy = buildCopy(ctx, direction, hold, item, affinities);

  return {
    headline: copy.headline,
    body: copy.body,
    channel: 'push' as const,
    offer: copy.offer,
    bundleWith: copy.bundleWith,
    audience: {
      segment: 'repeat purchasers, opted in',
      size: consented,
      consentBasis: 'explicit_marketing_optin',
    },
    targetStores: ctx.targetStores ?? [],
    sendWindow: { startsAt, endsAt },
    expectedUnitsMoved: hold ? 0 : expectedUnitsMoved,
    marginImpactEur: hold ? 0 : copy.marginImpactEur(expectedUnitsMoved),
    // wasteAvoidedUnits only makes literal sense for a markdown; for surge/bundle
    // it is 0 (the revenue metric is recomputed in code from expectedUnitsMoved).
    wasteAvoidedUnits: hold || direction !== 'decrease' ? 0 : expectedUnitsMoved,
    confidence: hold ? 0.28 : copy.confidence,
    rationale: buildRationale(ctx, direction, hold, badWeatherForGrill),
    signalsUsed: ctx.signalsUsed ?? ['price', 'weather', 'news', 'inventory', 'customer_interest'],
    signalsUnavailable: ctx.signalsUnavailable ?? [],
    recommendation: hold ? ('hold' as const) : ('proceed' as const),
  };
}

// Direction-specific, deliberately fun copy for the swipe deck.
function buildCopy(
  ctx: MockCtx,
  direction: 'increase' | 'decrease' | 'bundle',
  hold: boolean,
  item: string,
  affinities: string[],
) {
  const changePct = ctx.changePct ?? -(ctx.discountPct ?? 0);
  const newPrice = ctx.newPrice ?? 2.99;
  const prevPrice = ctx.previousPrice ?? newPrice;

  if (hold) {
    return {
      headline: `Hold: reassess ${item} move`.slice(0, 60),
      body: 'Conditions do not favour this move right now. Recommend holding or reframing before targeting customers.',
      offer: { type: 'percentage' as const, value: '0%' },
      bundleWith: [] as string[],
      confidence: 0.28,
      marginImpactEur: () => 0,
    };
  }

  if (direction === 'increase') {
    const pct = Math.round(changePct);
    return {
      headline: `${item}: +${pct}% while the rush lasts`.slice(0, 60),
      body: `Stock is tight and demand is spiking${ctx.topNews ? ` - ${lower(ctx.topNews)}` : ''}. A temporary +${pct}% keeps shelves stocked. Reverts in 72h.`.slice(0, 240),
      offer: { type: 'price_increase' as const, value: `+${pct}% for 72h` },
      bundleWith: [] as string[],
      confidence: 0.83,
      // Surge lifts margin: extra per-unit revenue on units still sold.
      marginImpactEur: (units: number) => round2(units * Math.max(0, newPrice - prevPrice)),
    };
  }

  if (direction === 'bundle') {
    const withItem = ctx.bundle?.withItem ?? affinities[0] ?? 'a favourite';
    const price = ctx.bundle?.bundlePrice;
    return {
      headline: `${item} + ${withItem} - better together`.slice(0, 60),
      body: `${ctx.topNews ? capitalize(ctx.topNews) + '. ' : ''}Bundle ${item} with ${withItem}${price ? ` for just €${price.toFixed(2)}` : ''} while both are trending.`.slice(0, 240),
      offer: {
        type: 'bundle' as const,
        value: price ? `${item} + ${withItem} for €${price.toFixed(2)}` : `${item} + ${withItem}`,
      },
      bundleWith: [withItem, ...affinities].slice(0, 3),
      confidence: 0.85,
      marginImpactEur: (units: number) => round2(units * (price ?? newPrice) * 0.35),
    };
  }

  // Markdown (decrease).
  const pct = ctx.discountPct ?? 30;
  const grill = (ctx.tags || []).includes('grill_ready');
  return {
    headline: `${item}, ${pct}% off this weekend`.slice(0, 60),
    body: `${item} is ${pct}% off while stock lasts. Pair with ${affinities[0] || 'your favourites'} and enjoy.`.slice(0, 240),
    offer: {
      type: grill ? ('bundle' as const) : ('percentage' as const),
      value: grill ? `${item} + ${affinities[0] || 'sides'}` : `${pct}%`,
    },
    bundleWith: grill ? affinities : [],
    confidence: 0.86,
    marginImpactEur: (units: number) => -round2(units * newPrice * 0.5),
  };
}

function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildRationale(
  ctx: MockCtx,
  direction: 'increase' | 'decrease' | 'bundle',
  hold: boolean,
  badWeather: boolean,
): string[] {
  const out: string[] = [];
  const changePct = ctx.changePct ?? -(ctx.discountPct ?? 0);
  if (direction === 'increase') {
    out.push(`price: +${Math.round(changePct)}% temporary surge on ${ctx.item || 'item'} triggers the run`);
  } else if (direction === 'bundle') {
    out.push(`price: bundle proposition for ${ctx.item || 'item'} (no per-unit change) triggers the run`);
  } else {
    out.push(`price: ${ctx.discountPct ?? 30}% markdown on ${ctx.item || 'item'} triggers the run`);
  }
  out.push(
    direction === 'increase'
      ? `weather: ${ctx.weatherGood === false ? 'wet forecast is fuelling demand' : 'conditions support the move'}`
      : badWeather
        ? 'weather: poor forecast undermines a grill-ready push'
        : `weather: ${ctx.weatherGood === false ? 'mixed' : 'dry and warm'} favours the offer`,
  );
  out.push(
    ctx.topNews
      ? `news: ${lower(ctx.topNews)}`
      : ctx.nationalEventConflict
        ? 'news: a national event conflicts with the send window'
        : 'news: no conflicting national event',
  );
  out.push(`inventory: ${ctx.atRiskUnits ?? 'tight'} units in play across target stores`);
  out.push(`customer_interest: ${ctx.consentedCount ?? 0} consented repeat purchasers`);
  if (hold) out.push('recommendation: hold, conditions do not justify the move');
  return out;
}

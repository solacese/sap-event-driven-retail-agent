// ---------------------------------------------------------------------------
// Deterministic fallback campaign. Used when the LLM output fails validation
// twice. The demo must never dead-end, so this always returns a valid campaign.
// ---------------------------------------------------------------------------
import type { LlmCampaign } from './schema.js';
import type { GatheredSignals } from './prompt.js';
import { buildContextJson } from './prompt.js';

export function buildFallbackCampaign(s: GatheredSignals): LlmCampaign {
  const ctx = buildContextJson(s);
  const grill = ctx.grillReady;
  const direction = ctx.direction as 'increase' | 'decrease' | 'bundle';
  const changePct = ctx.changePct;
  // Only a grill-item markdown is undermined by bad weather; a rainy-day surge
  // is helped by it.
  const hold =
    (direction === 'decrease' && grill && ctx.weatherGood === false) ||
    ctx.nationalEventConflict ||
    ctx.consentedCount === 0;
  const now = new Date();
  const startsAt = new Date(now.getTime() + 3600_000).toISOString();
  const endsAt = new Date(now.getTime() + 72 * 3600_000).toISOString();
  const expected = hold ? 0 : Math.min(ctx.atRiskUnits || 520, Math.round(ctx.consentedCount * 0.55));
  const affin = ctx.topAffinities[0] || 'your favourites';

  let headline: string;
  let body: string;
  let offer: LlmCampaign['offer'];
  let bundleWith: string[] = [];
  if (hold) {
    headline = `Hold: reassess ${ctx.item} move`.slice(0, 60);
    body = 'Conditions do not favour this move. Recommend holding or reframing before targeting.';
    offer = { type: 'percentage', value: '0%' };
  } else if (direction === 'increase') {
    const pct = Math.round(changePct);
    headline = `${ctx.item}: +${pct}% while the rush lasts`.slice(0, 60);
    body = `Stock is tight and demand is spiking. A temporary +${pct}% keeps shelves stocked, reverting in 72h.`.slice(0, 240);
    offer = { type: 'price_increase', value: `+${pct}% for 72h` };
  } else if (direction === 'bundle') {
    const withItem = ctx.bundle?.withItem ?? affin;
    const price = ctx.bundle?.bundlePrice;
    headline = `${ctx.item} + ${withItem} - better together`.slice(0, 60);
    body = `Bundle ${ctx.item} with ${withItem}${price ? ` for €${price.toFixed(2)}` : ''} while both are trending.`.slice(0, 240);
    offer = { type: 'bundle', value: price ? `${ctx.item} + ${withItem} for €${price.toFixed(2)}` : `${ctx.item} + ${withItem}` };
    bundleWith = [withItem, ...ctx.topAffinities].slice(0, 3);
  } else {
    headline = `${ctx.item}, ${ctx.discountPct}% off this weekend`.slice(0, 60);
    body = `${ctx.item} is ${ctx.discountPct}% off while stock lasts. Pair with ${affin} and enjoy.`.slice(0, 240);
    offer = {
      type: grill ? 'bundle' : 'percentage',
      value: grill ? `${ctx.item} + ${affin}` : `${ctx.discountPct}%`,
    };
    bundleWith = grill ? ctx.topAffinities.slice(0, 3) : [];
  }

  const marginImpactEur = hold
    ? 0
    : direction === 'increase'
      ? Number((expected * Math.max(0, ctx.newPrice - ctx.previousPrice)).toFixed(2))
      : direction === 'bundle'
        ? Number((expected * (ctx.bundle?.bundlePrice ?? ctx.newPrice) * 0.35).toFixed(2))
        : -Number((expected * ctx.newPrice * 0.5).toFixed(2));

  return {
    headline,
    body,
    channel: 'push',
    offer,
    bundleWith,
    audience: {
      segment: 'repeat purchasers, opted in',
      size: ctx.consentedCount,
      consentBasis: 'explicit_marketing_optin',
    },
    targetStores: ctx.targetStores,
    sendWindow: { startsAt, endsAt },
    expectedUnitsMoved: expected,
    marginImpactEur,
    wasteAvoidedUnits: direction === 'decrease' ? expected : 0,
    confidence: hold ? 0.25 : 0.82,
    rationale: [
      direction === 'increase'
        ? `price: +${Math.round(changePct)}% temporary surge triggered the run`
        : direction === 'bundle'
          ? 'price: bundle proposition (no per-unit change) triggered the run'
          : `price: ${ctx.discountPct}% markdown triggered the run`,
      `weather: ${ctx.weatherGood === false ? 'wet/poor' : 'favourable'} for the move`,
      ctx.topNews ? `news: ${ctx.topNews}` : ctx.nationalEventConflict ? 'news: national event conflict' : 'news: no conflict',
      `inventory: ${ctx.atRiskUnits ?? 'tight'} units in play`,
      `customer_interest: ${ctx.consentedCount} consented purchasers`,
    ],
    signalsUsed: s.signalsUsed,
    signalsUnavailable: s.signalsUnavailable,
    recommendation: hold ? 'hold' : 'proceed',
  };
}

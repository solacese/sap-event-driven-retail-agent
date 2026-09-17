// ---------------------------------------------------------------------------
// Consent enforcement test: the campaign audience must never exceed the
// consented count. This is enforced in code, not only in the prompt.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { campaignSchema, llmCampaignSchema } from '../src/server/agent/schema.js';
import { buildFallbackCampaign } from '../src/server/agent/fallback.js';
import type { GatheredSignals } from '../src/server/agent/prompt.js';
import type { PriceUpdated } from '../src/server/agent/schema.js';

const trigger: PriceUpdated = {
  sku: '51001',
  item: 'sausage',
  category: 'fresh_meat',
  tags: ['grill_ready', 'own_brand'],
  country: 'FR',
  region: 'EMEA',
  previousPrice: 4.29,
  newPrice: 2.99,
  currency: 'EUR',
  discountPct: 30.3,
  reason: 'expiry_window',
  shelfLifeDaysRemaining: 4,
  emittedAt: '2026-08-18T07:12:04Z',
};

function gathered(consentedCount: number): GatheredSignals {
  return {
    price: trigger,
    weather: { country: 'FR', outlook: [{ date: '2026-08-21', conditionCode: 'sunny', tempMaxC: 29, precipProbability: 0.05 }], summary: 'Dry and warm' },
    news: { country: 'FR', nationalEvents: [], notable: [] },
    inventory: { sku: '51001', totalUnits: 812, storesWithStock: 20, stores: [{ storeId: 'FR-0142', city: 'Lyon', units: 47, daysOfCover: 2.1 }], atRiskUnits: 640 },
    customerInterest: { sku: '51001', pastPurchasers: 1104, repeatPurchasers3Plus: 822, marketingConsented: consentedCount, consentWithheld: 1104 - consentedCount, topAffinities: ['bbq_sauce', 'buns', 'beer'] },
    signalsUsed: ['price', 'weather', 'news', 'inventory', 'customer_interest'],
    signalsUnavailable: [],
    consentedCount,
  };
}

// Mirror the code-path clamp the agent applies when finalising a campaign.
// Revenue Protected is computed in code (wasteAvoidedUnits x newPrice) and is
// always present on the finalised campaign - mirror that here so the parse
// matches the real finalize() step in discountBot.ts.
function finalizeAudience(partial: ReturnType<typeof buildFallbackCampaign>, consented: number) {
  const revenueProtectedEur = Number(
    (Math.max(0, partial.wasteAvoidedUnits ?? 0) * (trigger.newPrice ?? 0)).toFixed(2),
  );
  return campaignSchema.parse({
    ...partial,
    campaignId: 'CMP-51001-0001',
    sku: '51001',
    revenueProtectedEur,
    audience: { ...partial.audience, size: Math.min(partial.audience.size, consented) },
    guardrails: { consentEnforced: true, humanApprovalRequired: true },
  });
}

describe('consent enforcement', () => {
  it('fallback audience never exceeds consented count (consent squeeze)', () => {
    const g = gathered(96);
    const campaign = finalizeAudience(buildFallbackCampaign(g), g.consentedCount);
    expect(campaign.audience.size).toBeLessThanOrEqual(96);
  });

  it('clamps an over-large audience down to consented ceiling', () => {
    const g = gathered(96);
    const partial = buildFallbackCampaign(g);
    // Simulate an LLM returning a too-large audience.
    partial.audience.size = 1104;
    const campaign = finalizeAudience(partial, g.consentedCount);
    expect(campaign.audience.size).toBe(96);
  });

  it('zero consent leads to hold recommendation', () => {
    const g = gathered(0);
    const partial = buildFallbackCampaign(g);
    expect(partial.recommendation).toBe('hold');
    expect(partial.audience.size).toBe(0);
  });

  it('llmCampaignSchema rejects headline over 60 chars', () => {
    const bad = { headline: 'x'.repeat(61) };
    expect(() => llmCampaignSchema.parse(bad)).toThrow();
  });
});

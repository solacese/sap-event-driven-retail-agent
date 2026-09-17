// ---------------------------------------------------------------------------
// zod contracts for every event payload on the mesh and the strict LLM output.
// Shared between server modules; the campaign schema also gates LLM responses.
// ---------------------------------------------------------------------------
import { z } from 'zod';

// A dynamic-pricing move can go three ways now: a markdown (decrease), a
// temporary surge (increase) or a bundle proposition. `discountPct` stays for
// every existing consumer (the trigger threshold, mock/fallback copy, tests):
// it is the non-negative markdown magnitude, so a surge reports discountPct 0.
// `changePct` is the SIGNED move (+15 surge, -30 markdown) and `direction`
// names it explicitly. `bundle` carries the paired SKU for a bundle offer.
export const priceUpdatedSchema = z.object({
  sku: z.string(),
  item: z.string(),
  category: z.string(),
  tags: z.array(z.string()).default([]),
  country: z.string(),
  region: z.string(),
  previousPrice: z.number(),
  newPrice: z.number(),
  currency: z.string(),
  discountPct: z.number(),
  // Signed percentage move; defaults to -discountPct so legacy triggers (which
  // only set discountPct) still describe a markdown correctly.
  changePct: z.number().optional(),
  direction: z.enum(['increase', 'decrease', 'bundle']).optional(),
  bundle: z
    .object({
      withSku: z.string(),
      withItem: z.string(),
      bundlePrice: z.number(),
    })
    .optional(),
  reason: z.string(),
  shelfLifeDaysRemaining: z.number(),
  emittedAt: z.string(),
});
export type PriceUpdated = z.infer<typeof priceUpdatedSchema>;

export const weatherReplySchema = z.object({
  country: z.string(),
  outlook: z.array(
    z.object({
      date: z.string(),
      conditionCode: z.string(),
      tempMaxC: z.number(),
      precipProbability: z.number(),
    }),
  ),
  summary: z.string(),
});
export type WeatherReply = z.infer<typeof weatherReplySchema>;

export const newsReplySchema = z.object({
  country: z.string(),
  nationalEvents: z.array(
    z.object({ date: z.string(), name: z.string(), impact: z.string() }),
  ).default([]),
  notable: z.array(
    z.object({ date: z.string(), headline: z.string(), impact: z.string() }),
  ).default([]),
});
export type NewsReply = z.infer<typeof newsReplySchema>;

export const inventoryReplySchema = z.object({
  sku: z.string(),
  totalUnits: z.number(),
  storesWithStock: z.number(),
  stores: z.array(
    z.object({
      storeId: z.string(),
      city: z.string(),
      units: z.number(),
      daysOfCover: z.number(),
    }),
  ),
  atRiskUnits: z.number(),
});
export type InventoryReply = z.infer<typeof inventoryReplySchema>;

export const customerInterestReplySchema = z.object({
  sku: z.string(),
  pastPurchasers: z.number(),
  repeatPurchasers3Plus: z.number(),
  marketingConsented: z.number(),
  consentWithheld: z.number(),
  topAffinities: z.array(z.string()),
});
export type CustomerInterestReply = z.infer<typeof customerInterestReplySchema>;

// --- Strict campaign schema (LLM output) ---
export const campaignSchema = z.object({
  campaignId: z.string(),
  sku: z.string(),
  headline: z.string().max(60),
  body: z.string().max(240),
  channel: z.enum(['push', 'email', 'sms']),
  offer: z.object({
    type: z.enum(['percentage', 'bundle', 'multibuy', 'price_increase']),
    value: z.string(),
  }),
  bundleWith: z.array(z.string()).default([]),
  audience: z.object({
    segment: z.string(),
    size: z.number().int().nonnegative(),
    consentBasis: z.string(),
  }),
  targetStores: z.array(z.string()).default([]),
  sendWindow: z.object({ startsAt: z.string(), endsAt: z.string() }),
  expectedUnitsMoved: z.number(),
  marginImpactEur: z.number(),
  wasteAvoidedUnits: z.number(),
  // Revenue rescued from at-risk stock that would otherwise be written off:
  // wasteAvoidedUnits x newPrice. Always filled in code (see discountBot
  // finalize) so it is present on every campaign regardless of LLM output.
  revenueProtectedEur: z.number(),
  confidence: z.number().min(0).max(1),
  rationale: z.array(z.string()).min(1),
  signalsUsed: z.array(z.string()),
  signalsUnavailable: z.array(z.string()).default([]),
  recommendation: z.enum(['proceed', 'hold']).default('proceed'),
  guardrails: z.object({
    consentEnforced: z.boolean(),
    humanApprovalRequired: z.boolean(),
  }),
});
export type Campaign = z.infer<typeof campaignSchema>;

// The subset the LLM is asked to produce; server fills ids, guardrails,
// audience size and the computed revenueProtectedEur.
export const llmCampaignSchema = campaignSchema.omit({
  campaignId: true,
  sku: true,
  guardrails: true,
  revenueProtectedEur: true,
});
export type LlmCampaign = z.infer<typeof llmCampaignSchema>;

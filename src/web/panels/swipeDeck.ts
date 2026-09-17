// ---------------------------------------------------------------------------
// Local deck for the /swipe spot-the-mistake game.
//
// Dealing mode is fully client-side and per-player: entering it builds a
// self-contained 8-card deck HERE, with no mesh subscription and no server
// calls. That lets any number of people play their own game at the same time
// without stepping on a shared server queue.
//
// A deck is 5 genuine campaigns (the four hero scenarios, plus one repeat to
// reach five) shuffled with 3 planted "blunder" cards. Every card is a local
// RunTimeline whose runId carries the LOCAL_PREFIX, so decisions are scored
// locally and never POST to the server. The three blunders are deliberately
// easy to spot - low confidence and a silly offer - but rendered with the exact
// same campaign card as the genuine ones, so a reviewer has to actually read
// them:
//   1. Absurd markup    - a +400% "surge" on a staple, confidence 12%.
//   2. Nonsense bundle  - sunscreen + snow shovel, confidence 9%.
//   3. Compliance/logic - SMS blast to 50,000 with 0 consented, conf 15%.
// ---------------------------------------------------------------------------
import type { Campaign, RunTimeline } from '../lib/types.js';

export const LOCAL_PREFIX = 'local-';

export function isLocalRunId(runId: string): boolean {
  return runId.startsWith(LOCAL_PREFIX);
}

// The three planted mistakes carry these ids in their runId
// (`local-<id>-<nonce>-<seq>`). Used by scoring to tell a genuine campaign from
// a blunder without re-reading the campaign body.
const BLUNDER_IDS = ['markup', 'bundle', 'consent'];

export function isBlunderRunId(runId: string): boolean {
  if (!isLocalRunId(runId)) return false;
  const id = runId.slice(LOCAL_PREFIX.length).split('-')[0];
  return BLUNDER_IDS.includes(id);
}

const ALL_SIGNALS = ['price', 'weather', 'news', 'inventory', 'customer_interest'];

interface CardSpec {
  id: string;
  blunder?: boolean;
  sku: string;
  headline: string;
  body: string;
  channel: Campaign['channel'];
  offer: Campaign['offer'];
  bundleWith?: string[];
  audienceSize: number;
  consentBasis: string;
  expectedUnitsMoved: number;
  revenueProtectedEur: number;
  confidence: number;
  signalsUsed: string[];
}

// Five genuine campaigns - faithful to the server's hero scenarios so the deck
// reads like the real thing. (Ice cream appears twice to make five goods.)
const GOOD: CardSpec[] = [
  {
    id: 'umbrella',
    sku: '61010',
    headline: 'Compact Travel Umbrella: +15% while the rush lasts',
    body: 'Stock is tight and demand is spiking - washout weekend forecast: three days of rain across the region. A temporary +15% keeps shelves stocked. Reverts in 72h.',
    channel: 'push',
    offer: { type: 'price_increase', value: '+15% for 72h' },
    audienceSize: 968,
    consentBasis: 'explicit_marketing_optin',
    expectedUnitsMoved: 520,
    revenueProtectedEur: 936,
    confidence: 0.83,
    signalsUsed: ALL_SIGNALS,
  },
  {
    id: 'icecream',
    sku: '53027',
    headline: 'Vanilla Ice Cream Tub 1L, 20% off this weekend',
    body: 'Vanilla Ice Cream Tub 1L is 20% off while stock lasts. Pair with waffle_cones and enjoy.',
    channel: 'push',
    offer: { type: 'percentage', value: '20%' },
    audienceSize: 904,
    consentBasis: 'explicit_marketing_optin',
    expectedUnitsMoved: 497,
    revenueProtectedEur: 2068,
    confidence: 0.86,
    signalsUsed: ALL_SIGNALS,
  },
  {
    id: 'ube',
    sku: '62020',
    headline: 'Ube Halaya Spread 300g + Butter Biscuits 200g - better together',
    body: 'Ube goes viral again as a new season of The Mentalist fuels cosy-night-in snacking. Bundle Ube Halaya Spread 300g with Butter Biscuits 200g for just €9.00 while both are trending.',
    channel: 'push',
    offer: { type: 'bundle', value: 'Ube Halaya Spread 300g + Butter Biscuits 200g for €9.00' },
    bundleWith: ['ube_halaya_spread', 'butter_biscuits'],
    audienceSize: 1012,
    consentBasis: 'explicit_marketing_optin',
    expectedUnitsMoved: 520,
    revenueProtectedEur: 4680,
    confidence: 0.85,
    signalsUsed: ALL_SIGNALS,
  },
  {
    id: 'chips',
    sku: '63030',
    headline: 'Chili Lime Tortilla Chips 200g: +10% while the rush lasts',
    body: 'Stock is tight and demand is spiking - chili-lime chips explode on social feeds; shelves clearing nationwide. A temporary +10% keeps shelves stocked. Reverts in 72h.',
    channel: 'push',
    offer: { type: 'price_increase', value: '+10% for 72h' },
    audienceSize: 1058,
    consentBasis: 'explicit_marketing_optin',
    expectedUnitsMoved: 520,
    revenueProtectedEur: 156,
    confidence: 0.83,
    signalsUsed: ALL_SIGNALS,
  },
  {
    id: 'icecream2',
    sku: '53028',
    headline: 'Salted Caramel Ice Cream 500ml, 15% off - heatwave clearance',
    body: 'The heatwave broke and freezer cover is high. A short 15% markdown clears Salted Caramel Ice Cream 500ml before it ages out.',
    channel: 'push',
    offer: { type: 'percentage', value: '15%' },
    audienceSize: 861,
    consentBasis: 'explicit_marketing_optin',
    expectedUnitsMoved: 430,
    revenueProtectedEur: 1740,
    confidence: 0.82,
    signalsUsed: ALL_SIGNALS,
  },
];

// Three planted mistakes: obvious REJECTs, low confidence, silly offers.
const BLUNDERS: CardSpec[] = [
  {
    id: 'markup',
    blunder: true,
    sku: '10011',
    headline: 'Table Salt 1kg - now +400% this weekend! 🧂',
    body: 'Shoppers love salt, so raise the price 400% for the weekend. Nobody will notice.',
    channel: 'push',
    offer: { type: 'price_increase', value: '+400%' },
    audienceSize: 8200,
    consentBasis: 'explicit_marketing_optin',
    expectedUnitsMoved: -1200,
    revenueProtectedEur: -18400,
    confidence: 0.12,
    signalsUsed: ['price'],
  },
  {
    id: 'bundle',
    blunder: true,
    sku: '20477',
    headline: 'Bundle: Sunscreen SPF50 + Snow Shovel 🌞❄️',
    body: 'Pair sunscreen with a snow shovel for the ultimate all-weather kit. −60% off both!',
    channel: 'email',
    offer: { type: 'bundle', value: '−60%' },
    bundleWith: ['snow_shovel', 'sunscreen_spf50'],
    audienceSize: 15300,
    consentBasis: 'explicit_marketing_optin',
    expectedUnitsMoved: 40,
    revenueProtectedEur: -9100,
    confidence: 0.09,
    signalsUsed: ['price', 'inventory'],
  },
  {
    id: 'consent',
    blunder: true,
    sku: '30988',
    headline: 'SMS blast to 50,000 shoppers - send to everyone! 📣',
    body: 'Text a −90% coupon to all 50,000 shoppers regardless of opt-in. More reach = more sales!',
    channel: 'sms',
    offer: { type: 'percentage', value: '−90%' },
    audienceSize: 50000,
    consentBasis: 'none',
    expectedUnitsMoved: 300,
    revenueProtectedEur: -42000,
    confidence: 0.15,
    signalsUsed: ['price'],
  },
];

function toRun(spec: CardSpec, nonce: number, seq: number): RunTimeline {
  const runId = `${LOCAL_PREFIX}${spec.id}-${nonce}-${seq}`;
  const campaign: Campaign = {
    campaignId: `CMP-${spec.sku}-${nonce}`,
    sku: spec.sku,
    headline: spec.headline,
    body: spec.body,
    channel: spec.channel,
    offer: spec.offer,
    bundleWith: spec.bundleWith,
    audience: { segment: 'all_shoppers', size: spec.audienceSize, consentBasis: spec.consentBasis },
    targetStores: ['ALL'],
    expectedUnitsMoved: spec.expectedUnitsMoved,
    marginImpactEur: spec.revenueProtectedEur,
    wasteAvoidedUnits: 0,
    revenueProtectedEur: spec.revenueProtectedEur,
    confidence: spec.confidence,
    rationale: ['(demo card)'],
    signalsUsed: spec.signalsUsed,
    signalsUnavailable: [],
    guardrails: { consentEnforced: !spec.blunder, humanApprovalRequired: true },
  };
  return { runId, sku: spec.sku, signals: [], campaign, startedAt: Date.now(), draftedAt: Date.now() };
}

// Even interleave so the 3 blunders don't clump: goods first, then splice each
// blunder in at ~1/4, 1/2, 3/4 of the final length. Index 0 is always a good
// card, so the first card the player sees is a genuine campaign.
function interleave(goods: RunTimeline[], blunders: RunTimeline[]): RunTimeline[] {
  const out = [...goods];
  const total = out.length + blunders.length;
  blunders.forEach((b, i) => {
    const frac = (i + 1) / (blunders.length + 1);
    const at = Math.min(out.length, Math.max(1, Math.round(frac * total)));
    out.splice(at, 0, b);
  });
  return out;
}

// Build a fresh 8-card deck. `nonce` (e.g. Date.now()) keeps runIds unique
// across rounds so a replayed deck doesn't collide with a decided one.
export function makeDeck(nonce: number): RunTimeline[] {
  const goods = GOOD.map((s, i) => toRun(s, nonce, i));
  const blunders = BLUNDERS.map((s, i) => toRun(s, nonce, 100 + i));
  return interleave(goods, blunders);
}

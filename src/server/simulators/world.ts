// ---------------------------------------------------------------------------
// SimulatorWorld: the single source of truth for the demo scenario. Tool
// services and the price feed both read from here so a scenario change is
// reflected consistently across every event stream and every tool reply.
// ---------------------------------------------------------------------------
import type {
  WeatherReply,
  NewsReply,
  InventoryReply,
  CustomerInterestReply,
  PriceUpdated,
} from '../agent/schema.js';

export type ScenarioName =
  // Dynamic-pricing heroes (the four surfaced in the web toolbar).
  | 'rainy-umbrella'
  | 'ube-bundle'
  | 'heatwave-icecream'
  | 'viral-snack'
  // Legacy / internal scenarios kept for the free-text path, storm burst and
  // backwards-compatible API calls. Not surfaced as buttons any more.
  | 'sunny-bbq'
  | 'world-cup'
  | 'rain-event'
  | 'consent-squeeze'
  | 'tool-outage'
  | 'storm';

/** All known scenario names, for runtime validation of untyped input. */
export const SCENARIO_NAMES: readonly ScenarioName[] = [
  'rainy-umbrella',
  'ube-bundle',
  'heatwave-icecream',
  'viral-snack',
  'sunny-bbq',
  'world-cup',
  'rain-event',
  'consent-squeeze',
  'tool-outage',
  'storm',
];

/** A bundle proposition attached to a scenario (ube + biscuits, etc.). */
export interface BundleConfig {
  withSku: string;
  withItem: string;
  bundlePrice: number;
}

/** Narrow an arbitrary string to a ScenarioName, or throw if unknown. */
export function assertScenarioName(name: string): ScenarioName {
  if ((SCENARIO_NAMES as readonly string[]).includes(name)) {
    return name as ScenarioName;
  }
  throw new Error(`unknown scenario: ${name}`);
}

/**
 * The bounded subset of scenario fields an LLM may set from a free-text prompt.
 * Every field is optional; unknown fields are ignored by applyScenarioPatch.
 */
export interface ScenarioPatch {
  weatherGood?: boolean;
  nationalEvent?: boolean;
  weatherToolDown?: boolean;
  marketingConsented?: number;
  consentWithheld?: number;
  discountPct?: number;
  item?: string;
  reason?: string;
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}
function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** One store row used to build inventory replies and stock-level events. */
export interface StoreRow {
  storeId: string;
  city: string;
  units: number;
  daysOfCover: number;
  atRiskUnits: number;
}

/** Mutable scenario parameters. Everything the world derives comes from here. */
export interface ScenarioConfig {
  country: string;
  region: string;
  sku: string;
  item: string;
  category: string;
  tags: string[];
  currency: string;
  // Weather.
  weatherGood: boolean;
  // News / national event.
  nationalEvent: boolean;
  // Customer interest counts (exact audience math lives here, not in the feed).
  pastPurchasers: number;
  repeatPurchasers3Plus: number;
  marketingConsented: number;
  consentWithheld: number;
  topAffinities: string[];
  // Inventory shape.
  storeCount: number;
  unitsPerStore: number;
  daysOfCover: number;
  atRiskStores: number;
  // Trigger defaults (a normal single price update).
  previousPrice: number;
  newPrice: number;
  discountPct: number;
  // Signed price move. Negative for a markdown (equals -discountPct), positive
  // for a temporary surge, 0 for a pure bundle. `direction` names it for the UI.
  changePct: number;
  direction: 'increase' | 'decrease' | 'bundle';
  // When set, the scenario proposes a bundle with a second product.
  bundle?: BundleConfig;
  // A short, punchy news headline that motivates the move (rainy weekend, a new
  // season of a hit show, a viral snack). Threaded into the news signal so the
  // agent's rationale can cite it. Empty string = use the generic news copy.
  newsHeadline: string;
  shelfLifeDaysRemaining: number;
  reason: string;
}

/**
 * A frozen copy of the world at the instant a trigger fired. A run gathers all
 * of its scenario-derived signals from this, so concurrent runs never read each
 * other's (later-mutated) world state.
 */
export interface ScenarioSnapshot {
  scenario: ScenarioConfig;
  weatherToolDown: boolean;
}

// Cities used to derive the ~20 FR stores. Repeats are fine, storeId stays unique.
const FR_CITIES = [
  'Lyon',
  'Paris',
  'Marseille',
  'Toulouse',
  'Nice',
  'Nantes',
  'Strasbourg',
  'Montpellier',
  'Bordeaux',
  'Lille',
  'Rennes',
  'Reims',
  'Le Havre',
  'Saint-Etienne',
  'Toulon',
  'Grenoble',
  'Dijon',
  'Angers',
  'Nimes',
  'Clermont-Ferrand',
];

/**
 * The default scenario, matching the dynamic-pricing hero narrative: a rainy
 * weekend plus tight umbrella stock argues for a temporary +15% surge. A reset
 * lands here, so the world always tells the new story out of the box.
 */
function defaultScenario(): ScenarioConfig {
  return applyRainyUmbrella({
    country: 'FR',
    region: 'ILE-DE-FRANCE',
    sku: '51001',
    item: 'Artisan Pork Sausage 500g',
    category: 'fresh-meat',
    tags: ['bbq', 'grill', 'fresh', 'perishable'],
    currency: 'EUR',
    weatherGood: true,
    nationalEvent: false,
    pastPurchasers: 4200,
    repeatPurchasers3Plus: 1560,
    marketingConsented: 822,
    consentWithheld: 282, // 822 + 282 = 1104 total addressable
    topAffinities: ['bbq_sauce', 'buns', 'beer'],
    storeCount: 20,
    unitsPerStore: 34,
    daysOfCover: 3,
    atRiskStores: 20,
    previousPrice: 4.5,
    newPrice: 3.15,
    discountPct: 30,
    changePct: -30,
    direction: 'decrease',
    newsHeadline: '',
    shelfLifeDaysRemaining: 3,
    reason: 'Perishable clearance ahead of weekend demand',
  });
}

/**
 * Compute newPrice from a signed change and set the discountPct mirror. A
 * markdown (negative change) reports its magnitude as discountPct; a surge or a
 * bundle reports discountPct 0 so legacy consumers never read a surge as a
 * discount. Returns the same object for convenient chaining.
 */
function applyPriceMove(s: ScenarioConfig, changePct: number): ScenarioConfig {
  s.changePct = changePct;
  s.direction = changePct > 0 ? 'increase' : changePct < 0 ? 'decrease' : 'bundle';
  s.discountPct = Math.max(0, -changePct);
  s.newPrice = round2(s.previousPrice * (1 + changePct / 100));
  return s;
}

/**
 * Rainy Weekend, umbrella surge. A wet forecast plus tight umbrella stock →
 * a temporary +15% price increase while demand spikes. Mutates and returns the
 * passed config so both defaultScenario() and applyScenario() can reuse it.
 */
function applyRainyUmbrella(s: ScenarioConfig): ScenarioConfig {
  s.sku = '61010';
  s.item = 'Compact Travel Umbrella';
  s.category = 'seasonal';
  s.tags = ['umbrella', 'rain', 'weather-driven', 'surge'];
  s.previousPrice = 12.0;
  s.weatherGood = false; // rain is the whole point
  s.nationalEvent = false;
  s.topAffinities = ['raincoat', 'wellington_boots', 'hot_chocolate'];
  s.marketingConsented = 968;
  s.consentWithheld = 136;
  // Tight stock: fewer units, most of them scarce rather than "at risk".
  s.unitsPerStore = 9;
  s.daysOfCover = 1;
  s.atRiskStores = 0;
  s.shelfLifeDaysRemaining = 365; // non-perishable
  s.newsHeadline = 'Washout weekend forecast: three days of rain across the region';
  s.reason = 'Rainy weekend and low umbrella stock - temporary surge while demand spikes';
  return applyPriceMove(s, +15);
}

export class SimulatorWorld {
  scenario: ScenarioConfig = defaultScenario();

  /** When true, the weather tool must never reply so the request times out. */
  weatherToolDown = false;

  /** Total addressable audience (consented + withheld). */
  get totalAudience(): number {
    return this.scenario.marketingConsented + this.scenario.consentWithheld;
  }

  /** Reset to the hero default (sunny BBQ, no event, tools healthy). */
  reset() {
    this.scenario = defaultScenario();
    this.weatherToolDown = false;
  }

  /** Apply a named scenario, mutating the world in place. */
  applyScenario(name: ScenarioName) {
    this.reset();
    const s = this.scenario;
    switch (name) {
      case 'rainy-umbrella':
        // Default already models the rainy-umbrella surge. Nothing more to do.
        break;
      case 'ube-bundle':
        // Ube is trending online and a new season of "The Mentalist" is driving
        // cosy-night-in demand. Stock of ube spread is healthy, so instead of a
        // price change the agent proposes bundling it with butter biscuits.
        s.sku = '62020';
        s.item = 'Ube Halaya Spread 300g';
        s.category = 'grocery';
        s.tags = ['ube', 'trending', 'dessert', 'bundle'];
        s.previousPrice = 6.5;
        s.weatherGood = true;
        s.nationalEvent = false;
        s.topAffinities = ['butter_biscuits', 'condensed_milk', 'sticky_rice'];
        s.marketingConsented = 1012;
        s.consentWithheld = 92;
        s.unitsPerStore = 40;
        s.daysOfCover = 6;
        s.atRiskStores = 0;
        s.shelfLifeDaysRemaining = 120;
        s.bundle = { withSku: '62021', withItem: 'Butter Biscuits 200g', bundlePrice: 9.0 };
        s.newsHeadline =
          'Ube goes viral again as a new season of The Mentalist fuels cosy-night-in snacking';
        s.reason = 'Ube trending online plus a hit-show revival - bundle ube spread with biscuits';
        applyPriceMove(s, 0); // pure bundle, no per-unit price change
        break;
      case 'heatwave-icecream':
        // A heatwave has passed and ice cream is overstocked with short cover -
        // clear it fast with a deep markdown.
        s.sku = '53027';
        s.item = 'Vanilla Ice Cream Tub 1L';
        s.category = 'frozen';
        s.tags = ['frozen', 'dessert', 'summer', 'clearance'];
        s.previousPrice = 5.2;
        s.weatherGood = true;
        s.nationalEvent = false;
        s.topAffinities = ['waffle_cones', 'chocolate_sauce', 'fresh_berries'];
        s.marketingConsented = 904;
        s.consentWithheld = 200;
        s.unitsPerStore = 60;
        s.daysOfCover = 2;
        s.atRiskStores = 20;
        s.shelfLifeDaysRemaining = 4;
        s.newsHeadline = 'Heatwave breaks: cooler week ahead softens frozen-dessert demand';
        s.reason = 'Overstocked ice cream after the heatwave - clearance markdown to protect stock';
        applyPriceMove(s, -20);
        break;
      case 'viral-snack':
        // A snack is blowing up on social with limited stock - nudge price up
        // 10% while it rides the trend.
        s.sku = '63030';
        s.item = 'Chili Lime Tortilla Chips 200g';
        s.category = 'snacks';
        s.tags = ['snacks', 'viral', 'trending', 'surge'];
        s.previousPrice = 3.0;
        s.weatherGood = true;
        s.nationalEvent = false;
        s.topAffinities = ['salsa', 'guacamole', 'sparkling_water'];
        s.marketingConsented = 1058;
        s.consentWithheld = 46;
        s.unitsPerStore = 14;
        s.daysOfCover = 1;
        s.atRiskStores = 0;
        s.shelfLifeDaysRemaining = 90;
        s.newsHeadline = 'Chili-lime chips explode on social feeds; shelves clearing nationwide';
        s.reason = 'Snack going viral with limited stock - temporary surge while the trend runs';
        applyPriceMove(s, +10);
        break;
      case 'sunny-bbq':
        // Legacy sunny-BBQ hero: warm forecast clears fresh sausages at 30% off.
        s.sku = '51001';
        s.item = 'Artisan Pork Sausage 500g';
        s.category = 'fresh-meat';
        s.tags = ['bbq', 'grill', 'fresh', 'perishable'];
        s.previousPrice = 4.5;
        s.weatherGood = true;
        s.nationalEvent = false;
        s.topAffinities = ['bbq_sauce', 'buns', 'beer'];
        s.marketingConsented = 822;
        s.consentWithheld = 282;
        s.unitsPerStore = 34;
        s.daysOfCover = 3;
        s.atRiskStores = 20;
        s.shelfLifeDaysRemaining = 3;
        s.newsHeadline = '';
        s.reason = 'Perishable clearance ahead of weekend demand';
        applyPriceMove(s, -30);
        break;
      case 'world-cup':
        // Warm weekend + a major national football event: strong match-day
        // demand, a clear news signal, and a big consented audience. Use a
        // distinct hero product (a beer multipack) so this scenario reads
        // clearly apart from the sausage BBQ default.
        s.sku = '52014';
        s.item = 'Lager Beer 24 x 330ml Case';
        s.category = 'beverages';
        s.tags = ['beer', 'party', 'match-day', 'multipack'];
        s.previousPrice = 18.0;
        s.weatherGood = true;
        s.nationalEvent = true;
        s.topAffinities = ['crisps', 'peanuts', 'soft_drinks'];
        s.marketingConsented = 964;
        s.consentWithheld = 140;
        s.unitsPerStore = 34;
        s.daysOfCover = 3;
        s.atRiskStores = 20;
        s.shelfLifeDaysRemaining = 30;
        s.newsHeadline = '';
        s.reason = 'World Cup match weekend, strong beer and snack demand';
        applyPriceMove(s, -25);
        break;
      case 'rain-event':
        // Legacy: a rainy national-event weekend on the sausage product.
        s.sku = '51001';
        s.item = 'Artisan Pork Sausage 500g';
        s.category = 'fresh-meat';
        s.tags = ['bbq', 'grill', 'fresh', 'perishable'];
        s.previousPrice = 4.5;
        s.topAffinities = ['bbq_sauce', 'buns', 'beer'];
        s.marketingConsented = 822;
        s.consentWithheld = 282;
        s.unitsPerStore = 34;
        s.daysOfCover = 3;
        s.atRiskStores = 20;
        s.shelfLifeDaysRemaining = 3;
        s.weatherGood = false;
        s.nationalEvent = true;
        s.newsHeadline = '';
        s.reason = 'Rain forecast plus national event, demand uncertain';
        applyPriceMove(s, -30);
        break;
      case 'consent-squeeze':
        // Most of the addressable base has withheld marketing consent.
        s.sku = '51001';
        s.item = 'Artisan Pork Sausage 500g';
        s.category = 'fresh-meat';
        s.tags = ['bbq', 'grill', 'fresh', 'perishable'];
        s.previousPrice = 4.5;
        s.topAffinities = ['bbq_sauce', 'buns', 'beer'];
        s.unitsPerStore = 34;
        s.daysOfCover = 3;
        s.atRiskStores = 20;
        s.shelfLifeDaysRemaining = 3;
        s.weatherGood = true;
        s.nationalEvent = false;
        s.marketingConsented = 143;
        s.consentWithheld = 961; // still 1104 total
        s.newsHeadline = '';
        s.reason = 'Perishable clearance, small consented audience';
        applyPriceMove(s, -30);
        break;
      case 'tool-outage':
        // The weather tool never replies, so the run must degrade gracefully
        // without that signal. Use a frozen dessert so this scenario reads
        // clearly apart from the other heroes.
        s.sku = '53027';
        s.item = 'Vanilla Ice Cream Tub 1L';
        s.category = 'frozen';
        s.tags = ['frozen', 'dessert', 'summer', 'clearance'];
        s.previousPrice = 5.2;
        s.topAffinities = ['waffle_cones', 'chocolate_sauce', 'fresh_berries'];
        s.marketingConsented = 904;
        s.consentWithheld = 200;
        s.unitsPerStore = 34;
        s.daysOfCover = 3;
        s.atRiskStores = 20;
        s.shelfLifeDaysRemaining = 4;
        s.weatherGood = true;
        s.nationalEvent = false;
        s.newsHeadline = '';
        this.weatherToolDown = true;
        s.reason = 'Frozen clearance, weather signal unavailable';
        applyPriceMove(s, -20);
        break;
      case 'storm':
        // Bad weather; the storm trigger burst is generated by the simulator.
        // Bad weather; the storm trigger burst is generated by the simulator and
        // fully overrides each trigger's price fields, so base on a markdown.
        s.sku = '51001';
        s.item = 'Artisan Pork Sausage 500g';
        s.category = 'fresh-meat';
        s.tags = ['bbq', 'grill', 'fresh', 'perishable'];
        s.previousPrice = 4.5;
        s.topAffinities = ['bbq_sauce', 'buns', 'beer'];
        s.marketingConsented = 822;
        s.consentWithheld = 282;
        s.unitsPerStore = 34;
        s.daysOfCover = 3;
        s.atRiskStores = 20;
        s.shelfLifeDaysRemaining = 3;
        s.weatherGood = false;
        s.nationalEvent = false;
        s.newsHeadline = '';
        s.reason = 'Storm driven markdown burst';
        applyPriceMove(s, -30);
        break;
    }
  }

  /**
   * Apply a free-text scenario patch (produced by the LLM from a user prompt)
   * on top of a reset default. Only a safe, bounded subset of fields is
   * accepted; everything else is ignored so a bad model response cannot break
   * the world. Numbers are clamped to sane ranges.
   */
  applyScenarioPatch(patch: ScenarioPatch) {
    // Free-text scenarios are markdown-shaped by default, so start from the
    // sunny-BBQ markdown hero rather than the rainy-umbrella surge default.
    this.applyScenario('sunny-bbq');
    this.weatherToolDown = false;
    const s = this.scenario;
    if (typeof patch.weatherGood === 'boolean') s.weatherGood = patch.weatherGood;
    if (typeof patch.nationalEvent === 'boolean') s.nationalEvent = patch.nationalEvent;
    if (typeof patch.weatherToolDown === 'boolean') this.weatherToolDown = patch.weatherToolDown;
    if (isFiniteNumber(patch.marketingConsented) || isFiniteNumber(patch.consentWithheld)) {
      const total = s.marketingConsented + s.consentWithheld;
      const consented = clampInt(patch.marketingConsented ?? s.marketingConsented, 0, total);
      s.marketingConsented = consented;
      s.consentWithheld = total - consented;
    }
    if (isFiniteNumber(patch.discountPct)) {
      // A patched discount is always a markdown; keep changePct/direction in sync.
      applyPriceMove(s, -clampInt(patch.discountPct, 1, 90));
    }
    if (typeof patch.item === 'string' && patch.item.trim()) s.item = patch.item.trim().slice(0, 80);
    if (typeof patch.reason === 'string' && patch.reason.trim()) {
      s.reason = patch.reason.trim().slice(0, 160);
    }
  }

  // --- Derived data used to build tool replies and context events ----------
  // Each builder has a pure `*For(scenario)` form that reads ONLY the scenario
  // passed to it, plus a zero-arg wrapper over `this.scenario` for existing
  // callers. The pure forms let a run gather from a snapshot captured at trigger
  // time, so concurrent runs never read each other's (mutated) world state.

  /** Three day weather outlook derived from a scenario's weatherGood flag. */
  weatherOutlookFor(s: ScenarioConfig): WeatherReply {
    const base = new Date();
    const day = (offset: number) => {
      const d = new Date(base);
      d.setDate(d.getDate() + offset);
      return d.toISOString().slice(0, 10);
    };
    if (s.weatherGood) {
      return {
        country: s.country,
        outlook: [
          { date: day(0), conditionCode: 'sunny', tempMaxC: 28, precipProbability: 5 },
          { date: day(1), conditionCode: 'sunny', tempMaxC: 30, precipProbability: 10 },
          { date: day(2), conditionCode: 'partly-cloudy', tempMaxC: 27, precipProbability: 20 },
        ],
        summary: 'Warm and dry, strong barbecue weather across the weekend.',
      };
    }
    return {
      country: s.country,
      outlook: [
        { date: day(0), conditionCode: 'rain', tempMaxC: 14, precipProbability: 80 },
        { date: day(1), conditionCode: 'storm', tempMaxC: 12, precipProbability: 90 },
        { date: day(2), conditionCode: 'rain', tempMaxC: 15, precipProbability: 70 },
      ],
      summary: 'Cold and wet, outdoor grilling demand likely to drop.',
    };
  }
  weatherOutlook(): WeatherReply {
    return this.weatherOutlookFor(this.scenario);
  }

  /** News reply with an optional national event flag, for a given scenario. */
  newsReplyFor(s: ScenarioConfig): NewsReply {
    const base = new Date();
    const day = (offset: number) => {
      const d = new Date(base);
      d.setDate(d.getDate() + offset);
      return d.toISOString().slice(0, 10);
    };
    const nationalEvents = s.nationalEvent
      ? [
          {
            date: day(1),
            name: 'National football final',
            impact: 'Large at-home gatherings, snack and grill demand spike',
          },
        ]
      : [];
    // Prefer the scenario's own headline (rainy weekend, a hit-show revival, a
    // viral snack) so the agent's news signal carries the narrative that
    // motivates the pricing move. Fall back to the generic copy otherwise.
    const notable = s.newsHeadline
      ? [
          {
            date: day(0),
            headline: s.newsHeadline,
            impact: s.reason,
          },
        ]
      : s.nationalEvent
        ? [
            {
              date: day(1),
              headline: 'Retailers brace for match-day grocery rush',
              impact: 'Elevated fresh-meat and beverage sales expected',
            },
          ]
        : [
            {
              date: day(0),
              headline: 'Steady consumer demand reported nationwide',
              impact: 'No unusual demand signal',
            },
          ];
    return { country: s.country, nationalEvents, notable };
  }
  newsReply(): NewsReply {
    return this.newsReplyFor(this.scenario);
  }

  /** Derive the ~20 store rows from a scenario's parameters. */
  storesFor(s: ScenarioConfig): StoreRow[] {
    const rows: StoreRow[] = [];
    for (let i = 0; i < s.storeCount; i++) {
      const city = FR_CITIES[i % FR_CITIES.length];
      const storeId = `FR-${String(i + 1).padStart(3, '0')}`;
      // Deterministic small variance so units are not all identical.
      const units = s.unitsPerStore + (i % 5) - 2; // roughly 30+ units
      const atRisk = i < s.atRiskStores ? units : 0;
      rows.push({
        storeId,
        city,
        units,
        daysOfCover: s.daysOfCover,
        atRiskUnits: atRisk,
      });
    }
    return rows;
  }
  stores(): StoreRow[] {
    return this.storesFor(this.scenario);
  }

  /** Inventory reply aggregated from a scenario's derived store rows. */
  inventoryReplyFor(s: ScenarioConfig): InventoryReply {
    const stores = this.storesFor(s);
    const totalUnits = stores.reduce((sum, r) => sum + r.units, 0);
    const atRiskUnits = stores.reduce((sum, r) => sum + r.atRiskUnits, 0);
    return {
      sku: s.sku,
      totalUnits,
      storesWithStock: stores.filter((r) => r.units > 0).length,
      stores: stores.map((r) => ({
        storeId: r.storeId,
        city: r.city,
        units: r.units,
        daysOfCover: r.daysOfCover,
      })),
      atRiskUnits,
    };
  }
  inventoryReply(): InventoryReply {
    return this.inventoryReplyFor(this.scenario);
  }

  /** Customer interest reply built from a scenario's exact counts. */
  customerInterestReplyFor(s: ScenarioConfig): CustomerInterestReply {
    return {
      sku: s.sku,
      pastPurchasers: s.pastPurchasers,
      repeatPurchasers3Plus: s.repeatPurchasers3Plus,
      marketingConsented: s.marketingConsented,
      consentWithheld: s.consentWithheld,
      topAffinities: [...s.topAffinities],
    };
  }
  customerInterestReply(): CustomerInterestReply {
    return this.customerInterestReplyFor(this.scenario);
  }

  /** Deep copy of the current scenario, for snapshotting at trigger time. */
  cloneScenario(): ScenarioConfig {
    return {
      ...this.scenario,
      tags: [...this.scenario.tags],
      topAffinities: [...this.scenario.topAffinities],
      ...(this.scenario.bundle ? { bundle: { ...this.scenario.bundle } } : {}),
    };
  }

  /** Build a full price/updated payload from the current scenario. */
  priceUpdated(overrides: Partial<PriceUpdated> = {}): PriceUpdated {
    return this.priceUpdatedFor(this.scenario, overrides);
  }

  /**
   * Build a price/updated trigger from an explicit scenario. Pure - reads only
   * the passed scenario, so a trigger captured at click time is not corrupted by
   * a later scenario mutation of the shared world (button-spam isolation).
   */
  priceUpdatedFor(s: ScenarioConfig, overrides: Partial<PriceUpdated> = {}): PriceUpdated {
    const base: PriceUpdated = {
      sku: s.sku,
      item: s.item,
      category: s.category,
      tags: [...s.tags],
      country: s.country,
      region: s.region,
      previousPrice: s.previousPrice,
      newPrice: s.newPrice,
      currency: s.currency,
      discountPct: s.discountPct,
      changePct: s.changePct,
      direction: s.direction,
      ...(s.bundle ? { bundle: { ...s.bundle } } : {}),
      reason: s.reason,
      shelfLifeDaysRemaining: s.shelfLifeDaysRemaining,
      emittedAt: new Date().toISOString(),
    };
    return { ...base, ...overrides };
  }
}

export const world = new SimulatorWorld();

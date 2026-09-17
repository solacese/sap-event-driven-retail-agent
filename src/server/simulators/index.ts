// ---------------------------------------------------------------------------
// Simulators: publish the "world" onto the mesh as context event streams so the
// ContextStore materialises them BEFORE any trigger fires. This is what lets the
// agent label signals CACHED (already known) instead of REQUESTED. It also
// exposes trigger publishers used by the demo controls.
//
// This module only publishes to the bus. The gateway subscribes to everything
// and records to the feed centrally, so nothing here touches the feed/hub.
// ---------------------------------------------------------------------------
import type { Bus, MeshMessage, UserProperties } from '../types.js';
import { CONTEXT_TOPICS } from '../../../config/topics.js';
import type { PriceUpdated } from '../agent/schema.js';
import { makeLogger } from '../log.js';
import { world, assertScenarioName } from './world.js';
import type { ScenarioName, ScenarioPatch, ScenarioSnapshot } from './world.js';
import { contextStore } from '../context/store.js';

const log = makeLogger('SIMULATOR');

// --- Per-trigger scenario snapshots -----------------------------------------
// Captured synchronously when a trigger is published, so a run can gather from
// the exact world that fired it - even if the shared world is mutated moments
// later by another scenario click. Keyed by a short triggerId carried on the
// trigger's userProperties. Consumers delete the entry when the run terminates.
const triggerSnapshots = new Map<string, ScenarioSnapshot>();

let triggerSeq = 0;
function nextTriggerId(): string {
  triggerSeq += 1;
  return `t${triggerSeq.toString(36)}-${process.pid.toString(36)}`;
}

export function getTriggerSnapshot(triggerId: string): ScenarioSnapshot | undefined {
  return triggerSnapshots.get(triggerId);
}
export function releaseTriggerSnapshot(triggerId: string): void {
  triggerSnapshots.delete(triggerId);
}

/** Standard user properties on every simulator-published message. */
function props(extra: Partial<UserProperties> = {}): UserProperties {
  return {
    agent: 'simulator',
    schemaVersion: '1',
    emittedAt: new Date().toISOString(),
    ...extra,
  };
}

function publish(bus: Bus, topic: string, payload: unknown, extra: Partial<UserProperties> = {}) {
  const msg: MeshMessage = { topic, payload, userProperties: props(extra) };
  bus.publish(msg);
}

/**
 * Publish the full world as context streams. Materialises weather, news, stock
 * and a representative consent sample before triggers fire.
 */
export function publishWorld(bus: Bus) {
  const s = world.scenario;

  // Weather forecast per country. When the weather tool is "down" (tool-outage
  // scenario) we also withhold the materialised forecast, so the agent must
  // issue a mesh request for it, which then times out and degrades gracefully.
  // That is what makes the outage visible as a REQUESTED signal going amber.
  if (!world.weatherToolDown) {
    publish(bus, CONTEXT_TOPICS.weatherForecast(s.country), world.weatherOutlook(), {
      country: s.country,
    });
  }

  // News national-event flag per country.
  publish(bus, CONTEXT_TOPICS.newsNationalEvent(s.country), world.newsReply(), {
    country: s.country,
  });

  // Stock-level changes per store/sku for the ~20 stores.
  for (const store of world.stores()) {
    publish(
      bus,
      CONTEXT_TOPICS.stockLevel(store.storeId, s.sku),
      {
        storeId: store.storeId,
        sku: s.sku,
        units: store.units,
        city: store.city,
        daysOfCover: store.daysOfCover,
        atRiskUnits: store.atRiskUnits,
      },
      { sku: s.sku },
    );
  }

  // Consent updates. Publishing 1104 individual messages is too many for the
  // feed, so publish a representative sample (~30) for the visual. Exact
  // audience counts stay authoritative in world and are returned by the
  // customer-interest tool.
  const sampleSize = 30;
  for (let i = 0; i < sampleSize; i++) {
    const customerId = `C-${String(i + 1).padStart(5, '0')}`;
    // Roughly mirror the consented ratio in the sample.
    const consentedRatio = world.totalAudience > 0 ? s.marketingConsented / world.totalAudience : 0;
    const consented = i < Math.round(sampleSize * consentedRatio);
    publish(
      bus,
      CONTEXT_TOPICS.consentUpdated(customerId),
      { customerId, sku: s.sku, consented },
      { sku: s.sku },
    );
  }

  log.info('world published as context streams', {
    country: s.country,
    sku: s.sku,
    stores: world.scenario.storeCount,
    consentSample: sampleSize,
  });
}

/**
 * Start the simulators. Unless SIMULATORS_ENABLED === 'false', publish the
 * world so context is materialised at startup.
 */
export function startSimulators(bus: Bus): () => void {
  if (process.env.SIMULATORS_ENABLED === 'false') {
    log.info('simulators disabled via SIMULATORS_ENABLED=false');
    return () => {};
  }
  publishWorld(bus);
  startAmbientFeed(bus);
  log.info('simulators started');
  // Cleanup stops the recurring ambient feed so it never publishes to a stale
  // bus after teardown/reset.
  return () => stopAmbientFeed();
}

// --- Ambient context feed ---------------------------------------------------
// The mesh should look alive even when no pricing scenario is running: weather
// updates, news items and stock movements arrive continuously. These are
// CONTEXT events only - they refresh the ContextStore and populate the feed,
// but NEVER a price/updated trigger, so they never start an agent run. Only the
// scenario buttons / free-text box (pricing) start runs. Fires every ~3–5s
// with lightly randomised payloads so successive events visibly differ.
let ambientTimer: ReturnType<typeof setTimeout> | undefined;

function jitter(base: number, spread: number): number {
  return Math.max(0, Math.round(base + (Math.random() * 2 - 1) * spread));
}
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const WEATHER_NOTES = [
  'Warm and dry, strong barbecue weather across the weekend.',
  'Light cloud building through the afternoon, demand steady.',
  'Brief showers clearing by midday, outdoor demand holding.',
  'Heatwave advisory in the south, chilled-drinks pull expected.',
  'Mild evening, grill demand tapering into the night.',
] as const;
const NEWS_HEADLINES = [
  { headline: 'Steady consumer demand reported nationwide', impact: 'No unusual demand signal' },
  { headline: 'Fuel prices ease for third week running', impact: 'Marginal lift in discretionary spend' },
  { headline: 'Regional food festival draws weekend crowds', impact: 'Elevated fresh and beverage footfall' },
  { headline: 'Supply chains normalise after port delays', impact: 'Inventory availability improving' },
  { headline: 'Consumer confidence index ticks upward', impact: 'Slightly stronger basket sizes' },
] as const;

/** Publish one round of ambient context (weather + news + a stock movement). */
function publishAmbient(bus: Bus) {
  const s = world.scenario;
  const today = new Date().toISOString().slice(0, 10);

  // Weather refresh - a live forecast tick. Suppressed when the weather tool is
  // "down" (tool-outage scenario), matching publishWorld's behaviour.
  if (!world.weatherToolDown) {
    publish(
      bus,
      CONTEXT_TOPICS.weatherForecast(s.country),
      {
        country: s.country,
        outlook: [
          {
            date: today,
            conditionCode: pick(['sunny', 'partly-cloudy', 'cloudy', 'light-rain'] as const),
            tempMaxC: jitter(24, 6),
            precipProbability: jitter(20, 18),
          },
        ],
        summary: pick(WEATHER_NOTES),
      },
      { country: s.country, ambient: 'true' },
    );
  }

  // News tick - a rolling notable headline (no national-event flag; that stays
  // scenario-driven so it can't accidentally alter a run's reasoning).
  const news = pick(NEWS_HEADLINES);
  publish(
    bus,
    CONTEXT_TOPICS.newsNationalEvent(s.country),
    { country: s.country, nationalEvents: [], notable: [{ date: today, ...news }] },
    { country: s.country, ambient: 'true' },
  );

  // Stock movement - one store's units drift, as a live inventory signal.
  const stores = world.stores();
  if (stores.length > 0) {
    const store = pick(stores);
    publish(
      bus,
      CONTEXT_TOPICS.stockLevel(store.storeId, s.sku),
      {
        storeId: store.storeId,
        sku: s.sku,
        units: jitter(store.units, Math.max(4, Math.round(store.units * 0.15))),
        city: store.city,
        daysOfCover: store.daysOfCover,
        atRiskUnits: store.atRiskUnits,
      },
      { sku: s.sku, ambient: 'true' },
    );
  }
}

/** Kick off the recurring ambient feed on a lightly randomised ~3–5s cadence. */
export function startAmbientFeed(bus: Bus) {
  if (process.env.AMBIENT_FEED_ENABLED === 'false') {
    log.info('ambient feed disabled via AMBIENT_FEED_ENABLED=false');
    return;
  }
  const tick = () => {
    try {
      publishAmbient(bus);
    } catch (e) {
      log.warn('ambient publish failed', { error: String(e) });
    }
    ambientTimer = setTimeout(tick, 3000 + Math.random() * 2000);
  };
  // First tick shortly after startup so the feed is immediately alive.
  ambientTimer = setTimeout(tick, 1500);
  log.info('ambient feed started');
}

export function stopAmbientFeed() {
  if (ambientTimer) clearTimeout(ambientTimer);
  ambientTimer = undefined;
}

/**
 * Publish ONE price/updated trigger, plus overrides.
 *
 * When `opts.snapshot` is supplied the trigger payload AND the stored
 * per-trigger snapshot are both derived from it - the world as it was at click
 * time. This is the isolation guarantee: `publishScenarioTrigger` fires the
 * actual trigger on a short delay, and during that delay a spammed sibling
 * click may have already mutated the shared world. Capturing the snapshot at
 * click time (not here, inside the timer) is what keeps concurrent runs from
 * collapsing onto the last-clicked scenario. With no snapshot (organic/storm
 * triggers) it falls back to the live world.
 */
export function publishTrigger(
  bus: Bus,
  overrides: Partial<PriceUpdated> = {},
  opts: { forced?: boolean; snapshot?: ScenarioSnapshot } = {},
) {
  const snap = opts.snapshot;
  const payload = snap ? world.priceUpdatedFor(snap.scenario, overrides) : world.priceUpdated(overrides);
  const topic = CONTEXT_TOPICS.priceUpdated(payload.country, payload.region, payload.sku);
  // Store the snapshot the run will gather from. Prefer the click-time capture;
  // otherwise clone the world now (still before any later click mutates it for
  // organic single triggers).
  const triggerId = nextTriggerId();
  triggerSnapshots.set(triggerId, snap ?? {
    scenario: world.cloneScenario(),
    weatherToolDown: world.weatherToolDown,
  });
  publish(bus, topic, payload, {
    country: payload.country,
    sku: payload.sku,
    triggerId,
    // A user-initiated demo trigger (scenario button / free-text). It should
    // supersede any run for the same SKU still awaiting approval, rather than
    // being dropped as a duplicate.
    ...(opts.forced ? { forced: 'true' } : {}),
  });
  log.info('trigger published', {
    sku: payload.sku,
    discountPct: payload.discountPct,
    shelfLifeDaysRemaining: payload.shelfLifeDaysRemaining,
  });
  return payload;
}

/**
 * Apply a scenario to the world, republish context streams, then publish the
 * appropriate trigger(s). For 'storm', emit a burst of 12 price updates over
 * ~20s where only ~2 exceed the trigger threshold and 10 stay below it (so they
 * are suppressed). Returns quickly; the storm burst runs on timers.
 */
export function publishScenarioTrigger(bus: Bus, scenarioName: ScenarioName | string) {
  const name = assertScenarioName(scenarioName);
  world.applyScenario(name);
  // Clear the materialised view so CACHED signals reflect THIS scenario, not a
  // previously selected one. The world is then republished below, and the
  // trigger is delayed briefly so context materialises first (mock bus delivers
  // asynchronously via microtasks).
  contextStore.reset();
  publishWorld(bus);

  if (name === 'storm') {
    publishStormBurst(bus);
    return;
  }

  // Capture the world NOW, synchronously, before any spammed sibling click can
  // mutate world.scenario during the delay below. The trigger fired in the timer
  // derives BOTH its price payload and its gather-snapshot from this capture, so
  // three rapid clicks yield three runs each bound to their own scenario.
  const snapshot: ScenarioSnapshot = {
    scenario: world.cloneScenario(),
    weatherToolDown: world.weatherToolDown,
  };

  // All non-storm scenarios fire a single qualifying trigger, after a short
  // delay so weather/news/consent land in the ContextStore before gathering.
  // Forced: supersede any prior same-SKU run still awaiting approval.
  setTimeout(() => publishTrigger(bus, {}, { forced: true, snapshot }), 150);
}

/**
 * Apply a free-text scenario patch (already synthesised by the LLM from a user
 * prompt), republish context, then fire a qualifying trigger. Same delivery
 * shape as a named scenario, but the world state came from the prompt.
 */
export function publishFreetextScenario(bus: Bus, patch: ScenarioPatch) {
  world.applyScenarioPatch(patch);
  contextStore.reset();
  publishWorld(bus);
  // Capture at click time so a spammed sibling can't corrupt this run's world
  // during the delay (same isolation reasoning as publishScenarioTrigger).
  const snapshot: ScenarioSnapshot = {
    scenario: world.cloneScenario(),
    weatherToolDown: world.weatherToolDown,
  };
  // Forced: supersede any prior same-SKU run still awaiting approval, so a fresh
  // free-text scenario always starts even if the last one wasn't approved/denied.
  setTimeout(() => publishTrigger(bus, {}, { forced: true, snapshot }), 150);
}

/**
 * Storm burst: 12 price updates over ~20s. Two exceed the trigger threshold
 * (discountPct >= 15 or shelfLifeDaysRemaining <= 5), ten stay below it.
 */
function publishStormBurst(bus: Bus) {
  const total = 12;
  // Two DISTINCT SKUs qualify so two runs proceed (one may queue behind the
  // other), which is the "does it fire on everything" plus queueing beat.
  const qualifyingIndexes = new Map<number, { sku: string; item: string; category: string }>([
    [3, { sku: '51001', item: 'Artisan Pork Sausage 500g', category: 'fresh-meat' }],
    [8, { sku: '53020', item: 'Lager 6x33cl', category: 'beverages' }],
  ]);
  const intervalMs = Math.round(20000 / total); // ~1.66s apart, ~20s total

  const skus = [
    { sku: '51002', item: 'Beef Burger Patties 4pk', category: 'fresh-meat' },
    { sku: '51003', item: 'Chicken Wings 1kg', category: 'fresh-meat' },
    { sku: '52010', item: 'Brioche Burger Buns 6pk', category: 'bakery' },
    { sku: '54040', item: 'Charcoal 3kg', category: 'seasonal' },
    { sku: '55050', item: 'Paper Plates 24pk', category: 'household' },
  ];

  for (let i = 0; i < total; i++) {
    setTimeout(() => {
      const qualifies = qualifyingIndexes.has(i);
      const meta = qualifies ? qualifyingIndexes.get(i)! : skus[i % skus.length];
      const overrides: Partial<PriceUpdated> = qualifies
        ? {
            sku: meta.sku,
            item: meta.item,
            category: meta.category,
            previousPrice: 4.5,
            newPrice: 3.15,
            discountPct: 30, // exceeds threshold
            shelfLifeDaysRemaining: 2, // also below shelf-life threshold
            reason: 'Storm markdown, high urgency',
          }
        : {
            sku: meta.sku,
            item: meta.item,
            category: meta.category,
            previousPrice: 4.5,
            newPrice: 4.28,
            discountPct: 5, // below threshold
            shelfLifeDaysRemaining: 12, // above threshold, should suppress
            reason: 'Storm markdown, low urgency',
          };
      publishTrigger(bus, overrides);
    }, i * intervalMs);
  }

  log.info('storm burst scheduled', {
    total,
    qualifying: qualifyingIndexes.size,
    windowMs: total * intervalMs,
  });
}

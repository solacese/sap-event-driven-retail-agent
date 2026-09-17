// ---------------------------------------------------------------------------
// DiscountBotAgent: the state machine.
// disconnected -> idle -> triggered -> gathering -> reasoning -> drafted
//   -> awaiting_approval -> dispatched | suppressed | error
//
// Key EDA points made explicit in code:
// - Signals present in the ContextStore are CACHED ("already knew"); missing
//   ones are REQUESTED via mesh request/reply. Both are labelled for the UI.
// - Human approval is an EVENT round trip. The HTTP Yes/No handler publishes a
//   decision event; THIS agent reacts to that event, not to the HTTP call.
// - Consent is enforced in code (audience filtered before the LLM, and the
//   final audience size is asserted to never exceed the consented count).
// ---------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';
import type { Bus, MeshMessage, UserProperties } from '../types.js';
import { hub } from '../hub.js';
import { contextStore } from '../context/store.js';
import { makeLogger } from '../log.js';
import {
  AGENT_TOPICS,
  AGENT_SUBSCRIPTIONS,
  CONTEXT_SUBSCRIPTIONS,
  TOOL_TOPICS,
} from '../../../config/topics.js';
import {
  priceUpdatedSchema,
  weatherReplySchema,
  newsReplySchema,
  inventoryReplySchema,
  customerInterestReplySchema,
  campaignSchema,
  llmCampaignSchema,
  type PriceUpdated,
  type Campaign,
  type WeatherReply,
  type NewsReply,
  type InventoryReply,
  type CustomerInterestReply,
} from './schema.js';
import { complete } from '../llm/index.js';
import { buildMessages, buildRetryMessages, type GatheredSignals } from './prompt.js';
import { buildFallbackCampaign } from './fallback.js';
import { getTriggerSnapshot, releaseTriggerSnapshot } from '../simulators/index.js';
import { world, type ScenarioSnapshot } from '../simulators/world.js';

const log = makeLogger('AGENT');
const AGENT_VERSION = '1.0.0';
const TOOL_TIMEOUT_MS = 4000;
const APPROVAL_TIMEOUT_MS = 120_000;
const MAX_CONCURRENT = 3;
// Campaigns protecting less than this much revenue are auto-accepted (no human
// in the loop). Tunable via AUTO_ACCEPT_BELOW_EUR.
const AUTO_ACCEPT_BELOW_EUR = Number(process.env.AUTO_ACCEPT_BELOW_EUR ?? '2000');

// Deliberate pacing between run phases so the human audience can follow the
// agent thinking (gather -> reason -> draft). Totals ~3.4s of visible work on
// top of the actual gather/LLM latency. Tunable via AGENT_PACE_MS.
const PACE_MS = Number(process.env.AGENT_PACE_MS ?? '1100');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type SourceTag = 'CACHED' | 'REQUESTED';
type SignalStatus = 'pending' | 'resolved' | 'unavailable';

interface Run {
  runId: string;
  sku: string;
  country: string;
  trigger: PriceUpdated;
  startedAt: number;
  // User-initiated (a scenario button / free-text / swipe deal). Forced runs
  // always require human approval so the demo's HITL deck is never bypassed by
  // the low-value auto-accept path.
  forced?: boolean;
  approvalResolver?: (decision: 'yes' | 'no') => void;
  approvalTimer?: NodeJS.Timeout;
  campaign?: Campaign;
  // Estimated USD cost of the LLM call(s) this run made, attributed per-run.
  costUsd?: number;
  // Set when a newer user-initiated trigger for the same SKU supersedes this
  // run; its post-approval branch then exits quietly instead of emitting a
  // second (misleading) suppression.
  superseded?: boolean;
  // The world captured at trigger time. When present, gather() builds every
  // scenario-derived signal from THIS, not the shared (mutable) world/context,
  // so concurrent runs stay isolated. `triggerId` is the snapshot's registry key.
  triggerId?: string;
  snapshot?: ScenarioSnapshot;
}

export class DiscountBotAgent {
  private bus: Bus | null = null;
  private activeRuns = new Map<string, Run>();
  private queue: Array<{ price: PriceUpdated; triggerId?: string; snapshot?: ScenarioSnapshot; forced?: boolean }> = [];
  // Budget top-up: at most one outstanding at a time.
  private budgetTopUpPending = false;
  private budgetTopUpId?: string;

  attach(bus: Bus, opts?: { triggerTopic?: string }) {
    this.bus = bus;
    // Subscribe to context streams (materialise) and price triggers.
    for (const filter of CONTEXT_SUBSCRIPTIONS) {
      bus.subscribe(filter, (msg) => this.onContext(msg));
    }
    // Optional operator-specified trigger subscription (from Broker settings).
    // Additive: it flows through the same materialise/trigger path, so any
    // price-shaped payload arriving on it arms a run. Skipped when it would
    // duplicate a built-in context subscription.
    const trigger = opts?.triggerTopic?.trim();
    if (trigger && !CONTEXT_SUBSCRIPTIONS.includes(trigger)) {
      bus.subscribe(trigger, (msg) => this.onContext(msg));
      log.info('custom trigger subscription installed', { filter: trigger });
    }
    // Subscribe to the approval-decision topic: the human-in-the-loop event.
    for (const filter of AGENT_SUBSCRIPTIONS) {
      bus.subscribe(filter, (msg) => this.onApprovalDecision(msg));
    }
    hub.setAgentState('idle');
    log.info('agent attached and subscribed');
  }

  detach() {
    this.bus = null;
    for (const run of this.activeRuns.values()) {
      if (run.approvalTimer) clearTimeout(run.approvalTimer);
    }
    this.activeRuns.clear();
    this.queue = [];
    this.budgetTopUpPending = false;
    this.budgetTopUpId = undefined;
    hub.setAgentState('disconnected');
  }

  // --- Materialise context streams into the ContextStore, then maybe trigger ---
  private onContext(msg: MeshMessage) {
    const topic = msg.topic;
    try {
      if (topic.includes('/weather/forecast/updated/')) {
        const w = weatherReplySchema.parse(msg.payload);
        contextStore.setWeather(w.country, w);
      } else if (topic.includes('/news/national-event/flagged/')) {
        const n = newsReplySchema.parse(msg.payload);
        contextStore.setNews(n.country, n);
      } else if (topic.includes('/inventory/stock-level/changed/')) {
        const p = msg.payload as { storeId: string; sku: string; units: number; city: string; daysOfCover: number };
        if (p && p.storeId) contextStore.setStock(p);
      } else if (topic.includes('/customer/consent/updated/')) {
        const p = msg.payload as { customerId: string; consented: boolean };
        if (p && p.customerId != null) contextStore.setConsent(p.customerId, !!p.consented);
      } else if (topic.includes('/shopfloor/price/updated/')) {
        const price = priceUpdatedSchema.parse(msg.payload);
        contextStore.setPrice(price);
        const forced = msg.userProperties?.forced === 'true';
        const triggerId = msg.userProperties?.triggerId;
        const snapshot = triggerId ? getTriggerSnapshot(triggerId) : undefined;
        this.onPriceTrigger(price, forced, triggerId, snapshot);
      }
    } catch (e) {
      log.warn('failed to materialise context', { topic, error: String(e) });
    }
  }

  // --- Trigger rule ---
  private onPriceTrigger(
    price: PriceUpdated,
    forced = false,
    triggerId?: string,
    snapshot?: ScenarioSnapshot,
  ) {
    // Dynamic pricing: a run is worth starting for a meaningful markdown, a
    // near-expiry item, a temporary surge (>= 10% increase) or a bundle
    // proposition. `changePct` defaults to -discountPct for legacy markdowns.
    const changePct = price.changePct ?? -price.discountPct;
    const isBundle = price.direction === 'bundle' || !!price.bundle;
    const isSurge = changePct >= 10;
    const isMarkdown = price.discountPct >= 15;
    const nearExpiry = price.shelfLifeDaysRemaining <= 5;
    const triggers = isMarkdown || nearExpiry || isSurge || isBundle;
    if (!triggers) {
      const runId = shortId();
      this.publish(AGENT_TOPICS.runSuppressed(runId), {
        suppressed: true,
        sku: price.sku,
        reason: 'below_threshold',
        detail: `changePct ${changePct} within ±10, shelfLife ${price.shelfLifeDaysRemaining} > 5, no bundle`,
      }, { runId, sku: price.sku, country: price.country });
      hub.broadcast({ type: 'suppressed', runId, reason: 'below_threshold', sku: price.sku, dimmed: true });
      return;
    }

    // A user-initiated (forced) trigger supersedes any run for the same SKU that
    // is still in flight - otherwise a new scenario/free-text run is silently
    // dropped whenever the previous one is left awaiting approval. Organic
    // duplicate triggers keep the original de-dup behaviour below.
    if (forced) {
      this.cancelRunsForSku(price.sku);
    }

    // One run at a time per SKU; max 3 concurrent, queue the rest.
    if ([...this.activeRuns.values()].some((r) => r.sku === price.sku)) {
      log.info('sku already running, ignoring duplicate trigger', { sku: price.sku });
      if (triggerId) releaseTriggerSnapshot(triggerId);
      return;
    }
    // Budget gate: if the operating budget is spent, hold the run and raise a
    // top-up approval. It resumes from the queue once the top-up is approved.
    if (hub.isBudgetExhausted()) {
      this.queue.push({ price, triggerId, snapshot, forced });
      hub.broadcast({ type: 'queued', sku: price.sku, queueDepth: this.queue.length });
      this.raiseBudgetTopUp();
      return;
    }

    if (this.activeRuns.size >= MAX_CONCURRENT) {
      this.queue.push({ price, triggerId, snapshot, forced });
      hub.broadcast({ type: 'queued', sku: price.sku, queueDepth: this.queue.length });
      return;
    }

    void this.runOnce(price, triggerId, snapshot, forced);
  }

  /**
   * Raise a single budget top-up approval when the bar hits 100%. This is a
   * distinct human-in-the-loop card (not a campaign approval): approving it
   * resets the budget bar and drains any runs held while it was exhausted.
   */
  private raiseBudgetTopUp() {
    if (this.budgetTopUpPending) return;
    this.budgetTopUpPending = true;
    const topUpId = `budget-${shortId()}`;
    this.budgetTopUpId = topUpId;
    hub.broadcast({
      type: 'budget:request',
      runId: topUpId,
      question: 'Operating budget reached 100%. Approve a $1 top-up to continue?',
    });
  }

  /** Called (via the mesh decision event) when the top-up is approved/denied. */
  onBudgetDecision(decision: 'yes' | 'no', topUpId?: string) {
    if (!this.budgetTopUpPending) return;
    if (topUpId && this.budgetTopUpId && topUpId !== this.budgetTopUpId) return;
    this.budgetTopUpPending = false;
    const resolvedId = this.budgetTopUpId;
    this.budgetTopUpId = undefined;
    hub.broadcast({ type: 'budget:decision', runId: resolvedId, decision });
    if (decision === 'yes') {
      hub.topUpBudget();
      this.drainQueue();
    }
    // On 'no', held runs stay queued until a later top-up is approved.
  }

  private drainQueue() {
    // Runs stay parked while the budget is exhausted (awaiting top-up).
    if (hub.isBudgetExhausted()) {
      if (this.queue.length) this.raiseBudgetTopUp();
      return;
    }
    while (this.queue.length && this.activeRuns.size < MAX_CONCURRENT) {
      const next = this.queue.shift()!;
      if (![...this.activeRuns.values()].some((r) => r.sku === next.price.sku)) {
        void this.runOnce(next.price, next.triggerId, next.snapshot, next.forced);
      } else if (next.triggerId) {
        releaseTriggerSnapshot(next.triggerId);
      }
    }
  }

  // --- Full run ---
  private async runOnce(price: PriceUpdated, triggerId?: string, snapshot?: ScenarioSnapshot, forced = false) {
    const runId = shortId();
    const run: Run = {
      runId,
      sku: price.sku,
      country: price.country,
      trigger: price,
      startedAt: Date.now(),
      triggerId,
      snapshot,
      forced,
    };
    this.activeRuns.set(runId, run);

    try {
      hub.setAgentState('triggered');
      this.publish(AGENT_TOPICS.runStarted(runId), { runId, sku: price.sku, trigger: price }, { runId, sku: price.sku, country: price.country });
      hub.broadcast({ type: 'run:started', runId, sku: price.sku, trigger: price });
      await sleep(PACE_MS);

      // --- Gather (parallel), CACHED vs REQUESTED ---
      hub.setAgentState('gathering');
      const gathered = await this.gather(run);
      await sleep(PACE_MS);

      // --- Enforce consent in code BEFORE the LLM sees the audience ---
      const consentedCount = gathered.consentedCount;

      // --- Reason ---
      hub.setAgentState('reasoning');
      const { campaign, llmFallback, costUsd } = await this.reason(run, gathered);
      run.costUsd = costUsd;
      await sleep(PACE_MS);

      // Consent assertion: the campaign audience must never exceed consented.
      if (campaign.audience.size > consentedCount) {
        log.error('CONSENT VIOLATION: audience exceeds consented count', {
          audience: campaign.audience.size,
          consented: consentedCount,
        });
        // Clamp and suppress loudly rather than dispatch a non-compliant campaign.
        campaign.audience.size = consentedCount;
        this.suppress(run, 'consent_violation_blocked');
        return;
      }

      run.campaign = campaign;
      hub.setAgentState('drafted');
      this.publish(AGENT_TOPICS.campaignDrafted(runId), campaign, { runId, sku: price.sku, country: price.country });
      hub.broadcast({ type: 'campaign:drafted', runId, campaign, llmFallback, costUsd });

      // If the model recommends holding, suppress instead of asking for approval.
      if (campaign.recommendation === 'hold') {
        this.suppress(run, 'agent_recommended_hold');
        return;
      }

      // --- Low-value auto-accept ---
      // Campaigns protecting less than the auto-accept threshold of revenue are
      // low-stakes: dispatch them without a human in the loop. Only higher-value
      // campaigns are worth an approval round trip. User-initiated (forced) runs
      // - the demo scenarios and swipe deals - always go to the human so the
      // HITL/swipe deck is never bypassed, regardless of unit economics.
      if (!run.forced && campaign.revenueProtectedEur < AUTO_ACCEPT_BELOW_EUR) {
        hub.broadcast({
          type: 'approval:auto',
          runId,
          campaignId: campaign.campaignId,
          revenueProtectedEur: campaign.revenueProtectedEur,
          thresholdEur: AUTO_ACCEPT_BELOW_EUR,
        });
        this.dispatch(run, campaign, consentedCount, true);
        return;
      }

      // --- Human approval as an EVENT round trip ---
      const decision = await this.requestApproval(run, campaign);
      if (run.superseded) {
        // A newer trigger already superseded us and announced it; exit quietly.
        return;
      }
      if (decision === 'yes') {
        this.dispatch(run, campaign, consentedCount);
      } else {
        this.suppress(run, decision === 'no' ? 'human_rejected' : 'approval_timeout');
      }
    } catch (e) {
      log.error('run failed', { runId, error: String(e) });
      hub.setAgentState('error');
      hub.broadcast({ type: 'run:error', runId, error: String(e) });
    } finally {
      const run2 = this.activeRuns.get(runId);
      if (run2?.approvalTimer) clearTimeout(run2.approvalTimer);
      this.activeRuns.delete(runId);
      if (triggerId) releaseTriggerSnapshot(triggerId);
      hub.recordRunLatency(Date.now() - run.startedAt);
      if (this.activeRuns.size === 0) hub.setAgentState('idle');
      this.drainQueue();
    }
  }

  private async gather(run: Run): Promise<GatheredSignals> {
    const price = run.trigger;
    const country = price.country;
    const sku = price.sku;
    const signalsUsed: string[] = ['price'];
    const signalsUnavailable: string[] = [];

    const emitSignal = (name: string, sourceTag: SourceTag, status: SignalStatus, data?: unknown) => {
      this.publish(AGENT_TOPICS.signal(name, run.runId), { name, sourceTag, status, data }, { runId: run.runId, sku, country });
      hub.broadcast({ type: 'signal', runId: run.runId, name, sourceTag, status, data });
    };

    // When the run carries a snapshot (user-initiated scenario/free-text), gather
    // EVERY scenario-derived signal from that frozen world. This keeps concurrent
    // runs isolated: a later scenario click cannot change what this run sees. The
    // CACHED-vs-REQUESTED choreography and the tool-outage timeout are preserved.
    const snap = run.snapshot;

    // Weather: CACHED from the snapshot; when the snapshot marks the tool down we
    // reproduce the outage locally (REQUESTED → times out → unavailable).
    const weatherP: Promise<WeatherReply | undefined> = snap
      ? snap.weatherToolDown
        ? this.resolveSignal<WeatherReply>(
            'weather',
            false,
            () => undefined,
            () => this.neverResolve<WeatherReply>(),
            emitSignal,
          )
        : this.resolveSignal<WeatherReply>(
            'weather',
            true,
            () => world.weatherOutlookFor(snap.scenario),
            () => this.neverResolve<WeatherReply>(),
            emitSignal,
          )
      : this.resolveSignal<WeatherReply>(
          'weather',
          contextStore.hasWeather(country),
          () => contextStore.getWeather(country),
          () => this.request(TOOL_TOPICS.weatherRequest(country), { country }, weatherReplySchema),
          emitSignal,
        );

    const newsP: Promise<NewsReply | undefined> = snap
      ? this.resolveSignal<NewsReply>(
          'news',
          true,
          () => world.newsReplyFor(snap.scenario),
          () => this.neverResolve<NewsReply>(),
          emitSignal,
        )
      : this.resolveSignal<NewsReply>(
          'news',
          contextStore.hasNews(country),
          () => contextStore.getNews(country),
          () => this.request(TOOL_TOPICS.newsRequest(country), { country }, newsReplySchema),
          emitSignal,
        );

    // Inventory: keep it REQUESTED for the visual, but resolve from the snapshot.
    const invP: Promise<InventoryReply | undefined> = snap
      ? this.resolveSignal<InventoryReply>(
          'inventory',
          false,
          () => undefined,
          async () => world.inventoryReplyFor(snap.scenario),
          emitSignal,
        )
      : this.resolveSignal<InventoryReply>(
          'inventory',
          false,
          () => undefined,
          () => this.request(TOOL_TOPICS.inventoryRequest(sku), { sku }, inventoryReplySchema),
          emitSignal,
        );

    const ciP: Promise<CustomerInterestReply | undefined> = snap
      ? this.resolveSignal<CustomerInterestReply>(
          'customer_interest',
          false,
          () => undefined,
          async () => world.customerInterestReplyFor(snap.scenario),
          emitSignal,
        )
      : this.resolveSignal<CustomerInterestReply>(
          'customer_interest',
          false,
          () => undefined,
          () => this.request(TOOL_TOPICS.customerInterestRequest(sku), { sku }, customerInterestReplySchema),
          emitSignal,
        );

    const [weather, news, inventory, customerInterest] = await Promise.all([weatherP, newsP, invP, ciP]);

    for (const [name, val] of [
      ['weather', weather],
      ['news', news],
      ['inventory', inventory],
      ['customer_interest', customerInterest],
    ] as const) {
      if (val) signalsUsed.push(name);
      else signalsUnavailable.push(name);
    }

    // Consent enforced in code. The authoritative consented count is the
    // customer-interest tool's marketingConsented figure (the full audience
    // math). The consent event stream is a live sample used for feed visuals
    // and corroboration, not a ceiling, so we never clamp to the sample size.
    // If the tool signal was unavailable, fall back to the materialised sample.
    const consentedCount = customerInterest
      ? customerInterest.marketingConsented
      : contextStore.consentedCount();

    return {
      price,
      weather,
      news,
      inventory,
      customerInterest,
      signalsUsed,
      signalsUnavailable,
      consentedCount,
    };
  }

  private async resolveSignal<T>(
    name: string,
    cached: boolean,
    fromCache: () => T | undefined,
    fromMesh: () => Promise<T>,
    emit: (name: string, tag: SourceTag, status: SignalStatus, data?: unknown) => void,
  ): Promise<T | undefined> {
    if (cached) {
      const data = fromCache();
      emit(name, 'CACHED', 'resolved', data);
      hub.addToolCall(); // count materialised reads too? No: only mesh requests below.
      return data;
    }
    emit(name, 'REQUESTED', 'pending');
    try {
      const data = await fromMesh();
      hub.addToolCall();
      emit(name, 'REQUESTED', 'resolved', data);
      return data;
    } catch (e) {
      log.warn('signal unavailable (tool timeout or error)', { name, error: String(e) });
      emit(name, 'REQUESTED', 'unavailable');
      // Record a tool-timeout row in the feed as an amber chip.
      hub.record(
        { topic: `signal/${name}/timeout`, payload: { name, error: 'timeout' }, userProperties: {} },
        'in',
        { toolTimeout: true, summary: `${name} tool timed out, degrading gracefully`, sourceTag: 'REQUESTED' },
      );
      return undefined;
    }
  }

  /**
   * Reproduce a tool outage for a snapshot-driven run: reject after the same
   * timeout the mesh request would use, so `resolveSignal` renders the identical
   * amber "timed out, degrading gracefully" beat without a shared-world read.
   */
  private neverResolve<T>(): Promise<T> {
    return new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error('tool timeout (snapshot outage)')), TOOL_TIMEOUT_MS);
    });
  }

  private async reason(run: Run, gathered: GatheredSignals): Promise<{ campaign: Campaign; llmFallback: boolean; costUsd: number }> {
    const messages = buildMessages(gathered);
    const campaignId = `CMP-${run.sku}-${String(hub.counters.runsCompleted + 1).padStart(4, '0')}`;

    const price = gathered.price;
    const changePct = price.changePct ?? -price.discountPct;
    const direction = price.direction ?? (changePct > 0 ? 'increase' : changePct < 0 ? 'decrease' : 'bundle');

    const finalize = (partial: import('./schema.js').LlmCampaign): Campaign => {
      // "Revenue Protected" is the headline money metric on every card. Its
      // meaning flexes with the pricing move:
      //  • markdown  → revenue rescued from write-off: wasteAvoidedUnits × newPrice
      //  • surge     → uplift from the higher price: expectedUnitsMoved × (newPrice−prevPrice)
      //  • bundle    → incremental basket value: expectedUnitsMoved × bundlePrice
      // Computed in code so it never depends on the LLM emitting it, and so a
      // surge/bundle carries a real, HITL-worthy number rather than ~0.
      const units = Math.max(0, partial.expectedUnitsMoved ?? 0);
      let revenueProtectedEur: number;
      if (direction === 'increase') {
        const perUnit = Math.max(0, (price.newPrice ?? 0) - (price.previousPrice ?? 0));
        revenueProtectedEur = Number((units * perUnit).toFixed(2));
      } else if (direction === 'bundle') {
        const bundlePrice = price.bundle?.bundlePrice ?? price.newPrice ?? 0;
        revenueProtectedEur = Number((units * bundlePrice).toFixed(2));
      } else {
        revenueProtectedEur = Number(
          (Math.max(0, partial.wasteAvoidedUnits ?? 0) * (price.newPrice ?? 0)).toFixed(2),
        );
      }
      const merged: Campaign = campaignSchema.parse({
        ...partial,
        campaignId,
        sku: run.sku,
        revenueProtectedEur,
        // Consent enforced in code: clamp audience to the consented ceiling.
        audience: {
          ...partial.audience,
          size: Math.min(partial.audience.size, gathered.consentedCount),
          consentBasis: partial.audience.consentBasis || 'explicit_marketing_optin',
        },
        guardrails: { consentEnforced: true, humanApprovalRequired: true },
      });
      return merged;
    };

    // Accumulate every billed call so this run's card can show its own cost.
    let runCostUsd = 0;
    try {
      const r1 = await complete(messages, { schema: llmCampaignSchema });
      hub.addLlmUsage(r1.tokensIn, r1.tokensOut, r1.costUsd);
      runCostUsd += r1.costUsd;
      return { campaign: finalize(r1.value), llmFallback: false, costUsd: Number(runCostUsd.toFixed(5)) };
    } catch (e1) {
      log.warn('llm output failed validation, retrying once', { error: String(e1) });
      try {
        const retry = buildRetryMessages(messages, String(e1));
        const r2 = await complete(retry, { schema: llmCampaignSchema });
        hub.addLlmUsage(r2.tokensIn, r2.tokensOut, r2.costUsd);
        runCostUsd += r2.costUsd;
        return { campaign: finalize(r2.value), llmFallback: false, costUsd: Number(runCostUsd.toFixed(5)) };
      } catch (e2) {
        log.warn('llm retry failed, using deterministic fallback', { error: String(e2) });
        return { campaign: finalize(buildFallbackCampaign(gathered)), llmFallback: true, costUsd: Number(runCostUsd.toFixed(5)) };
      }
    }
  }

  private requestApproval(run: Run, campaign: Campaign): Promise<'yes' | 'no' | 'timeout'> {
    hub.setAgentState('awaiting_approval');
    const topic = AGENT_TOPICS.humanApproval(run.runId);
    const question = `Approve dispatch of "${campaign.headline}" to ${campaign.audience.size} consented customers?`;
    this.publish(topic, { runId: run.runId, campaignId: campaign.campaignId, question, campaign }, { runId: run.runId, sku: run.sku, country: run.country });
    hub.broadcast({ type: 'approval:request', runId: run.runId, topic, question, campaignId: campaign.campaignId });

    return new Promise((resolve) => {
      run.approvalResolver = (decision) => resolve(decision);
      run.approvalTimer = setTimeout(() => {
        run.approvalResolver = undefined;
        resolve('timeout');
      }, APPROVAL_TIMEOUT_MS);
    });
  }

  // The HTTP handler publishes the decision EVENT; the agent reacts here.
  private onApprovalDecision(msg: MeshMessage) {
    const p = msg.payload as { runId?: string; decision?: 'yes' | 'no' };
    if (!p?.runId) return;
    const run = this.activeRuns.get(p.runId);
    hub.broadcast({ type: 'approval:decision', runId: p.runId, decision: p.decision });
    if (run?.approvalResolver && (p.decision === 'yes' || p.decision === 'no')) {
      if (run.approvalTimer) clearTimeout(run.approvalTimer);
      const resolve = run.approvalResolver;
      run.approvalResolver = undefined;
      resolve(p.decision);
    }
  }

  private dispatch(run: Run, campaign: Campaign, consentedCount: number, auto = false) {
    hub.setAgentState('dispatched');
    const topic = AGENT_TOPICS.campaignDispatch(run.country, campaign.campaignId);
    const recipients = Math.min(campaign.audience.size, consentedCount);
    this.publish(topic, { campaignId: campaign.campaignId, sku: run.sku, recipients, campaign, auto }, { runId: run.runId, sku: run.sku, country: run.country });
    hub.broadcast({ type: 'dispatch', runId: run.runId, topic, recipients, campaignId: campaign.campaignId, auto });
    log.info('campaign dispatched', { runId: run.runId, recipients, auto });
  }

  private suppress(run: Run, reason: string) {
    hub.setAgentState('suppressed');
    this.publish(AGENT_TOPICS.runSuppressed(run.runId), { suppressed: true, runId: run.runId, sku: run.sku, reason }, { runId: run.runId, sku: run.sku, country: run.country });
    hub.broadcast({ type: 'suppressed', runId: run.runId, reason, sku: run.sku });
    log.info('run suppressed', { runId: run.runId, reason });
  }

  /**
   * Supersede every in-flight run for a SKU so a fresh user-initiated trigger can
   * start. A run parked on the approval promise is unblocked by resolving it
   * (routing through the run's own cleanup), and any other same-SKU run is
   * dropped from the active set so the de-dup guard no longer blocks the new one.
   * Broadcasts `superseded` so the UI clears the stale approval card.
   */
  private cancelRunsForSku(sku: string) {
    for (const run of [...this.activeRuns.values()]) {
      if (run.sku !== sku) continue;
      run.superseded = true;
      if (run.approvalTimer) {
        clearTimeout(run.approvalTimer);
        run.approvalTimer = undefined;
      }
      this.publish(AGENT_TOPICS.runSuppressed(run.runId), { suppressed: true, runId: run.runId, sku: run.sku, reason: 'superseded' }, { runId: run.runId, sku: run.sku, country: run.country });
      hub.broadcast({ type: 'suppressed', runId: run.runId, reason: 'superseded', sku: run.sku });
      log.info('run superseded by new trigger', { runId: run.runId, sku });
      // Delete first so this run can't re-block the incoming trigger, then
      // unblock any awaiting approval (its finally-block delete is now a no-op).
      this.activeRuns.delete(run.runId);
      const resolve = run.approvalResolver;
      run.approvalResolver = undefined;
      if (resolve) resolve('no');
    }
  }

  // --- helpers ---
  private async request<T>(topic: string, payload: unknown, schema: { parse: (x: unknown) => T }): Promise<T> {
    if (!this.bus) throw new Error('no bus');
    const reply = await this.bus.request(topic, payload, { timeoutMs: TOOL_TIMEOUT_MS });
    // Record the request/reply pair in the feed.
    hub.record({ topic, payload, userProperties: { runId: '', agent: 'discount-bot' } }, 'out', { sourceTag: 'REQUESTED' });
    hub.record(reply, 'in', { sourceTag: 'REQUESTED' });
    return schema.parse(reply.payload);
  }

  private publish(topic: string, payload: unknown, extra: Partial<UserProperties> = {}) {
    if (!this.bus) return;
    const userProperties: UserProperties = {
      agent: 'discount-bot',
      agentVersion: AGENT_VERSION,
      schemaVersion: '1',
      correlationId: randomUUID(),
      emittedAt: new Date().toISOString(),
      ...extra,
    };
    const msg: MeshMessage = { topic, payload, userProperties };
    this.bus.publish(msg);
    hub.record(msg, 'out');
  }
}

function shortId(): string {
  return randomUUID().slice(0, 8);
}

export const agent = new DiscountBotAgent();

// ---------------------------------------------------------------------------
// EventHub: the in-memory nerve centre. Wraps the active Bus, records every
// mesh message into the capped feed, tracks counters, and fans out to SSE
// clients. The agent and HTTP layer read/write demo state here.
// ---------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { Bus, FeedEvent, MeshMessage, AgentState } from './types.js';
import { categorise } from '../../config/topics.js';
import { makeLogger } from './log.js';

const log = makeLogger('GATEWAY');
const FEED_CAP = 200;

export interface Counters {
  eventsIn: number;
  eventsOut: number;
  toolCalls: number;
  llmCalls: number;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  lastRunLatencyMs: number;
  avgRunLatencyMs: number;
  runsCompleted: number;
  // --- Budget bar ---
  // A $1 operating budget. `budgetSpentUsd` is the REAL estimated LLM spend
  // since the last top-up. `budgetFillPct` is that spend scaled by a demo
  // multiplier so the bar reaches 100% in ~10–15 runs (the displayed dollar
  // figure stays true; only the fill rate is amplified). At 100% the agent
  // pauses and a top-up approval is raised; approving resets spend to 0.
  budgetCapUsd: number;
  budgetSpentUsd: number;
  budgetFillPct: number;
  budgetExhausted: boolean;
}

// $1 operating budget, with the fill rate amplified so the bar is legible in a
// short demo. ~$0.0007/run real spend × 100 ≈ 7%/run → full in ~14 runs.
const BUDGET_CAP_USD = 1;
const BUDGET_FILL_MULTIPLIER = Number(process.env.BUDGET_FILL_MULTIPLIER ?? '100');

export interface SsePayload {
  type: string;
  [k: string]: unknown;
}

export interface LlmInfo {
  provider: string;
  model: string;
  baseUrl?: string;
}

export class EventHub {
  private clients = new Set<Response>();
  private feed: FeedEvent[] = [];
  // Runs the agent has actually started this session. Lets the HTTP layer reject
  // approval decisions for runIds that never existed, without coupling to the
  // agent's private state. Populated from run lifecycle broadcasts.
  private knownRuns = new Set<string>();
  // Pending human-in-the-loop approvals, keyed by runId, in arrival order. Each
  // entry holds the exact broadcast events a client replays to rebuild the card
  // (run:started → campaign:drafted → approval:request). This is what lets a
  // device that opens /swipe (or the desktop) AFTER a campaign was published
  // still see the outstanding card, instead of only devices that were already
  // connected when the live events fired. Cleared once the run is decided,
  // dispatched, auto-approved, suppressed, or errors out.
  private pendingApprovals = new Map<
    string,
    { started?: SsePayload; drafted?: SsePayload; request: SsePayload }
  >();
  private pendingParts = new Map<string, { started?: SsePayload; drafted?: SsePayload }>();
  bus: Bus | null = null;
  agentState: AgentState = 'disconnected';
  llmInfo: LlmInfo = { provider: 'mock', model: 'mock-campaigner' };
  counters: Counters = {
    eventsIn: 0,
    eventsOut: 0,
    toolCalls: 0,
    llmCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    estCostUsd: 0,
    lastRunLatencyMs: 0,
    avgRunLatencyMs: 0,
    runsCompleted: 0,
    budgetCapUsd: BUDGET_CAP_USD,
    budgetSpentUsd: 0,
    budgetFillPct: 0,
    budgetExhausted: false,
  };

  // ---- SSE client registry ----
  addClient(res: Response) {
    this.clients.add(res);
    // Replay current state so a fresh tab is immediately populated.
    this.sendTo(res, { type: 'hello', agentState: this.agentState, llmInfo: this.llmInfo });
    this.sendTo(res, { type: 'feed:init', events: this.feed.slice(0, FEED_CAP) });
    this.sendTo(res, { type: 'counters', counters: this.counters });
    const conn = this.bus?.info() ?? null;
    this.sendTo(res, { type: 'connection', connected: this.bus?.isConnected() ?? false, info: conn, brokerKind: this.bus?.kind ?? null });
    // Replay any outstanding approvals so a device that connects AFTER a campaign
    // was published still sees the pending card. Each is replayed as the same
    // event sequence a live client would have received, in arrival order, so the
    // client's reducer rebuilds an identical pending-approval entry.
    for (const entry of this.pendingApprovals.values()) {
      if (entry.started) this.sendTo(res, entry.started);
      if (entry.drafted) this.sendTo(res, entry.drafted);
      this.sendTo(res, entry.request);
    }
  }

  removeClient(res: Response) {
    this.clients.delete(res);
  }

  private sendTo(res: Response, payload: SsePayload) {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      this.clients.delete(res);
    }
  }

  broadcast(payload: SsePayload) {
    // Track live runIds off the lifecycle stream so the HTTP layer can validate
    // approval decisions without reaching into the agent.
    const runId = typeof payload.runId === 'string' ? payload.runId : undefined;
    if (payload.type === 'run:started' && runId) {
      this.knownRuns.add(runId);
    }
    // Maintain the replayable set of outstanding approvals (see addClient).
    if (runId) {
      switch (payload.type) {
        case 'run:started': {
          this.pendingParts.set(runId, { ...this.pendingParts.get(runId), started: payload });
          break;
        }
        case 'campaign:drafted': {
          this.pendingParts.set(runId, { ...this.pendingParts.get(runId), drafted: payload });
          break;
        }
        case 'approval:request': {
          const parts = this.pendingParts.get(runId) ?? {};
          this.pendingApprovals.set(runId, { ...parts, request: payload });
          break;
        }
        // Any terminal outcome clears the outstanding card.
        case 'approval:decision':
        case 'approval:auto':
        case 'dispatch':
        case 'suppressed':
        case 'run:error': {
          this.pendingApprovals.delete(runId);
          this.pendingParts.delete(runId);
          break;
        }
      }
    }
    for (const res of this.clients) this.sendTo(res, payload);
  }

  /** True if the agent has started a run with this id this session. */
  hasRun(runId: string): boolean {
    return this.knownRuns.has(runId);
  }

  // ---- Feed recording ----
  record(msg: MeshMessage, direction: 'in' | 'out', extra?: Partial<FeedEvent>): FeedEvent {
    const ev: FeedEvent = {
      id: randomUUID(),
      topic: msg.topic,
      payload: msg.payload,
      userProperties: msg.userProperties || {},
      direction,
      category: categorise(msg.topic),
      summary: summarise(msg),
      receivedAt: new Date().toISOString(),
      ...extra,
    };
    this.feed.unshift(ev);
    if (this.feed.length > FEED_CAP) this.feed.length = FEED_CAP;
    if (direction === 'in') this.counters.eventsIn++;
    else this.counters.eventsOut++;
    this.broadcast({ type: 'feed:event', event: ev });
    this.broadcast({ type: 'counters', counters: this.counters });
    return ev;
  }

  setAgentState(state: AgentState) {
    if (this.agentState === state) return;
    this.agentState = state;
    log.info('agent state', { state });
    this.broadcast({ type: 'agent:state', state });
  }

  recordRunLatency(ms: number) {
    const c = this.counters;
    c.lastRunLatencyMs = ms;
    c.runsCompleted++;
    c.avgRunLatencyMs = Math.round(
      (c.avgRunLatencyMs * (c.runsCompleted - 1) + ms) / c.runsCompleted,
    );
    this.broadcast({ type: 'counters', counters: this.counters });
  }

  addLlmUsage(tokensIn: number, tokensOut: number, costUsd: number) {
    this.counters.llmCalls++;
    this.counters.tokensIn += tokensIn;
    this.counters.tokensOut += tokensOut;
    this.counters.estCostUsd = Number((this.counters.estCostUsd + costUsd).toFixed(5));
    // Real spend also accrues against the budget bar (scaled fill).
    this.counters.budgetSpentUsd = Number((this.counters.budgetSpentUsd + costUsd).toFixed(5));
    this.recomputeBudget();
    this.broadcast({ type: 'counters', counters: this.counters });
  }

  private recomputeBudget() {
    const c = this.counters;
    const pct = (c.budgetSpentUsd * BUDGET_FILL_MULTIPLIER) / c.budgetCapUsd;
    c.budgetFillPct = Math.min(100, Math.round(pct * 100));
    c.budgetExhausted = c.budgetFillPct >= 100;
  }

  /** True when the budget is spent and a top-up approval is outstanding. */
  isBudgetExhausted(): boolean {
    return this.counters.budgetExhausted;
  }

  /** Approve a budget top-up: reset spend to zero so runs can continue. */
  topUpBudget() {
    this.counters.budgetSpentUsd = 0;
    this.recomputeBudget();
    this.broadcast({ type: 'counters', counters: this.counters });
    this.broadcast({ type: 'budget:toppedup' });
    log.info('budget topped up, bar reset');
  }

  addToolCall() {
    this.counters.toolCalls++;
    this.broadcast({ type: 'counters', counters: this.counters });
  }

  setLlmInfo(info: LlmInfo) {
    this.llmInfo = info;
    this.broadcast({ type: 'llm:info', llmInfo: info });
  }

  resetCounters() {
    this.counters = {
      eventsIn: 0,
      eventsOut: 0,
      toolCalls: 0,
      llmCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      estCostUsd: 0,
      lastRunLatencyMs: 0,
      avgRunLatencyMs: 0,
      runsCompleted: 0,
      budgetCapUsd: BUDGET_CAP_USD,
      budgetSpentUsd: 0,
      budgetFillPct: 0,
      budgetExhausted: false,
    };
    this.feed = [];
    this.knownRuns.clear();
    this.broadcast({ type: 'feed:init', events: [] });
    this.broadcast({ type: 'counters', counters: this.counters });
  }
}

// One-line human summary of a payload for the feed row.
function summarise(msg: MeshMessage): string {
  const p = msg.payload as Record<string, unknown> | null;
  if (!p || typeof p !== 'object') return String(msg.payload ?? '');
  if ('newPrice' in p && 'item' in p)
    return `${p.item} ${p.sku}: ${p.previousPrice} to ${p.newPrice} ${p.currency} (${p.discountPct}% off)`;
  if ('headline' in p) return String(p.headline);
  if ('outlook' in p) return String(p.summary ?? 'weather outlook');
  if ('nationalEvents' in p || 'notable' in p) {
    const notable = Array.isArray(p.notable) ? (p.notable[0] as { headline?: string } | undefined) : undefined;
    const events = Array.isArray(p.nationalEvents) ? (p.nationalEvents[0] as { name?: string } | undefined) : undefined;
    return String(events?.name ?? notable?.headline ?? 'news update');
  }
  if ('totalUnits' in p) return `${p.totalUnits} units, ${p.atRiskUnits} at risk`;
  if ('units' in p && 'storeId' in p) return `${p.storeId}: ${p.units} units on hand`;
  if ('pastPurchasers' in p) return `${p.marketingConsented} consented of ${p.pastPurchasers}`;
  if ('decision' in p) return `approval decision: ${p.decision}`;
  if ('reason' in p && 'suppressed' in p) return `suppressed: ${p.reason}`;
  if ('reason' in p) return `reason: ${p.reason}`;
  const keys = Object.keys(p).slice(0, 3).join(', ');
  return keys || 'event';
}

export const hub = new EventHub();

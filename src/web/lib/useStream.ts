// ---------------------------------------------------------------------------
// useStream: opens EventSource('/api/stream'), folds every SSE message into a
// single reactive state object, and reconnects on error. Unknown message types
// are ignored so the backend can add events without breaking the client.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import type {
  AgentState,
  ApprovalRequest,
  BudgetTopUp,
  Campaign,
  Connection,
  Counters,
  DispatchInfo,
  FeedEvent,
  LlmInfo,
  RunSignal,
  RunTimeline,
  Suppression,
} from './types.js';

const FEED_CAP = 200;

export interface StreamState {
  connectedToStream: boolean;
  agentState: AgentState;
  feed: FeedEvent[];
  counters: Counters;
  connection: Connection;
  llmInfo: LlmInfo;
  run: RunTimeline | null;
  // Every run currently known to the client, keyed by runId. Run-scoped SSE
  // messages (signal / campaign:drafted / approval:request / dispatch /
  // suppressed / decision) are folded into the run they NAME, not into whichever
  // run happens to be displayed. This is what makes button-spam robust: N
  // interleaved runs each accumulate their own signals and campaign snapshot,
  // so every HITL card shows its own scenario instead of collapsing onto the
  // last-started run.
  runs: Record<string, RunTimeline>;
  // Runs that have reached awaiting_approval and are not yet decided. Newest
  // first. Lets the Human-in-the-Loop rail stack multiple approvals, each with
  // its own campaign snapshot, so a fast operator can queue several decisions.
  pendingApprovals: RunTimeline[];
  // A single outstanding budget top-up approval (the bar hit 100%), or null.
  budgetTopUp: BudgetTopUp | null;
  suppressions: Suppression[];
  // A monotonically bumped map of topic-prefix flashes, keyed by match string.
  lastMessageAt: number;
  lastTopic: string;
}

const EMPTY_COUNTERS: Counters = {
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
  budgetCapUsd: 1,
  budgetSpentUsd: 0,
  budgetFillPct: 0,
  budgetExhausted: false,
};

const INITIAL: StreamState = {
  connectedToStream: false,
  agentState: 'disconnected',
  feed: [],
  counters: EMPTY_COUNTERS,
  connection: { connected: false, info: null, brokerKind: null },
  llmInfo: { provider: 'mock', model: 'mock-campaigner' },
  run: null,
  runs: {},
  pendingApprovals: [],
  budgetTopUp: null,
  suppressions: [],
  lastMessageAt: 0,
  lastTopic: '',
};

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function useStream(enabled: boolean, url = '/api/stream'): StreamState {
  const [state, setState] = useState<StreamState>(INITIAL);
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let closed = false;

    const open = () => {
      if (closed) return;
      const es = new EventSource(url, { withCredentials: true });
      esRef.current = es;

      es.onopen = () => {
        setState((s) => ({ ...s, connectedToStream: true }));
      };

      es.onmessage = (e) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        setState((s) => reduce(s, msg));
      };

      es.onerror = () => {
        setState((s) => ({ ...s, connectedToStream: false }));
        es.close();
        esRef.current = null;
        if (closed) return;
        // Reconnect with a short backoff. EventSource also auto-retries, but we
        // recreate it to recover from a fully closed connection.
        retryRef.current = setTimeout(open, 2000);
      };
    };

    open();

    return () => {
      closed = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [enabled, url]);

  return state;
}

function reduce(s: StreamState, msg: Record<string, unknown>): StreamState {
  const type = String(msg.type || '');
  switch (type) {
    case 'hello':
      return {
        ...s,
        agentState: (msg.agentState as AgentState) ?? s.agentState,
        llmInfo: (msg.llmInfo as LlmInfo) ?? s.llmInfo,
      };

    case 'feed:init':
      return { ...s, feed: ((msg.events as FeedEvent[]) ?? []).slice(0, FEED_CAP) };

    case 'feed:event': {
      const ev = msg.event as FeedEvent | undefined;
      if (!ev) return s;
      const feed = [ev, ...s.feed].slice(0, FEED_CAP);
      return { ...s, feed, lastMessageAt: Date.now(), lastTopic: ev.topic };
    }

    case 'counters':
      return { ...s, counters: (msg.counters as Counters) ?? s.counters };

    case 'agent:state':
      return { ...s, agentState: (msg.state as AgentState) ?? s.agentState };

    case 'connection':
      return {
        ...s,
        connection: {
          connected: Boolean(msg.connected),
          info: (msg.info as Connection['info']) ?? null,
          brokerKind: (msg.brokerKind as Connection['brokerKind']) ?? null,
        },
      };

    case 'llm:info':
      return { ...s, llmInfo: (msg.llmInfo as LlmInfo) ?? s.llmInfo };

    // ---- agent run lifecycle ----
    // Every case below resolves the run it names via msg.runId, folds the
    // update into the runs map, and mirrors it into s.run only when the message
    // targets the currently-displayed run. Under button-spam this keeps each
    // run's signals + campaign isolated so no HITL card shows a sibling's data.
    case 'run:started': {
      const runId = String(msg.runId || '');
      const run: RunTimeline = {
        runId,
        sku: msg.sku as string | undefined,
        trigger: msg.trigger,
        signals: [],
        startedAt: Date.now(),
      };
      // The newest-started run becomes the center-panel focus. Cap the map so a
      // long-lived tab that fires many runs stays bounded; pending approvals are
      // preserved because they never fall out of the (separate) pending stack.
      const runs = capRuns({ ...s.runs, [runId]: run }, s.pendingApprovals);
      return { ...s, run, runs };
    }

    case 'run:timeline': {
      // Backend may push a full timeline snapshot; merge it wholesale. This can
      // introduce a run the client has not seen a run:started for, so seed the
      // map directly rather than route through withRun (which ignores unknowns).
      const t = msg.timeline as RunTimeline | undefined;
      if (!t?.runId) return s;
      const merged: RunTimeline = { ...t };
      const runs = { ...s.runs, [t.runId]: merged };
      const run = !s.run || s.run.runId === t.runId ? merged : s.run;
      return { ...s, runs, run };
    }

    case 'signal': {
      const runId = String(msg.runId || '');
      const incoming: RunSignal = {
        name: String(msg.name || ''),
        sourceTag: (msg.sourceTag as RunSignal['sourceTag']) ?? 'REQUESTED',
        status: (msg.status as RunSignal['status']) ?? 'pending',
        data: msg.data,
      };
      return withRun(s, runId, (run) => ({ ...run, signals: upsertSignal(run.signals, incoming) }));
    }

    case 'campaign:drafted': {
      const runId = String(msg.runId || '');
      return withRun(s, runId, (run) => ({
        ...run,
        campaign: msg.campaign as Campaign | undefined,
        llmFallback: Boolean(msg.llmFallback),
        costUsd: typeof msg.costUsd === 'number' ? msg.costUsd : run.costUsd,
        // Record the moment the draft landed so the UI can show how long the
        // agent took from trigger to proposed campaign. Only stamp once.
        draftedAt: run.draftedAt ?? Date.now(),
      }));
    }

    case 'approval:request': {
      const runId = String(msg.runId || '');
      const base = s.runs[runId];
      if (!base) return s;
      const approval: ApprovalRequest = {
        runId,
        topic: String(msg.topic || ''),
        question: String(msg.question || ''),
        campaignId: msg.campaignId as string | undefined,
      };
      const runWithApproval: RunTimeline = { ...base, approval };
      const next = withRun(s, runId, () => runWithApproval);
      // Stack this run onto the pending list (newest first), replacing any
      // stale entry for the same runId so re-requests don't duplicate. The
      // stacked object is the run's OWN snapshot, so each card renders its own
      // campaign even when several requests arrive back to back.
      const pendingApprovals = [
        runWithApproval,
        ...next.pendingApprovals.filter((r) => r.runId !== runId),
      ];
      return { ...next, pendingApprovals };
    }

    case 'approval:decision': {
      const decidedRunId = String(msg.runId || '');
      if (!decidedRunId) return s;
      const decision = msg.decision as 'yes' | 'no';
      // A decision clears this run from the pending stack; the decision note is
      // carried on the run it names.
      const next = withRun(s, decidedRunId, (run) => ({ ...run, decision }));
      const pendingApprovals = next.pendingApprovals.filter((r) => r.runId !== decidedRunId);
      return { ...next, pendingApprovals };
    }

    case 'approval:auto': {
      // Low-value run auto-accepted (no human in the loop). Mark the run so its
      // card reads "Auto-accepted"; the dispatch message follows.
      const runId = String(msg.runId || '');
      return withRun(s, runId, (run) => ({ ...run, autoAccepted: true }));
    }

    case 'dispatch': {
      const runId = String(msg.runId || '');
      const dispatch: DispatchInfo = {
        runId,
        topic: String(msg.topic || ''),
        recipients: num(msg.recipients),
        campaignId: msg.campaignId as string | undefined,
      };
      const auto = Boolean(msg.auto);
      return withRun(s, runId, (run) => ({ ...run, dispatch, autoAccepted: run.autoAccepted || auto }));
    }

    // ---- budget top-up (bar hit 100%) ----
    case 'budget:request': {
      const topUpId = String(msg.runId || '');
      if (!topUpId) return s;
      return { ...s, budgetTopUp: { topUpId, question: String(msg.question || '') } };
    }

    case 'budget:decision':
    case 'budget:toppedup':
      // Either a decision landed or the bar was reset - clear the pending card.
      return { ...s, budgetTopUp: null };

    case 'suppressed': {
      const runId = String(msg.runId || '');
      const reason = String(msg.reason || 'unspecified');
      const suppression: Suppression = { runId, reason, at: Date.now() };
      const next = runId ? withRun(s, runId, (run) => ({ ...run, suppressed: { reason } })) : s;
      // A suppressed run is no longer awaiting a human, so drop it from the
      // pending approvals stack too.
      const pendingApprovals = next.pendingApprovals.filter((r) => r.runId !== runId);
      return {
        ...next,
        pendingApprovals,
        suppressions: [suppression, ...next.suppressions].slice(0, 50),
      };
    }

    default:
      // Unknown types are ignored gracefully.
      return s;
  }
}

/**
 * Fold an update into the run named by runId. The run is updated in the `runs`
 * map, and mirrored into the top-level `run` slot only when it is the currently
 * displayed run - so run-scoped messages for an earlier run never overwrite the
 * center panel's focus, and never leak one run's data onto another's card.
 * Messages naming an unknown run are ignored (the run may have been evicted).
 */
function withRun(
  s: StreamState,
  runId: string,
  update: (run: RunTimeline) => RunTimeline,
): StreamState {
  if (!runId) return s;
  const existing = s.runs[runId];
  if (!existing) return s;
  const updated = update(existing);
  const runs = { ...s.runs, [runId]: updated };
  const run = s.run?.runId === runId ? updated : s.run;
  return { ...s, runs, run };
}

const RUNS_CAP = 50;

// Suppression reasons that still earn a standing card in the Human-in-the-Loop
// rail (kept in sync with OutcomeRail.RAIL_SUPPRESSIONS). Runs suppressed for
// these reasons must survive eviction so their "Agent held" card persists.
const RAIL_SUPPRESSIONS = new Set(['agent_recommended_hold', 'consent_violation_blocked']);

/**
 * A run is "rail-worthy" if the Human-in-the-Loop rail shows a card for it:
 * anything awaiting a decision, anything already decided/dispatched, and held /
 * consent-blocked runs. These must never be evicted out from under their card,
 * even after a long burst of newer runs - the rail is a durable audit trail.
 */
function isRailWorthy(r: RunTimeline): boolean {
  // A human decision is terminal and keeps the card regardless of a trailing
  // suppression (e.g. `human_rejected` after a "no").
  if (r.decision || r.dispatch) return true;
  if (r.suppressed) return RAIL_SUPPRESSIONS.has(r.suppressed.reason);
  return Boolean(r.approval);
}

/**
 * Bound the runs map on a long-lived tab. Keeps the most recently started runs
 * (Map preserves insertion order), any run still in the pending-approval stack,
 * and every rail-worthy run (awaiting / decided / held) so a card the operator
 * can still see is never evicted from under it.
 */
function capRuns(
  runs: Record<string, RunTimeline>,
  pending: RunTimeline[],
): Record<string, RunTimeline> {
  const ids = Object.keys(runs);
  if (ids.length <= RUNS_CAP) return runs;
  const keep = new Set(ids.slice(ids.length - RUNS_CAP));
  for (const r of pending) keep.add(r.runId);
  for (const id of ids) if (isRailWorthy(runs[id])) keep.add(id);
  const next: Record<string, RunTimeline> = {};
  for (const id of ids) if (keep.has(id)) next[id] = runs[id];
  return next;
}

function upsertSignal(signals: RunSignal[], incoming: RunSignal): RunSignal[] {
  const idx = signals.findIndex((x) => x.name === incoming.name);
  if (idx === -1) return [...signals, incoming];
  const next = signals.slice();
  next[idx] = { ...next[idx], ...incoming };
  return next;
}

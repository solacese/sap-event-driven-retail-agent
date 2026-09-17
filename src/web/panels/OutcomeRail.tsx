// ---------------------------------------------------------------------------
// Right rail "Human in the Loop": a durable ledger of every run that reached a
// rail-worthy state, newest first. Each run keeps its own card for the life of
// the session - a card never vanishes when its run is decided or held. Cards
// come in three flavours:
//   • awaiting  - has an approval, not yet decided: shows the campaign + Yes/No.
//   • resolved  - approved / dispatched / rejected: same campaign, decision
//                 badge, no buttons (the audit trail).
//   • held      - the agent declined to escalate (agent_recommended_hold or
//                 consent_violation_blocked): an "Agent held" card, no buttons.
// Runs suppressed for mesh-plumbing reasons (superseded, below_threshold) are
// NOT laddered here - they belong to the mesh feed, not the human queue.
//
// Spamming N distinct scenarios therefore always leaves N cards standing, each
// showing its own scenario, so nothing the agent worked on silently disappears.
//
// Human-in-the-loop note: the Yes/No buttons POST to the backend, which
// publishes a decision EVENT onto the mesh. The agent reacts to that event, not
// to the HTTP call. This is the SAP human-in-the-loop pattern.
// ---------------------------------------------------------------------------
import { useState } from 'react';
import { api } from '../lib/api.js';
import type { BudgetTopUp, Campaign, RunTimeline } from '../lib/types.js';

interface Props {
  run: RunTimeline | null;
  runs: Record<string, RunTimeline>;
  budgetTopUp: BudgetTopUp | null;
}

// Suppression reasons that still deserve a standing card in the human rail: the
// agent made a judgement call (held / consent-blocked) the operator should see.
// Everything else (superseded, below_threshold) is mesh plumbing and stays out.
const RAIL_SUPPRESSIONS = new Set(['agent_recommended_hold', 'consent_violation_blocked']);

type CardKind = 'awaiting' | 'resolved' | 'held';

function cardKind(r: RunTimeline): CardKind | null {
  // A human decision is terminal and wins over any trailing suppression. The
  // backend emits a `human_rejected` suppression right after a "no" decision;
  // that must still read as a resolved (rejected) card, not vanish.
  if (r.decision || r.dispatch) return 'resolved';
  // Held / consent-blocked: the agent declined to escalate. Show as a distinct
  // card even though it never produced an approval request.
  if (r.suppressed) {
    return RAIL_SUPPRESSIONS.has(r.suppressed.reason) ? 'held' : null;
  }
  // Awaiting a human decision.
  if (r.approval) return 'awaiting';
  return null;
}

export function OutcomeRail({ run, runs, budgetTopUp }: Props) {
  const awaitingCampaign = run && !run.campaign && !run.suppressed && !run.approval;
  const draftLatencyMs =
    run?.draftedAt != null ? Math.max(0, run.draftedAt - run.startedAt) : null;

  // The ledger: every rail-worthy run, newest first. Kept for the session so a
  // decided or held card never disappears.
  const cards = Object.values(runs)
    .map((r) => ({ run: r, kind: cardKind(r) }))
    .filter((c): c is { run: RunTimeline; kind: CardKind } => c.kind !== null)
    .sort((a, b) => b.run.startedAt - a.run.startedAt);

  const awaitingCount = cards.filter((c) => c.kind === 'awaiting').length;
  const hasCards = cards.length > 0;
  const hasContent = hasCards || Boolean(budgetTopUp);

  return (
    <section className="panel">
      <div className="panel-title-row">
        <h2>Human in the Loop</h2>
        {awaitingCount > 0 && (
          <span className="latency-badge mono" title="Runs awaiting your decision.">
            {awaitingCount} awaiting
          </span>
        )}
        {awaitingCount === 0 && draftLatencyMs != null && (
          <span
            className="latency-badge mono"
            title="Wall-clock time from the trigger event to the proposed campaign (single LLM call)."
          >
            trigger → draft {formatLatency(draftLatencyMs)}
          </span>
        )}
      </div>

      <div className="panel-scroll">
        {/* Budget top-up: a distinct human-in-the-loop card raised when the
            operating budget bar reaches 100%. Approving resets the bar. */}
        {budgetTopUp && <BudgetTopUpCard topUp={budgetTopUp} />}

        {!hasContent && !run && (
          <p className="rail-hint">
            No active run. Trigger a scenario to watch the agent correlate context from SAP S/4HANA
            and draft a campaign.
          </p>
        )}

        {!hasContent && awaitingCampaign && (
          <p className="rail-hint">
            The agent is correlating context and drafting a campaign. The draft and approval
            controls appear here.
          </p>
        )}

        {/* The ledger. The newest awaiting card opens by default so a fast
            operator lands on the decision that needs them; everything else
            collapses to a one-line summary they can toggle open. */}
        {hasCards && (
          <div className="approval-stack">
            {cards.map((c, i) => (
              <RunCard
                key={c.run.runId}
                run={c.run}
                kind={c.kind}
                defaultOpen={i === 0 && c.kind === 'awaiting'}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// A single collapsible card. The header always shows the scenario + a status
// chip; the body shows the campaign and - only while awaiting - the Yes/No
// controls. Resolved and held cards keep the campaign for the audit trail but
// drop the buttons.
function RunCard({
  run,
  kind,
  defaultOpen,
}: {
  run: RunTimeline;
  kind: CardKind;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const campaign = run.campaign;
  const title = campaign?.headline ?? `Run ${run.runId.slice(0, 8)}`;

  return (
    <div className={`approval-card approval-card--${kind}${open ? ' open' : ''}`}>
      <button
        className="approval-card-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`caret${open ? ' open' : ''}`} aria-hidden>
          ▸
        </span>
        <span className="approval-card-title">{title}</span>
        {run.sku && <span className="chip mono">SKU {run.sku}</span>}
        <StatusChip run={run} kind={kind} />
      </button>

      {open && (
        <div className="approval-card-body">
          {campaign && (
            <CampaignCard campaign={campaign} llmFallback={run.llmFallback} costUsd={run.costUsd} />
          )}
          {kind === 'awaiting' && <ApprovalBlock run={run} />}
          {kind === 'held' && <HeldBlock run={run} />}
          {kind === 'resolved' && <ResolvedBlock run={run} />}
        </div>
      )}
    </div>
  );
}

// The one-word status chip in every card header. Resolved cards distinguish
// dispatched / approved / rejected so the audit trail reads at a glance.
function StatusChip({ run, kind }: { run: RunTimeline; kind: CardKind }) {
  if (kind === 'awaiting') return <span className="chip gold">Approval</span>;
  if (kind === 'held') return <span className="chip orange">Agent held</span>;
  if (run.autoAccepted) return <span className="chip green">Auto-accepted</span>;
  if (run.dispatch) return <span className="chip green">Dispatched</span>;
  if (run.decision === 'yes') return <span className="chip green">Approved</span>;
  return <span className="chip">Rejected</span>;
}

// Held / consent-blocked: the agent chose not to escalate. No buttons - this is
// a terminal outcome, shown so the operator can see the agent's reasoning.
function HeldBlock({ run }: { run: RunTimeline }) {
  const reason = run.suppressed?.reason ?? 'agent_recommended_hold';
  const label =
    reason === 'consent_violation_blocked'
      ? 'The agent blocked this campaign: no consented audience remained.'
      : 'The agent held this campaign rather than escalate it for approval.';
  return (
    <div className="result-card result-card--warning approval-block">
      <h3>Agent Held</h3>
      <p className="prose">
        {label} Reason: <span className="mono">{reason}</span>. Nothing was sent to customers.
      </p>
    </div>
  );
}

// Resolved: approved / dispatched / rejected. The decision is preserved as an
// audit row; no further action is possible.
function ResolvedBlock({ run }: { run: RunTimeline }) {
  if (run.dispatch) {
    return (
      <div className="result-card result-card--success approval-block">
        <h3>{run.autoAccepted ? 'Auto-Accepted & Dispatched' : 'Campaign Dispatched'}</h3>
        <span className="topic">{run.dispatch.topic}</span>
        <p className="prose">
          {run.autoAccepted && (
            <>
              Revenue protected was under the €2,000 auto-accept threshold, so no human approval was
              required.{' '}
            </>
          )}
          Sent to <strong>{run.dispatch.recipients}</strong> consented recipients via SAP Emarsys.
        </p>
      </div>
    );
  }
  if (run.decision === 'yes') {
    return (
      <div className="result-card result-card--success approval-block">
        <h3>Approved</h3>
        <p className="prose">
          Approval published to the mesh: <span className="mono">yes</span>. Awaiting dispatch
          event.
        </p>
      </div>
    );
  }
  return (
    <div className="result-card result-card--warning approval-block">
      <h3>Rejected</h3>
      <p className="prose">
        Decision published to the mesh: <span className="mono">no</span>. Nothing was sent to
        customers.
      </p>
    </div>
  );
}

function CampaignCard({
  campaign,
  llmFallback,
  costUsd,
}: {
  campaign: Campaign;
  llmFallback?: boolean;
  costUsd?: number;
}) {
  const confidence = Math.round((campaign.confidence ?? 0) * 100);
  return (
    <div className="result-card result-card--gold campaign-card">
      <div className="headline">{campaign.headline}</div>
      <div className="body-copy">{campaign.body}</div>

      <div className="btn-row">
        <span className="chip mono">
          {campaign.offer?.type}: {campaign.offer?.value}
        </span>
        <span className="chip mono">{campaign.channel}</span>
        {typeof costUsd === 'number' && (
          <span className="chip mono" title="Estimated LLM cost to produce this campaign">
            {formatCost(costUsd)}
          </span>
        )}
        {llmFallback && <span className="chip orange">LLM Fallback</span>}
      </div>

      <div className="metric-grid">
        <Metric label="Audience" value={`${campaign.audience?.size ?? 0}`} source="SAP CDP" />
        <Metric label="Consent Basis" value={campaign.audience?.consentBasis ?? 'n/a'} source="SAP CDP" />
        <Metric label="Target Stores" value={`${campaign.targetStores?.length ?? 0}`} source="S/4HANA" />
        <Metric label="Expected Units Moved" value={`${campaign.expectedUnitsMoved ?? 0}`} />
        <Metric label="Waste Avoided" value={`${campaign.wasteAvoidedUnits ?? 0} units`} source="S/4HANA" />
        <Metric
          label="Revenue Protected"
          value={`${(campaign.revenueProtectedEur ?? 0).toFixed(2)} EUR`}
          source="S/4HANA"
        />
      </div>

      <div className="confidence">
        <div className="confidence-head">
          <span className="confidence-label">Confidence</span>
          <span className="mono">{confidence}%</span>
        </div>
        <div className="bar">
          <div className="fill" style={{ width: `${confidence}%` }} />
        </div>
      </div>

      {campaign.rationale?.length > 0 && (
        <>
          <div className="section-title">Rationale</div>
          <ul className="rationale">
            {campaign.rationale.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </>
      )}

      <div className="btn-row signals-row">
        {(campaign.signalsUsed ?? []).map((s) => (
          <span key={`u-${s}`} className="chip green">
            {prettySignal(s)}
          </span>
        ))}
        {(campaign.signalsUnavailable ?? []).map((s) => (
          <span key={`n-${s}`} className="chip orange">
            {prettySignal(s)} missing
          </span>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value, source }: { label: string; value: string; source?: string }) {
  return (
    <div className="metric">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {source && <div className="metric-source">{source}</div>}
    </div>
  );
}

function ApprovalBlock({ run }: { run: RunTimeline }) {
  const [busy, setBusy] = useState(false);
  const approval = run.approval!;

  const decide = async (decision: 'yes' | 'no') => {
    setBusy(true);
    try {
      await api.approval(run.runId, decision);
    } catch {
      // The decision event flows over the mesh; a failed HTTP call is surfaced
      // by the absence of a decision row, so no destructive fallback here.
    } finally {
      setBusy(false);
    }
  };

  const tip =
    'Yes or No publishes a decision event to the mesh. The agent reacts to the event, not this HTTP call (SAP human-in-the-loop pattern).';

  return (
    <div className="result-card result-card--gold approval-block">
      <h3>Human Approval Required</h3>
      <span className="topic">{approval.topic}</span>
      <p className="prose">{approval.question}</p>
      <div className="approval-buttons">
        <span className="tooltip">
          <button className="btn big yes" onClick={() => decide('yes')} disabled={busy}>
            Yes
          </button>
          <span className="tip" role="tooltip">
            {tip}
          </span>
        </span>
        <span className="tooltip">
          <button className="btn big no" onClick={() => decide('no')} disabled={busy}>
            No
          </button>
          <span className="tip" role="tooltip">
            {tip}
          </span>
        </span>
      </div>
    </div>
  );
}


// The budget top-up card: a distinct human-in-the-loop gate that appears when
// the $1 operating budget is spent. Approving resets the bar and resumes any
// runs held while it was exhausted.
function BudgetTopUpCard({ topUp }: { topUp: BudgetTopUp }) {
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'yes' | 'no') => {
    setBusy(true);
    try {
      await api.budgetTopUp(topUp.topUpId, decision);
    } catch {
      // Surfaced by the card staying/leaving; no destructive fallback.
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="approval-card approval-card--awaiting open budget-topup-card">
      <div className="approval-card-head" style={{ cursor: 'default' }}>
        <span className="approval-card-title">Operating budget reached</span>
        <span className="chip gold">Top-up</span>
      </div>
      <div className="approval-card-body">
        <div className="result-card result-card--gold approval-block">
          <h3>Budget Top-Up Required</h3>
          <p className="prose">{topUp.question}</p>
          <div className="approval-buttons">
            <button className="btn big yes" onClick={() => decide('yes')} disabled={busy}>
              Approve top-up
            </button>
            <button className="btn big no" onClick={() => decide('no')} disabled={busy}>
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatCost(usd: number): string {
  if (usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return `${s.toFixed(s < 10 ? 1 : 0)} s`;
}

function prettySignal(name: string): string {
  const map: Record<string, string> = {
    weather: 'Weather',
    news: 'News',
    inventory: 'Inventory',
    customer_interest: 'Customer Interest',
    price: 'Price',
  };
  return map[name] ?? name;
}

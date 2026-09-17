// ---------------------------------------------------------------------------
// CostMeter: a compact live strip of the agent's operational counters. These
// are computed and broadcast by the server on every run (SSE {type:'counters'})
// but were previously never rendered. It surfaces the cost story of the demo:
// LLM calls, tokens, estimated USD spend, tool calls, and run latency.
// ---------------------------------------------------------------------------
import type { Counters, LlmInfo } from '../lib/types.js';
import { LLM_MODELS } from '../lib/api.js';

interface CostMeterProps {
  counters: Counters;
  llmInfo: LlmInfo;
  // Selected agent LLM + change handler. The picker lives here, in the budget
  // bar, so the model choice sits with the cost story it drives.
  model: string;
  onModelChange: (value: string) => void;
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

// Cost is small per run; show enough precision to be non-zero yet readable.
function fmtCost(usd: number): string {
  if (usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function fmtLatency(ms: number): string {
  if (ms <= 0) return '-';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function CostMeter({ counters, llmInfo, model, onModelChange }: CostMeterProps) {
  const c = counters;
  const totalTokens = c.tokensIn + c.tokensOut;
  // Only meaningful once a run has completed; until then show "-" rather than a
  // "$0.00" that reads as a contradiction next to a non-zero session cost.
  const avgCost = c.runsCompleted > 0 ? fmtCost(c.estCostUsd / c.runsCompleted) : '-';
  const fill = Math.max(0, Math.min(100, c.budgetFillPct));

  return (
    <div className="cost-meter" role="group" aria-label="Agent cost and activity">
      <Stat label="Est. cost" value={fmtCost(c.estCostUsd)} primary title="Estimated LLM spend this session" />
      <Stat label="Cost / run" value={avgCost} title="Average estimated cost per completed run" />
      <Stat label="LLM calls" value={fmtInt(c.llmCalls)} title="Model completions this session" />
      <Stat
        label="Tokens"
        value={fmtInt(totalTokens)}
        title={`${fmtInt(c.tokensIn)} in / ${fmtInt(c.tokensOut)} out`}
      />
      <Stat label="Tool calls" value={fmtInt(c.toolCalls)} title="Mesh signal requests" />
      <Stat label="Runs" value={fmtInt(c.runsCompleted)} title="Completed agent runs" />
      <Stat label="Avg latency" value={fmtLatency(c.avgRunLatencyMs)} title="Mean trigger→outcome time" />

      {/* Budget bar: a $1 operating budget that fills as the agent runs. At
          100% a human-in-the-loop top-up appears in the right rail. */}
      <span
        className={`cost-budget${c.budgetExhausted ? ' cost-budget--full' : ''}`}
        title={`Operating budget: ${fmtCost(c.budgetSpentUsd)} of ${fmtCost(c.budgetCapUsd)} used (${fill}%)`}
      >
        <span className="cost-budget-head">
          <span className="cost-stat-label">Budget</span>
          <span className="cost-budget-pct">{fill}%</span>
        </span>
        <span className="cost-budget-track" role="progressbar" aria-valuenow={fill} aria-valuemin={0} aria-valuemax={100}>
          <span className="cost-budget-fill" style={{ width: `${fill}%` }} />
        </span>
      </span>

      <label
        className="cost-meter-model llm-picker"
        title={`Choose the model the agent reasons with · active: ${llmInfo.model} via SAP AI Core (provider ${llmInfo.provider})`}
      >
        <span className="llm-picker-label">Agent LLM</span>
        <select value={model} onChange={(e) => onModelChange(e.target.value)} aria-label="Agent LLM">
          {LLM_MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label} ({m.hint})
            </option>
          ))}
        </select>
        <span className="cost-meter-access"> via SAP AI Core</span>
      </label>
    </div>
  );
}

function Stat({
  label,
  value,
  title,
  primary,
}: {
  label: string;
  value: string;
  title?: string;
  primary?: boolean;
}) {
  return (
    <span className={`cost-stat${primary ? ' cost-stat--primary' : ''}`} title={title}>
      <span className="cost-stat-value">{value}</span>
      <span className="cost-stat-label">{label}</span>
    </span>
  );
}

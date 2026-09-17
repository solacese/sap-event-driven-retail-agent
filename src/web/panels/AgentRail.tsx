// ---------------------------------------------------------------------------
// Left rail "The agent": the avatar (its animation is driven by the current
// agent state, so the bot visibly reacts as events flow through the mesh) plus
// a simple list of the topic families it subscribes to.
//
// Idle liveliness: while the agent is at rest its *gaze follows the cursor*
// continuously (not in discrete steps) until the user first interacts with the
// page. We render a dedicated `ContinuousGazeAvatar` for the resting state: it
// reuses the upstream *core* rendering primitives but drives the head + pupils
// per frame from a cursor-derived target with its own spring, so tracking is
// smooth rather than snapping between a handful of compass poses. Once a run
// starts (a non-resting state) we switch to the controlled upstream `Avatar`
// so the state-driven animation (thinking, excited, ...) owns the presentation.
// Gaze stops for good on the first click / keypress and is skipped under
// reduced-motion (handled inside ContinuousGazeAvatar).
// ---------------------------------------------------------------------------
import { Avatar, animationForState } from '../avatar/Avatar.js';
import { ContinuousGazeAvatar } from '../avatar/ContinuousGazeAvatar.js';
import type { AvatarDefinition } from '../avatar/Avatar.js';
import type { AgentState, RunSignal, RunTimeline } from '../lib/types.js';
import { TOPIC_PREFIXES } from '../lib/topics.js';
import { type LlmModel } from '../lib/api.js';

// Fluid avatar size: shrinks with the viewport (never below 150px, never above
// 260px) and, crucially, is bounded by the rail column's own width via the
// vw term, so it scales down on narrow browsers instead of overflowing.
const AVATAR_SIZE = 'clamp(150px, 18vw, 260px)';

interface Props {
  agentState: AgentState;
  avatar: AvatarDefinition | null;
  run: RunTimeline | null;
  // The selected agent LLM (owned by the dashboard; the picker now lives in the
  // budget bar). Used here only to tint the avatar to the model's palette.
  model: LlmModel;
}

// Signals the agent correlates for every run, in display order.
const EXPECTED_SIGNALS = ['weather', 'news', 'inventory', 'customer_interest'];

// States where the bot is "at rest" and free to watch the cursor. Once a run
// is triggered the state-driven animation should own the presentation.
const RESTING: ReadonlySet<AgentState> = new Set<AgentState>(['idle', 'disconnected', 'connecting']);

// Recolor an avatar definition to a model's palette without touching geometry,
// expressions or animations. Returns an immutable copy so React sees a new
// reference and both avatar renderers re-render on model change.
function themeAvatar(def: AvatarDefinition, palette: LlmModel['palette']): AvatarDefinition {
  const base = def as unknown as { colors?: Record<string, unknown> };
  return {
    ...(def as object),
    colors: { ...(base.colors ?? {}), body: palette.body, eyes: palette.eyes },
  } as AvatarDefinition;
}

export function AgentRail({ agentState, avatar, run, model }: Props) {
  const resting = RESTING.has(agentState);
  const themed = avatar ? themeAvatar(avatar, model.palette) : null;

  return (
    <section className="panel">
      <div className="panel-title-row">
        <h2>The Agent</h2>
      </div>

      <div className="panel-scroll">
        <div className={`agent-avatar${resting ? ' gazing' : ''}`}>
          {themed ? (
            resting ? (
              // Continuous cursor-tracking gaze (smooth, per-frame).
              <ContinuousGazeAvatar
                definition={themed}
                ariaLabel="Retail Pricer Bot avatar, watching"
                size={AVATAR_SIZE}
              />
            ) : (
              // Controlled: the state-driven animation owns the presentation.
              <Avatar
                definition={themed}
                animationName={animationForState(agentState)}
                size={AVATAR_SIZE}
              />
            )
          ) : (
            <div style={{ color: 'var(--text-dim)' }}>Loading avatar…</div>
          )}
        </div>

        {run && <RunTimelineView run={run} />}

        <SubscriptionsBlock />
      </div>
    </section>
  );
}

// The bottom-left panel below the agent. Two equal-width groups that tell the
// event-driven story side by side:
//   • Listens ambiently - the context the agent continuously subscribes to and
//     caches (weather, news, inventory, consent). Streams in on its own; never
//     starts a run.
//   • Acts with - the events the agent acts on: a price update pulls the trigger
//     (a run starts) and the agent emits a campaign in response.
// Rendering them as two equal columns makes "listens vs. acts" read at a glance.
const ACTS_KEYS = new Set(['price', 'marketing']);
const CACHED_CONTEXT_KEYS = new Set(['weather', 'news', 'inventory', 'consent']);
const ACT_TAG: Record<string, string> = { price: 'trigger', marketing: 'emits' };
const ACT_LABEL: Record<string, string> = { marketing: 'Campaign' };

function SubscriptionsBlock() {
  const acts = TOPIC_PREFIXES.filter((p) => ACTS_KEYS.has(p.key));
  const cached = TOPIC_PREFIXES.filter((p) => CACHED_CONTEXT_KEYS.has(p.key));

  return (
    <div className="subscriptions">
      <div className="sub-group sub-group--cached">
        <div className="subscriptions-title">Listens ambiently</div>
        <p className="sub-group-note">
          Context streamed continuously and cached in <strong>SAP HANA DB</strong> via{' '}
          <strong>SAP Business Data Cloud</strong>. Never starts a run.
        </p>
        <ul className="subscription-list">
          {cached.map((p) => (
            <li key={p.key} className="sub-chip sub-chip--cached">
              {p.label}
              <span className="sub-chip-tag">cached</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="sub-group sub-group--trigger">
        <div className="subscriptions-title">Acts with</div>
        <p className="sub-group-note">A price change starts a run; the agent emits a campaign.</p>
        <ul className="subscription-list">
          {acts.map((p) => (
            <li key={p.key} className="sub-chip sub-chip--trigger">
              {ACT_LABEL[p.key] ?? p.label}
              <span className="sub-chip-tag">{ACT_TAG[p.key] ?? 'acts'}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// The current run as a vertical timeline: trigger, the four correlated signals
// (each tagged CACHED/REQUESTED and pending/resolved/unavailable), reasoning,
// and draft. Rendered under the Agent so the bot's work reads top-to-bottom on
// the left, leaving the right rail for the human-in-the-loop decision.
function RunTimelineView({ run }: { run: RunTimeline }) {
  const byName = new Map(run.signals.map((s) => [s.name, s]));
  return (
    <>
      <div className="subscriptions-title" style={{ marginTop: 4 }}>
        This run
      </div>
      <ul className="timeline">
        <li className="done">
          <div className="row-label">
            <strong>Trigger</strong>
            {run.sku && <span className="chip mono">SKU {run.sku}</span>}
          </div>
        </li>
        {EXPECTED_SIGNALS.map((name) => (
          <SignalRow key={name} name={name} signal={byName.get(name)} />
        ))}
        <li className={run.campaign ? 'done' : 'pending'}>
          <div className="row-label">
            <strong>Reasoning</strong>
            {run.campaign ? (
              <span className="chip green">Complete</span>
            ) : (
              <span className="chip sky">In progress</span>
            )}
          </div>
        </li>
        <li className={run.campaign ? 'done' : 'pending'}>
          <div className="row-label">
            <strong>Draft</strong>
            {run.llmFallback && <span className="chip orange">Template Fallback</span>}
          </div>
        </li>
      </ul>
    </>
  );
}

function SignalRow({ name, signal }: { name: string; signal?: RunSignal }) {
  const status = signal?.status ?? 'pending';
  const cls = status === 'resolved' ? 'done' : status === 'unavailable' ? 'unavailable' : 'pending';
  const source = signalSource(name);
  return (
    <li className={cls}>
      <div className="row-label">
        <strong>{prettySignal(name)}</strong>
        {signal?.sourceTag && (
          <span className={`chip ${signal.sourceTag === 'CACHED' ? 'sky' : 'outline'}`}>
            {signal.sourceTag}
          </span>
        )}
        {status === 'unavailable' && <span className="chip orange">Unavailable</span>}
        {status === 'pending' && <span className="chip dim">Pending</span>}
        {status === 'resolved' && <span className="chip green">Resolved</span>}
      </div>
      {source && <div className="signal-source">{source}</div>}
    </li>
  );
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

// System of record behind each signal. Grounds every context signal the agent
// correlates in a concrete SAP (or external) source.
function signalSource(name: string): string | null {
  const map: Record<string, string> = {
    price: 'SAP S/4HANA · Pricing',
    inventory: 'SAP S/4HANA · Inventory',
    customer_interest: 'SAP Customer Data Platform',
    weather: 'External weather API',
    news: 'External news API',
  };
  return map[name] ?? null;
}

// ---------------------------------------------------------------------------
// SwipePage: the mobile-first Human-in-the-Loop surface at /swipe. Public (no
// login). It subscribes to the same live mesh feed as the desktop dashboard
// (via /api/swipe/stream) and presents each pending approval as a single
// focused campaign panel - styled like the desktop campaign card, not a
// dark Tinder deck. One decision at a time:
//   • swipe RIGHT / →  → approve  (publishes a "yes" decision EVENT to the mesh)
//   • swipe LEFT  / ←  → reject   (publishes a "no"  decision EVENT to the mesh)
// The agent reacts to the decision EVENT, not to the HTTP call - the same SAP
// human-in-the-loop pattern the desktop uses. Decisions are scored on speed to
// make triage a game; "Deal a round" fires the four hero scenarios so a solo
// player always has a full queue.
//
// Decision lifecycle: a swipe optimistically removes the panel AND fires the
// decision; the run then leaves `pendingApprovals` when its decision event
// arrives, so the queue stays consistent even if two clients decide at once.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useStream } from '../lib/useStream.js';
import type { Campaign, RunTimeline } from '../lib/types.js';
import { makeDeck, isLocalRunId, isBlunderRunId } from './swipeDeck.js';
import '../styles/swipe.css';

const MAX_QUEUE = 8;
const DECISION_WINDOW_MS = 20000; // 20s per card, behind the speed bonus.
const SWIPE_COMMIT_PX = 110; // horizontal travel that commits a swipe.

interface ScoreState {
  total: number;
  decided: number;
  streak: number;
  lastPoints: number;
  lastLabel: string;
}

const ZERO_SCORE: ScoreState = { total: 0, decided: 0, streak: 0, lastPoints: 0, lastLabel: '' };

export function SwipePage() {
  // Dealing mode is per-player and fully local. While playing we STOP
  // subscribing to the shared mesh (useStream disabled) and play through a
  // self-contained 8-card deck, so any number of people can play their own game
  // at the same time without a shared server queue. Outside a game we keep a
  // live subscription so desktop-triggered scenarios still stream in here.
  const [playing, setPlaying] = useState(false);
  const [deck, setDeck] = useState<RunTimeline[]>([]);
  const stream = useStream(!playing, '/api/swipe/stream');

  // Runs we've already acted on locally, so a decided panel leaves immediately
  // and never reappears if the decision event lags. Bounded set.
  const [actedOn, setActedOn] = useState<Set<string>>(() => new Set());
  const markActed = useCallback((runId: string) => {
    setActedOn((prev) => {
      const next = new Set(prev);
      next.add(runId);
      if (next.size > 200) {
        const first = next.values().next().value;
        if (first) next.delete(first);
      }
      return next;
    });
  }, []);

  // The queue in focus. In dealing mode it is the local deck; otherwise it is
  // the live pending approvals from the mesh. Either way, index 0 is the panel
  // currently in focus and decided cards drop out via actedOn.
  const queue = useMemo(() => {
    const source = playing ? deck : stream.pendingApprovals;
    return source.filter((r) => !actedOn.has(r.runId)).slice(0, MAX_QUEUE);
  }, [playing, deck, stream.pendingApprovals, actedOn]);

  const [score, setScore] = useState<ScoreState>(ZERO_SCORE);
  const [summaryShown, setSummaryShown] = useState(false);
  const hadItemsRef = useRef(false);

  useEffect(() => {
    if (queue.length > 0) {
      hadItemsRef.current = true;
      if (summaryShown) setSummaryShown(false);
    } else if (hadItemsRef.current && score.decided > 0) {
      // The deck (or shared queue) has been cleared: show the round summary and,
      // if we were in dealing mode, leave it - re-subscribing to the mesh so
      // desktop-triggered scenarios stream in again between games.
      setSummaryShown(true);
      hadItemsRef.current = false;
      if (playing) setPlaying(false);
    }
  }, [queue.length, score.decided, summaryShown, playing]);

  // The item in focus; its arrival time drives the countdown/bonus.
  const topRunId = queue.length ? queue[0].runId : null;
  const dealtAtRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const map = dealtAtRef.current;
    for (const r of queue) if (!map.has(r.runId)) map.set(r.runId, Date.now());
  }, [queue]);

  const scoreDecision = useCallback((runId: string, decision: 'yes' | 'no') => {
    const dealtAt = dealtAtRef.current.get(runId) ?? Date.now();
    const elapsed = Date.now() - dealtAt;
    // The right call: approve a genuine campaign, reject a blunder. Rejecting a
    // good campaign is a miss - it earns nothing.
    const isBlunder = isBlunderRunId(runId);
    const correct = isBlunder ? decision === 'no' : decision === 'yes';
    setScore((s) => {
      // Rejecting a good campaign scores 0: no base, no speed bonus, streak breaks.
      if (!correct) {
        return {
          total: s.total,
          decided: s.decided + 1,
          streak: 0,
          lastPoints: 0,
          lastLabel: isBlunder ? 'Approved a bad one - 0' : 'Rejected a good one - 0',
        };
      }
      // The first decision of the session is untimed: no clock, no speed tiers,
      // just a flat base so newcomers can read the card at their own pace.
      const firstCard = s.decided === 0;
      let points = 100;
      let label = 'Nailed it';
      if (firstCard) {
        label = 'First one - no rush';
      } else if (elapsed <= 5000) {
        points += 150;
        label = 'Lightning! +150 speed';
      } else if (elapsed <= 10000) {
        points += 100;
        label = 'Fast! +100 speed';
      } else if (elapsed <= 16000) {
        points += 50;
        label = 'Quick +50 speed';
      }
      const streak = !firstCard && elapsed <= 10000 ? s.streak + 1 : firstCard ? s.streak : 0;
      const multiplier = streak >= 3 ? 1.5 : 1;
      const gained = Math.round(points * multiplier);
      return {
        total: s.total + gained,
        decided: s.decided + 1,
        streak,
        lastPoints: gained,
        lastLabel: multiplier > 1 ? `${label} · x1.5 streak` : label,
      };
    });
    // Local deck cards (dealing mode) are client-only - never touch the mesh.
    // Only live approvals from the shared stream publish a decision.
    if (!isLocalRunId(runId)) {
      void api.swipeApproval(runId, decision).catch(() => undefined);
    }
  }, []);

  const decide = useCallback(
    (runId: string, decision: 'yes' | 'no') => {
      if (actedOn.has(runId)) return;
      markActed(runId);
      scoreDecision(runId, decision);
    },
    [actedOn, markActed, scoreDecision],
  );

  // Enter dealing mode: build a fresh, self-contained 8-card deck locally and
  // stop subscribing to the mesh. No server calls - every player gets their own
  // game. A fresh score and clean dealt-clock make each round independent.
  const dealRound = useCallback(() => {
    const nonce = Date.now();
    dealtAtRef.current.clear();
    setActedOn(new Set());
    setScore(ZERO_SCORE);
    setSummaryShown(false);
    setDeck(makeDeck(nonce));
    setPlaying(true);
  }, []);

  // Keyboard: ← reject focused item, → approve focused item.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!topRunId) return;
      if (e.key === 'ArrowRight') decide(topRunId, 'yes');
      else if (e.key === 'ArrowLeft') decide(topRunId, 'no');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [topRunId, decide]);

  const connected = stream.connection.connected || stream.connectedToStream;
  const topRun = queue.length ? queue[0] : null;

  return (
    <div className="swipe-app">
      <header className="swipe-header">
        <span className="swipe-wordmark">
          Solace + SAP + AI = <strong>Retail Pricer Bot</strong>
        </span>
        <Scoreboard score={score} />
      </header>

      <div className="swipe-subhead">
        <div className="swipe-subhead-title">
          <h2>Approve pricing moves</h2>
          <span className="swipe-hint">Swipe → approve · ← reject</span>
        </div>
        {queue.length > 0 && (
          <span className="swipe-queue-count">
            {queue.length} awaiting
          </span>
        )}
      </div>

      <main className="swipe-stage">
        {topRun ? (
          <ApprovalPanel
            key={topRun.runId}
            run={topRun}
            // First decision of the session: no clock (untimed).
            countdownMs={score.decided === 0 ? null : DECISION_WINDOW_MS}
            dealtAt={dealtAtRef.current.get(topRun.runId) ?? Date.now()}
            onDecide={(decision) => decide(topRun.runId, decision)}
          />
        ) : (
          <EmptyState
            connected={connected}
            playing={playing}
            onDeal={dealRound}
            summary={summaryShown ? score : null}
          />
        )}
      </main>

      <footer className="swipe-footer">
        <button
          className="btn big no swipe-action"
          disabled={!topRunId}
          onClick={() => topRunId && decide(topRunId, 'no')}
        >
          ✕ Reject
        </button>
        <button className="btn swipe-deal" onClick={dealRound}>
          {playing && queue.length ? `Restart (${queue.length} left)` : 'Deal a round'}
        </button>
        <button
          className="btn big yes swipe-action"
          disabled={!topRunId}
          onClick={() => topRunId && decide(topRunId, 'yes')}
        >
          ♥ Approve
        </button>
      </footer>
    </div>
  );
}

function Scoreboard({ score }: { score: ScoreState }) {
  return (
    <div className="swipe-score" aria-live="polite">
      <div className="swipe-score-total">{score.total.toLocaleString()}</div>
      <div className="swipe-score-meta">
        <span>{score.decided} decided</span>
        {score.streak >= 3 && <span className="swipe-streak">🔥 {score.streak}</span>}
      </div>
      {score.lastPoints > 0 && (
        <div className="swipe-score-flash" key={`${score.decided}-${score.lastPoints}`}>
          +{score.lastPoints} · {score.lastLabel}
        </div>
      )}
    </div>
  );
}

function EmptyState({
  connected,
  playing,
  onDeal,
  summary,
}: {
  connected: boolean;
  playing: boolean;
  onDeal: () => void;
  summary: ScoreState | null;
}) {
  if (summary) {
    const avg = summary.decided ? Math.round(summary.total / summary.decided) : 0;
    return (
      <div className="swipe-empty panel">
        <div className="swipe-empty-emoji" aria-hidden>🏁</div>
        <h2>Round clear</h2>
        <p className="swipe-empty-score">{summary.total.toLocaleString()} points</p>
        <p className="swipe-empty-hint">
          {summary.decided} campaigns · {avg} avg / decision
        </p>
        <button className="btn primary big" onClick={onDeal}>
          Deal another round
        </button>
      </div>
    );
  }
  // Dealing mode is local, so the deal button always works - no mesh needed.
  return (
    <div className="swipe-empty panel">
      <h2>Ready to play</h2>
      <p className="swipe-empty-hint">
        Deal a round of 8 campaigns to review - spot the ones the agent got wrong. Your game is
        yours alone; play at your own pace.
        {!connected && !playing ? ' (Mesh offline - that’s fine, the game runs locally.)' : ''}
      </p>
      <button className="btn primary big" onClick={onDeal}>
        Deal a round
      </button>
    </div>
  );
}

// A single focused approval panel. Pointer/touch drag with a subtle tilt and
// approve/reject stamps; commits on release past the threshold (or a fast
// flick). Uses the desktop panel + campaign-card visual language.
function ApprovalPanel({
  run,
  countdownMs,
  dealtAt,
  onDecide,
}: {
  run: RunTimeline;
  countdownMs: number | null;
  dealtAt: number;
  onDecide: (decision: 'yes' | 'no') => void;
}) {
  const [dx, setDx] = useState(0);
  const [flyOut, setFlyOut] = useState<null | 'yes' | 'no'>(null);
  const startX = useRef<number | null>(null);
  const startT = useRef(0);

  const commit = useCallback(
    (decision: 'yes' | 'no') => {
      if (flyOut) return;
      setFlyOut(decision);
      setTimeout(() => onDecide(decision), 180);
    },
    [flyOut, onDecide],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (flyOut) return;
    startX.current = e.clientX;
    startT.current = Date.now();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (startX.current == null) return;
    setDx(e.clientX - startX.current);
  };
  const onPointerUp = () => {
    if (startX.current == null) return;
    const travelled = dx;
    const dt = Date.now() - startT.current;
    const flick = Math.abs(travelled) > 60 && dt < 250;
    startX.current = null;
    if (travelled > SWIPE_COMMIT_PX || (flick && travelled > 0)) commit('yes');
    else if (travelled < -SWIPE_COMMIT_PX || (flick && travelled < 0)) commit('no');
    else setDx(0);
  };

  const campaign = run.campaign;
  const rot = Math.max(-8, Math.min(8, dx / 18));
  const likeOpacity = Math.max(0, Math.min(1, dx / SWIPE_COMMIT_PX));
  const nopeOpacity = Math.max(0, Math.min(1, -dx / SWIPE_COMMIT_PX));

  const style: React.CSSProperties = flyOut
    ? {
        transform: `translateX(${flyOut === 'yes' ? 640 : -640}px) rotate(${flyOut === 'yes' ? 12 : -12}deg)`,
        opacity: 0,
        transition: 'transform 180ms ease-in, opacity 180ms ease-in',
      }
    : {
        transform: `translateX(${dx}px) rotate(${rot}deg)`,
        transition: startX.current == null ? 'transform 220ms cubic-bezier(.2,.8,.2,1)' : 'none',
      };

  return (
    <section
      className="panel swipe-panel"
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="swipe-stamp like" style={{ opacity: likeOpacity }}>APPROVE</div>
      <div className="swipe-stamp nope" style={{ opacity: nopeOpacity }}>REJECT</div>
      <CardCountdown dealtAt={dealtAt} windowMs={countdownMs} />
      {campaign ? (
        <CampaignBody campaign={campaign} run={run} llmFallback={run.llmFallback} />
      ) : (
        <div className="swipe-loading">Drafting campaign…</div>
      )}
    </section>
  );
}

// A thin countdown bar across the top of the panel: full at deal time, draining
// over the speed-bonus window so a player can see the clock. When windowMs is
// null the card is untimed (the first decision of the session) - we show a
// full, calm bar with a "no timer" label instead of a running clock.
function CardCountdown({ dealtAt, windowMs }: { dealtAt: number; windowMs: number | null }) {
  const [pct, setPct] = useState(100);
  useEffect(() => {
    if (windowMs == null) {
      setPct(100);
      return;
    }
    let raf = 0;
    const tick = () => {
      const remaining = Math.max(0, windowMs - (Date.now() - dealtAt));
      setPct((remaining / windowMs) * 100);
      if (remaining > 0) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dealtAt, windowMs]);
  if (windowMs == null) {
    return (
      <div className="swipe-countdown swipe-countdown--untimed" title="Take your time on the first one">
        <div className="swipe-countdown-fill good" style={{ width: '100%' }} />
        <span className="swipe-countdown-label">No timer · take your time</span>
      </div>
    );
  }
  const hue = pct > 50 ? 'good' : pct > 20 ? 'warn' : 'bad';
  return (
    <div className="swipe-countdown">
      <div className={`swipe-countdown-fill ${hue}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function offerEmoji(campaign: Campaign): string {
  const t = campaign.offer?.type;
  if (t === 'price_increase') return '📈';
  if (t === 'bundle') return '🎁';
  if (t === 'multibuy') return '🛒';
  return '🏷️';
}

function directionLabel(campaign: Campaign): string {
  const t = campaign.offer?.type;
  if (t === 'price_increase') return 'Temporary surge';
  if (t === 'bundle') return 'Bundle proposition';
  return 'Markdown';
}

// The campaign detail, mirroring the desktop CampaignCard: gold result-card,
// headline + body, offer chip, a 3-up metric grid, a confidence bar and the
// signal chips. Reuses the shared brand.css classes so it reads identically.
function CampaignBody({
  campaign,
  run,
  llmFallback,
}: {
  campaign: Campaign;
  run: RunTimeline;
  llmFallback?: boolean;
}) {
  const confidence = Math.round((campaign.confidence ?? 0) * 100);
  const revenue = campaign.revenueProtectedEur ?? 0;
  return (
    <div className="swipe-panel-body">
      <div className="swipe-panel-top">
        <span className="swipe-emoji" aria-hidden>{offerEmoji(campaign)}</span>
        <div className="swipe-panel-badges">
          <span className="chip gold">{directionLabel(campaign)}</span>
          {run.sku && <span className="chip mono">SKU {run.sku}</span>}
        </div>
      </div>

      <div className="result-card result-card--gold campaign-card">
        <div className="headline">{campaign.headline}</div>
        <div className="body-copy">{campaign.body}</div>

        <div className="btn-row">
          <span className="chip mono">
            {campaign.offer?.type?.replace('_', ' ')}: {campaign.offer?.value}
          </span>
          <span className="chip mono">{campaign.channel}</span>
          {llmFallback && <span className="chip orange">LLM Fallback</span>}
        </div>

        <div className="metric-grid swipe-metric-grid">
          <Metric label="Revenue impact" value={`€${revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
          <Metric label="Audience" value={(campaign.audience?.size ?? 0).toLocaleString()} source="SAP CDP" />
          <Metric label="Est. units" value={(campaign.expectedUnitsMoved ?? 0).toLocaleString()} />
        </div>

        <div className="confidence">
          <div className="confidence-head">
            <span className="confidence-label">Agent confidence</span>
            <span className="mono">{confidence}%</span>
          </div>
          <div className="bar">
            <div className="fill" style={{ width: `${confidence}%` }} />
          </div>
        </div>

        <div className="btn-row signals-row">
          {(campaign.signalsUsed ?? []).slice(0, 5).map((s) => (
            <span key={s} className="chip green">{prettySignal(s)}</span>
          ))}
        </div>
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

function prettySignal(name: string): string {
  const map: Record<string, string> = {
    weather: 'Weather',
    news: 'News',
    inventory: 'Inventory',
    customer_interest: 'Customers',
    price: 'Price',
  };
  return map[name] ?? name;
}

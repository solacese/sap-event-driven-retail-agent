// ---------------------------------------------------------------------------
// Centre "The mesh": live event feed, newest first, capped at 200 rows.
// Rows are memoised and use CSS `content-visibility: auto`, so off-screen rows
// skip layout/paint - a virtualization-grade win at the 200-row cap without a
// dependency. Revisit true windowing only if the cap ever grows. Each row is
// a full-width mono topic, a one-line summary, a coloured left border by
// category, a CACHED/REQUESTED badge when present, and amber styling on tool
// timeouts. Clicking a row expands the full JSON payload and user properties.
// Filter bar: three coarse topic groups (All / Triggers / Context / The agent).
// ---------------------------------------------------------------------------
import { memo, useCallback, useMemo, useState } from 'react';
import type { FeedEvent } from '../lib/types.js';
import { CATEGORY_COLOR, TOPIC_GROUPS, matchesGroup } from '../lib/topics.js';

interface Props {
  feed: FeedEvent[];
}

export function MeshFeed({ feed }: Props) {
  // A single active group ('' = show everything). One choice is simpler to
  // navigate than eight independent toggles.
  const [group, setGroup] = useState('');
  // Listen to a specific topic: a case-insensitive substring match on the
  // topic string, combined (AND) with the group filter.
  const [topicFilter, setTopicFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  // Stable identity so memoised rows don't re-render just because MeshFeed did
  // (e.g. on every incoming SSE event). The row passes its own id back.
  const toggleRow = useCallback((id: string) => {
    setExpanded((cur) => (cur === id ? null : id));
  }, []);

  const filtered = useMemo(() => {
    const g = group ? TOPIC_GROUPS.find((x) => x.key === group) : undefined;
    const needle = topicFilter.trim().toLowerCase();
    return feed.filter((ev) => {
      if (g && !matchesGroup(ev.topic, g)) return false;
      if (needle && !ev.topic.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [feed, group, topicFilter]);

  return (
    <section className="panel">
      <div className="panel-title-row">
        <h2>The Mesh</h2>
      </div>

      <div className="feed-toolbar">
        <div className="filter-toggles">
          <button
            className={`toggle${group === '' ? ' active' : ''}`}
            onClick={() => setGroup('')}
          >
            All
          </button>
          {TOPIC_GROUPS.map((g) => (
            <button
              key={g.key}
              className={`toggle${group === g.key ? ' active' : ''}`}
              onClick={() => setGroup(g.key)}
            >
              {g.label}
            </button>
          ))}
        </div>
        <div className="topic-listen">
          <input
            className="mono"
            value={topicFilter}
            onChange={(e) => setTopicFilter(e.target.value)}
            placeholder="Listen to a topic… (e.g. weather)"
            aria-label="Filter the mesh by topic"
          />
          {topicFilter.trim() && (
            <button
              className="topic-clear"
              onClick={() => setTopicFilter('')}
              aria-label="Clear topic filter"
              title="Clear"
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className="feed-list">
        {filtered.length === 0 && (
          <p className="rail-hint" style={{ padding: 8 }}>
            No events yet. Connect a broker and run a scenario.
          </p>
        )}
        {filtered.map((ev) => (
          <FeedRow key={ev.id} ev={ev} open={expanded === ev.id} onToggle={toggleRow} />
        ))}
      </div>
    </section>
  );
}

// Memoised: a row only re-renders when its own event or open state changes, so
// a burst of incoming events doesn't re-execute the whole (up to 200-row) list.
const FeedRow = memo(function FeedRow({
  ev,
  open,
  onToggle,
}: {
  ev: FeedEvent;
  open: boolean;
  onToggle: (id: string) => void;
}) {
  const border = ev.toolTimeout ? CATEGORY_COLOR.tool : CATEGORY_COLOR[ev.category];
  return (
    <div
      className={`feed-row${ev.direction === 'out' ? ' out' : ''}${ev.toolTimeout ? ' timeout' : ''}`}
      style={{ borderLeftColor: border }}
      onClick={() => onToggle(ev.id)}
    >
      <div className="topic">{ev.topic}</div>
      <div className="summary">{ev.summary}</div>
      <div className="meta">
        <span className={`dir-badge${ev.direction === 'out' ? ' out' : ''}`}>
          {ev.direction === 'out' ? 'OUT' : 'IN'}
        </span>
        {ev.sourceTag && (
          <span className={`chip ${ev.sourceTag === 'CACHED' ? 'sky' : 'outline'}`}>
            {ev.sourceTag}
          </span>
        )}
        {ev.toolTimeout && <span className="chip orange">Tool Timeout</span>}
        <span className="chip dim mono">{new Date(ev.receivedAt).toLocaleTimeString()}</span>
      </div>
      {open && (
        <pre className="feed-json">
          {JSON.stringify(
            { payload: ev.payload, userProperties: ev.userProperties },
            null,
            2,
          )}
        </pre>
      )}
    </div>
  );
});

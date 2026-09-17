# Architecture

Discount Bot is a retail pricing agent that lives on a Solace event mesh. The single sentence it exists to prove: agents are only as good as the events they can see.

This document explains how the demo is wired: how the browser stays off the broker, how one Node process hosts four logical roles, how the ContextStore materialises event streams, the agent state machine, request/reply over the mesh, human approval as an event round trip, and the SSE bridge to the browser.

No em dashes are used anywhere in this file.

## The browser never talks to the broker

The React UI speaks only to the Node gateway over HTTP and SSE. It never opens a Solace connection.

- Broker credentials are entered in the UI, POSTed once to the gateway, held in memory server-side only, and never returned by any GET, never written to disk, never logged.
- `GET /api/session` returns host, VPN and username only.
- Every mesh event the UI shows arrives over the SSE stream from the gateway, not from the broker directly.

```
Browser (React)
  |  POST /api/session/connect   (broker creds, in-memory only)
  |  GET  /api/stream            (SSE: every mesh event + agent state)
  |  POST /api/approval/:id      (yes / no)
  |  POST /api/scenario/:name    (demo controls)
  v
Node process (one process, four roles)
  +-- GATEWAY     Express + helmet CSP + cookie auth + SSE + static build
  +-- AGENT       Discount Bot state machine, mesh request/reply, LLM calls
  +-- TOOLS       four request/reply services on the mesh
  +-- SIMULATOR   publishes the fake world (price, weather, news, stock, consent)
        |
        v
     Bus abstraction
        |
   +----+----------------------------+
   |                                  |
 MockBus (in-process)          SolaceBus (SMF over WebSocket)
 zero external services        customer broker or Solace Cloud trial
```

## The Bus abstraction: MockBus vs SolaceBus

Everything that publishes, subscribes or does request/reply goes through one Bus interface. Two implementations sit behind it.

- MockBus is an in-process pub/sub bus. It fans out to the same wildcard subscriptions the real broker would (`ALL_SUBSCRIPTIONS` in `config/topics.ts`), so the whole demo runs with no broker at all. This is the default and it is what makes `npm run dev` work at an airport with no network.
- SolaceBus wraps a single `solclientjs` session using SMF over WebSocket with direct messaging. It is used when a prospect enters real Solace Cloud or customer credentials in the UI.

Both implementations expose the same publish, subscribe and request/reply surface, so the agent, tools and simulators do not know or care which bus is active. `BROKER_MODE=mock` (the default) auto-connects the MockBus at startup. `BROKER_MODE=solace` waits for credentials from the UI.

## Four logical roles in one Node process

The spec ships four processes inside one Node process, clearly separated in code, each with its own log prefix and its own colour in the UI.

| Role | Responsibility |
|---|---|
| `SIMULATOR` | Publishes the world: price updates, weather forecasts, news flags, stock changes, consent updates. Toggle with `SIMULATORS_ENABLED`. |
| `TOOLS` | Four request/reply services on the mesh: weather, news, inventory, customer interest. |
| `AGENT` | The Discount Bot: state machine, mesh request/reply, LLM calls, approval round trip. |
| `GATEWAY` | HTTP plus SSE for the UI, auth, health check, static build serving. |

`SIMULATORS_ENABLED=false` turns the fake world off so the agent can be pointed at a customer's real topics later without code changes.

## ContextStore: the materialised view, and CACHED vs REQUESTED

The agent subscribes to five context streams on connect (the wildcard subscriptions in `CONTEXT_SUBSCRIPTIONS`). As those events arrive, the ContextStore folds them into a materialised local view keyed by country, region, store and SKU. This is the "context is already there" selling point: weather, news, stock and consent are event streams that are kept fresh locally, so a lookup is instant.

When a run needs a signal, the agent asks the ContextStore first:

- CACHED: the signal is already in the materialised view from a subscribed event stream. The lookup is instant and the UI labels the signal row `CACHED`.
- REQUESTED: the signal is not in the view, or a fresh authoritative answer is wanted, so the agent issues a request/reply call to a mesh tool. The UI labels that signal row `REQUESTED`.

Labelling every signal `CACHED` or `REQUESTED` on screen is the single strongest event-driven talking point in the demo. It makes the difference between polling and event-driven context visible without narration.

## Agent state machine

States, in order:

`disconnected` to `idle` to `triggered` to `gathering` to `reasoning` to `drafted` to `awaiting_approval` to `dispatched`, with `suppressed` and `error` as terminal branches.

```
disconnected --connect--> idle
idle --price event passes threshold--> triggered
idle --price event below threshold--> suppressed (dimmed row, reason published)
triggered --> gathering        (4 signals resolve, CACHED or REQUESTED)
gathering --> reasoning         (LLM call, zod-validated output)
reasoning --> drafted           (campaign card)
reasoning --> suppressed        (LLM recommends hold)
drafted --> awaiting_approval   (approval request published)
awaiting_approval --decision: yes--> dispatched
awaiting_approval --decision: no --> suppressed
awaiting_approval --120s timeout--> suppressed (reason: approval_timeout)
any --unrecoverable error--> error
```

Rules that matter for the demo:

- Trigger only on price updates where `discountPct >= 15` or `shelfLifeDaysRemaining <= 5`. Everything else publishes a `run/suppressed` event with a reason and shows as a dimmed row. This answers the question every prospect asks: does it fire on everything?
- One run at a time per SKU. Concurrent SKUs are allowed, up to a max of three, and the rest queue.
- Gathering runs the four tool requests in parallel and shows each signal resolving live.
- If weather is poor and the item is `grill_ready`, or a national event conflicts, the agent reduces confidence or recommends a different bundle. The LLM is allowed to say no with a hold recommendation, which publishes `run/suppressed`.

## Request/reply over the mesh, 4 second timeout, graceful degradation

Tool calls are not HTTP to hardcoded endpoints. The agent is the requestor and the four TOOLS services are the repliers, all over the broker with reply-to correlation.

- Timeout is 4000 ms per tool request.
- On timeout the agent degrades gracefully: it marks that signal `unavailable`, continues with the remaining signals, and states the gap in the campaign rationale (`signalsUnavailable`).
- The UI shows a timeout as an amber chip. This is a feature, not a bug: it demonstrates that tools are decoupled mesh services that can be swapped, scaled or removed without touching the agent.

## Human approval as an event round trip

Approval is not an in-process function call. It is a round trip over the mesh, which is exactly the human-in-the-loop pattern enterprise buyers want to see.

1. The agent publishes a `human-approval/{runId}` request event and moves to `awaiting_approval`.
2. The UI Yes or No button POSTs to the gateway at `/api/approval/:id`.
3. The gateway publishes a `human-approval/decision/{runId}` event onto the mesh.
4. The agent is subscribed to its own decision topic (`AGENT_SUBSCRIPTIONS`) and reacts to the decision event, not to the HTTP call.
5. Only after consuming a yes decision does the agent publish the dispatch event.

The feed ordering makes this verifiable: the decision event appears on the mesh before any dispatch event. Nothing auto-fires to customers.

## SSE to the browser

The gateway holds a hub that every role writes to. Each mesh event, each agent state change, and each counter update is pushed to the browser over Server-Sent Events at `GET /api/stream` (auth required). The browser renders the live feed, the avatar state, the run timeline, the campaign card and the footer counters from this one stream. In production Caddy is configured with SSE buffering off so events flush immediately.

## Topic taxonomy

Solace uses `/` as the level separator. Every topic is built from `config/topics.ts` with a `TOPIC_ROOT` prefix (default `acme/retail`) so the whole taxonomy rebrands per prospect in one line. The tables below are copied from `config/topics.ts` and the spec.

### Events the agent subscribes to (context streams, materialised into ContextStore)

| Purpose | Topic |
|---|---|
| Price change (trigger) | `acme/retail/shopfloor/price/updated/v1/{country}/{region}/{sku}` |
| Weather forecast | `acme/retail/weather/forecast/updated/v1/{country}` |
| National event flag | `acme/retail/news/national-event/flagged/v1/{country}` |
| Stock level change | `acme/retail/inventory/stock-level/changed/v1/{storeId}/{sku}` |
| Consent change | `acme/retail/customer/consent/updated/v1/{customerId}` |

Wildcard subscriptions installed on connect (`CONTEXT_SUBSCRIPTIONS`):

```
acme/retail/shopfloor/price/updated/v1/>
acme/retail/weather/forecast/updated/v1/>
acme/retail/news/national-event/flagged/v1/>
acme/retail/inventory/stock-level/changed/v1/>
acme/retail/customer/consent/updated/v1/>
```

### Tool request/reply (agent is the requestor, TOOLS are the repliers)

| Tool | Request topic | Notes |
|---|---|---|
| Weather | `acme/retail/tools/weather/request/v1/{country}` | 3 day outlook |
| News | `acme/retail/tools/news/request/v1/{country}` | next 5 days, national events |
| Inventory | `acme/retail/tools/inventory/request/v1/{sku}` | per store units, days of cover |
| Customer interest | `acme/retail/tools/customer-interest/request/v1/{sku}` | past purchasers plus consent split |

Wildcard subscriptions each tool service installs (`TOOL_SUBSCRIPTIONS`):

```
acme/retail/tools/weather/request/v1/>
acme/retail/tools/news/request/v1/>
acme/retail/tools/inventory/request/v1/>
acme/retail/tools/customer-interest/request/v1/>
```

### Events the agent publishes

| Purpose | Topic |
|---|---|
| Run started | `acme/retail/agents/discount-bot/v1/run/started/{runId}` |
| Signal gathered | `acme/retail/agents/discount-bot/v1/signal/{signalName}/{runId}` |
| Campaign drafted | `acme/retail/agents/discount-bot/v1/campaign/drafted/{runId}` |
| Human approval requested | `acme/retail/agents/discount-bot/v1/human-approval/{runId}` |
| Approval decision | `acme/retail/agents/discount-bot/v1/human-approval/decision/{runId}` |
| Campaign dispatched | `acme/retail/marketing/campaign/dispatch/requested/v1/{country}/{campaignId}` |
| Run suppressed | `acme/retail/agents/discount-bot/v1/run/suppressed/{runId}` |

The agent also subscribes to its own approval decision topic so the human-in-the-loop round trip happens over the mesh (`AGENT_SUBSCRIPTIONS`):

```
acme/retail/agents/discount-bot/v1/human-approval/decision/>
```

Every published message carries user properties: `runId`, `correlationId`, `agent=discount-bot`, `agentVersion`, `sku`, `country`, `emittedAt` (ISO 8601), and `schemaVersion=1`. Payloads are JSON, UTF-8.

### UI colour categories

`categorise()` in `config/topics.ts` maps any topic to a feed colour: tool topics are orange on timeout, weather and news are external context, inventory and customer are customer or inventory data, and everything else is a mesh event.

## Layout

The dashboard is a three-column story under a single control header:

```
+-----------------------------------------------------------------------+
| Solace  Discount Bot            [llm chip] [scenarios] [Publish] [...] |  header
+----------------+--------------------------------+---------------------+
| Agent rail     | Mesh feed (the star)           | The outcome         |
| avatar, state, | live request/reply topics,     | run timeline,       |
| signal pulses  | CACHED vs REQUESTED, timeouts  | campaign, approval  |
+----------------+--------------------------------+---------------------+
| footer counters                                                       |
+-----------------------------------------------------------------------+
```

The "Publish Custom Event" tool lives in a right-hand slide-over **drawer**
toggled from the header ("Publish Event"), not a full-width panel at the top.
This keeps the three columns above the fold and gives the mesh feed the full
viewport height, which matters because the feed is what an event-driven demo
most wants a prospect to watch.

### Alternatives considered

- **A. Drawer for the custom-event tool (chosen).** Story stays above the fold;
  the tool is one click away and closes on scrim-click or `Esc`. Lowest risk,
  highest signal-to-noise.
- **B. Feed-dominant with collapsible side rails.** The feed grows edge to edge
  and the agent/outcome rails collapse to slivers. Maximises the feed but hides
  the narrative context (what state the agent is in, what it produced) that
  carries the pitch, so it reads as a raw log rather than a story.
- **C. Outcome-forward two-pane** (`agent + feed` left, `outcome` right, each
  half-width). Great for the payoff screenshot but it halves the feed width and
  forces topic strings to wrap, muddying the live event stream.

The layout constants live in `.app-main` (`src/web/styles/brand.css`); switching
to B or C is a grid-template change plus a rail collapse toggle.

# Claude Code prompt: "Discount Bot" SAP + Solace event-driven agent demo

Copy everything below the line into Claude Code as the initial prompt. Run it in an empty directory.
Before you start, save the avatar JSON you exported from https://avatars.bible-strong.app/ to `assets/discount-bot-avatar.json`.

---

# ROLE

You are building a customer-facing sales demo for Solace. It must run reliably in front of enterprise prospects in EMEA and UK, on a laptop or on AWS behind a password. Prioritise: demo reliability, visual polish, zero-config startup, and a clear narrative. This is not production software, but nothing may crash on stage.

# THE STORY THIS DEMO SELLS

One sentence: **agents are only as good as the events they can see.**

The demo shows a retail pricing agent ("Discount Bot") built with an enterprise AI SDK (SAP Cloud SDK for AI, pluggable) that lives on a Solace event mesh. It does not poll systems and it does not sit behind a chat box. A price change event lands on the mesh, the agent wakes up, correlates real-time context it is already subscribed to, calls tools over the mesh, reasons with an LLM, then asks a human for approval by publishing an approval event. Every step is an event on the mesh, so it is observable, replayable and auditable.

Selling points that must be visible on screen without narration:
1. **Event-triggered, not prompt-triggered.** No user types anything to start the run.
2. **Context is already there.** Weather, news, stock levels and consent arrive as event streams and are materialised locally, so lookups are instant.
3. **Tools are mesh services.** Tool calls go out as request/reply over the broker, not HTTP to hardcoded endpoints. Any tool can be swapped, scaled or replaced without touching the agent.
4. **Human in the loop is an event.** Approval request out, approval decision in. Nothing auto-fires to customers.
5. **Governance by design.** Consent enforced before targeting, full audit trail on the mesh, EU-relevant framing (GDPR consent, EU AI Act human oversight).

# STACK

- **Runtime:** Node.js 20, TypeScript, single repo, single `npm run dev` to start everything.
- **Backend:** Express + `solclientjs` (Solace SMF over WebSocket) + SSE stream to the browser.
- **Frontend:** Vite + React + TypeScript, plain CSS (no Tailwind), custom SVG avatar renderer.
- **LLM:** adapter pattern, see LLM LAYER below.
- **Auth:** single shared password gate (see SECURITY).
- **Packaging:** Dockerfile + docker-compose + Caddy for TLS and basic auth on AWS.

Do not use a database. All state is in memory, with a `resetDemo()` that returns everything to a known state.

# ARCHITECTURE

Browser never talks to the broker directly. Broker credentials are entered in the UI, POSTed once to the backend, held in memory server-side only, and never returned to the client and never written to disk or logs.

```
Browser (React)
  |  POST /api/session/connect   (broker creds)
  |  GET  /api/stream            (SSE: every mesh event + agent state)
  |  POST /api/approval/:id      (yes / no)
  |  POST /api/scenario/:name    (demo controls)
  v
Backend (Node)
  - SolaceSession        one solclientjs session, direct messaging
  - ContextStore         materialised view built from subscribed event streams
  - DiscountBotAgent     state machine, mesh request/reply, LLM calls
  - Simulators           price feed + 4 tool services + consent/stock/weather/news publishers
  v
Solace broker (customer's, or Solace Cloud trial)
```

Ship four processes inside one Node process, clearly separated in code, each with its own log prefix and its own colour in the UI:
- `SIMULATOR` publishes the world (price updates, weather forecasts, news flags, stock changes, consent updates)
- `TOOLS` four request/reply services on the mesh
- `AGENT` the Discount Bot
- `GATEWAY` HTTP + SSE for the UI

Add an env flag `SIMULATORS_ENABLED=true|false` so we can point the agent at a customer's real topics later and turn the fake world off.

# TOPIC TAXONOMY

Solace uses `/` as the level separator. Normalise everything to `/`. All topics configurable via `config/topics.ts` with a `TOPIC_ROOT` prefix (default `acme/retail`) so we can rebrand per prospect in one line.

**Events the agent subscribes to (context streams, materialised into ContextStore):**

| Purpose | Topic |
|---|---|
| Price change (trigger) | `acme/retail/shopfloor/price/updated/v1/{country}/{region}/{sku}` |
| Weather forecast | `acme/retail/weather/forecast/updated/v1/{country}` |
| National event flag | `acme/retail/news/national-event/flagged/v1/{country}` |
| Stock level change | `acme/retail/inventory/stock-level/changed/v1/{storeId}/{sku}` |
| Consent change | `acme/retail/customer/consent/updated/v1/{customerId}` |

**Tool request/reply (agent is the requestor, TOOLS are the repliers):**

| Tool | Request topic | Notes |
|---|---|---|
| Weather | `acme/retail/tools/weather/request/v1/{country}` | 3 day outlook |
| News | `acme/retail/tools/news/request/v1/{country}` | next 5 days, national events |
| Inventory | `acme/retail/tools/inventory/request/v1/{sku}` | per store units, days of cover |
| Customer interest | `acme/retail/tools/customer-interest/request/v1/{sku}` | past purchasers + consent split |

Use `session.sendRequest()` with a 4000 ms timeout and reply-to correlation. On timeout, the agent must degrade gracefully: mark that signal as `unavailable`, continue, and say so in the campaign rationale. Show the timeout in the UI as an amber chip. This is a feature, not a bug: it demonstrates decoupling.

**Events the agent publishes:**

| Purpose | Topic |
|---|---|
| Run started | `acme/retail/agents/discount-bot/v1/run/started/{runId}` |
| Signal gathered | `acme/retail/agents/discount-bot/v1/signal/{signalName}/{runId}` |
| Campaign drafted | `acme/retail/agents/discount-bot/v1/campaign/drafted/{runId}` |
| Human approval requested | `acme/retail/agents/discount-bot/v1/human-approval/{runId}` |
| Approval decision | `acme/retail/agents/discount-bot/v1/human-approval/decision/{runId}` |
| Campaign dispatched | `acme/retail/marketing/campaign/dispatch/requested/v1/{country}/{campaignId}` |
| Run suppressed | `acme/retail/agents/discount-bot/v1/run/suppressed/{runId}` |

Every published message carries user properties: `runId`, `correlationId`, `agent=discount-bot`, `agentVersion`, `sku`, `country`, `emittedAt` (ISO 8601), and `schemaVersion=1`. Payloads are JSON, UTF-8.

# EVENT CONTRACTS

```jsonc
// price updated
{
  "sku": "51001",
  "item": "sausage",
  "category": "fresh_meat",
  "tags": ["grill_ready", "own_brand"],
  "country": "FR",
  "region": "EMEA",
  "previousPrice": 4.29,
  "newPrice": 2.99,
  "currency": "EUR",
  "discountPct": 30.3,
  "reason": "expiry_window",
  "shelfLifeDaysRemaining": 4,
  "emittedAt": "2026-08-18T07:12:04Z"
}

// weather tool reply
{ "country": "FR", "outlook": [ { "date": "2026-08-21", "conditionCode": "sunny", "tempMaxC": 29, "precipProbability": 0.05 } ], "summary": "Dry and warm through the weekend" }

// news tool reply
{ "country": "FR", "nationalEvents": [], "notable": [ { "date": "2026-08-22", "headline": "No major national event", "impact": "neutral" } ] }

// inventory tool reply
{ "sku": "51001", "totalUnits": 812, "storesWithStock": 20, "stores": [ { "storeId": "FR-0142", "city": "Lyon", "units": 47, "daysOfCover": 2.1 } ], "atRiskUnits": 640 }

// customer interest tool reply
{ "sku": "51001", "pastPurchasers": 1104, "repeatPurchasers3Plus": 822, "marketingConsented": 822, "consentWithheld": 282, "topAffinities": ["bbq_sauce", "buns", "beer"] }

// campaign drafted (LLM output, strict schema)
{
  "campaignId": "CMP-51001-0001",
  "sku": "51001",
  "headline": "string, max 60 chars",
  "body": "string, max 240 chars",
  "channel": "push" | "email" | "sms",
  "offer": { "type": "percentage" | "bundle" | "multibuy", "value": "string" },
  "bundleWith": ["string"],
  "audience": { "segment": "string", "size": 822, "consentBasis": "explicit_marketing_optin" },
  "targetStores": ["FR-0142"],
  "sendWindow": { "startsAt": "ISO", "endsAt": "ISO" },
  "expectedUnitsMoved": 480,
  "marginImpactEur": -710.4,
  "wasteAvoidedUnits": 480,
  "confidence": 0.0,
  "rationale": ["short bullet referencing each signal used"],
  "signalsUsed": ["price", "weather", "news", "inventory", "customer_interest"],
  "signalsUnavailable": [],
  "guardrails": { "consentEnforced": true, "humanApprovalRequired": true }
}
```

Validate the LLM output with zod. On validation failure, retry once with the validation error appended to the prompt, then fall back to a deterministic template campaign and flag `llmFallback: true` in the UI. The demo must never dead-end.

# AGENT STATE MACHINE

States, in order: `disconnected`, `idle`, `triggered`, `gathering`, `reasoning`, `drafted`, `awaiting_approval`, `dispatched`, `suppressed`, `error`.

Rules:
- Trigger only on price updates where `discountPct >= 15` or `shelfLifeDaysRemaining <= 5`. Publish `run/suppressed` with a reason for everything else, and show it in the UI as a dimmed row. Prospects always ask "does it fire on everything?".
- One run at a time per SKU. Concurrent SKUs allowed, max 3, queue the rest.
- Gathering runs the four tool requests in parallel. Show each signal resolving live.
- The agent must state which signals came from the materialised event cache (instant, "already knew") versus which required a mesh request. Label them in the UI as `CACHED` and `REQUESTED`. This is the single strongest EDA talking point on the screen.
- If weather is poor and the item is `grill_ready`, or a national event conflicts, the agent should reduce confidence or recommend a different bundle. The LLM must be able to say no: allow `"recommendation": "hold"` and publish `run/suppressed`.
- Approval: publish the approval request, wait for a decision event. The UI Yes/No buttons POST to the backend, which publishes the decision event onto the mesh, and the agent reacts to the event, not to the HTTP call. Make this explicit in code comments and in a UI tooltip, because it is exactly the SAM human-in-the-loop pattern.
- Timeout on approval after 120 s: publish `run/suppressed` with reason `approval_timeout`.

# LLM LAYER

`src/llm/index.ts` exports `complete(messages, { schema })` and picks a provider from `LLM_PROVIDER`:

1. `openai_compatible` (default). Base URL from `LLM_BASE_URL`, model from `LLM_MODEL`, key from `LLM_API_KEY` (optional). At startup, probe in order for a local proxy: `http://localhost:4000/v1`, `http://localhost:8000/v1`, `http://localhost:1234/v1`, `http://localhost:11434/v1`. Log which one answered and which models it exposes. Never hardcode a model name that only exists on one machine.
2. `sap_ai_core`. Use `@sap-ai-sdk/orchestration` with `AICORE_SERVICE_KEY`, deployment id and resource group from env. Implement it behind the same interface, keep it optional at build time so a missing SAP credential cannot break `npm run dev`. Add a short `docs/SAP_AI_SDK.md` explaining exactly which env vars a SAP prospect needs to set to run the same demo through SAP AI Core, and what changes on screen (nothing, which is the point).
3. `mock`. Deterministic canned campaign, no network. Used for offline demos and for tests.

Show the active provider and model in the UI header as a small mono chip, for example `SAP AI Core / gpt-4o` or `local proxy / claude-sonnet`. When a prospect sees their own SDK named on screen, the co-sell lands.

Log token counts and latency per call and show a running cost estimate in the footer if `LLM_PRICE_PER_1K_INPUT` and `..._OUTPUT` are set.

# AVATAR

Load `assets/discount-bot-avatar.json` at runtime through `GET /api/avatar` so it can be swapped without a rebuild. Build a self-contained React SVG renderer for the schema `bible-strong/avatar-definition` v1. Do not add a dependency, do not embed an iframe.

Schema handling:
- `body.primary`: `type: "sphere"` with `width`, `height`, `depth`, `roundness`. Render as an ellipse or rounded rect driven by width/height and roundness (1 = full ellipse).
- `colors.body`, `colors.eyes`: defaults. Per-expression `colors` overrides take precedence when that expression is active, and must tween on transition.
- Each expression has `eyes.left` and `eyes.right` with `width`, `height`, `x`, `y`, `angle`, plus `eyes.spacing`. Render each eye as a rounded rect (fully rounded caps, radius = min(width,height)/2), rotated by `angle` degrees around its own centre, offset horizontally by `spacing/2`.
- `head.x`, `head.y`, `head.z`: treat x as pitch, y as yaw, z as roll, all in degrees. Apply as a cheap pseudo 3D: yaw and pitch translate and horizontally or vertically compress the eye group and shift it within the body, roll rotates the whole eye group. Keep it subtle and never let eyes clip outside the body.
- `animations`: each has `playbackMode: "loop"`, `steps[]` with `expression`, `holdMs`, `transitionMs`, `transition: "smooth"`, and a `blink` block with `enabled`, `initialDelayMs`, `minIntervalMs`, `maxIntervalMs`, `durationMs`. Implement interpolation of every numeric field between the current pose and the next step's pose with an ease-in-out curve over `transitionMs`, then hold for `holdMs`. Blink = temporarily collapse eye height to about 8 percent and back over `durationMs`, at a random interval in the given range, without disturbing the base animation.
- `motion.eyes` and `motion.body`: implement `none`, `shake` (fast low amplitude jitter) and `slowDrift` (slow sine offset).
- Respect `prefers-reduced-motion`: fall back to static poses.

State to animation mapping (use the animation names from the JSON):

| Agent state | Animation |
|---|---|
| disconnected | `sleeping` |
| connecting | `waking` |
| idle | `idle` |
| triggered | `surprised` |
| gathering | `searching` |
| reasoning | `thinking` |
| drafted | `excited` |
| awaiting_approval | `listening` |
| dispatched | `celebrate` |
| suppressed | `confused` |
| error | `angry` |

Override the body colour to Solace Classic Green `#00C895` and the eyes to Dark Blue `#03213B` at load, keeping per-expression overrides (`angry-brows` red, `uneasy-left` pale blue) intact so the emotional beats still read. Size the avatar to fill the left panel, minimum 280 px, scaling with the viewport.

Add a hidden dev route `/avatar-lab` that lists every expression and every animation with buttons, so we can rehearse and verify the renderer.

# UI

Solace brand. Dark mode, because this is developer and architecture content.

- Background Dark Blue `#03213B`, panels Deep Blue `#093B5F`, primary accent Classic Green `#00C895`, secondary accent Sky Blue `#C2F7FF`, alert Orange `#FCA829`, text White.
- Headline font: New Spirit if available, fallback Georgia, title case, never all caps.
- Body: Figtree, fallback system sans.
- Topic strings, payloads and code: Space Mono, fallback ui-monospace, max 16 px.
- Never use secondary colours standalone, always paired with a primary. Body copy is never in a secondary colour. WCAG AA contrast throughout.
- No em dashes anywhere in UI copy.

Layout, 3 columns on desktop, stacked on tablet:

**Left rail, "the agent":** avatar filling the panel, agent name `Discount Bot`, current state as a green mono chip, active LLM provider and model chip, connection status to the broker with VPN name and host, and a small pulse dot per subscribed topic that flashes on each message received.

**Centre, "the mesh":** live event feed, newest at top, capped at 200 rows with virtualisation. Each row is a card styled like the pitch slide: a full-width topic string in mono, the payload summary in one line, an icon, and a coloured left border by category (green = mesh event, magenta = external context, blue = customer or inventory data, orange = tool timeout). Clicking a row expands the full JSON payload and user properties. A `CACHED` or `REQUESTED` badge on every signal row. A filter bar with toggles per topic prefix, and a topic search box.

**Right rail, "the outcome":** the current run as a vertical timeline (trigger, 4 signals, reasoning, draft), then the campaign card: headline, body, offer, audience size with consent basis, target stores, expected units moved, waste avoided, margin impact, confidence bar, and the rationale bullets. Under it, the approval block: the exact approval topic string, the question, and large Yes and No buttons. After a decision, show the dispatch confirmation with the campaign topic and the number of consented recipients, plus a "replay this run" button that republishes the original trigger.

**Header:** Solace logo, demo title, broker connect or disconnect button, scenario buttons, reset button.

**Footer:** counters (events in, events out, tool calls, LLM calls, tokens, estimated cost, average run latency). Latency matters: prospects will ask how long the whole loop takes. Show it in ms.

Every panel needs a one line explainer in Sky Blue, small, so the demo is self-documenting when Raphael shares his screen or leaves the tab open.

# DEMO CONTROLS

Scenario buttons that reconfigure the simulators, then publish a trigger:
1. **Sunny weekend BBQ** (the hero scenario, exactly as the pitch slide): sausage SKU 51001, FR, 30 percent markdown, sunny and dry, no national event, 822 repeat purchasers all consented, 30+ units in 20 stores. Expected outcome: grill bundle micro-campaign, high confidence.
2. **Rain and a national event**: same SKU, wet forecast, a national event flagged. Expected outcome: hold or reframe to an indoor bundle, low confidence, suppression is a valid answer.
3. **Consent squeeze**: 1104 past purchasers but only 96 consented. Expected outcome: campaign shrinks, consent basis called out, no targeting of the other 1008. This is the GDPR beat.
4. **Tool outage**: kill the weather tool service. Expected outcome: amber chip, agent proceeds with 3 signals and says so. This is the decoupling beat.
5. **Storm of updates**: publish 12 price updates in 20 seconds, most below threshold. Expected outcome: 2 runs, 10 suppressions, queueing visible. This is the "does it fire on everything" beat.

Also a `Publish custom event` panel: editable topic and JSON payload with a publish button, so a prospect can throw their own event at the agent live. Prefill with the hero payload.

Keep a `docs/DEMO_SCRIPT.md`: 5 minute run of show, with the exact click order, the one sentence Raphael says at each step, and the two questions to ask the prospect at the end.

# SECURITY

- Password gate: `DEMO_PASSWORD` env var, POST to `/api/login`, httpOnly signed cookie, 8 hour expiry, all `/api/*` routes except login require it. Plus Caddy basic auth in front for defence in depth.
- Broker credentials: accepted over HTTPS, held in memory only, never logged, never persisted, never returned by any GET. Redact anything matching password patterns in all log output. `GET /api/session` returns host, VPN and username only.
- No credentials, tokens or keys in the repo, in git history, or in any default config. Provide `.env.example` only.
- Rate limit `/api/login` to 5 attempts per minute per IP.
- Helmet, strict CSP, no inline scripts except the Vite build output hash, no external CDN calls at runtime. Bundle fonts locally or fall back to system fonts.
- The consent rule is enforced in code, not only in the prompt: filter the audience to consented customers before it reaches the LLM, and assert the campaign audience size never exceeds the consented count. Fail the run loudly if it does. A prospect in a regulated account will test this.

# AWS DEPLOYMENT

Produce both paths and document them in `docs/DEPLOY.md`:

1. **Simple (default):** single EC2 t3.small, Docker Compose with two services, the app and Caddy. Caddy terminates TLS via Let's Encrypt on a subdomain and applies basic auth. One `docker compose up -d`. Include the Caddyfile and the hashed-password generation command.
2. **Team-friendly:** ECS Fargate service behind an ALB, image in ECR, secrets in AWS Secrets Manager, HTTPS listener with ACM. Ship a minimal CDK or Terraform stack, and a single `make deploy`.

Health check at `/healthz` returning broker connection state, LLM provider reachability and version. Structured JSON logs to stdout. Graceful shutdown that disconnects the Solace session cleanly.

# REPO STRUCTURE

```
/assets/discount-bot-avatar.json
/config/topics.ts
/src/server/index.ts
/src/server/solace/session.ts        connect, subscribe, publish, request
/src/server/solace/topics.ts
/src/server/context/store.ts         materialised view + CACHED vs REQUESTED bookkeeping
/src/server/agent/discountBot.ts     state machine
/src/server/agent/prompt.ts          system + user prompt builders
/src/server/agent/schema.ts          zod contracts
/src/server/tools/*.ts               4 mesh request/reply services
/src/server/simulators/*.ts          price feed, weather, news, inventory, consent
/src/server/llm/{index,openai,sapAiCore,mock}.ts
/src/server/http/{auth,stream,routes}.ts
/src/web/App.tsx
/src/web/avatar/{Avatar.tsx,engine.ts,interpolate.ts}
/src/web/panels/{AgentRail,MeshFeed,OutcomeRail,Header,Footer}.tsx
/src/web/styles/brand.css
/docs/{DEMO_SCRIPT,DEPLOY,SAP_AI_SDK,ARCHITECTURE}.md
/Dockerfile /docker-compose.yml /Caddyfile /.env.example /README.md
```

# BUILD ORDER

Work in these increments and confirm each one runs before moving on. Do not write the whole thing then debug.

1. Skeleton, brand CSS, password gate, health check, SSE plumbing with fake events.
2. Avatar renderer plus `/avatar-lab`, all expressions and animations verified visually.
3. Solace session: connect form, subscribe, publish, live feed of real broker messages. Include a `mock broker` mode that keeps the whole demo working with no broker at all, for airport rehearsals.
4. Simulators and the 4 tool services, request/reply proven end to end.
5. ContextStore and the CACHED vs REQUESTED distinction.
6. Agent state machine, LLM layer, zod validation, campaign card.
7. Human approval as an event round trip.
8. Scenario buttons, custom event publisher, counters, replay.
9. Docker, Caddy, AWS docs, demo script.

# ACCEPTANCE CRITERIA

- `npm install && npm run dev` starts everything on one port with no broker and no LLM configured, in `mock` mode, and the hero scenario completes end to end.
- With Solace Cloud credentials entered in the UI, the same run happens over the real broker and every topic string in the taxonomy appears in the feed.
- The approval Yes button results in a `human-approval/decision` event on the mesh, which the agent consumes, before any dispatch event is published. Verifiable in the feed ordering.
- Killing the weather tool mid-run degrades the run instead of failing it.
- Audience size never exceeds the consented count, enforced in code, with a test.
- No credentials appear in any log line, any HTTP response, or any file on disk.
- Avatar reflects agent state within 300 ms of a state change.
- Full hero run completes in under 15 seconds with a local LLM proxy.
- No em dashes in any UI string, doc or comment.

# NON GOALS

No real customer data, no real marketing dispatch, no persistence, no multi-tenant, no user accounts, no mobile-first layout, no Kubernetes.

# WHEN YOU ARE DONE

Print: the local URL, the demo password, the list of every topic the demo publishes and subscribes to, the env vars a SAP prospect must set to switch to SAP AI Core, and the 5 minute demo script in the terminal.

Ask me only about decisions you genuinely cannot make yourself. Prefer a sensible default plus a documented env var over a question.
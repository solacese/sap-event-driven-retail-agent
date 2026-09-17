# Discount Bot

A Solace event-driven retail pricing agent demo. The one sentence it exists to prove: agents are only as good as the events they can see.

Discount Bot is a retail pricing agent that lives on a Solace event mesh. It does not poll systems and it does not sit behind a chat box. A price change event lands on the mesh, the agent wakes up, correlates real-time context it is already subscribed to, calls tools over the mesh, reasons with an LLM through a pluggable enterprise AI SDK, then asks a human for approval by publishing an approval event. Every step is an event on the mesh, so it is observable, replayable and auditable. No em dashes appear anywhere in this project.

## Quick start

```bash
npm install && npm run dev
```

Then:

1. Open http://localhost:5173
2. Enter the password `solace` (env `DEMO_PASSWORD`)
3. Click the "Sunny weekend BBQ" scenario button in the header

That is the hero run. It completes end to end with no broker and no LLM configured, because the demo defaults to a mock broker and an auto-detected or mock LLM.

In dev, Vite serves the UI on http://localhost:5173 and proxies `/api` to the gateway on port 8080. For a production-style single-port run:

```bash
npm run build && npm start
```

which serves everything on http://localhost:8080.

## What you will see

- The avatar on the left reacts to agent state (sleeping, surprised, searching, thinking, excited, listening, celebrating).
- The centre mesh feed shows every event live, newest at the top, colour-coded by category, with a `CACHED` or `REQUESTED` badge on each signal.
- The right rail shows the run timeline, the drafted campaign card, and the human approval block.
- The header shows the active LLM provider and model as a mono chip.
- The footer shows counters: events in and out, tool calls, LLM calls, tokens, estimated cost, average run latency in ms.

## Mock broker vs Solace broker

- Default is `BROKER_MODE=mock`, an in-process bus that fans out to the same wildcard subscriptions the real broker would. The whole demo runs with no broker, which is ideal for rehearsals and offline demos.
- Enter real Solace Cloud or customer credentials in the UI to switch to `BROKER_MODE=solace`. The same run then happens over the real broker and every topic in the taxonomy appears in the feed.
- Broker credentials are held in memory server-side only. They are never returned by any GET, never written to disk, and never logged. The browser never talks to the broker directly.

## LLM auto-detection

The LLM layer uses an adapter pattern (`LLM_PROVIDER`): `openai_compatible` (default), `sap_ai_core`, or `mock`.

By default the app probes for a local OpenAI-compatible proxy in this order and uses the first that answers:

1. `http://localhost:4000/v1` (LiteLLM)
2. `http://localhost:8000/v1`
3. `http://localhost:1234/v1` (LM Studio)
4. `http://localhost:11434/v1` (Ollama)

If none answer, it falls back to a deterministic mock LLM, so the demo always runs with zero external services.

### Running LiteLLM

Via Docker Compose:

```bash
docker compose --profile llm up -d litellm
```

Or locally with pip:

```bash
pip install 'litellm[proxy]'
litellm --config litellm.config.yaml --port 4000
```

LiteLLM fronts a local Ollama by default (see `litellm.config.yaml`) and exposes an OpenAI-compatible API on port 4000, which the app probes first. To run through SAP AI Core instead, see [docs/SAP_AI_SDK.md](docs/SAP_AI_SDK.md).

## Scenarios

Scenario buttons reconfigure the simulators and publish a trigger:

1. Sunny weekend BBQ: the hero scenario, grill bundle micro-campaign, high confidence.
2. Rain and a national event: hold or reframe to an indoor bundle, suppression is a valid answer.
3. Consent squeeze: campaign shrinks to consented customers only, the GDPR beat.
4. Tool outage: the weather tool is killed, the agent degrades to three signals, the decoupling beat.
5. Storm of updates: twelve price updates in twenty seconds, two runs and ten suppressions, the does-it-fire-on-everything beat.

There is also a custom event publisher (editable topic and JSON payload) and a replay button that republishes the original trigger of a run.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the Bus abstraction, the four roles, ContextStore, the agent state machine, request/reply, approval round trip, SSE, and the full topic taxonomy.
- [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md): a tight five minute run of show.
- [docs/SAP_AI_SDK.md](docs/SAP_AI_SDK.md): switching the LLM to SAP AI Core.
- [docs/DEPLOY.md](docs/DEPLOY.md): the simple EC2 path and the ECS Fargate path.

## Security notes

- Password gate via `DEMO_PASSWORD`, an httpOnly signed cookie with an 8 hour expiry, all `/api/*` routes except login require it, and login is rate limited.
- Broker credentials are in memory only, never logged, never persisted, never returned by any GET. `GET /api/session` returns host, VPN and username only.
- No credentials, tokens or keys are in the repo or in git history. Only `.env.example` is provided.
- Helmet with a strict CSP, no external CDN calls at runtime, fonts fall back to system fonts.
- Consent is enforced in code, not only in the prompt: the audience is filtered to consented customers before it reaches the LLM, and the campaign audience size can never exceed the consented count.
- `GET /healthz` returns broker connection state, LLM provider reachability and version. Graceful shutdown disconnects the Solace session cleanly.

## Non goals

- No real customer data.
- No real marketing dispatch.
- No persistence, no database.
- No multi-tenant, no user accounts.
- No mobile-first layout.
- No Kubernetes.

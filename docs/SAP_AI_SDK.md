# Switching Discount Bot to SAP AI Core

Discount Bot uses an adapter pattern for the LLM layer. The default is an OpenAI-compatible local proxy, but a SAP prospect can run the exact same demo through SAP AI Core by setting a handful of environment variables. This document lists them precisely and explains what changes on screen: nothing except the header provider chip. That is the point of the co-sell.

No em dashes are used anywhere in this file.

## How the provider is selected

`src/server/llm/index.ts` reads `LLM_PROVIDER` and resolves one of three providers:

- `openai_compatible` (default): explicit `LLM_BASE_URL`, or auto-detected local proxy.
- `sap_ai_core`: SAP AI Core via `@sap-ai-sdk/orchestration`.
- `mock`: deterministic canned campaign, no network.

The SAP path is implemented in `src/server/llm/sapAiCore.ts` behind the same `complete(messages, { schema })` interface as every other provider, so the agent code does not change when you switch.

## The env vars a SAP prospect sets

| Variable | Purpose |
|---|---|
| `LLM_PROVIDER=sap_ai_core` | Selects the SAP AI Core provider. |
| `AICORE_SERVICE_KEY` | The full SAP AI Core service key, as a single JSON string. Holds `clientid`, `clientsecret`, `url` and the AI API service URL. |
| `AICORE_DEPLOYMENT_ID` | The deployment id of your orchestration or model deployment in SAP AI Core. |
| `AICORE_RESOURCE_GROUP` | The AI Core resource group. Commonly `default`. |
| `AICORE_MODEL` | The model to route to through orchestration, for example `gpt-4o`. |

`AICORE_SERVICE_KEY` is the JSON you download from the SAP BTP service key screen. Paste it as one line. It is a credential, so keep it out of git and out of any committed config, exactly like broker credentials.

## It is optional and loaded lazily

`@sap-ai-sdk/orchestration` is declared as an `optionalDependency` in `package.json`. The SAP module is imported lazily inside `sapAiCore.ts`, only when `LLM_PROVIDER=sap_ai_core` is active and a completion is requested.

This means a missing SAP credential or a missing package can never break `npm run dev`. If `AICORE_SERVICE_KEY` is not set, or the package is not installed, the resolver logs a warning and falls back to the mock provider so the demo still runs end to end. You never dead-end on stage.

## What changes on screen

Nothing except the header provider chip.

- With the default local proxy the chip reads something like `local proxy / gpt-4o`.
- With SAP AI Core active the chip reads `SAP AI Core / gpt-4o`.

The events, the mesh, the CACHED versus REQUESTED signals, the approval round trip, the campaign card and every other beat are identical. When a prospect sees their own SDK named on screen while everything else stays the same, the message is clear: the mesh and the agent pattern are unchanged, only the model provider swapped.

## Copy-paste .env snippet

```bash
# Switch Discount Bot to SAP AI Core
LLM_PROVIDER=sap_ai_core

# Paste the full service key JSON on one line
AICORE_SERVICE_KEY={"clientid":"...","clientsecret":"...","url":"https://<subaccount>.authentication.<region>.hana.ondemand.com","serviceurls":{"AI_API_URL":"https://api.ai.<region>.ml.hana.ondemand.com"}}

# Your orchestration or model deployment
AICORE_DEPLOYMENT_ID=your-deployment-id
AICORE_RESOURCE_GROUP=default
AICORE_MODEL=gpt-4o
```

If the package was skipped during install, add it explicitly:

```bash
npm install @sap-ai-sdk/orchestration
```

Then restart the server. The header chip will read `SAP AI Core / gpt-4o` and the demo runs exactly as before.

// ---------------------------------------------------------------------------
// Typed fetch helpers for every REST endpoint the UI calls. All requests use
// credentials 'same-origin' so the signed session cookie rides along.
// ---------------------------------------------------------------------------
import type { Connection } from './types.js';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new ApiError(res.status, detail || res.statusText);
  }
  // Some endpoints reply 204 or empty bodies.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ConnectForm {
  url: string;
  vpn: string;
  username: string;
  password: string;
  // Optional Solace topic subscription that arms the agent's trigger. When
  // blank the server uses the built-in price-updated wildcard.
  triggerTopic?: string;
}

// One-click preset for the shared AEM playground broker. Connectivity to these
// credentials has been verified end-to-end (connect + subscribe + publish
// round-trip). Surfaced as a "Connect to AEM broker" button in Broker settings.
export const AEM_BROKER: ConnectForm = {
  url: 'wss://mr-connection-0aakxdcizei.messaging.solace.cloud:443',
  vpn: 'aem-playground-shared',
  username: 'solace-cloud-client',
  password: 'REPLACE_ME',
  triggerTopic: 'acme/retail/shopfloor/price/updated/v1/>',
};

export const api = {
  login: (password: string) =>
    jsonFetch<{ ok: boolean }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  session: () => jsonFetch<Connection>('/api/session'),

  connect: (form: ConnectForm) =>
    jsonFetch<Connection>('/api/session/connect', {
      method: 'POST',
      body: JSON.stringify(form),
    }),

  connectMock: () =>
    jsonFetch<Connection>('/api/session/connect', {
      method: 'POST',
      body: JSON.stringify({ mock: true }),
    }),

  disconnect: () => jsonFetch<Connection>('/api/session/disconnect', { method: 'POST' }),

  avatar: () => jsonFetch<unknown>('/api/avatar'),

  approval: (runId: string, decision: 'yes' | 'no') =>
    jsonFetch<{ ok: boolean }>(`/api/approval/${encodeURIComponent(runId)}`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }),

  budgetTopUp: (topUpId: string, decision: 'yes' | 'no') =>
    jsonFetch<{ ok: boolean }>(`/api/budget/${encodeURIComponent(topUpId)}`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }),

  scenario: (name: string) =>
    jsonFetch<{ ok: boolean }>(`/api/scenario/${encodeURIComponent(name)}`, { method: 'POST' }),

  // Public (no-login) swipe-page decision: publishes the same yes/no decision
  // EVENT to the mesh as /api/approval, via a narrow rate-limited endpoint so a
  // phone can play the swipe game without the demo password.
  swipeApproval: (runId: string, decision: 'yes' | 'no') =>
    jsonFetch<{ ok: boolean }>(`/api/swipe/approval/${encodeURIComponent(runId)}`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }),

  // Public (no-login) swipe-page dealer: fire a named scenario without auth so
  // the phone's "Deal a round" button can stock its own deck.
  swipeDeal: (name: string) =>
    jsonFetch<{ ok: boolean }>(`/api/swipe/deal/${encodeURIComponent(name)}`, { method: 'POST' }),

  scenarioFreetext: (text: string) =>
    jsonFetch<{ ok: boolean; source: 'llm' | 'heuristic' }>('/api/scenario-freetext', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  publish: (topic: string, payload: unknown) =>
    jsonFetch<{ ok: boolean }>('/api/publish', {
      method: 'POST',
      body: JSON.stringify({ topic, payload }),
    }),

  reset: () => jsonFetch<{ ok: boolean }>('/api/reset', { method: 'POST' }),

  setLlmModel: (model: string) =>
    jsonFetch<{ provider: string; model: string; baseUrl?: string }>('/api/llm/model', {
      method: 'POST',
      body: JSON.stringify({ model }),
    }),

  health: () => jsonFetch<unknown>('/healthz'),
};

// The agent's selectable LLM. Cosmetic for the demo - the mock provider runs the
// campaign either way - but the chosen label rides through to every client, and
// each model tints the avatar (body/eyes) so switching is visible at a glance.
export interface LlmModel {
  value: string;
  label: string;
  hint: string;
  palette: { body: string; eyes: string };
}

export const LLM_MODELS: LlmModel[] = [
  { value: 'GPT 5.6', label: 'GPT 5.6', hint: 'Top eval score', palette: { body: '#5b7fe5', eyes: '#111316' } },
  { value: 'Claude Sonnet 5', label: 'Claude Sonnet 5', hint: 'Best SLA', palette: { body: '#d98a3d', eyes: '#2a1c10' } },
  { value: 'GLM 5.3', label: 'GLM 5.3', hint: 'Cheapest', palette: { body: '#2fa98a', eyes: '#0f1a17' } },
];

// The four dynamic-pricing scenarios surfaced as toolbar buttons, plus a
// free-text box (handled separately). The server still supports the legacy
// sunny-bbq, world-cup, rain-event, consent-squeeze, tool-outage and storm
// scenarios via the API; they're just not surfaced here any more.
export const SCENARIOS: { name: string; label: string; hint: string; desc: string; emoji: string }[] = [
  {
    name: 'rainy-umbrella',
    label: 'Rainy weekend',
    emoji: '☔',
    hint: 'Rain + low stock → +15% surge',
    desc: 'A washout weekend and tight umbrella stock. The agent correlates weather, stock and demand, then proposes a temporary +15% surge for approval.',
  },
  {
    name: 'ube-bundle',
    label: 'Ube fever',
    emoji: '🍠',
    hint: 'Trend + hit show → bundle',
    desc: 'Ube is trending online and a new season of The Mentalist drives cosy-night-in demand. The agent proposes bundling ube spread with butter biscuits.',
  },
  {
    name: 'heatwave-icecream',
    label: 'Heatwave rush',
    emoji: '🍦',
    hint: 'Overstock → −20% clearance',
    desc: 'The heatwave broke and ice cream is overstocked with days of cover left. The agent proposes a −20% clearance markdown to protect the stock.',
  },
  {
    name: 'viral-snack',
    label: 'Viral snack',
    emoji: '🌶️',
    hint: 'Going viral → +10% surge',
    desc: 'Chili-lime chips are exploding on social with limited stock. The agent proposes a temporary +10% surge while the trend runs hot.',
  },
];

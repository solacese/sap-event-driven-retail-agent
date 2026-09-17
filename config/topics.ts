// ---------------------------------------------------------------------------
// Topic taxonomy. Single source of truth for every topic string in the demo.
// Solace uses "/" as the level separator. TOPIC_ROOT rebrands per prospect in
// one line (default "acme/retail"). All builders normalise to "/".
// ---------------------------------------------------------------------------

export const TOPIC_ROOT = (process.env.TOPIC_ROOT || 'acme/retail').replace(/\/+$/, '');

const r = TOPIC_ROOT;

/** Category used for UI colour-coding of feed rows. */
export type TopicCategory = 'mesh' | 'context' | 'data' | 'tool';

// --- Context streams the agent subscribes to (materialised into ContextStore) ---
export const CONTEXT_TOPICS = {
  priceUpdated: (country = '*', region = '*', sku = '*') =>
    `${r}/shopfloor/price/updated/v1/${country}/${region}/${sku}`,
  weatherForecast: (country = '*') => `${r}/weather/forecast/updated/v1/${country}`,
  newsNationalEvent: (country = '*') => `${r}/news/national-event/flagged/v1/${country}`,
  stockLevel: (storeId = '*', sku = '*') =>
    `${r}/inventory/stock-level/changed/v1/${storeId}/${sku}`,
  consentUpdated: (customerId = '*') => `${r}/customer/consent/updated/v1/${customerId}`,
};

// Wildcard subscriptions the agent installs on connect.
export const CONTEXT_SUBSCRIPTIONS = [
  `${r}/shopfloor/price/updated/v1/>`,
  `${r}/weather/forecast/updated/v1/>`,
  `${r}/news/national-event/flagged/v1/>`,
  `${r}/inventory/stock-level/changed/v1/>`,
  `${r}/customer/consent/updated/v1/>`,
];

// --- Tool request/reply (agent is requestor, TOOLS are repliers) ---
export const TOOL_TOPICS = {
  weatherRequest: (country: string) => `${r}/tools/weather/request/v1/${country}`,
  newsRequest: (country: string) => `${r}/tools/news/request/v1/${country}`,
  inventoryRequest: (sku: string) => `${r}/tools/inventory/request/v1/${sku}`,
  customerInterestRequest: (sku: string) => `${r}/tools/customer-interest/request/v1/${sku}`,
};

// Wildcard subscriptions each tool service installs.
export const TOOL_SUBSCRIPTIONS = {
  weather: `${r}/tools/weather/request/v1/>`,
  news: `${r}/tools/news/request/v1/>`,
  inventory: `${r}/tools/inventory/request/v1/>`,
  customerInterest: `${r}/tools/customer-interest/request/v1/>`,
};

// --- Events the agent publishes ---
export const AGENT_TOPICS = {
  runStarted: (runId: string) => `${r}/agents/discount-bot/v1/run/started/${runId}`,
  signal: (signalName: string, runId: string) =>
    `${r}/agents/discount-bot/v1/signal/${signalName}/${runId}`,
  campaignDrafted: (runId: string) => `${r}/agents/discount-bot/v1/campaign/drafted/${runId}`,
  humanApproval: (runId: string) => `${r}/agents/discount-bot/v1/human-approval/${runId}`,
  approvalDecision: (runId: string) =>
    `${r}/agents/discount-bot/v1/human-approval/decision/${runId}`,
  campaignDispatch: (country: string, campaignId: string) =>
    `${r}/marketing/campaign/dispatch/requested/v1/${country}/${campaignId}`,
  runSuppressed: (runId: string) => `${r}/agents/discount-bot/v1/run/suppressed/${runId}`,
};

// The agent subscribes to its own approval-decision topic (human-in-the-loop
// round trip happens over the mesh, not the HTTP call).
export const AGENT_SUBSCRIPTIONS = [`${r}/agents/discount-bot/v1/human-approval/decision/>`];

/** Classify any topic string into a UI colour category. */
export function categorise(topic: string): TopicCategory {
  if (topic.includes('/tools/')) return 'tool';
  if (topic.includes('/weather/') || topic.includes('/news/')) return 'context';
  if (topic.includes('/inventory/') || topic.includes('/customer/')) return 'data';
  return 'mesh';
}

/** All wildcard subscriptions a full in-process demo installs, for mock bus fan-out. */
export const ALL_SUBSCRIPTIONS = [
  ...CONTEXT_SUBSCRIPTIONS,
  ...Object.values(TOOL_SUBSCRIPTIONS),
  ...AGENT_SUBSCRIPTIONS,
];

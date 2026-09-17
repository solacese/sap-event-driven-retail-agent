// ---------------------------------------------------------------------------
// Client-side mirror of the server runtime types. Kept in sync with
// src/server/types.ts, src/server/hub.ts and config/topics.ts by hand so the
// web bundle never imports server code.
// ---------------------------------------------------------------------------

export type AgentState =
  | 'disconnected'
  | 'connecting'
  | 'idle'
  | 'triggered'
  | 'gathering'
  | 'reasoning'
  | 'drafted'
  | 'awaiting_approval'
  | 'dispatched'
  | 'suppressed'
  | 'error';

export type TopicCategory = 'mesh' | 'context' | 'data' | 'tool';

export interface UserProperties {
  runId?: string;
  correlationId?: string;
  agent?: string;
  agentVersion?: string;
  sku?: string;
  country?: string;
  emittedAt?: string;
  schemaVersion?: string;
  [k: string]: string | undefined;
}

export interface FeedEvent {
  id: string;
  topic: string;
  payload: unknown;
  userProperties: UserProperties;
  direction: 'in' | 'out';
  category: TopicCategory;
  summary: string;
  receivedAt: string;
  sourceTag?: 'CACHED' | 'REQUESTED';
  toolTimeout?: boolean;
}

export interface Counters {
  eventsIn: number;
  eventsOut: number;
  toolCalls: number;
  llmCalls: number;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  lastRunLatencyMs: number;
  avgRunLatencyMs: number;
  runsCompleted: number;
  budgetCapUsd: number;
  budgetSpentUsd: number;
  budgetFillPct: number;
  budgetExhausted: boolean;
}

// A pending budget top-up approval: raised when the budget bar reaches 100%.
export interface BudgetTopUp {
  topUpId: string;
  question: string;
}

export interface LlmInfo {
  provider: string;
  model: string;
  baseUrl?: string;
}

export interface ConnectionInfo {
  host: string;
  vpn: string;
  username: string;
}

export interface Connection {
  connected: boolean;
  info: ConnectionInfo | null;
  brokerKind: 'mock' | 'solace' | null;
}

// ---- Agent run events (emitted by the backend during a run) ----

export type SignalName = 'weather' | 'news' | 'inventory' | 'customer_interest' | string;
export type SignalStatus = 'pending' | 'resolved' | 'unavailable';
export type SourceTag = 'CACHED' | 'REQUESTED';

export interface RunSignal {
  name: SignalName;
  sourceTag: SourceTag;
  status: SignalStatus;
  data?: unknown;
}

export interface CampaignOffer {
  type: 'percentage' | 'bundle' | 'multibuy' | string;
  value: string;
}

export interface CampaignAudience {
  segment: string;
  size: number;
  consentBasis: string;
}

export interface Campaign {
  campaignId: string;
  sku: string;
  headline: string;
  body: string;
  channel: 'push' | 'email' | 'sms' | string;
  offer: CampaignOffer;
  bundleWith?: string[];
  audience: CampaignAudience;
  targetStores: string[];
  sendWindow?: { startsAt: string; endsAt: string };
  expectedUnitsMoved: number;
  marginImpactEur: number;
  wasteAvoidedUnits: number;
  revenueProtectedEur: number;
  confidence: number;
  rationale: string[];
  signalsUsed: string[];
  signalsUnavailable: string[];
  guardrails?: { consentEnforced: boolean; humanApprovalRequired: boolean };
}

export interface RunTimeline {
  runId: string;
  sku?: string;
  trigger?: unknown;
  signals: RunSignal[];
  campaign?: Campaign;
  llmFallback?: boolean;
  // Estimated USD cost of the LLM call(s) for this run (from campaign:drafted).
  costUsd?: number;
  approval?: ApprovalRequest;
  decision?: 'yes' | 'no';
  dispatch?: DispatchInfo;
  // Set when the run was dispatched automatically (revenue protected under the
  // auto-accept threshold), i.e. no human approval was required.
  autoAccepted?: boolean;
  suppressed?: { reason: string };
  startedAt: number;
  // Client wall-clock (ms) captured the moment the campaign draft arrived.
  // Used to show trigger -> proposed-campaign latency in the UI.
  draftedAt?: number;
}

export interface ApprovalRequest {
  runId: string;
  topic: string;
  question: string;
  campaignId?: string;
}

export interface DispatchInfo {
  runId: string;
  topic: string;
  recipients: number;
  campaignId?: string;
}

export interface Suppression {
  runId: string;
  reason: string;
  at: number;
}

// ---- SSE message union ----
export interface SseMessage {
  type: string;
  [k: string]: unknown;
}

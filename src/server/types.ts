// ---------------------------------------------------------------------------
// Shared runtime types and the Bus abstraction. Bus is the single seam between
// the mock in-process broker (airport rehearsals, no network) and real Solace.
// Every module publishes/subscribes/requests through Bus and never touches
// solclientjs directly.
// ---------------------------------------------------------------------------
import type { TopicCategory } from '../../config/topics.js';

export type AgentState =
  | 'disconnected'
  | 'idle'
  | 'triggered'
  | 'gathering'
  | 'reasoning'
  | 'drafted'
  | 'awaiting_approval'
  | 'dispatched'
  | 'suppressed'
  | 'error';

/** User properties carried on every published mesh message. */
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

export interface MeshMessage {
  topic: string;
  payload: unknown;
  userProperties: UserProperties;
}

/** A message as surfaced to the UI feed. */
export interface FeedEvent extends MeshMessage {
  id: string;
  direction: 'in' | 'out';
  category: TopicCategory;
  summary: string;
  receivedAt: string;
  /** signal rows are tagged CACHED (materialised) or REQUESTED (mesh request). */
  sourceTag?: 'CACHED' | 'REQUESTED';
  toolTimeout?: boolean;
}

export type MessageHandler = (msg: MeshMessage) => void;

export interface RequestOptions {
  timeoutMs?: number;
}

/**
 * The broker abstraction. Implemented by MockBus (in-process) and SolaceBus.
 */
export interface Bus {
  readonly kind: 'mock' | 'solace';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  subscribe(topicFilter: string, handler: MessageHandler): void;
  publish(msg: MeshMessage): void;
  /** request/reply with reply-to correlation. Rejects on timeout. */
  request(topic: string, payload: unknown, opts?: RequestOptions): Promise<MeshMessage>;
  /** register a responder for a request topic filter (used by tool services). */
  respond(topicFilter: string, responder: (msg: MeshMessage) => Promise<unknown> | unknown): void;
  info(): { host: string; vpn: string; username: string } | null;
}

export interface ConnectionInfo {
  host: string;
  vpn: string;
  username: string;
}

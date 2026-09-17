// ---------------------------------------------------------------------------
// MockBus: an in-process event mesh that behaves like a Solace direct-messaging
// session, including request/reply with reply-to correlation and > / * topic
// wildcards. Lets the entire demo run on a laptop with no broker at all.
// ---------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';
import type { Bus, MeshMessage, MessageHandler, RequestOptions } from '../types.js';
import { makeLogger } from '../log.js';
import { topicMatches } from './topics.js';

const log = makeLogger('SOLACE');

interface Sub {
  filter: string;
  handler: MessageHandler;
}
interface Responder {
  filter: string;
  fn: (msg: MeshMessage) => Promise<unknown> | unknown;
}

export class MockBus implements Bus {
  readonly kind = 'mock' as const;
  private connected = false;
  private subs: Sub[] = [];
  private responders: Responder[] = [];

  async connect(): Promise<void> {
    this.connected = true;
    log.info('mock bus connected (in-process, no network)');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.subs = [];
    this.responders = [];
    log.info('mock bus disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  subscribe(topicFilter: string, handler: MessageHandler): void {
    this.subs.push({ filter: topicFilter, handler });
  }

  respond(topicFilter: string, fn: (msg: MeshMessage) => Promise<unknown> | unknown): void {
    this.responders.push({ filter: topicFilter, fn });
  }

  publish(msg: MeshMessage): void {
    if (!this.connected) return;
    // Deliver asynchronously so publish never reenters a handler synchronously.
    queueMicrotask(() => {
      for (const s of this.subs) {
        if (topicMatches(s.filter, msg.topic)) {
          try {
            s.handler(msg);
          } catch (e) {
            log.error('subscriber handler threw', { topic: msg.topic, error: String(e) });
          }
        }
      }
    });
  }

  request(topic: string, payload: unknown, opts?: RequestOptions): Promise<MeshMessage> {
    const timeoutMs = opts?.timeoutMs ?? 4000;
    const correlationId = randomUUID();
    return new Promise<MeshMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`request timeout after ${timeoutMs}ms on ${topic}`));
      }, timeoutMs);

      const responder = this.responders.find((r) => topicMatches(r.filter, topic));
      const reqMsg: MeshMessage = {
        topic,
        payload,
        userProperties: { correlationId },
      };

      if (!responder) {
        // No service listening: behave like a broker with no consumer -> timeout.
        return;
      }

      Promise.resolve()
        .then(() => responder.fn(reqMsg))
        .then((replyPayload) => {
          clearTimeout(timer);
          resolve({
            topic: `${topic}/reply`,
            payload: replyPayload,
            userProperties: { correlationId },
          });
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  info() {
    return { host: 'in-process://mock', vpn: 'mock', username: 'mock' };
  }
}

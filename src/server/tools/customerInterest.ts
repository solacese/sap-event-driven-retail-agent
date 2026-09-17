// ---------------------------------------------------------------------------
// Customer-interest tool service. Replies with exact audience counts (past
// purchasers, repeat buyers, consented vs withheld) from the world scenario so
// the agent can do precise, consent-aware audience math.
// ---------------------------------------------------------------------------
import type { Bus, MeshMessage } from '../types.js';
import { TOOL_SUBSCRIPTIONS } from '../../../config/topics.js';
import { customerInterestReplySchema } from '../agent/schema.js';
import { normalise } from '../solace/topics.js';
import { makeLogger } from '../log.js';
import { world } from '../simulators/world.js';

const log = makeLogger('TOOLS');

function lastLevel(topic: string): string {
  const parts = normalise(topic).split('/');
  return parts[parts.length - 1];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function register(bus: Bus) {
  bus.respond(TOOL_SUBSCRIPTIONS.customerInterest, async (msg: MeshMessage) => {
    const sku = lastLevel(msg.topic);
    await delay(150 + Math.floor(Math.random() * 250));
    const reply = world.customerInterestReply();
    reply.sku = sku;
    log.info('customer-interest reply', {
      sku,
      marketingConsented: reply.marketingConsented,
      consentWithheld: reply.consentWithheld,
    });
    return customerInterestReplySchema.parse(reply);
  });
}

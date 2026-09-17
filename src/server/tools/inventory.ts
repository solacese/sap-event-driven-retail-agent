// ---------------------------------------------------------------------------
// Inventory tool service. Replies with per-store stock and at-risk units for a
// SKU, aggregated from the world scenario.
// ---------------------------------------------------------------------------
import type { Bus, MeshMessage } from '../types.js';
import { TOOL_SUBSCRIPTIONS } from '../../../config/topics.js';
import { inventoryReplySchema } from '../agent/schema.js';
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
  bus.respond(TOOL_SUBSCRIPTIONS.inventory, async (msg: MeshMessage) => {
    const sku = lastLevel(msg.topic);
    await delay(150 + Math.floor(Math.random() * 250));
    const reply = world.inventoryReply();
    // Honour the requested SKU in the reply topic argument.
    reply.sku = sku;
    log.info('inventory reply', {
      sku,
      stores: reply.stores.length,
      atRiskUnits: reply.atRiskUnits,
    });
    return inventoryReplySchema.parse(reply);
  });
}

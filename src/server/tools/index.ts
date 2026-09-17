// ---------------------------------------------------------------------------
// Tool service registration. Wires all four request/reply responders onto the
// bus so the agent can gather signals it does not already have cached.
// ---------------------------------------------------------------------------
import type { Bus } from '../types.js';
import { register as registerWeather } from './weather.js';
import { register as registerNews } from './news.js';
import { register as registerInventory } from './inventory.js';
import { register as registerCustomerInterest } from './customerInterest.js';
import { makeLogger } from '../log.js';

const log = makeLogger('TOOLS');

export function registerTools(bus: Bus) {
  registerWeather(bus);
  registerNews(bus);
  registerInventory(bus);
  registerCustomerInterest(bus);
  log.info('tool services registered', {
    tools: ['weather', 'news', 'inventory', 'customerInterest'],
  });
}

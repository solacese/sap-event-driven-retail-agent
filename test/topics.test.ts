import { describe, it, expect } from 'vitest';
import { topicMatches, normalise } from '../src/server/solace/topics.js';

describe('solace topic matching', () => {
  it('matches exact topics', () => {
    expect(topicMatches('a/b/c', 'a/b/c')).toBe(true);
    expect(topicMatches('a/b/c', 'a/b/d')).toBe(false);
  });
  it('* matches exactly one level', () => {
    expect(topicMatches('a/*/c', 'a/b/c')).toBe(true);
    expect(topicMatches('a/*/c', 'a/b/x/c')).toBe(false);
  });
  it('> matches one or more trailing levels', () => {
    expect(topicMatches('a/b/>', 'a/b/c')).toBe(true);
    expect(topicMatches('a/b/>', 'a/b/c/d/e')).toBe(true);
    expect(topicMatches('a/b/>', 'a/b')).toBe(false);
  });
  it('normalises separators', () => {
    expect(normalise('a.b.c')).toBe('a/b/c');
    expect(normalise('/a//b/')).toBe('a/b');
  });
  it('matches the real price topic against the subscription', () => {
    expect(
      topicMatches('acme/retail/shopfloor/price/updated/v1/>', 'acme/retail/shopfloor/price/updated/v1/FR/EMEA/51001'),
    ).toBe(true);
  });
});

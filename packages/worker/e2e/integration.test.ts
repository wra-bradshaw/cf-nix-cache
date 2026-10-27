import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  closeFixture,
  createFixture,
  type E2eFixture,
} from './support/harness';
import { runCacheRoundTrip } from './scenarios/cache-round-trip';

describe('full local cache flow', () => {
  let fixture: E2eFixture | undefined;

  beforeAll(
    async () => {
      fixture = await createFixture();
    },
    15 * 60 * 1000,
  );

  afterAll(
    async () => {
      if (fixture) await closeFixture(fixture);
    },
    15 * 60 * 1000,
  );

  it(
    'pushes, processes, signs, ranges, and copies a real Nix closure',
    async () => {
      if (!fixture) throw new Error('e2e harness was not initialized');
      await runCacheRoundTrip(fixture);
    },
    15 * 60 * 1000,
  );
});

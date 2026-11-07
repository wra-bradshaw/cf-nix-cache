import { describe, expect, it } from 'vitest';
import { deleteCacheWorkflowId } from './enqueue';

describe('workflow instance ids', () => {
  it('uses the characters and length Cloudflare accepts', () => {
    const id = deleteCacheWorkflowId('67aea408-622d-4a82-ac6c-88aa4bfd092a');
    expect(id).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/);
    expect(id.length).toBeLessThanOrEqual(100);
  });
});

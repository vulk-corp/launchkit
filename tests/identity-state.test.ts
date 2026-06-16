import { describe, expect, it, vi } from 'vitest';

describe('identity state', () => {
  it('survives separate module instances created by CDN chunk splitting', async () => {
    const first = await import('../src/identity-state');
    first.resetIdentity();
    first.setIdentity('alice@example.com', 'user_42');

    vi.resetModules();

    const second = await import('../src/identity-state');
    expect(second.getIdentity()).toEqual({
      email: 'alice@example.com',
      userId: 'user_42',
    });

    second.resetIdentity();
  });
});

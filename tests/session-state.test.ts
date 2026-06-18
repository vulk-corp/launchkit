import { getReplaySessionId, setReplaySessionId } from '../src/session-state';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

describe('session-state holder', () => {
  afterEach(() => {
    setReplaySessionId(null);
  });

  it('returns null before any session is set', () => {
    expect(getReplaySessionId()).toBeNull();
  });

  it('returns the session id after set', () => {
    setReplaySessionId(SESSION_A);
    expect(getReplaySessionId()).toBe(SESSION_A);
  });

  it('overwrites the previous session id on a new set', () => {
    setReplaySessionId(SESSION_A);
    setReplaySessionId(SESSION_B);
    expect(getReplaySessionId()).toBe(SESSION_B);
  });

  it('clears to null when set to null', () => {
    setReplaySessionId(SESSION_A);
    setReplaySessionId(null);
    expect(getReplaySessionId()).toBeNull();
  });
});

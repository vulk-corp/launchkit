import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_LENGTH,
  MAX_STACK_LENGTH,
  MAX_URL_LENGTH,
  sanitizeAndTruncate,
  truncateMessage,
} from '../src/normalize-thrown';

/** True when the string contains no unpaired surrogate code units. */
function isWellFormedUtf16(value: string): boolean {
  try {
    // encodeURIComponent throws URIError on lone surrogates.
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

describe('truncateMessage', () => {
  it('returns short messages unchanged', () => {
    expect(truncateMessage('boom')).toBe('boom');
  });

  it('returns a message of exactly MAX_MESSAGE_LENGTH unchanged', () => {
    const exact = 'x'.repeat(MAX_MESSAGE_LENGTH);
    expect(truncateMessage(exact)).toBe(exact);
  });

  it('message_truncated_5000: cuts oversized messages to the server cap', () => {
    expect(truncateMessage('x'.repeat(10_000)).length).toBe(MAX_MESSAGE_LENGTH);
  });

  it('truncate_surrogate_safe: never ends on a lone high surrogate', () => {
    // Emoji straddles the cut point: chars 4999-5000 are the surrogate pair.
    const message = 'B'.repeat(MAX_MESSAGE_LENGTH - 1) + '\u{1F4A5}' + 'tail';
    const result = truncateMessage(message);

    expect(result.length).toBe(MAX_MESSAGE_LENGTH - 1);
    const last = result.charCodeAt(result.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    // The payload must survive UTF-8 encoding end to end.
    expect(isWellFormedUtf16(result)).toBe(true);
  });

  it('keeps a complete surrogate pair that ends exactly at the cap', () => {
    // Pair occupies chars 4998-4999: the cut lands after the pair.
    const message = 'B'.repeat(MAX_MESSAGE_LENGTH - 2) + '\u{1F4A5}' + 'tail';
    const result = truncateMessage(message);

    expect(result.length).toBe(MAX_MESSAGE_LENGTH);
    expect(result.endsWith('\u{1F4A5}')).toBe(true);
    expect(isWellFormedUtf16(result)).toBe(true);
  });

  it('interior_lone_surrogate: repairs a lone surrogate inside a short message', () => {
    const result = truncateMessage('user said \uD83D and left');

    expect(result).toBe('user said \uFFFD and left');
    expect(isWellFormedUtf16(result)).toBe(true);
  });

  it('repairs a lone low surrogate and keeps complete pairs intact', () => {
    const result = truncateMessage('pair \u{1F4A5} lone \uDC00 end');

    expect(result).toBe('pair \u{1F4A5} lone \uFFFD end');
    expect(isWellFormedUtf16(result)).toBe(true);
  });
});

describe('sanitizeAndTruncate', () => {
  it('caps stacks at MAX_STACK_LENGTH and urls at MAX_URL_LENGTH', () => {
    expect(sanitizeAndTruncate('s'.repeat(12_000), MAX_STACK_LENGTH).length).toBe(
      MAX_STACK_LENGTH,
    );
    expect(sanitizeAndTruncate('u'.repeat(3_000), MAX_URL_LENGTH).length).toBe(MAX_URL_LENGTH);
  });

  it('never ends on a lone high surrogate at a custom cap', () => {
    const value = 'B'.repeat(MAX_URL_LENGTH - 1) + '\u{1F4A5}' + 'tail';
    const result = sanitizeAndTruncate(value, MAX_URL_LENGTH);

    expect(result.length).toBe(MAX_URL_LENGTH - 1);
    expect(isWellFormedUtf16(result)).toBe(true);
  });
});

import { MAX_MESSAGE_LENGTH, normalizeThrown } from '../src/normalize-thrown';

describe('normalizeThrown', () => {
  it('exports MAX_MESSAGE_LENGTH matching the server cap', () => {
    expect(MAX_MESSAGE_LENGTH).toBe(5000);
  });

  it('error_instance_unchanged: keeps Error message and stack as-is', () => {
    const err = new Error('boom');
    const result = normalizeThrown(err);
    expect(result.message).toBe('boom');
    expect(result.stack).toBe(err.stack);
  });

  it('keeps empty Error message empty (server maps to "Unknown error")', () => {
    expect(normalizeThrown(new Error('')).message).toBe('');
  });

  it('primitive_verbatim: returns strings verbatim and stringifies other primitives', () => {
    expect(normalizeThrown('plain')).toEqual({ message: 'plain', stack: null });
    expect(normalizeThrown(42)).toEqual({ message: '42', stack: null });
    expect(normalizeThrown(false)).toEqual({ message: 'false', stack: null });
    expect(normalizeThrown(10n)).toEqual({ message: '10', stack: null });
    expect(normalizeThrown(undefined)).toEqual({ message: 'undefined', stack: null });
    expect(normalizeThrown(null)).toEqual({ message: 'null', stack: null });
    expect(normalizeThrown(Symbol('sym')).message).toBe('Symbol(sym)');
  });

  it('object_message_field: extracts a string message property', () => {
    expect(normalizeThrown({ message: 'payment failed' }).message).toBe('payment failed');
  });

  it('honors a string stack property on non-Error objects', () => {
    expect(normalizeThrown({ message: 'm', stack: 'trace' })).toEqual({
      message: 'm',
      stack: 'trace',
    });
  });

  it('object_error_field: recurses once into the error property', () => {
    expect(normalizeThrown({ error: 'inner string' }).message).toBe('inner string');
    expect(normalizeThrown({ error: new Error('inner error') }).message).toBe('inner error');
    expect(normalizeThrown({ error: { message: 'nested message' } }).message).toBe(
      'nested message',
    );
  });

  it('propagates the inner stack when the error field holds an Error instance', () => {
    const inner = new Error('inner');
    expect(normalizeThrown({ error: inner }).stack).toBe(inner.stack);
  });

  it('stops error-field recursion at depth 1', () => {
    expect(normalizeThrown({ error: { error: 'too deep' } }).message).toBe(
      '{"error":"too deep"}',
    );
  });

  it('serializes field-less objects to JSON', () => {
    expect(normalizeThrown({ code: 500 }).message).toBe('{"code":500}');
  });

  it('ignores a non-string message property and serializes instead', () => {
    expect(normalizeThrown({ message: 123 }).message).toBe('{"message":123}');
  });

  it('falls back to plain copy for values JSON cannot represent', () => {
    expect(normalizeThrown(() => undefined).message).toBe('[error details could not be read]');
    class Exotic {
      toJSON(): never {
        throw new Error('no json');
      }
    }
    expect(normalizeThrown(new Exotic()).message).toBe('[error details could not be read]');
  });

  it('normalize_never_throws: circular, BigInt property, and throwing getter all return safely', () => {
    const circular: Record<string, unknown> = { code: 500 };
    circular.self = circular;
    expect(() => normalizeThrown(circular)).not.toThrow();
    expect(normalizeThrown(circular).message).toBe('[error details could not be read]');

    expect(() => normalizeThrown({ big: 10n })).not.toThrow();
    expect(normalizeThrown({ big: 10n }).message).toBe('[error details could not be read]');

    const throwingGetter = {};
    Object.defineProperty(throwingGetter, 'message', {
      get() {
        throw new Error('gotcha');
      },
    });
    expect(() => normalizeThrown(throwingGetter)).not.toThrow();
    expect(normalizeThrown(throwingGetter).message).toBe('[error details could not be read]');
  });

  it('normalize_always_string: every value class yields typeof string', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const samples: unknown[] = [
      new Error('e'),
      'string',
      42,
      true,
      10n,
      undefined,
      null,
      Symbol('s'),
      { message: 'm' },
      { message: 123 },
      { error: 'inner' },
      { code: 500 },
      circular,
      () => undefined,
    ];
    for (const sample of samples) {
      expect(typeof normalizeThrown(sample).message).toBe('string');
    }
  });

  it('does not truncate inside the helper (enqueueError owns truncation)', () => {
    const long = 'x'.repeat(MAX_MESSAGE_LENGTH + 5000);
    expect(normalizeThrown(long).message.length).toBe(MAX_MESSAGE_LENGTH + 5000);
  });

  it('empty_message_falls_through: empty message prop yields error field or JSON, not ""', () => {
    expect(normalizeThrown({ message: '', error: 'real cause' }).message).toBe('real cause');
    expect(normalizeThrown({ message: '' }).message).toBe('{"message":""}');
  });

  it('serializes a non-string nested message prop', () => {
    expect(normalizeThrown({ message: { nested: true } }).message).toBe(
      '{"message":{"nested":true}}',
    );
  });

  it('serializes arrays thrown as values', () => {
    expect(normalizeThrown([1, 'two']).message).toBe('[1,"two"]');
    expect(normalizeThrown([]).message).toBe('[]');
  });

  it('handles frozen objects (read-only normalization)', () => {
    expect(normalizeThrown(Object.freeze({ code: 500 })).message).toBe('{"code":500}');
  });

  it('handles an error field pointing back at the object itself', () => {
    const selfRef: Record<string, unknown> = {};
    selfRef.error = selfRef;
    const result = normalizeThrown(selfRef);
    expect(typeof result.message).toBe('string');
    expect(result.message).toBe('[error details could not be read]');
  });

  it('error_subclass_overridden_getters: non-string message/stack getters stay string-typed', () => {
    class BadMessage extends Error {
      get message(): string {
        return { nested: true } as unknown as string;
      }
    }
    const badMessage = normalizeThrown(new BadMessage());
    expect(badMessage.message).toBe('{"nested":true}');
    expect(typeof badMessage.message).toBe('string');

    class BadStack extends Error {
      constructor() {
        super('m');
        Object.defineProperty(this, 'stack', { value: 42 });
      }
    }
    expect(normalizeThrown(new BadStack())).toEqual({ message: 'm', stack: null });

    class ThrowingMessage extends Error {
      get message(): never {
        throw new Error('nope');
      }
    }
    expect(normalizeThrown(new ThrowingMessage()).message).toBe(
      '[error details could not be read]',
    );
  });

  it('caps recursion when an Error message getter returns the error itself', () => {
    const err = new Error('seed');
    Object.defineProperty(err, 'message', { get: () => err });
    expect(() => normalizeThrown(err)).not.toThrow();
    expect(normalizeThrown(err).message).toBe('[error details could not be read]');
  });

  it('dom_exception: DOMException keeps its message verbatim', () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    expect(normalizeThrown(abort).message).toBe('The operation was aborted.');
  });
});

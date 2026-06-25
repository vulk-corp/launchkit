import { getVisitorId } from '../src/visitor-state';

const VISITOR_STATE_KEY = '__bworldsLaunchKitVisitorState__';
const STORAGE_KEY = 'bworlds-visitor-id';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Forget the in-memory id so the next read goes back to localStorage. */
function forgetInMemoryId(): void {
  delete (globalThis as Record<string, unknown>)[VISITOR_STATE_KEY];
}

beforeEach(() => {
  localStorage.clear();
  forgetInMemoryId();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('visitor identity', () => {
  it('generates a UUID and persists it to localStorage', () => {
    const id = getVisitorId();
    expect(id).toMatch(UUID_RE);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(id);
  });

  it('returns the same id on repeated reads within a page', () => {
    expect(getVisitorId()).toBe(getVisitorId());
  });

  it('reuses the stored id across a fresh page load', () => {
    const first = getVisitorId();
    forgetInMemoryId(); // simulate a reload: in-memory cache gone, storage kept
    expect(getVisitorId()).toBe(first);
  });

  it('regenerates when the stored value is not a valid UUID', () => {
    localStorage.setItem(STORAGE_KEY, 'tampered-value');
    const id = getVisitorId();
    expect(id).toMatch(UUID_RE);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(id);
  });

  it('fails open with an in-memory id when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    const id = getVisitorId();
    expect(id).toMatch(UUID_RE);
    // Stable within the page even though nothing could be persisted.
    expect(getVisitorId()).toBe(id);
  });

  it('does not overwrite the stored id when a read throws', () => {
    const original = '11111111-2222-4333-8444-555555555555';
    localStorage.setItem(STORAGE_KEY, original);
    forgetInMemoryId();

    // Reads throw while writes still work (e.g. an extension blocking getItem).
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('read blocked');
    });
    const setSpy = vi.spyOn(Storage.prototype, 'setItem');

    const id = getVisitorId();
    expect(id).toMatch(UUID_RE); // a fresh in-memory id for this page
    expect(setSpy).not.toHaveBeenCalled(); // the stored id is left untouched

    // Once reads recover, the original persisted id comes back.
    vi.restoreAllMocks();
    forgetInMemoryId();
    expect(getVisitorId()).toBe(original);
  });
});

export const FETCH_TIMEOUT_MS = 3000;

export async function fetchJsonWithTimeout<T>(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

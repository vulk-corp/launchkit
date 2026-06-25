/**
 * UUID v4 generator shared across telemetry identifiers (session id, visitor id).
 *
 * Prefers crypto.randomUUID and falls back to a Math.random implementation for
 * engines that lack it or whose implementation throws. Always returns: this runs
 * at module-eval time for the replay instance id, so a throw here would abort the
 * whole SDK load. The output matches the canonical UUID shape the server
 * validates, so a malformed id never reaches the wire.
 */
export function generateUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    // crypto.randomUUID present but throwing: use the Math.random implementation.
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

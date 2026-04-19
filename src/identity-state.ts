/**
 * Shared identity state module — avoids circular imports between index.ts and replay.ts.
 * index.ts writes; replay.ts reads.
 */

let _email: string | null = null;
let _userId: string | null = null;

export function setIdentity(email: string | null, userId: string | null): void {
  _email = email;
  _userId = userId;
}

export function resetIdentity(): void {
  _email = null;
  _userId = null;
}

export function getIdentity(): { email: string | null; userId: string | null } {
  return { email: _email, userId: _userId };
}

/** Short unique ids with a readable prefix: newId('case') -> 'case_k3x9q2'. Implemented by: server-core. */
import { randomBytes } from 'node:crypto';

export type IdPrefix =
  | 'case' | 'plan' | 'step' | 'bill' | 'apr' | 'call' | 'neg' | 'offer' | 'msg' | 'act'
  | 'evt' | 'fu' | 'media' | 'arena' | 'run';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(5).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

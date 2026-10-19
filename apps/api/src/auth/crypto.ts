import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export interface TokenPayload {
  sub: string;
  roles: { role: string; baseScope?: string | null }[];
  employeeId?: string | null;
  /** Password version: the user's passwordChangedAt (ms) when the token was issued. A change or reset revokes older tokens. */
  pv?: number;
  exp: number;
}

export function signToken(p: Omit<TokenPayload, 'exp'>, secret: string, ttlSeconds = 8 * 3600, now = Date.now()): string {
  const body = b64(JSON.stringify({ ...p, exp: Math.floor(now / 1000) + ttlSeconds }));
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifyToken(token: string, secret: string, now = Date.now()): TokenPayload | null {
  const [head, body, sig] = token.split('.');
  if (!head || !body || !sig) return null;
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
  return payload.exp * 1000 > now ? payload : null;
}

/** An unguessable token for links sent by email; store only its hash. */
export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A temporary password an administrator can read out: no look-alike characters. */
export function tempPassword(length = 12): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(length), b => alphabet[b % alphabet.length]).join('');
}

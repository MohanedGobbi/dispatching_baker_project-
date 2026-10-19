import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, signToken, verifyToken } from './crypto';
import { can } from './permissions';

describe('passwords', () => {
  it('verifies correct and rejects wrong', () => {
    const h = hashPassword('demo1234');
    expect(verifyPassword('demo1234', h)).toBe(true);
    expect(verifyPassword('nope', h)).toBe(false);
    expect(verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('tokens', () => {
  const p = { sub: 'u1', roles: [{ role: 'HR' }] };
  it('round trips', () => expect(verifyToken(signToken(p, 's'), 's')?.sub).toBe('u1'));
  it('rejects wrong secret, tampering and expiry', () => {
    const t = signToken(p, 's', 60, 0);
    expect(verifyToken(t, 'other', 0)).toBeNull();
    expect(verifyToken(t, 's', 61_000)).toBeNull();
    const [h, , s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'u1', roles: [{ role: 'SUPER_ADMIN' }], exp: 9e9 })).toString('base64url');
    expect(verifyToken(`${h}.${forged}.${s}`, 's', 0)).toBeNull();
  });
});

describe('permissions (plan section 3)', () => {
  it('dispatcher has no medical access', () => expect(can(['DISPATCHER'], 'medical', 'view')).toBe(false));
  it('HR has full medical, ops only view', () => {
    expect(can(['HR'], 'medical', 'full')).toBe(true);
    expect(can(['OPS_MANAGER'], 'medical', 'edit')).toBe(false);
    expect(can(['OPS_MANAGER'], 'medical', 'view')).toBe(true);
  });
  it('only super admin edits settings; roles combine', () => {
    expect(can(['OPS_MANAGER'], 'settings', 'edit')).toBe(false);
    expect(can(['EMPLOYEE', 'SUPER_ADMIN'], 'settings', 'full')).toBe(true);
  });
});

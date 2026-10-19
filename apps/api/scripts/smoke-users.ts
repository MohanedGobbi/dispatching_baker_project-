// Live checks for E2/E26: user admin, temporary passwords, change and reset, session revocation, the audit trail.
// Isolated: every account it touches is created here (logins start with "smk-").
import '../src/env';
import { prisma, call, check, login, finish } from './lib';
import { sha256 } from '../src/auth/crypto';

async function main() {
  const [admin, ops, disp, hr] = await Promise.all(['admin', 'ops', 'dispatcher', 'hr'].map(login));
  const tag = `smk-${Date.now() % 1e6}`;

  // ================= who may manage accounts =================
  check('dispatcher cannot list users', (await call('GET', '/users', disp)).status === 403);
  check('ops can list users', (await call('GET', '/users', ops)).status === 200);
  check('ops cannot create users', (await call('POST', '/users', ops, { login: `${tag}-x`, roles: [{ role: 'HR' }] })).status === 403);
  const roles = await call('GET', '/users/roles', admin);
  check('role list comes with the matrix', roles.json.roles.includes('DISPATCHER') && roles.json.matrix.HR.medical === 'full');

  // ================= create with a temporary password =================
  check('bad login refused', (await call('POST', '/users', admin, { login: 'a b', roles: [{ role: 'HR' }] })).status === 400);
  check('unknown role refused', (await call('POST', '/users', admin, { login: `${tag}-r`, roles: [{ role: 'KING' }] })).status === 400);
  check('base manager needs a base', (await call('POST', '/users', admin, { login: `${tag}-b`, roles: [{ role: 'BASE_MANAGER' }] })).status === 400);
  check('weak password refused', (await call('POST', '/users', admin, { login: `${tag}-w`, roles: [{ role: 'HR' }], password: 'short' })).status === 400);
  const made = await call('POST', '/users', admin, { login: `${tag}-disp`, email: `${tag}@example.test`, roles: [{ role: 'DISPATCHER' }] });
  check('admin creates a dispatcher and gets a temporary password once', made.status === 201 && typeof made.json.tempPassword === 'string' && made.json.tempPassword.length >= 12 && made.json.user.mustChangePassword, made.json);
  check('the password hash is never returned', !JSON.stringify(made.json).includes('scrypt'));
  check('duplicate login refused', (await call('POST', '/users', admin, { login: `${tag}-disp`, roles: [{ role: 'HR' }] })).status === 400);
  const uid = made.json.user.id as string;
  const temp = made.json.tempPassword as string;

  const first = await call('POST', '/auth/login', undefined, { login: `${tag}-disp`, password: temp });
  check('signs in with the temporary password, told to change it', first.status === 201 && first.json.user.mustChangePassword === true, first.json);
  let tok = first.json.token as string;
  check('until changed, other screens are refused', (await call('GET', '/replacements', tok)).status === 403);
  check('...but /auth/me works', (await call('GET', '/auth/me', tok)).json?.mustChangePassword === true);
  check('wrong current password refused', (await call('POST', '/auth/change-password', tok, { current: 'nope', next: 'a-new-password-1' })).status === 400);
  check('too short refused', (await call('POST', '/auth/change-password', tok, { current: temp, next: 'abc' })).status === 400);
  const changed = await call('POST', '/auth/change-password', tok, { current: temp, next: 'a-new-password-1' });
  check('password changed, new token returned', changed.status === 201 && typeof changed.json.token === 'string', changed.json);
  check('the old token is revoked', (await call('GET', '/auth/me', tok)).status === 401);
  tok = changed.json.token;
  check('the new token works on planner screens', (await call('GET', '/replacements', tok)).status === 200);
  check('old password no longer signs in', (await call('POST', '/auth/login', undefined, { login: `${tag}-disp`, password: temp })).status === 401);

  // ================= role changes and disabling apply to live sessions =================
  check('role change applies without signing in again', (await call('PUT', `/users/${uid}`, admin, { roles: [{ role: 'CHIEF_OF_UNIT' }] })).status === 200
    && (await call('GET', '/replacements', tok)).status === 403);
  await call('PUT', `/users/${uid}`, admin, { roles: [{ role: 'BASE_MANAGER', baseScope: 'HMD' }] });
  check('base scope stored as the base code', (await prisma.userRole.findFirst({ where: { userId: uid } }))?.baseScope === 'HMD');
  check('disable: the session ends', (await call('PUT', `/users/${uid}`, admin, { active: false })).json.active === false && (await call('GET', '/auth/me', tok)).status === 401);
  check('disabled account cannot sign in', (await call('POST', '/auth/login', undefined, { login: `${tag}-disp`, password: 'a-new-password-1' })).status === 401);
  await call('PUT', `/users/${uid}`, admin, { active: true });

  // ================= admin reset =================
  const ar = await call('POST', `/users/${uid}/reset-password`, admin);
  check('admin reset gives a new temporary password', ar.status === 201 && typeof ar.json.tempPassword === 'string');
  const afterReset = await call('POST', '/auth/login', undefined, { login: `${tag}-disp`, password: ar.json.tempPassword });
  check('...which must be changed at sign-in', afterReset.json.user?.mustChangePassword === true);

  // ================= admin safety =================
  const adminId = (await prisma.user.findUniqueOrThrow({ where: { login: 'admin' } })).id;
  check('cannot disable yourself', (await call('PUT', `/users/${adminId}`, admin, { active: false })).status === 400);
  check('cannot drop your own admin role', (await call('PUT', `/users/${adminId}`, admin, { roles: [{ role: 'OPS_MANAGER' }] })).status === 400);
  const second = await call('POST', '/users', admin, { login: `${tag}-adm`, roles: [{ role: 'SUPER_ADMIN' }], password: 'second-admin-1' });
  check('another admin can be demoted while one remains', (await call('PUT', `/users/${second.json.user.id}`, admin, { roles: [{ role: 'HR' }] })).status === 200);

  // ================= self-service reset by email =================
  const unknown = await call('POST', '/auth/forgot', undefined, { login: 'nobody-here' });
  check('forgot: same answer for an unknown login', unknown.status === 201 && unknown.json.ok === true);
  const before = await prisma.emailOutbox.count({ where: { userId: uid, type: 'password_reset' } });
  const fg = await call('POST', '/auth/forgot', undefined, { login: `${tag}-disp` });
  const mail = await prisma.emailOutbox.findFirst({ where: { userId: uid, type: 'password_reset' }, orderBy: { createdAt: 'desc' } });
  check('forgot: a reset link is queued for the account email', fg.json.ok === true && mail?.toEmail === `${tag}@example.test` && (await prisma.emailOutbox.count({ where: { userId: uid, type: 'password_reset' } })) === before + 1);
  const resetTok = mail?.body.match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? '';
  check('only a hash of the token is stored', resetTok.length > 20 && !(await prisma.passwordResetToken.findFirst({ where: { tokenHash: resetTok } })));
  check('reset: weak password refused', (await call('POST', '/auth/reset', undefined, { token: resetTok, password: 'x' })).status === 400);
  check('reset: bad token refused', (await call('POST', '/auth/reset', undefined, { token: 'forged', password: 'brand-new-pass-2' })).status === 400);
  check('reset: works with the emailed token', (await call('POST', '/auth/reset', undefined, { token: resetTok, password: 'brand-new-pass-2' })).status === 201);
  check('reset: the link works only once', (await call('POST', '/auth/reset', undefined, { token: resetTok, password: 'brand-new-pass-3' })).status === 400);
  const viaReset = await call('POST', '/auth/login', undefined, { login: `${tag}-disp`, password: 'brand-new-pass-2' });
  check('signs in with the new password, no forced change', viaReset.status === 201 && viaReset.json.user.mustChangePassword === false);
  await call('POST', '/auth/forgot', undefined, { login: `${tag}-disp` });
  await call('POST', '/auth/forgot', undefined, { login: `${tag}-disp` });
  await call('POST', '/auth/forgot', undefined, { login: `${tag}-disp` });
  check('forgot is throttled (3 links per 15 minutes)', (await prisma.passwordResetToken.count({ where: { userId: uid, createdAt: { gte: new Date(Date.now() - 15 * 60_000) } } })) === 3);
  const expired = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: uid, usedAt: null } });
  await prisma.passwordResetToken.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const expMail = (await prisma.emailOutbox.findMany({ where: { userId: uid, type: 'password_reset' }, orderBy: { createdAt: 'desc' }, take: 3 }));
  const expTok = expMail.map(m => m.body.match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? '').find(t => sha256(t) === expired.tokenHash);
  check('reset: an expired link is refused', !!expTok && (await call('POST', '/auth/reset', undefined, { token: expTok, password: 'brand-new-pass-4' })).status === 400);

  // ================= the audit trail =================
  check('dispatcher cannot read the audit log', (await call('GET', '/audit', disp)).status === 403);
  const trail = await call('GET', `/audit?entity=User&entityId=${uid}&limit=50`, hr);
  const actions = (trail.json?.items ?? []).map((r: any) => r.action);
  check('HR reads the trail for this account', trail.status === 200 && ['create', 'update', 'password_change', 'password_reset_by_admin', 'password_reset_requested', 'password_reset'].every(a => actions.includes(a)), actions);
  check('entries say who did it', trail.json.items.find((r: any) => r.action === 'create')?.user?.login === 'admin');
  check('no password or hash ever lands in the trail', !trail.text.includes('scrypt') && !trail.text.includes('a-new-password-1') && !trail.text.includes(temp));
  const facets = await call('GET', '/audit/facets', ops);
  check('facets list entities with counts', facets.status === 200 && facets.json.entities.some((e: any) => e.name === 'User' && e.count > 0));
  const byLogin = await call('GET', '/audit?login=admin&limit=5', ops);
  check('filter by who did it', byLogin.json.items.length > 0 && byLogin.json.items.every((r: any) => r.user?.login.includes('admin')));
  await call('PUT', '/settings/security.passwordMinLength', admin, { value: 10 });
  const setTrail = await call('GET', '/audit?entity=Setting&entityId=security.passwordMinLength', ops);
  check('setting changes are audited with before and after', setTrail.json.items[0]?.before?.value === 8 && setTrail.json.items[0]?.after?.value === 10, setTrail.json.items[0]);
  check('the new minimum applies', (await call('POST', '/users', admin, { login: `${tag}-len`, roles: [{ role: 'HR' }], password: 'nine-char' })).status === 400);
  await call('PUT', '/settings/security.passwordMinLength', admin, { value: 8 });

  check('outbox send reports SMTP is not configured', (await call('POST', '/notifications/outbox/send', admin)).json.enabled === false);

  await finish();
}

main().catch(e => { console.error(e); process.exit(1); });

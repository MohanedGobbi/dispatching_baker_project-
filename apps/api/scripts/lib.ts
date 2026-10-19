// Shared helpers for the live smoke scripts. They mutate the database: run `npm run seed` afterwards.
import '../src/env';
import { PrismaClient } from '@prisma/client';

export const API = process.env.API ?? 'http://localhost:3000';
export const prisma = new PrismaClient();
export const DAY = 86_400_000;
export const today = new Date(); today.setUTCHours(0, 0, 0, 0);
export const at = (n: number) => new Date(today.getTime() + n * DAY).toISOString();
export const day = (s: string) => s.slice(0, 10);

let failed = 0;
let seq = 0;
export const failures = () => failed;

export async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(API + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

export function check(name: string, ok: boolean, extra?: unknown) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))?.slice(0, 500)}`);
}

export const login = async (l: string) => (await call('POST', '/auth/login', undefined, { login: l, password: 'demo1234' })).json.token as string;

/** A person with valid certs, a chosen seniority and qualification, on a 28/28 rotation that began 2 days ago. */
export async function mkEmployee(opts: { position: string; level: 'NEW_RECRUIT' | 'JUNIOR' | 'EXPERIENCED' | 'SENIOR'; quals: string[]; base: string; anchorOffset?: number }) {
  seq++;
  const pos = await prisma.position.findUniqueOrThrow({ where: { name: opts.position }, include: { requiredCertTypes: true } });
  const base = await prisma.base.findUniqueOrThrow({ where: { code: opts.base } });
  const rot = await prisma.rotationPattern.findUniqueOrThrow({ where: { name: '28/28' } });
  const quals = await prisma.qualification.findMany({ where: { name: { in: opts.quals } } });
  return prisma.employee.create({
    data: {
      employeeNo: `S${Date.now() % 1e6}-${seq}`, firstName: `T${seq}`, lastName: 'Smoke', positionId: pos.id, homeBaseId: base.id, workMode: 'FIELD',
      hireDate: new Date(today.getTime() - 900 * DAY), seniorityOverride: opts.level, rotationPatternId: rot.id, rotationAnchorDate: new Date(today.getTime() + (opts.anchorOffset ?? -2) * DAY),
      qualifications: { create: quals.map(q => ({ qualificationId: q.id, obtainedAt: today })) },
      certifications: { create: pos.requiredCertTypes.map(c => ({ typeId: c.id, issuedAt: today })) },
    },
  });
}

/** A login for an employee (password demo1234), so the portal and notifications can be tried as that person. */
export async function mkUser(employeeId: string, roles: { role: string; baseScope?: string }[] = [{ role: 'EMPLOYEE' }], login?: string) {
  const { hashPassword } = await import('../src/auth/crypto');
  seq++;
  return prisma.user.create({ data: { login: login ?? `u${Date.now() % 1e6}-${seq}`, passwordHash: hashPassword('demo1234'), employeeId, roles: { create: roles } } });
}

export async function finish() {
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

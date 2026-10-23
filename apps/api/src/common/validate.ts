import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '../db';

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'string[]';
export type Spec = Record<string, FieldType>;

/** Whitelist + type-check body fields. Dates arrive as ISO strings and leave as Date. */
export function pickFields(spec: Spec, body: Record<string, unknown> | undefined, required: string[] = []): Record<string, unknown> {
  const src = body ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, type] of Object.entries(spec)) {
    const v = src[k];
    if (v === undefined) continue;
    if (v === null) { out[k] = null; continue; }
    if (type === 'date') {
      const d = typeof v === 'string' ? new Date(v) : null;
      if (!d || Number.isNaN(d.getTime())) throw new BadRequestException(`"${k}" must be an ISO date`);
      out[k] = d;
    } else if (type === 'string[]') {
      if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) throw new BadRequestException(`"${k}" must be string[]`);
      out[k] = v;
    } else {
      if (typeof v !== type) throw new BadRequestException(`"${k}" must be ${type}`);
      out[k] = v;
    }
  }
  const missing = required.filter(k => out[k] === undefined || out[k] === null || out[k] === '');
  if (missing.length) throw new BadRequestException(`Missing: ${missing.join(', ')}`);
  return out;
}

/** Stored in "done by" columns (createdBy, approvedBy...): the manager is the only user. */
export const MANAGER = 'manager';

/** A list-of-strings column (Employee.tags, Base.facilities, Plan.scope): stored as JSON since SQLite has no arrays. */
export function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function page(q: { limit?: string; offset?: string }) {
  const take = Math.min(Math.max(parseInt(q.limit ?? '50', 10) || 50, 1), 200);
  const skip = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0);
  return { take, skip };
}

export function parseDate(v: string | undefined, fallback = new Date()): Date {
  if (!v) return fallback;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid date "${v}"`);
  return d;
}

/** Plan section 23: every change stores entity, before/after and an optional reason (the manager is the only user). */
export function audit(
  prisma: PrismaClient, entity: string, entityId: string, action: string,
  before?: unknown, after?: unknown, reason?: string,
) {
  return prisma.auditLog.create({
    data: { entity, entityId, action, before: before as never, after: after as never, reason },
  });
}

/** Turn common Prisma constraint errors into clean 4xx responses instead of a 500. */
export function mapDbError(e: unknown, what = 'Record'): unknown {
  const code = (e as { code?: string }).code;
  if (code === 'P2002') return new BadRequestException(`${what} already exists (duplicate value)`);
  if (code === 'P2003') return new BadRequestException('A referenced record does not exist');
  if (code === 'P2025') return new NotFoundException(`${what} not found`);
  return e;
}

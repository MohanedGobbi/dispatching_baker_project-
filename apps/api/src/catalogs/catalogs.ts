import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, Post, Put, Req, ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthedRequest } from '../auth/auth.module';
import { can } from '../auth/permissions';
import type { Module as Mod } from '../auth/permissions';

type FieldType = 'string' | 'number' | 'boolean' | 'string[]';

interface CatalogDef {
  model: string;                     // Prisma delegate name
  module: Mod;                       // permission module guarding writes
  fields: Record<string, FieldType>; // whitelist of writable scalar fields
  required: string[];
  connects?: Record<string, string>; // body key (id list) -> relation field
  include?: Record<string, boolean>;
}

// Catalogs from plan section 22. Write access follows the matrix in section 3.
export const CATALOGS: Record<string, CatalogDef> = {
  positions: {
    model: 'position', module: 'positions',
    fields: { name: 'string', category: 'string', canFillUnitSeat: 'boolean', canFillBasePost: 'boolean', defaultRotationId: 'string' },
    required: ['name', 'category'],
    connects: { requiredQualificationIds: 'requiredQualifications', requiredCertTypeIds: 'requiredCertTypes' },
    include: { requiredQualifications: true, requiredCertTypes: true },
  },
  qualifications: { model: 'qualification', module: 'positions', fields: { name: 'string' }, required: ['name'] },
  'certification-types': { model: 'certificationType', module: 'positions', fields: { name: 'string' }, required: ['name'] },
  'leave-types': {
    model: 'leaveType', module: 'settings',
    fields: { name: 'string', category: 'string', needsApproval: 'boolean', needsDocument: 'boolean' }, required: ['name', 'category'],
  },
  'unit-types': {
    model: 'unitType', module: 'settings', fields: { name: 'string', colorKey: 'string' }, required: ['name', 'colorKey'],
    include: { crewSeats: true },
  },
  'rotation-patterns': {
    model: 'rotationPattern', module: 'settings',
    fields: { name: 'string', type: 'string', daysOn: 'number', daysOff: 'number', weeklyMask: 'string', travelPolicy: 'string' },
    required: ['name', 'type'],
  },
};

/** Pick only whitelisted fields, type-check them, and enforce required ones on create. */
export function sanitize(def: CatalogDef, body: Record<string, unknown>, creating: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, type] of Object.entries(def.fields)) {
    if (!(k in body) || body[k] === undefined) continue;
    const v = body[k];
    const ok = type === 'string[]' ? Array.isArray(v) && v.every(x => typeof x === 'string') : typeof v === type;
    if (!ok) throw new BadRequestException(`"${k}" must be ${type}`);
    out[k] = v;
  }
  if (creating) {
    const missing = def.required.filter(k => out[k] === undefined || out[k] === '');
    if (missing.length) throw new BadRequestException(`Missing: ${missing.join(', ')}`);
  }
  return out;
}

@Controller('catalogs')
class CatalogsController {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}

  private def(slug: string) {
    const def = CATALOGS[slug];
    if (!def) throw new NotFoundException(`Unknown catalog "${slug}"`);
    return def;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private repo(def: CatalogDef): any { return (this.prisma as any)[def.model]; }

  private relations(def: CatalogDef, body: Record<string, unknown>, mode: 'create' | 'update') {
    const rel: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(def.connects ?? {})) {
      const ids = body[key];
      if (ids === undefined) continue;
      if (!Array.isArray(ids)) throw new BadRequestException(`"${key}" must be an array of ids`);
      const list = ids.map(id => ({ id: String(id) }));
      rel[field] = mode === 'create' ? { connect: list } : { set: list };
    }
    return rel;
  }

  @Get(':slug')
  list(@Param('slug') slug: string) {
    const def = this.def(slug);
    return this.repo(def).findMany({ orderBy: { name: 'asc' }, ...(def.include ? { include: def.include } : {}) });
  }

  @Post(':slug')
  create(@Param('slug') slug: string, @Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const def = this.def(slug);
    this.assertWrite(def, req);
    return this.repo(def).create({
      data: { ...sanitize(def, body ?? {}, true), ...this.relations(def, body ?? {}, 'create') },
      ...(def.include ? { include: def.include } : {}),
    });
  }

  @Put(':slug/:id')
  async update(@Param('slug') slug: string, @Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const def = this.def(slug);
    this.assertWrite(def, req);
    try {
      return await this.repo(def).update({
        where: { id },
        data: { ...sanitize(def, body ?? {}, false), ...this.relations(def, body ?? {}, 'update') },
        ...(def.include ? { include: def.include } : {}),
      });
    } catch (e: unknown) { throw this.mapError(e); }
  }

  @Delete(':slug/:id')
  async remove(@Param('slug') slug: string, @Param('id') id: string, @Req() req: AuthedRequest) {
    const def = this.def(slug);
    this.assertWrite(def, req);
    try { await this.repo(def).delete({ where: { id } }); return { deleted: id }; }
    catch (e: unknown) { throw this.mapError(e); }
  }

  // Write permission depends on the catalog, so it is checked here rather than via one static decorator.
  private assertWrite(def: CatalogDef, req: AuthedRequest) {
    const roles = (req.user?.roles ?? []).map(r => r.role);
    if (!can(roles, def.module, 'edit')) throw new ForbiddenException(`Needs edit access on ${def.module}`);
  }

  private mapError(e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === 'P2025') return new NotFoundException('Not found');
    if (code === 'P2003') return new BadRequestException('Still in use by other records; archive instead of deleting');
    return e;
  }
}

@Module({ controllers: [CatalogsController] })
export class CatalogsModule {}

import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Module, NotFoundException, Param, Post, Req, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { AuthedRequest } from '../auth/auth.module';
import { can } from '../auth/permissions';
import { audit } from '../common/validate';

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Map([['application/pdf', '.pdf'], ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp']]);
// Local disk for now; the same two "buckets" map onto object storage (MinIO) later (plan 29 "Files").
export const STORAGE_ROOT = process.env.STORAGE_DIR ?? join(process.cwd(), 'storage');

/** Certificates and documents. Medical files live in their own folder and only HR, Ops and the owner can open them (12.3). */
@Controller('files')
class FilesController {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}

  @Post()
  async upload(@Body() body: { name?: string; mime?: string; kind?: string; dataBase64?: string }, @Req() req: AuthedRequest) {
    const kind = body?.kind === 'medical' ? 'medical' : 'general';
    if (!body?.name?.trim() || !body.dataBase64) throw new BadRequestException('name and dataBase64 are required');
    const ext = ALLOWED.get(body.mime ?? '');
    if (!ext) throw new BadRequestException('Only PDF, JPEG, PNG or WebP files are accepted');
    const bytes = Buffer.from(body.dataBase64, 'base64');
    if (bytes.length === 0) throw new BadRequestException('The file is empty');
    if (bytes.length > MAX_BYTES) throw new BadRequestException(`The file is larger than ${MAX_BYTES / 1024 / 1024} MB`);
    // A file named by the user is only ever a label: the stored name is generated, so no path can be injected.
    const id = randomUUID();
    const dir = join(STORAGE_ROOT, kind);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${id}${ext}`);
    await writeFile(path, bytes);
    const row = await this.prisma.storedFile.create({ data: { id, ownerUserId: req.user!.sub, kind, name: body.name.trim().slice(0, 120), mime: body.mime!, size: bytes.length, path } });
    await audit(this.prisma, req.user!.sub, 'File', row.id, kind === 'medical' ? 'medical_upload' : 'upload');
    return { id: row.id, url: `files/${row.id}`, name: row.name, size: row.size, kind };
  }

  @Get(':id')
  async download(@Param('id') id: string, @Req() req: AuthedRequest, @Res() res: Response) {
    const f = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!f) throw new NotFoundException('File not found');
    const roles = (req.user?.roles ?? []).map(r => r.role);
    const owner = f.ownerUserId === req.user!.sub;
    const staff = roles.filter(r => r !== 'EMPLOYEE');
    // The employee a medical certificate belongs to uploaded it themselves or HR did on their behalf; staff access follows the medical rule.
    // ...or the file is attached to the viewer's own leave (HR may have uploaded it for them).
    const attached = !owner && !!req.user?.employeeId && !!(await this.prisma.leave.findFirst({ where: { employeeId: req.user.employeeId, documentUrl: { in: [`files/${id}`, `/files/${id}`] } }, select: { id: true } }));
    const allowed = owner || attached || (f.kind === 'medical' ? can(staff, 'medical', 'view') : staff.length > 0);
    if (!allowed) throw new ForbiddenException('You cannot open this file');
    if (f.kind === 'medical' && !owner) await audit(this.prisma, req.user!.sub, 'File', f.id, 'medical_view');
    const bytes = await readFile(f.path);
    res.set({ 'content-type': f.mime, 'content-length': String(bytes.length), 'content-disposition': `inline; filename="${f.name.replace(/[^\w. -]/g, '_')}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    res.send(bytes);
  }
}

@Module({ controllers: [FilesController] })
export class FilesModule {}

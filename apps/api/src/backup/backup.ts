// Backups of the SQLite database and the uploaded files into BACKUP_DIR (default <data>/backups).
// One a day automatically (checked at start and every hour), plus "Back up now" from Settings. Kept: the 14 newest,
// and beyond those the newest of each month.
import { Controller, Get, Inject, Injectable, Module, OnModuleDestroy, OnModuleInit, Post } from '@nestjs/common';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';

const KEEP_RECENT = 14;
const NAME = /^crewboard-(\d{4}-\d{2}-\d{2})-(\d{4})$/; // crewboard-2026-10-23-1405

export interface Backup { name: string; at: string; sizeBytes: number }

function size(path: string): number {
  const s = statSync(path);
  return s.isDirectory() ? readdirSync(path).reduce((n, f) => n + size(join(path, f)), 0) : s.size;
}

@Injectable()
export class BackupService {
  readonly dir = process.env.BACKUP_DIR!;
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}

  list(): Backup[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter(n => NAME.test(n)).sort().reverse().map(name => {
      const [, d, hm] = NAME.exec(name)!;
      return { name, at: `${d}T${hm.slice(0, 2)}:${hm.slice(2)}:00`, sizeBytes: size(join(this.dir, name)) };
    });
  }

  /** Copies the database (VACUUM INTO, so nothing still in the WAL file is missed) and the uploaded files. */
  async create(): Promise<Backup> {
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const name = `crewboard-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
    const target = join(this.dir, name), tmp = `${target}.partial`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    await this.prisma.$executeRawUnsafe(`VACUUM INTO '${join(tmp, 'crewboard.db').replace(/'/g, "''")}'`);
    const storage = process.env.STORAGE_DIR!;
    if (existsSync(storage)) cpSync(storage, join(tmp, 'storage'), { recursive: true });
    rmSync(target, { recursive: true, force: true }); // a second backup in the same minute replaces the first
    renameSync(tmp, target);
    this.prune();
    return this.list().find(b => b.name === name)!;
  }

  /** A backup is made when none exists for today. */
  async daily() {
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time like the names
    if (!this.list().some(b => b.at.startsWith(today))) await this.create();
  }

  private prune() {
    const all = this.list(); // newest first
    const months = new Set<string>();
    for (const [i, b] of all.entries()) {
      const month = b.at.slice(0, 7);
      const keep = i < KEEP_RECENT || !months.has(month);
      months.add(month);
      if (!keep) rmSync(join(this.dir, b.name), { recursive: true, force: true });
    }
  }
}

@Controller('backups')
class BackupController {
  constructor(@Inject(BackupService) private svc: BackupService) {}

  @Get() list() { return { dir: this.svc.dir, backups: this.svc.list() }; }

  @Post() create() { return this.svc.create(); }
}

@Module({ controllers: [BackupController], providers: [BackupService] })
export class BackupModule implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  constructor(@Inject(BackupService) private svc: BackupService) {}
  onModuleInit() {
    if (process.env.JOBS === 'off') return;
    const tick = () => { this.svc.daily().catch(e => console.error('backup failed', e)); };
    tick();
    this.timer = setInterval(tick, 60 * 60 * 1000);
    this.timer.unref();
  }
  onModuleDestroy() { clearInterval(this.timer); }
}

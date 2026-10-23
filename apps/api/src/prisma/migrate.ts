// Applies prisma/migrations/*/migration.sql in order without the Prisma CLI, which an installed app does not have.
// Applied names are kept in _migrations; each migration runs in one transaction.
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

/** prisma/migrations next to the code: src/prisma under tsx, dist/src/prisma once built. MIGRATIONS_DIR wins. */
function migrationsDir() {
  const dir = process.env.MIGRATIONS_DIR ?? [join(__dirname, '..', '..', 'prisma', 'migrations'), join(__dirname, '..', '..', '..', 'prisma', 'migrations')].find(existsSync);
  if (!dir) throw new Error('prisma/migrations not found (set MIGRATIONS_DIR)');
  return dir;
}

export async function migrate(prisma: PrismaClient): Promise<string[]> {
  await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "_migrations" ("name" TEXT PRIMARY KEY, "appliedAt" DATETIME NOT NULL)');
  const done = new Set((await prisma.$queryRawUnsafe<{ name: string }[]>('SELECT "name" FROM "_migrations"')).map(r => r.name));
  const dir = migrationsDir();
  const applied: string[] = [];
  for (const name of readdirSync(dir).filter(n => existsSync(join(dir, n, 'migration.sql'))).sort()) {
    if (done.has(name)) continue;
    const statements = readFileSync(join(dir, name, 'migration.sql'), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map(s => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
    await prisma.$transaction([
      ...statements.map(s => prisma.$executeRawUnsafe(s)),
      prisma.$executeRawUnsafe('INSERT INTO "_migrations" ("name", "appliedAt") VALUES (?, ?)', name, new Date().toISOString()),
    ]);
    applied.push(name);
  }
  return applied;
}

/**
 * DATABASE_URL limited to one connection. Scripts that switch foreign keys off (wipeDatabase, the Postgres copy) need it:
 * the PRAGMA only holds on the connection it ran on.
 */
export function singleConnectionUrl() {
  const url = process.env.DATABASE_URL ?? '';
  return url + (url.includes('?') ? '&' : '?') + 'connection_limit=1';
}

/** Empties every table (keeps the schema and _migrations). Give it a client made with singleConnectionUrl(). */
export async function wipeDatabase(prisma: PrismaClient) {
  await prepareDatabase(prisma);
  const tables = await prisma.$queryRawUnsafe<{ name: string }[]>(`SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' AND "name" <> '_migrations'`);
  await prisma.$executeRawUnsafe('PRAGMA foreign_keys=OFF');
  try { for (const t of tables) await prisma.$executeRawUnsafe(`DELETE FROM "${t.name}"`); }
  finally { await prisma.$executeRawUnsafe('PRAGMA foreign_keys=ON'); }
}

/** Everything a fresh or existing database needs before use: its folder, WAL mode, a busy timeout, the migrations. */
export async function prepareDatabase(prisma: PrismaClient) {
  const url = process.env.DATABASE_URL ?? '';
  if (url.startsWith('file:')) mkdirSync(dirname(url.slice(5)), { recursive: true });
  await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL');
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=10000');
  const applied = await migrate(prisma);
  if (applied.length) console.log(`Database: applied ${applied.join(', ')}`);
}

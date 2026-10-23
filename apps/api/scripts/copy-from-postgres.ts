// One-time copy of the Postgres database (Docker, POSTGRES_URL in .env) into the SQLite database (DATA_DIR), plus the
// uploaded files from apps/api/storage into DATA_DIR/storage. Postgres is only read, never changed.
// Prints a row count per table on both sides and exits with 1 if any differ.
//   npx tsx scripts/copy-from-postgres.ts            refuses if the SQLite database already has data
//   npx tsx scripts/copy-from-postgres.ts --replace  empties the SQLite database first
import '../src/env';
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaClient as PostgresClient } from '../generated/postgres';
import { prepareDatabase, singleConnectionUrl } from '../src/prisma/migrate';

const pg = new PostgresClient();
const lite = new PrismaClient({ datasourceUrl: singleConnectionUrl() });
type Delegate = { findMany: () => Promise<Record<string, unknown>[]>; createMany: (a: { data: unknown[] }) => Promise<unknown>; count: () => Promise<number>; deleteMany: () => Promise<unknown> };
const on = (client: object, model: string) => (client as Record<string, Delegate>)[model[0].toLowerCase() + model.slice(1)];

const models = Prisma.dmmf.datamodel.models;
/** Many-to-many join tables Prisma makes without a model (two columns, A and B). */
const JOIN_TABLES = ['_PositionCerts', '_PositionQualifications'];

async function count(name: string, side: 'pg' | 'lite') {
  if (JOIN_TABLES.includes(name)) {
    const rows = side === 'pg'
      ? await pg.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM "${name}"`)
      : await lite.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM "${name}"`);
    return Number(rows[0].n);
  }
  return on(side === 'pg' ? pg : lite, name).count();
}

function files(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).reduce((n, f) => n + (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : 1), 0);
}

/** Every row of every model, field by field (dates as ISO strings, rows sorted). Returns the models that differ. */
async function compareContent(): Promise<string[]> {
  const norm = (v: unknown) => JSON.stringify(v, (_k, x) => x instanceof Date ? x.toISOString() : x);
  const differ: string[] = [];
  for (const m of models) {
    const [a, b] = await Promise.all([on(pg, m.name).findMany(), on(lite, m.name).findMany()]);
    const key = (rows: Record<string, unknown>[]) => rows.map(norm).sort().join('\n');
    if (key(a) !== key(b)) differ.push(m.name);
  }
  return differ;
}

async function main() {
  if (!process.env.POSTGRES_URL) throw new Error('POSTGRES_URL is not set (apps/api/.env)');
  if (process.argv.includes('--verify')) {
    const differ = await compareContent();
    console.log(differ.length ? `Content differs in: ${differ.join(', ')}` : `Content matches: every row of all ${models.length} models is identical.`);
    if (differ.length) process.exitCode = 1;
    return;
  }
  console.log(`From ${process.env.POSTGRES_URL.replace(/:[^:@/]+@/, ':***@')}\nTo   ${process.env.DATABASE_URL}\n`);
  await prepareDatabase(lite);

  const names = [...models.map(m => m.name), ...JOIN_TABLES];
  const filled = [];
  for (const n of names) if (await count(n, 'lite') > 0) filled.push(n);
  if (filled.length && !process.argv.includes('--replace')) {
    throw new Error(`The SQLite database already has data (${filled.join(', ')}). Run with --replace to empty it first.`);
  }

  await lite.$executeRawUnsafe('PRAGMA foreign_keys=OFF'); // tables go in any order; checked at the end
  try {
    for (const t of JOIN_TABLES) await lite.$executeRawUnsafe(`DELETE FROM "${t}"`);
    for (const m of models) await on(lite, m.name).deleteMany();

    for (const m of models) {
      const json = m.fields.filter(f => f.type === 'Json').map(f => f.name);
      const rows = (await on(pg, m.name).findMany()).map(r => {
        for (const f of json) if (r[f] === null) r[f] = Prisma.DbNull; // optional Json: null must be spelled DbNull
        return r;
      });
      for (let i = 0; i < rows.length; i += 500) await on(lite, m.name).createMany({ data: rows.slice(i, i + 500) });
    }
    for (const t of JOIN_TABLES) {
      const rows = await pg.$queryRawUnsafe<{ A: string; B: string }[]>(`SELECT "A", "B" FROM "${t}"`);
      for (const r of rows) await lite.$executeRawUnsafe(`INSERT INTO "${t}" ("A", "B") VALUES (?, ?)`, r.A, r.B);
    }
  } finally {
    await lite.$executeRawUnsafe('PRAGMA foreign_keys=ON');
  }
  const broken = await lite.$queryRawUnsafe<unknown[]>('PRAGMA foreign_key_check');

  // Uploaded files: before the switch they lived in apps/api/storage (the API's working folder).
  const oldStorage = join(__dirname, '..', 'storage');
  const newStorage = process.env.STORAGE_DIR!;
  if (existsSync(oldStorage)) cpSync(oldStorage, newStorage, { recursive: true, force: false, errorOnExist: false });

  let differ = 0;
  const rows: [string, number, number][] = [];
  for (const n of names) rows.push([n, await count(n, 'pg'), await count(n, 'lite')]);
  rows.push(['(uploaded files)', files(oldStorage), files(newStorage)]);
  const w = Math.max(...rows.map(r => r[0].length));
  console.log(`${'Table'.padEnd(w)}  Postgres    SQLite`);
  for (const [n, a, b] of rows) {
    if (a !== b) differ++;
    console.log(`${n.padEnd(w)}  ${String(a).padStart(8)}  ${String(b).padStart(8)}${a === b ? '' : '   <-- differs'}`);
  }
  console.log(`\n${rows.reduce((s, r) => s + r[1], 0)} rows and files in Postgres, ${rows.reduce((s, r) => s + r[2], 0)} in SQLite.`);
  console.log(broken.length ? `${broken.length} broken references (PRAGMA foreign_key_check)` : 'No broken references.');
  console.log(differ || broken.length ? 'NOT OK: see above.' : 'OK: every table and file matches.');
  if (differ || broken.length) process.exitCode = 1;
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => { await pg.$disconnect(); await lite.$disconnect(); });

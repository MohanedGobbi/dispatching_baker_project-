// Read-only: every table with its row count, then any broken references. Uses DATA_DIR / DATABASE_URL like the app.
import '../src/env';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log(process.env.DATABASE_URL);
  const tables = await prisma.$queryRawUnsafe<{ name: string }[]>(`SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`);
  for (const t of tables) {
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM "${t.name}"`);
    console.log(`${t.name.padEnd(26)} ${String(n).padStart(6)}`);
  }
  const broken = await prisma.$queryRawUnsafe<unknown[]>('PRAGMA foreign_key_check');
  console.log(broken.length ? `${broken.length} broken references` : 'No broken references.');
}

main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());

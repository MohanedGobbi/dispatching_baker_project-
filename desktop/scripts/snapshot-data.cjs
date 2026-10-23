// Puts a snapshot of the crew data into build/seed-data, which the installer carries. On a computer with no CrewBoard
// data yet, the first launch copies it into %APPDATA%\CrewBoard\data (desktop/main.js); existing data is never touched.
// Reads only: the source database is copied with VACUUM INTO (a consistent copy even while CrewBoard is open) and the
// source folder is not modified. Source: CREWBOARD_SEED_FROM, else %APPDATA%\CrewBoard\data.
// The snapshot holds real names: build/ is git-ignored, and so is the installer.
const { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } = require('node:fs');
const { join } = require('node:path');

const desktop = join(__dirname, '..');
const out = join(desktop, 'build', 'seed-data');
const from = process.env.CREWBOARD_SEED_FROM ?? join(process.env.APPDATA ?? '', 'CrewBoard', 'data');

rmSync(out, { recursive: true, force: true });
if (process.argv.includes('--no-data')) { console.log('No crew data in this installer (--no-data): it starts empty.'); process.exit(0); }
if (!existsSync(join(from, 'crewboard.db'))) throw new Error(`No crew data to put in the installer: ${join(from, 'crewboard.db')} does not exist (use --no-data for an empty installer)`);

const files = dir => existsSync(dir) ? readdirSync(dir).reduce((n, f) => n + (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : 1), 0) : 0;

(async () => {
  const { PrismaClient } = require(join(desktop, '..', 'apps', 'api', 'prisma', 'client'));
  mkdirSync(out, { recursive: true });
  const prisma = new PrismaClient({ datasourceUrl: `file:${join(from, 'crewboard.db')}` });
  try {
    await prisma.$executeRawUnsafe(`VACUUM INTO '${join(out, 'crewboard.db').replace(/'/g, "''")}'`);
    const [{ n }] = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "Employee"');
    console.log(`Crew data from ${from}: ${n} people`);
  } finally { await prisma.$disconnect(); }
  if (existsSync(join(from, 'storage'))) cpSync(join(from, 'storage'), join(out, 'storage'), { recursive: true });
  console.log(`Snapshot in ${out}: database and ${files(join(out, 'storage'))} uploaded files`);
})().catch(e => { console.error(e); process.exit(1); });

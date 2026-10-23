// npm run build: a clean dist/, the Prisma client generated, TypeScript compiled, then the generated client and the
// migrations copied next to the compiled code (dist/prisma), where src/db.ts and prisma/migrate.ts look for them.
const { execSync } = require('node:child_process');
const { cpSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const api = join(__dirname, '..');
const run = cmd => execSync(cmd, { cwd: api, stdio: 'inherit' });

rmSync(join(api, 'dist'), { recursive: true, force: true });
run('npx prisma generate');
run('npx tsc -p tsconfig.json');
for (const d of ['client', 'migrations']) cpSync(join(api, 'prisma', d), join(api, 'dist', 'prisma', d), { recursive: true });
console.log('API built into dist/');

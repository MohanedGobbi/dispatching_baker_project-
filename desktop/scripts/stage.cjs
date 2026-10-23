// Assembles the desktop app in build/app: the compiled API (with its Prisma client and migrations), the built web
// app, the Electron main process and the API's runtime packages only. electron-builder packs that folder.
const { execSync } = require('node:child_process');
const { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const desktop = join(__dirname, '..');
const root = join(desktop, '..');
const out = join(desktop, 'build', 'app');
const run = (cmd, cwd, env) => execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });

if (!process.argv.includes('--no-build')) run('npm run build', root); // API (tsc, Prisma client, migrations) and web (Vite)

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'apps', 'api', 'dist'), join(out, 'api'), { recursive: true });
cpSync(join(root, 'apps', 'web', 'dist'), join(out, 'web'), { recursive: true });
cpSync(join(desktop, 'main.js'), join(out, 'main.js'));
cpSync(join(desktop, 'icon.ico'), join(out, 'icon.ico'));
for (const f of ['api/prisma/seed.js']) rmSync(join(out, f), { force: true }); // the mock-data seed is not shipped

const desk = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const apiDir = join(root, 'apps', 'api');
const apiPkg = JSON.parse(readFileSync(join(apiDir, 'package.json'), 'utf8'));
// The exact versions installed for the API (the ones it was tested with), not the ranges in its package.json.
const version = name => {
  const file = [join(apiDir, 'node_modules', name, 'package.json'), join(root, 'node_modules', name, 'package.json')].find(existsSync);
  if (!file) throw new Error(`${name} is not installed: run npm install at the repository root`);
  return JSON.parse(readFileSync(file, 'utf8')).version;
};
const dependencies = Object.fromEntries(Object.keys(apiPkg.dependencies).map(n => [n, version(n)]));
writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: 'crewboard', productName: desk.productName, version: desk.version, description: desk.description,
  author: desk.author, license: 'UNLICENSED', private: true, main: 'main.js', dependencies,
}, null, 2) + '\n');
run('npm install --omit=dev --prefer-offline --no-audit --no-fund', out, { PRISMA_SKIP_POSTINSTALL_GENERATE: '1' });
rmSync(join(out, 'package-lock.json'), { force: true });

if (!existsSync(join(out, 'api', 'prisma', 'client', 'query_engine-windows.dll.node'))) throw new Error('Prisma engine missing from the staged app');
console.log(`Staged in ${out}`);

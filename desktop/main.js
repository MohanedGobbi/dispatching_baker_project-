// CrewBoard desktop: the Electron main process. It starts the API (the compiled NestJS app in ./api) as a utility
// process on a free local port, then shows the web app (./web, served by the API) in its own window.
// Data lives in %APPDATA%\CrewBoard\data. Every request must carry a key made at launch, so no other program on this
// computer can use the API.
const { app, BrowserWindow, Menu, dialog, session, shell, utilityProcess } = require('electron');
const { copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');

// Tests point the whole app at a throwaway folder instead of %APPDATA%\CrewBoard.
if (process.env.CREWBOARD_USER_DATA) app.setPath('userData', process.env.CREWBOARD_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

const key = randomBytes(24).toString('hex');
let win = null;
let api = null;
let quitting = false;

/** Inside the installer the Prisma engine sits in app.asar.unpacked; native libraries cannot load from the archive. */
function engine() {
  const file = join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'api', 'prisma', 'client', 'query_engine-windows.dll.node');
  return existsSync(file) ? { PRISMA_QUERY_ENGINE_LIBRARY: file } : {};
}

/**
 * A computer with no CrewBoard data yet starts with the crew data the installer carries (resources/seed-data).
 * It is copied only when there is no database: existing data is never overwritten, so updating or reinstalling is safe.
 */
function firstRun(data) {
  const db = join(data, 'crewboard.db');
  const seed = [join(process.resourcesPath ?? '', 'seed-data'), join(__dirname, '..', 'seed-data')].find(d => existsSync(join(d, 'crewboard.db')));
  if (existsSync(db) || !seed) return;
  copyFileSync(join(seed, 'crewboard.db'), db);
  if (existsSync(join(seed, 'storage'))) cpSync(join(seed, 'storage'), join(data, 'storage'), { recursive: true });
}

function startApi() {
  const data = join(app.getPath('userData'), 'data');
  const logs = join(app.getPath('userData'), 'logs');
  mkdirSync(data, { recursive: true });
  mkdirSync(logs, { recursive: true });
  firstRun(data);
  return new Promise((resolve, reject) => {
    api = utilityProcess.fork(join(__dirname, 'api', 'src', 'main.js'), [], {
      stdio: 'pipe',
      serviceName: 'CrewBoard API',
      env: {
        ...process.env, ...engine(),
        DATA_DIR: data, HOST: '127.0.0.1', PORT: '0', CB_KEY: key,
        WEB_DIST: join(__dirname, 'web'), MIGRATIONS_DIR: join(__dirname, 'api', 'prisma', 'migrations'),
      },
    });
    const log = createWriteStream(join(logs, 'api.log'), { flags: 'a' });
    log.write(`\n--- ${new Date().toISOString()} CrewBoard ${app.getVersion()}\n`);
    api.stdout?.pipe(log);
    api.stderr?.pipe(log);
    api.once('message', m => resolve(m.port));
    api.once('exit', code => {
      if (quitting) return;
      const err = new Error(`The CrewBoard engine stopped (code ${code}). Details are in ${join(logs, 'api.log')}`);
      if (win) { dialog.showErrorBox('CrewBoard stopped', err.message); app.quit(); } else reject(err);
    });
  });
}

function open(origin) {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600, show: false,
    title: 'CrewBoard', backgroundColor: '#0f172a', icon: join(__dirname, 'icon.ico'),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  // Pages of the app open in CrewBoard (uploaded documents, for instance); anything else in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(origin)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: join(__dirname, 'icon.ico') } };
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin)) { e.preventDefault(); if (/^https?:/.test(url)) void shell.openExternal(url); } });
  win.on('closed', () => { win = null; });
  return win.loadURL(origin);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  let port;
  try { port = await startApi(); } catch (e) {
    dialog.showErrorBox('CrewBoard could not start', String(e && e.message || e));
    app.exit(1);
    return;
  }
  const origin = `http://127.0.0.1:${port}`;
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (d, cb) => cb({ requestHeaders: { ...d.requestHeaders, 'x-crewboard-key': key } }));
  await open(origin);
  if (process.env.CREWBOARD_SELFTEST) await selfTest(origin, process.env.CREWBOARD_SELFTEST);
});

/** Checks for the packaging tests: every screen renders through the key-guarded API, then the app quits. */
async function selfTest(origin, file) {
  const report = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    await wait(2500);
    const pages = {};
    for (const a of [...document.querySelectorAll('a[href^="#/"]')].map(a => a.getAttribute('href'))) {
      location.hash = a; await wait(1500);
      pages[a] = { h1: document.querySelector('h1')?.textContent?.trim() ?? null, errors: [...document.querySelectorAll('.banner.error,[role=alert]')].map(e => e.textContent.trim()).filter(Boolean) };
    }
    const calls = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/'));
    return { pages, apiCalls: calls.length, failed: calls.filter(e => e.responseStatus >= 400 || e.responseStatus === 0).map(e => e.name) };
  })()`);
  report.withoutKey = (await fetch(`${origin}/api/health`)).status; // Node's fetch: no key added, must be refused
  report.version = app.getVersion();
  report.packaged = app.isPackaged;
  report.userData = app.getPath('userData');
  require('node:fs').writeFileSync(file, JSON.stringify(report, null, 2));
  app.quit();
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { if (api) api.kill(); });

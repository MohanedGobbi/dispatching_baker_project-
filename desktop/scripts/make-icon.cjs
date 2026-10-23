// Draws the CrewBoard logo (apps/web/public/icon.svg) into desktop/icon.ico at 16 to 256 px, the sizes Windows uses
// for the window, taskbar, Start menu and installer. Run with Electron (it does the drawing):
//   electron-dist\electron.exe scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = readFileSync(join(__dirname, '..', '..', 'apps', 'web', 'public', 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="256" height="256" ')}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise(r => setTimeout(r, 500));
  const full = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  const pngs = SIZES.map(s => (s === 256 ? full : full.resize({ width: s, height: s, quality: 'best' })).toPNG());

  // ICO: a 6-byte header, a 16-byte entry per image, then the images (PNG data is allowed for every size).
  const header = Buffer.alloc(6 + 16 * SIZES.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(SIZES.length, 4);
  let offset = header.length;
  SIZES.forEach((s, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(s === 256 ? 0 : s, e); header.writeUInt8(s === 256 ? 0 : s, e + 1); // 0 means 256
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(pngs[i].length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  writeFileSync(join(__dirname, '..', 'icon.ico'), Buffer.concat([header, ...pngs]));
  writeFileSync(join(__dirname, '..', 'icon-256.png'), pngs[SIZES.length - 1]);
  console.log('icon.ico written', SIZES.join(', '));
  app.quit();
});

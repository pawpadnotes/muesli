// Renders the app and tray icons from SVG. Run: npx electron scripts/make-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const bars = (stroke, width) => `<g stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" fill="none"><path d="M20 38v24M40 22v56M60 32v36M80 40v20"/></g>`;
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="4" y="4" width="92" height="92" rx="22" fill="#2e7d46"/>${bars('#f2faf4', 8)}</svg>`;
const template = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${bars('#000', 10)}</svg>`;

const jobs = [
  ['icon.png', tile, 512],
  ['tray.png', tile, 32],
  ['trayTemplate.png', template, 18],
  ['trayTemplate@2x.png', template, 36],
];

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  for (const [name, svg, size] of jobs) {
    const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
    await win.loadURL(`data:text/html,<body style="margin:0;background:transparent">${encodeURIComponent(svg.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `))}`);
    await new Promise((r) => setTimeout(r, 300));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, '..', 'src', 'icons', name), img.resize({ width: size, height: size }).toPNG());
    win.destroy();
  }
  app.quit();
});

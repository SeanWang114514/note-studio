const { app, BrowserWindow, net, protocol, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The renderer must fetch bundled .tar/.tar.gz files. A file:// page cannot
// reliably fetch those archives in Chromium, so serve the complete dist tree
// through a privileged local protocol instead.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const distRoot = path.resolve(__dirname, '..', 'dist');

function resolveDistFile(requestUrl) {
  const url = new URL(requestUrl);
  if (url.host !== 'bundle') return null;
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const filePath = path.resolve(distRoot, relative);
  if (filePath !== distRoot && !filePath.startsWith(distRoot + path.sep)) return null;
  return filePath;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#f7f7f5',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL('app://bundle/index.html');
}

app.whenReady().then(() => {
  protocol.handle('app', async (request) => {
    const filePath = resolveDistFile(request.url);
    if (!filePath) return new Response('Not found', { status: 404 });
    try {
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

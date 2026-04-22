/**
 * main.js  (Electron main process)
 * IPC bridge between your renderer UI and the TicketMonitor.
 *
 * Add these ipcMain handlers to your existing main.js,
 * or merge with your current BrowserWindow setup.
 */

const { app, BrowserWindow, ipcMain, Notification, safeStorage } = require('electron');
const path = require('path');
const { TicketMonitor } = require('./ticketMonitor');

let mainWindow;
let monitor = null;

// ─── Window setup ─────────────────────────────────────────────────────────

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
});

app.on('window-all-closed', async () => {
  if (monitor) await monitor.stop();
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC: start monitoring ─────────────────────────────────────────────────

ipcMain.handle('monitor:start', async (_event, config) => {
  if (monitor) await monitor.stop();

  const profile = await loadProfile();
  monitor = new TicketMonitor(config, profile);

  // Forward log messages to renderer
  monitor.on('log', (msg, level) => {
    mainWindow?.webContents.send('monitor:log', { msg, level });
  });

  // Tickets found — notify user and send to renderer
  monitor.on('found', (result) => {
    // Desktop notification
    new Notification({
      title: '🎟 Tickets available!',
      body: `${config.eventName} — ${result.description}`,
      urgency: 'critical',
    }).show();

    mainWindow?.webContents.send('monitor:found', result);
  });

  monitor.on('autofillComplete', () => {
    mainWindow?.webContents.send('monitor:autofillComplete');
  });

  await monitor.start();
  return { ok: true };
});

// ─── IPC: stop monitoring ──────────────────────────────────────────────────

ipcMain.handle('monitor:stop', async () => {
  if (monitor) await monitor.stop();
  monitor = null;
  return { ok: true };
});

// ─── IPC: confirm order → run autofill ────────────────────────────────────

ipcMain.handle('monitor:autofill', async () => {
  if (!monitor) return { ok: false, error: 'Monitor not running' };
  try {
    const page = await monitor.launchVisible();
    await page.goto(monitor.config.url, { waitUntil: 'domcontentloaded' });
    await monitor.autofillAndShow(() => {
      mainWindow?.webContents.send('monitor:captchaDetected');
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─── IPC: cancel — skip these tickets, resume polling ─────────────────────

ipcMain.handle('monitor:resume', async () => {
  if (monitor) {
    monitor.pollCount = 0;
    monitor._schedulePoll();
  }
  return { ok: true };
});

// ─── IPC: save / load profile via OS keychain ─────────────────────────────

ipcMain.handle('profile:save', async (_event, profile) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'OS keychain not available' };
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(profile));
  // Persist the Buffer — in production write to a file or electron-store
  app.encryptedProfile = encrypted;
  return { ok: true };
});

ipcMain.handle('profile:load', async () => {
  try {
    const profile = await loadProfile();
    // Return a redacted version to the renderer (never send raw card numbers to UI)
    return {
      name: profile.name,
      email: profile.email,
      cardLast4: profile.cardNumber?.slice(-4),
      deliveryMethod: profile.deliveryMethod,
    };
  } catch {
    return null;
  }
});

async function loadProfile() {
  if (!app.encryptedProfile) {
    // Fallback for dev — in production always use the keychain
    return {
      name: 'Your Name',
      email: 'you@example.com',
      cardNumber: '',
      cardExpiry: '',
      cardCvv: '',
      deliveryMethod: 'mobile',
    };
  }
  const decrypted = safeStorage.decryptString(app.encryptedProfile);
  return JSON.parse(decrypted);
}

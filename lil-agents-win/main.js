const { app, dialog } = require('electron');

// Prevent Electron/Chromium from disrupting Bluetooth audio profiles on startup.
// Without these flags, Chromium's audio service initializes aggressively and causes
// Windows to switch Bluetooth from A2DP (stereo) to Hands-Free (mono), disconnecting
// the headset.
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');
app.commandLine.appendSwitch('audio-buffer-size', '4096');

// Catch errors early
process.on('uncaughtException', (err) => {
  dialog.showErrorBox('lil agents error', err.stack || err.message);
});

const { AppManager } = require('./src/main/app');

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  let appManager;

  app.on('second-instance', () => {
    // Focus existing instance
  });

  app.whenReady().then(() => {
    appManager = new AppManager();
    appManager.init();
  });

  app.on('window-all-closed', (e) => {
    // Keep running in tray
    e.preventDefault();
  });

  app.on('before-quit', () => {
    if (appManager) appManager.cleanup();
  });
}

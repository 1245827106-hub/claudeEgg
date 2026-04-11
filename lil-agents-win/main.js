const { app, dialog } = require('electron');

// Disable Windows media overlay (volume OSD) triggered by HTMLAudioElement.play()
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');

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

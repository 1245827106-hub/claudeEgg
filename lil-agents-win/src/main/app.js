const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { CharacterManager } = require('./character-manager');
const { ALL_THEME_NAMES, getCharacterTheme, setCharacterTheme } = require('./themes');

class AppManager {
  constructor() {
    this.tray = null;
    this.characterManager = null;
  }

  init() {
    this.characterManager = new CharacterManager();
    this.characterManager.init();
    this._createTray();
  }

  _createTray() {
    const icon = this._createTrayIcon();
    this.tray = new Tray(icon);
    this.tray.setToolTip('lil agents');
    this.tray.on('click', () => this.tray.popUpContextMenu());
    this._rebuildMenu();
  }

  _buildCharacterThemeSubmenu(characterId) {
    const current = getCharacterTheme(characterId);
    return ALL_THEME_NAMES.map(name => ({
      label: name,
      type: 'radio',
      checked: current.name === name,
      click: () => {
        setCharacterTheme(characterId, name);
        const char = this.characterManager.characters[characterId];
        if (char) char.applyTheme();
        this._rebuildMenu();
      }
    }));
  }

  _rebuildMenu() {
    const contextMenu = Menu.buildFromTemplate([
      { label: 'lil agents', enabled: false },
      { type: 'separator' },
      {
        label: 'Bruce',
        submenu: [
          {
            label: 'Show',
            type: 'checkbox',
            checked: true,
            click: (menuItem) => {
              const bruce = this.characterManager.characters.bruce;
              if (menuItem.checked) {
                if (bruce.window && !bruce.window.isDestroyed()) bruce.window.show();
              } else {
                if (bruce.window && !bruce.window.isDestroyed()) bruce.window.hide();
                bruce._hideBubble();
                if (bruce.chatWindow && !bruce.chatWindow.isDestroyed()) bruce.chatWindow.hide();
                bruce.isIdleForPopover = false;
              }
            }
          },
          { type: 'separator' },
          {
            label: 'Theme',
            submenu: this._buildCharacterThemeSubmenu('bruce'),
          }
        ]
      },
      {
        label: 'Jazz',
        submenu: [
          {
            label: 'Show',
            type: 'checkbox',
            checked: true,
            click: (menuItem) => {
              const jazz = this.characterManager.characters.jazz;
              if (menuItem.checked) {
                if (jazz.window && !jazz.window.isDestroyed()) jazz.window.show();
              } else {
                if (jazz.window && !jazz.window.isDestroyed()) jazz.window.hide();
                jazz._hideBubble();
                if (jazz.chatWindow && !jazz.chatWindow.isDestroyed()) jazz.chatWindow.hide();
                jazz.isIdleForPopover = false;
              }
            }
          },
          { type: 'separator' },
          {
            label: 'Theme',
            submenu: this._buildCharacterThemeSubmenu('jazz'),
          }
        ]
      },
      { type: 'separator' },
      {
        label: 'Sound Effects',
        type: 'checkbox',
        checked: CharacterManager.getSoundsEnabled(),
        click: (menuItem) => {
          CharacterManager.setSoundsEnabled(menuItem.checked);
        }
      },
      {
        label: 'Text to Speech',
        type: 'checkbox',
        checked: CharacterManager.getTTSEnabled(),
        click: (menuItem) => {
          CharacterManager.setTTSEnabled(menuItem.checked);
          if (menuItem.checked) {
            this.characterManager.ttsService.start().catch(() => {});
          } else {
            this.characterManager.ttsService.stop();
          }
          this._rebuildMenu();
        }
      },
      {
        label: 'Wake Word (小爱)',
        type: 'checkbox',
        checked: CharacterManager.getWakewordEnabled(),
        click: (menuItem) => {
          this.characterManager.setWakewordEnabled(menuItem.checked);
          this._rebuildMenu();
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          this.cleanup();
          app.quit();
        }
      }
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  _createTrayIcon() {
    const size = 16;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <circle cx="${size/2}" cy="${size/2}" r="${size/2 - 1}" fill="#e87461"/>
      <circle cx="${size/2 - 2}" cy="${size/2 - 1}" r="1.2" fill="#2a2a2a"/>
      <circle cx="${size/2 + 2}" cy="${size/2 - 1}" r="1.2" fill="#2a2a2a"/>
    </svg>`;
    return nativeImage.createFromDataURL(
      `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
    );
  }

  _getASRStatusLabel() {
    if (!this.characterManager || !this.characterManager.asrService) return 'N/A';
    const status = this.characterManager.asrService.getStatus();
    if (status === 'ready') return 'Ready';
    if (status === 'loading') return 'Loading...';
    if (status === 'error') return 'Error';
    return 'Stopped';
  }

  _getTTSStatusLabel() {
    if (!this.characterManager || !this.characterManager.ttsService) return 'N/A';
    const status = this.characterManager.ttsService.getStatus();
    if (status === 'ready') return 'Ready';
    if (status === 'loading') return 'Loading...';
    if (status === 'error') return 'Error';
    return 'Stopped';
  }

  cleanup() {
    if (this.characterManager) this.characterManager.cleanup();
    if (this.tray) this.tray.destroy();
  }
}

module.exports = { AppManager };

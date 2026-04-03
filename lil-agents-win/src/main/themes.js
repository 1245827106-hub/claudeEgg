/**
 * Theme system - ported from PopoverTheme.swift
 * 4 themes: Peach, Midnight, Cloud, Moss
 */

const Store = require('./store');

const THEMES = {
  Peach: {
    name: 'Peach',
    titleFormat: 'lowercaseTilde', // "claude ~"
    // Popover
    popoverBg: 'rgba(255, 247, 235, 0.97)',
    popoverBorder: 'rgba(242, 140, 166, 0.8)',
    popoverBorderWidth: '2.5px',
    popoverRadius: '24px',
    titleBarBg: 'rgba(250, 237, 224, 1)',
    titleText: 'rgba(217, 89, 115, 1)',
    titleFontWeight: '800',
    titleFontFamily: "-apple-system, 'Segoe UI', system-ui, sans-serif",
    separator: 'rgba(242, 140, 166, 0.25)',
    // Terminal
    fontFamily: "-apple-system, 'Segoe UI', system-ui, sans-serif",
    fontSize: '12px',
    fontBoldWeight: '600',
    textPrimary: 'rgba(51, 46, 56, 1)',
    textDim: 'rgba(128, 120, 133, 1)',
    accent: 'rgba(217, 89, 115, 1)',
    error: 'rgba(230, 77, 51, 1)',
    success: 'rgba(77, 184, 128, 1)',
    inputBg: 'rgba(255, 250, 242, 1)',
    inputRadius: '14px',
    // Bubble
    bubbleBg: 'rgba(255, 242, 230, 0.95)',
    bubbleBorder: 'rgba(242, 140, 166, 0.6)',
    bubbleText: 'rgba(140, 128, 133, 1)',
    bubbleCompletionBorder: 'rgba(77, 191, 128, 0.7)',
    bubbleCompletionText: 'rgba(51, 153, 102, 1)',
    bubbleFontWeight: '600',
    bubbleFontSize: '11px',
    bubbleRadius: '14px',
  },

  Midnight: {
    name: 'Midnight',
    titleFormat: 'uppercase', // "CLAUDE"
    popoverBg: 'rgba(18, 18, 18, 0.96)',
    popoverBorder: 'rgba(255, 102, 0, 0.7)',
    popoverBorderWidth: '2.5px',
    popoverRadius: '12px',
    titleBarBg: 'rgba(26, 26, 26, 1)',
    titleText: 'rgba(255, 102, 0, 1)',
    titleFontWeight: '700',
    titleFontFamily: "'Cascadia Code', 'Consolas', 'SF Mono', monospace",
    separator: 'rgba(255, 102, 0, 0.3)',
    fontFamily: "'Cascadia Code', 'Consolas', 'SF Mono', monospace",
    fontSize: '11.5px',
    fontBoldWeight: '500',
    textPrimary: 'rgba(255, 255, 255, 1)',
    textDim: 'rgba(153, 153, 153, 1)',
    accent: 'rgba(255, 102, 0, 1)',
    error: 'rgba(255, 77, 51, 1)',
    success: 'rgba(102, 166, 102, 1)',
    inputBg: 'rgba(31, 31, 31, 1)',
    inputRadius: '4px',
    bubbleBg: 'rgba(26, 26, 26, 0.92)',
    bubbleBorder: 'rgba(255, 102, 0, 0.6)',
    bubbleText: 'rgba(179, 179, 179, 1)',
    bubbleCompletionBorder: 'rgba(77, 204, 77, 0.7)',
    bubbleCompletionText: 'rgba(77, 217, 77, 1)',
    bubbleFontWeight: '500',
    bubbleFontSize: '10px',
    bubbleRadius: '12px',
  },

  Cloud: {
    name: 'Cloud',
    titleFormat: 'lowercaseTilde', // "claude ~"
    popoverBg: 'rgba(240, 242, 245, 0.98)',
    popoverBorder: 'rgba(14, 68, 184, 0.8)',
    popoverBorderWidth: '2.5px',
    popoverRadius: '16px',
    titleBarBg: 'rgba(224, 230, 237, 1)',
    titleText: 'rgba(77, 77, 89, 1)',
    titleFontWeight: '600',
    titleFontFamily: "-apple-system, 'Segoe UI', system-ui, sans-serif",
    separator: 'rgba(160, 170, 195, 0.7)',
    fontFamily: "-apple-system, 'Segoe UI', system-ui, sans-serif",
    fontSize: '12px',
    fontBoldWeight: '600',
    textPrimary: 'rgba(38, 38, 51, 1)',
    textDim: 'rgba(128, 128, 140, 1)',
    accent: 'rgba(0, 120, 214, 1)',
    error: 'rgba(217, 51, 38, 1)',
    success: 'rgba(51, 166, 77, 1)',
    inputBg: 'rgba(255, 255, 255, 1)',
    inputRadius: '8px',
    bubbleBg: 'rgba(240, 242, 247, 0.95)',
    bubbleBorder: 'rgba(0, 120, 214, 0.4)',
    bubbleText: 'rgba(115, 120, 133, 1)',
    bubbleCompletionBorder: 'rgba(51, 179, 77, 0.6)',
    bubbleCompletionText: 'rgba(38, 140, 51, 1)',
    bubbleFontWeight: '600',
    bubbleFontSize: '10px',
    bubbleRadius: '12px',
  },

  Moss: {
    name: 'Moss',
    titleFormat: 'capitalized', // "Claude"
    popoverBg: 'rgba(209, 214, 199, 0.98)',
    popoverBorder: 'rgba(140, 148, 128, 0.8)',
    popoverBorderWidth: '2.5px',
    popoverRadius: '10px',
    titleBarBg: 'rgba(184, 191, 173, 1)',
    titleText: 'rgba(38, 43, 31, 1)',
    titleFontWeight: '700',
    titleFontFamily: "'Consolas', 'Courier New', monospace",
    separator: 'rgba(140, 148, 128, 0.5)',
    fontFamily: "'Consolas', 'Courier New', monospace",
    fontSize: '11px',
    fontBoldWeight: '700',
    textPrimary: 'rgba(26, 31, 20, 1)',
    textDim: 'rgba(89, 97, 77, 1)',
    accent: 'rgba(51, 56, 38, 1)',
    error: 'rgba(153, 38, 26, 1)',
    success: 'rgba(38, 102, 38, 1)',
    inputBg: 'rgba(224, 230, 214, 1)',
    inputRadius: '3px',
    bubbleBg: 'rgba(209, 214, 199, 0.95)',
    bubbleBorder: 'rgba(140, 148, 128, 0.7)',
    bubbleText: 'rgba(102, 107, 97, 1)',
    bubbleCompletionBorder: 'rgba(51, 128, 51, 0.7)',
    bubbleCompletionText: 'rgba(38, 102, 38, 1)',
    bubbleFontWeight: '500',
    bubbleFontSize: '10px',
    bubbleRadius: '8px',
  },
};

const ALL_THEME_NAMES = ['Peach', 'Midnight', 'Cloud', 'Moss'];

function getCurrentTheme() {
  const name = Store.get('theme', 'Peach');
  return THEMES[name] || THEMES.Peach;
}

function setCurrentTheme(name) {
  if (THEMES[name]) {
    Store.set('theme', name);
  }
}

function getCharacterTheme(characterId) {
  const name = Store.get(`theme_${characterId}`, 'Peach');
  return THEMES[name] || THEMES.Peach;
}

function setCharacterTheme(characterId, name) {
  if (THEMES[name]) {
    Store.set(`theme_${characterId}`, name);
  }
}

function formatTitle(theme) {
  const name = 'Claude';
  switch (theme.titleFormat) {
    case 'uppercase': return name.toUpperCase();
    case 'lowercaseTilde': return `${name.toLowerCase()} ~`;
    case 'capitalized': return name;
    default: return name;
  }
}

/**
 * Convert theme to CSS custom properties string
 */
function themeToCSSVars(theme) {
  return `
    --popover-bg: ${theme.popoverBg};
    --popover-border: ${theme.popoverBorder};
    --popover-border-width: ${theme.popoverBorderWidth};
    --popover-radius: ${theme.popoverRadius};
    --title-bar-bg: ${theme.titleBarBg};
    --title-text: ${theme.titleText};
    --title-font-weight: ${theme.titleFontWeight};
    --title-font-family: ${theme.titleFontFamily};
    --separator: ${theme.separator};
    --font-family: ${theme.fontFamily};
    --font-size: ${theme.fontSize};
    --font-bold-weight: ${theme.fontBoldWeight};
    --text-primary: ${theme.textPrimary};
    --text-dim: ${theme.textDim};
    --accent: ${theme.accent};
    --error: ${theme.error};
    --success: ${theme.success};
    --input-bg: ${theme.inputBg};
    --input-radius: ${theme.inputRadius};
  `;
}

module.exports = { THEMES, ALL_THEME_NAMES, getCurrentTheme, setCurrentTheme, getCharacterTheme, setCharacterTheme, formatTitle, themeToCSSVars };

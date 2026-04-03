const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Find a binary in PATH or common locations
 */
function findBinary(name, fallbackPaths = []) {
  // Check PATH first
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  const ext = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];

  for (const dir of pathDirs) {
    for (const e of ext) {
      const fullPath = path.join(dir, name + e);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  // Check fallback paths
  for (const p of fallbackPaths) {
    for (const e of ext) {
      const fullPath = p + e;
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return null;
}

/**
 * Build process environment with enhanced PATH
 */
function getProcessEnv() {
  const home = os.homedir();
  const env = { ...process.env };

  // Add common paths for CLI tools
  const extraPaths = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local', 'bin'),
    path.join(home, 'AppData', 'Roaming', 'npm'),
    path.join(home, 'AppData', 'Local', 'Programs', 'claude-code'),
    'C:\\Program Files\\nodejs',
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];

  const currentPath = env.PATH || env.Path || '';
  env.PATH = extraPaths.join(path.delimiter) + path.delimiter + currentPath;
  env.TERM = 'dumb';

  // Remove Claude Code nesting detection markers
  delete env.CLAUDE_CODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  return env;
}

/**
 * Get common fallback paths for Claude CLI
 */
function getClaudeFallbackPaths() {
  const home = os.homedir();
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'bin', 'claude'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'claude'),
    path.join(home, 'AppData', 'Local', 'Programs', 'claude-code', 'claude'),
    'C:\\Program Files\\nodejs\\claude',
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
}

module.exports = { findBinary, getProcessEnv, getClaudeFallbackPaths };

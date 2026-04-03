/**
 * Simple JSON file store for persisting settings
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_PATH = path.join(os.homedir(), '.lil-agents-settings.json');

let data = {};

// Load on startup
try {
  if (fs.existsSync(STORE_PATH)) {
    data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  }
} catch {
  data = {};
}

function get(key, defaultValue) {
  return data[key] !== undefined ? data[key] : defaultValue;
}

function set(key, value) {
  data[key] = value;
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // Ignore write errors
  }
}

module.exports = { get, set };

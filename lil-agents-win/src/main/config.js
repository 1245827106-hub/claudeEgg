/**
 * Centralized service configuration.
 *
 * Resolution order (highest priority first):
 *   1. Values set at runtime via Store (user config UI)
 *   2. Environment variables (LIL_ASR_PYTHON, LIL_TTS_PYTHON, LIL_WAKEWORD_PYTHON, ...)
 *   3. Optional config.json in project root or user home
 *   4. Built-in fallback (only suitable for the original developer machine)
 *
 * Provide a project-root `config.json` (see config.example.json) to override
 * the fallbacks without modifying source.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const Store = require('./store');

const BUILTIN_FALLBACK = {
  asr_python_path: 'E:/Qwen3-ASR/envs/qwen3-asr/python.exe',
  asr_model_path: 'E:/Qwen3-ASR/models/Qwen3-ASR-1.7B',
  asr_port: 18920,
  asr_language: 'Chinese',
  tts_python_path: 'C:/Users/ZMJ/miniconda3/envs/lilvoice/python.exe',
  tts_port: 18921,
  wakeword_python_path: null, // null → fall back to asr_python_path
  wakeword_port: 18922,
};

const ENV_MAP = {
  asr_python_path: 'LIL_ASR_PYTHON',
  asr_model_path: 'LIL_ASR_MODEL',
  asr_port: 'LIL_ASR_PORT',
  asr_language: 'LIL_ASR_LANGUAGE',
  tts_python_path: 'LIL_TTS_PYTHON',
  tts_port: 'LIL_TTS_PORT',
  wakeword_python_path: 'LIL_WAKEWORD_PYTHON',
  wakeword_port: 'LIL_WAKEWORD_PORT',
};

// Load file-based overrides once at module load.
function loadFileOverrides() {
  const candidates = [
    path.join(process.cwd(), 'config.json'),
    path.join(__dirname, '..', '..', 'config.json'),
    path.join(os.homedir(), '.lil-agents-config.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch {
      // Ignore malformed files, try the next candidate.
    }
  }
  return {};
}

const FILE_OVERRIDES = loadFileOverrides();

function coerce(key, value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (key.endsWith('_port')) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return value;
}

function resolve(key) {
  const stored = Store.get(key, undefined);
  if (stored !== undefined && stored !== '') return stored;

  const envKey = ENV_MAP[key];
  const envVal = envKey ? coerce(key, process.env[envKey]) : undefined;
  if (envVal !== undefined) return envVal;

  const fileVal = coerce(key, FILE_OVERRIDES[key]);
  if (fileVal !== undefined) return fileVal;

  return BUILTIN_FALLBACK[key];
}

module.exports = {
  get: resolve,
  getASRConfig: () => ({
    pythonPath: resolve('asr_python_path'),
    modelPath: resolve('asr_model_path'),
    port: resolve('asr_port'),
    language: resolve('asr_language'),
  }),
  getTTSConfig: () => ({
    pythonPath: resolve('tts_python_path'),
    port: resolve('tts_port'),
  }),
  getWakewordConfig: () => ({
    pythonPath: resolve('wakeword_python_path') || resolve('asr_python_path'),
    port: resolve('wakeword_port'),
    asrPort: resolve('asr_port'),
  }),
};

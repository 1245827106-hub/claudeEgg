/**
 * Development launcher for lil-agents-win
 * Copies app files to Electron's resources/app directory and launches
 */
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const electronDir = path.join(__dirname, 'node_modules', 'electron', 'dist');
const appDir = path.join(electronDir, 'resources', 'app');
const srcDir = __dirname;

// Files and directories to copy
const filesToCopy = ['main.js', 'preload.js', 'package.json'];
const dirsToCopy = ['src'];

// Clean and recreate app directory
if (fs.existsSync(appDir)) {
  fs.rmSync(appDir, { recursive: true });
}
fs.mkdirSync(appDir, { recursive: true });

// Copy files
for (const file of filesToCopy) {
  const src = path.join(srcDir, file);
  const dst = path.join(appDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  }
}

// Copy directories recursively
function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

for (const dir of dirsToCopy) {
  const src = path.join(srcDir, dir);
  const dst = path.join(appDir, dir);
  if (fs.existsSync(src)) {
    copyDirSync(src, dst);
  }
}

console.log('App files copied to Electron resources.');
console.log('Launching lil agents...');

// Launch Electron from its own directory so it can find .pak resource files
const electronExe = path.join(electronDir, 'electron.exe');
const child = spawn(electronExe, [], {
  stdio: 'inherit',
  detached: false,
  cwd: electronDir,
});

child.on('close', (code) => {
  process.exit(code || 0);
});

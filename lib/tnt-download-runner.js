'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

const specPath = process.argv[2];
if (!specPath) {
  console.error('Missing download spec path');
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const exe = spec.exe || 'N_m3u8DL-RE';
const args = spec.args || [];
const cwd = spec.cwd || process.cwd();

const child = spawn(exe, args, {
  cwd,
  stdio: 'inherit',
  shell: false,
  windowsHide: false,
});

child.on('error', (err) => {
  console.error(err.message || err);
  process.exit(1);
});

child.on('exit', (code) => {
  if (code && code !== 0) {
    console.error(`N_m3u8DL-RE exited with code ${code}`);
    process.exit(code);
  }
});

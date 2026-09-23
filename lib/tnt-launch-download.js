'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT } = require('./paths');

const CMD_EXE = process.env.TNT_CMD_EXE || process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
const RUNNER = path.join(__dirname, 'tnt-download-runner.js');

/** Safe for cmd.exe `title` (| & ^ < > break parsing). */
function sanitizeBatchText(text) {
  return String(text || '')
    .replace(/[|&<>^]/g, ' ')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function ensureDir(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

function resolveDownloadDir(saveDir) {
  if (saveDir) return saveDir;
  const custom = process.env.TNT_DOWNLOAD_DIR;
  return custom ? path.resolve(custom) : ROOT;
}

/**
 * Launch N_m3u8DL-RE in a new cmd window.
 * Prefer downloadLaunch { exe, args, cwd } so manifest URLs keep % encoding (no .bat mangling).
 */
function launchNm3u8DlCommand(command, { saveDir = null, title = null, downloadLaunch = null } = {}) {
  if (!command && !downloadLaunch) throw new Error('No download command to launch');

  const outDir = resolveDownloadDir(saveDir || downloadLaunch?.cwd);
  ensureDir(outDir);

  const windowTitle = sanitizeBatchText(title ? `TNT download - ${title}` : 'TNT download');

  if (downloadLaunch?.exe && Array.isArray(downloadLaunch.args)) {
    const specPath = path.join(outDir, `_tnt_download_${Date.now()}.json`);
    const spec = {
      exe: downloadLaunch.exe,
      args: downloadLaunch.args,
      cwd: downloadLaunch.cwd || outDir,
    };
    fs.writeFileSync(specPath, JSON.stringify(spec), 'utf8');

    const batchName = `_tnt_download_${Date.now()}.bat`;
    const batchPath = path.join(outDir, batchName);
    const nodeExe = process.execPath;
    const batchBody = [
      '@echo off',
      'setlocal EnableExtensions',
      `cd /d "${outDir.replace(/"/g, '""')}"`,
      `title ${windowTitle}`,
      `"${nodeExe.replace(/"/g, '""')}" "${RUNNER.replace(/"/g, '""')}" "${specPath.replace(/"/g, '""')}"`,
      'if errorlevel 1 pause',
      '',
    ].join('\r\n');
    fs.writeFileSync(batchPath, batchBody, 'utf8');

    const launch = `start "" "${CMD_EXE}" /k "${batchPath}"`;
    spawn(launch, { shell: true, detached: true, stdio: 'ignore', cwd: ROOT }).unref();

    return { cmdExe: CMD_EXE, saveDir: outDir, batchPath, specPath, command, downloadLaunch: spec };
  }

  let cmdLine = String(command || '').trim();
  const batchName = `_tnt_download_${Date.now()}.bat`;
  const batchPath = path.join(outDir, batchName);
  const batchCmd = cmdLine.replace(/%/g, '%%');
  const batchBody = [
    '@echo off',
    'setlocal EnableExtensions',
    'cd /d "%~dp0"',
    `title ${windowTitle}`,
    `call ${batchCmd}`,
    'if errorlevel 1 pause',
    '',
  ].join('\r\n');
  fs.writeFileSync(batchPath, batchBody, 'utf8');

  const launch = `start "" "${CMD_EXE}" /k "${batchPath}"`;
  spawn(launch, { shell: true, detached: true, stdio: 'ignore', cwd: ROOT }).unref();

  return { cmdExe: CMD_EXE, saveDir: outDir, batchPath, command: cmdLine };
}

module.exports = { launchNm3u8DlCommand, ensureDir };

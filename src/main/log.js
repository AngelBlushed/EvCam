'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_BYTES = 512 * 1024;

/** Mirrors console output into <userData>/evcam.log (kept small) to help diagnose problems. */
function install() {
  const file = path.join(app.getPath('userData'), 'evcam.log');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.old`);
  } catch { /* logging must never break the app */ }

  const write = (level, args) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${util.format(...args)}\n`);
    } catch { /* ignore */ }
  };
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { original(...args); write(level.toUpperCase(), args); };
  }
  process.on('uncaughtException', (err) => write('FATAL', [err && err.stack || err]));
  process.on('unhandledRejection', (err) => write('REJECT', [err && err.stack || err]));
  return file;
}

module.exports = { install };

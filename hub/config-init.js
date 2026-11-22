// Loads hub/config.json. On the first run it is created from config.example.json with a fresh random access key,
// and wallpaper/config.js (how the wallpaper page finds the hub) is written to match.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function loadConfig() {
  const file = path.join(__dirname, 'config.json');
  if (!fs.existsSync(file)) {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.example.json'), 'utf8'));
    cfg.key = crypto.randomBytes(18).toString('hex');
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const js = path.join(__dirname, '..', 'wallpaper', 'config.js');
  const want = `window.NULLWAVE = { hub: 'http://127.0.0.1:${cfg.port}', key: '${cfg.key}' };\n`;
  try { if (!fs.existsSync(js) || fs.readFileSync(js, 'utf8') !== want) fs.writeFileSync(js, want); } catch {}
  return cfg;
};

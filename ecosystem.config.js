const fs = require('fs');
const path = require('path');

// Parse .env file into object
function loadEnv(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

module.exports = {
  apps: [{
    name: 'visitor-logger',
    script: './server.js',
    cwd: '/opt/visitor-logger',
    env: loadEnv('/opt/visitor-logger/.env'),
    autorestart: true,
    max_restarts: 10,
    restart_delay: 1000,
  }],
};

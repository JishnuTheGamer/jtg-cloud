const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const filename = path.join(__dirname, '.env');
const configured = fs.existsSync(filename) ? parseEnv(fs.readFileSync(filename, 'utf8')) : {};
const env = { NODE_ENV: 'production' };
// Explicit file values replace stale settings retained by an existing PM2 process.
for (const key of ['PORT','HOST','APP_URL','TRUST_PROXY','COOKIE_SECURE','DATA_DIR','BACKUP_DIR','REGISTRATION_DOMAIN']) {
  if (Object.hasOwn(configured, key)) env[key] = configured[key];
}

module.exports = {
  apps: [{
    name: 'jtg-cloud', cwd: __dirname, script: 'src/server.mjs',
    node_args: '--env-file-if-exists=.env', instances: 1, exec_mode: 'fork',
    autorestart: true, max_memory_restart: '700M', kill_timeout: 12000,
    exp_backoff_restart_delay: 1000, time: true,
    env
  }]
};

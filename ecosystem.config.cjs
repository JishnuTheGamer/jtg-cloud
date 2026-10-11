module.exports = {
  apps: [{
    name: 'jtg-cloud', cwd: __dirname, script: 'src/server.mjs',
    node_args: '--env-file-if-exists=.env', instances: 1, exec_mode: 'fork',
    autorestart: true, max_memory_restart: '700M', kill_timeout: 12000,
    exp_backoff_restart_delay: 1000, time: true,
    env: { NODE_ENV: 'production' }
  }]
};

#!/usr/bin/env bash
# JTG Cloud updater by JTG Studio.
set -Eeuo pipefail
umask 077
configure_service_env() {
  node --input-type=module - "$APP_DIR" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const filename = path.join(process.argv[2], '.env');
let text = fs.readFileSync(filename, 'utf8').replaceAll('\r\n', '\n');
if (/^JTG_NETWORK_MODE=direct-v1\s*$/m.test(text)) process.exit(0);
const values = {PORT:'6969',HOST:'0.0.0.0',APP_URL:'',TRUST_PROXY:'false',COOKIE_SECURE:'false',JTG_NETWORK_MODE:'direct-v1'};
for (const [key, value] of Object.entries(values)) {
  const expression = new RegExp(`^${key}=.*$`, 'gm');
  text = expression.test(text) ? text.replace(expression, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
}
fs.writeFileSync(filename,text);
console.log('Service configured for localhost / IPv4 on port 6969.');
JS
}
previous_restart_safe() {
  node --env-file=.env --input-type=module - "$APP_DIR" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const directory = process.argv[2];
const [major, minor] = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'))).version.split('.').map(Number);
if (major > 1 || (major === 1 && minor >= 1)) process.exit(0);
const filename = path.resolve(directory, process.env.DATA_DIR || 'data', 'cloud.sqlite');
if (!fs.existsSync(filename)) process.exit(0);
const db = new DatabaseSync(filename, { readOnly: true });
try {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const hasNewBlobs = ['file_parts', 'upload_parts'].some(table => tables.has(table) && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get());
  const hasNewEntries = db.prepare('PRAGMA table_info(entries)').all().some(column => column.name === 'storage_format') && db.prepare("SELECT 1 FROM entries WHERE storage_format='chunked' LIMIT 1").get();
  if (hasNewBlobs || hasNewEntries) process.exitCode = 2;
} finally { db.close(); }
JS
}
follow_remote_branch() {
  branch=$(git symbolic-ref --short HEAD)
  if git show-ref --verify --quiet "refs/remotes/origin/$branch"; then return 0; fi
  # Follow a renamed default branch only when the existing source can fast-forward.
  local default_branch
  default_branch=$(git ls-remote --symref origin HEAD | awk '$1=="ref:" && $3=="HEAD" {sub(/^refs\/heads\//,"",$2); print $2}')
  [[ -n "$default_branch" ]] && git show-ref --verify --quiet "refs/remotes/origin/$default_branch" || { printf 'The tracked branch was removed and no remote default branch was found. Review the Git checkout.\n' >&2; return 1; }
  git merge-base --is-ancestor HEAD "origin/$default_branch" || { printf 'The renamed branch is not a fast-forward. Review the Git checkout.\n' >&2; return 1; }
  git branch -m "$default_branch" || return 1
  branch=$default_branch
  git branch --set-upstream-to="origin/$branch" "$branch" || return 1
  git remote set-head origin "$branch" || return 1
  printf 'Following renamed branch: %s\n' "$branch"
}
# Parse the complete update before replacing its tracked script on disk.
main() {
APP_DIR=/root/jtg-cloud
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export PM2_HOME=/root/.pm2
[[ $EUID -eq 0 ]] || { printf 'Run with sudo bash update.sh\n' >&2; exit 1; }
[[ -d "$APP_DIR/.git" && -f "$APP_DIR/.env" ]] || { printf 'A managed installation was not found.\n' >&2; exit 1; }
[[ ! -L "$APP_DIR" && "$(realpath -e -- "$APP_DIR")" == "$APP_DIR" ]] || { printf 'Unsafe installation directory.\n' >&2; exit 1; }
[[ ! -L "$APP_DIR/.git" && ! -L "$APP_DIR/.env" ]] || { printf 'Managed Git/environment paths must not be symbolic links.\n' >&2; exit 1; }
command -v pm2 >/dev/null || { printf 'Global PM2 is missing. Choose Repair / migrate in the latest installer.\n' >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)' || { printf 'Node.js 24+ is required. Choose Repair / migrate.\n' >&2; exit 1; }
cd "$APP_DIR"
if [[ -t 1 && -z "${NO_COLOR+x}" && "${TERM:-dumb}" != dumb ]]; then
  printf '\n\033[1;36mJTG CLOUD / JTG Studio\033[0m\n\033[1mApplication update\033[0m\n\n'
else
  printf '\nJTG CLOUD / JTG Studio\nApplication update\n\n'
fi
health() {
  local i
  for i in {1..30}; do
    if curl --noproxy '*' --connect-timeout 2 --max-time 3 --fail --silent http://127.0.0.1:6969/api/health | node -e 'try {const body=JSON.parse(require("node:fs").readFileSync(0,"utf8"));process.exit(body.status==="ok"&&body.version===require("./package.json").version?0:1)} catch {process.exit(1)}'; then return 0; fi
    sleep 1
  done
  printf 'Health failed. Inspect: pm2 logs jtg-cloud --lines 50\n' >&2
  curl --noproxy '*' --connect-timeout 2 --max-time 3 --silent --show-error http://127.0.0.1:6969/api/health >&2 || true
  pm2 logs jtg-cloud --lines 30 --nostream >&2 || true
  return 1
}
pm2 ping >/dev/null
state=$(pm2 jlist | node --input-type=module -e '
import fs from "node:fs";
const apps=JSON.parse(fs.readFileSync(0,"utf8")).filter(item=>item.name==="jtg-cloud");
if(apps.some(item=>item.pm2_env?.pm_exec_path!=="/root/jtg-cloud/src/server.mjs")) throw new Error("PM2 name jtg-cloud belongs to another application.");
console.log(apps.length?"present":"missing");')
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { printf 'Tracked source files have local changes. Save them before updating. Data and .env are ignored and preserved.\n' >&2; exit 1; }
git fetch --prune origin
follow_remote_branch
git merge-base --is-ancestor HEAD "origin/$branch" || { printf 'Update is not a fast-forward. Resolve the branch manually.\n' >&2; exit 1; }
previous=$(git rev-parse HEAD)
next=$(git rev-parse "origin/$branch")
if [[ "$previous" == "$next" ]] && grep -qx 'JTG_NETWORK_MODE=direct-v1' .env; then printf 'JTG Cloud is already up to date. Use installer option 3 to restart, or option 9 to repair.\n'; exit 0; fi
stopped=0
env_backup=''
rollback() {
  local error=$?
  trap - ERR
  printf '\nUpdate failed. Restoring the previous application version. Your data backup is retained.\n' >&2
  if [[ "$stopped" == 1 ]]; then pm2 stop jtg-cloud || true; fi
  # Only tracked source is reset; ignored data, backups and .env are preserved.
  git reset --hard "$previous" || true
  if [[ -n "$env_backup" && -f "$env_backup" ]]; then cp -- "$env_backup" .env || true; fi
  npm ci --omit=dev --ignore-scripts || true
  if [[ "$stopped" == 1 ]]; then
    if previous_restart_safe; then
      pm2 startOrRestart ecosystem.config.cjs --only jtg-cloud --update-env --interpreter "$(command -v node)" || true
    else
      pm2 stop jtg-cloud || true
      printf 'The previous source cannot read the current chunked storage, or compatibility could not be verified. The cloud stays stopped to protect encrypted parts. Restore the complete pre-update backup before starting old source.\n' >&2
    fi
  fi
  printf 'Source rollback does not restore the database. Keep the pre-update backup for recovery.\n' >&2
  exit "$error"
}
trap rollback ERR
if [[ "$state" == present ]]; then pm2 stop jtg-cloud; fi
stopped=1
NODE_ENV=development APP_URL= node --env-file=.env src/cli.mjs backup
mkdir -p "$APP_DIR/backups"
env_backup=$(mktemp "$APP_DIR/backups/.env-update-XXXXXX")
chmod 600 "$env_backup"
cp -- .env "$env_backup"
git merge --ff-only "origin/$branch"
configure_service_env
chown -R root:root "$APP_DIR"
chmod -R go-rwx "$APP_DIR"
chmod 600 .env
npm ci --omit=dev --ignore-scripts
node scripts/check.mjs
node --test --test-concurrency=1 tests/*.test.mjs
pm2 startOrRestart ecosystem.config.cjs --only jtg-cloud --update-env --interpreter "$(command -v node)"
health
pm2 save
printf 'Setup completed: %s\n' "$(date -u +%FT%TZ)" > .jtg-installed
chmod 600 .jtg-installed
stopped=0
trap - ERR
printf '\nJTG Cloud updated successfully. Data, owner account and encryption key were preserved.\n'
}
if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then main "$@"; fi

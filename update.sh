#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
# Parse the complete update before replacing its tracked script on disk.
main() {
APP_DIR=/opt/jtg-cloud
RUNTIME=/opt/jtg-cloud-runtime
SERVICE_USER=jtgcloud
PM2="$RUNTIME/pm2/bin/pm2"
export PATH="$RUNTIME/current/bin:$RUNTIME/pm2/bin:$PATH"
[[ $EUID -eq 0 ]] || { printf 'Run with sudo bash update.sh\n' >&2; exit 1; }
[[ -d "$APP_DIR/.git" && -f "$APP_DIR/.env" ]] || { printf 'A managed installation was not found.\n' >&2; exit 1; }
cd "$APP_DIR"
as_cloud() { runuser -u "$SERVICE_USER" -- env PATH="$PATH" PM2_HOME="/home/$SERVICE_USER/.pm2" "$@"; }
health() { local i; for i in {1..30}; do if curl --fail --silent http://127.0.0.1:6696/api/health >/dev/null; then return 0; fi; sleep 1; done; return 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { printf 'Tracked source files have local changes. Save them before updating. Data and .env are ignored and preserved.\n' >&2; exit 1; }
branch=$(git symbolic-ref --short HEAD)
git fetch --prune origin
git merge-base --is-ancestor HEAD "origin/$branch" || { printf 'Update is not a fast-forward. Resolve the branch manually.\n' >&2; exit 1; }
previous=$(git rev-parse HEAD)
next=$(git rev-parse "origin/$branch")
[[ "$previous" != "$next" ]] || { printf 'JTG Cloud is already up to date.\n'; exit 0; }
stopped=0
rollback() {
  local error=$?
  trap - ERR
  printf '\nUpdate failed. Restoring the previous application version. Your data backup is retained.\n' >&2
  # Only tracked source is reset; ignored data, backups and .env are preserved.
  git reset --hard "$previous" || true
  npm ci --omit=dev --ignore-scripts || true
  if [[ "$stopped" == 1 ]]; then as_cloud "$PM2" restart ecosystem.config.cjs --update-env || true; fi
  printf 'If a future release migrated the database, restore the pre-update backup before running the old code.\n' >&2
  exit "$error"
}
trap rollback ERR
as_cloud "$PM2" stop jtg-cloud
stopped=1
as_cloud node --env-file=.env src/cli.mjs backup
git merge --ff-only "origin/$branch"
npm ci --omit=dev --ignore-scripts
node scripts/check.mjs
node --test --test-concurrency=1 tests/*.test.mjs
as_cloud "$PM2" restart ecosystem.config.cjs --update-env
health
as_cloud "$PM2" save
stopped=0
trap - ERR
printf '\nJTG Cloud updated successfully. Data, owner account and encryption key were preserved.\n'
}
main "$@"

#!/usr/bin/env bash
# JTG Cloud VPS control center by JTG Studio.
set -Eeuo pipefail
umask 027
APP_DIR=/opt/jtg-cloud
REPO_URL=https://github.com/JishnuTheGamer/jtg-cloud.git
REPO_BRANCH=jtg-studio
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
LOG_FILE=/var/log/jtg-cloud-install.log
RUNTIME=/opt/jtg-cloud-runtime
SERVICE_USER=jtgcloud
PM2="$RUNTIME/pm2/bin/pm2"
export PATH="$RUNTIME/current/bin:$RUNTIME/pm2/bin:$PATH"
BOLD='' RESET='' ACCENT='' DIM='' GREEN='' RED=''
if [[ -z "${NO_COLOR+x}" && "${TERM:-dumb}" != dumb ]] && [[ -t 1 || "${FORCE_COLOR:-0}" == 1 ]]; then
  BOLD=$'\033[1m'; RESET=$'\033[0m'; ACCENT=$'\033[36m'
  DIM=$'\033[2m'; GREEN=$'\033[32m'; RED=$'\033[31m'
fi
heading() { printf '\n%s%s%s%s\n' "$BOLD" "$ACCENT" "$*" "$RESET"; }
note() { printf '  %s\n' "$*"; }
success() { printf '  %sOK%s  %s\n' "$GREEN" "$RESET" "$*"; }
die() { printf '\n%s%sERROR%s  %s\n' "$BOLD" "$RED" "$RESET" "$*" >&2; exit 1; }
step() { printf '\n%s%s[%02d/10] %s%s\n' "$BOLD" "$ACCENT" "$1" "$2" "$RESET"; }
run_command() {
  if "$@" >>"$LOG_FILE" 2>&1; then return 0; fi
  printf '\nCommand failed. Recent diagnostic output:\n' >&2
  tail -n 15 "$LOG_FILE" >&2
  return 1
}
install_error() {
  local status=$1 line=$2
  trap - ERR
  printf '\n%sInstallation stopped%s at line %s. Review %s.\nExisting data is preserved. See README for recovery before retrying.\n' "$BOLD" "$RESET" "$line" "$LOG_FILE" >&2
  exit "$status"
}
banner() {
  printf '\n%s%s  +----------------------------------------------------+\n' "$BOLD" "$ACCENT"
  printf '  |                    JTG CLOUD                       |\n'
  printf '  |          Private storage. On your own server.      |\n'
  printf '  +----------------------------------------------------+%s\n' "$RESET"
  printf '  %sJTG Studio%s  /  VPS CONTROL CENTER\n\n' "$BOLD" "$RESET"
  note "Repository  $REPO_URL"
  note "Branch      $REPO_BRANCH"
  note "Directory   $APP_DIR"
  note 'App port    6696'
  if [[ -f "$APP_DIR/.env" ]]; then success 'Installed'; else note 'Status      Ready for a new installation'; fi
}
installation_plan() {
  heading 'INSTALLATION PLAN'
  note "git clone --branch $REPO_BRANCH $REPO_URL $APP_DIR"
  note "cd $APP_DIR"
  note 'An authenticated local checkout is reused when available.'
  step 1 'Install Linux requirements'; note 'Git, curl, CA certificates, Python and xz tools.'
  step 2 'Install Node.js LTS and PM2'; note 'Latest supported LTS (24+), verified SHA-256, isolated runtime.'
  step 3 'Clone JTG Cloud and enter the project directory'
  step 4 'Install locked application requirements'; note 'npm ci --omit=dev --ignore-scripts'
  step 5 'Configure service account and private storage'; note 'Port 6696, restricted environment and data permissions.'
  step 6 'Create the owner account'; note 'Username, email and a password entered privately.'
  step 7 'Configure HTTPS'; note "Nginx + Let's Encrypt, or your existing HTTPS reverse proxy."
  step 8 'Start JTG Cloud with PM2'
  step 9 'Enable automatic startup after reboot'
  step 10 'Verify cloud health'; note 'Open your HTTPS domain and sign in.'
  printf '\n'
}
clone_project() {
  local source_remote=''
  if [[ -d "$SOURCE_DIR/.git" || -f "$SOURCE_DIR/.git" ]]; then
    source_remote=$(git -c safe.directory="$SOURCE_DIR" -C "$SOURCE_DIR" remote get-url origin 2>/dev/null) || source_remote=''
  fi
  case "$source_remote" in
    "$REPO_URL"|"${REPO_URL%.git}"|git@github.com:JishnuTheGamer/jtg-cloud.git)
      note 'Using the authenticated local checkout (committed source only).'
      run_command git -c safe.directory="$SOURCE_DIR" clone --no-hardlinks --branch "$REPO_BRANCH" -- "$SOURCE_DIR" "$APP_DIR" || return 1
      ;;
    *)
      note "Cloning $REPO_URL"
      if ! run_command git clone --branch "$REPO_BRANCH" -- "$REPO_URL" "$APP_DIR"; then
        printf 'This repository requires GitHub access while private. Authenticate Git first, then use the README installation commands.\n' >&2
        return 1
      fi
      ;;
  esac
  git -C "$APP_DIR" remote set-url origin "$REPO_URL" || return 1
  [[ -f "$APP_DIR/src/server.mjs" && -f "$APP_DIR/package.json" ]] || { printf 'JTG Cloud source is missing from the repository root.\n' >&2; return 1; }
  cd "$APP_DIR" || return 1
  node -e "const p=require('./package.json'); if(p.name!=='jtg-cloud')process.exit(1)" || return 1
  success "Source ready in $APP_DIR"
}
require_root() { [[ $EUID -eq 0 ]] || die 'Run this installer with sudo bash install.sh.'; }
as_cloud() { runuser -u "$SERVICE_USER" -- env PATH="$PATH" PM2_HOME="/home/$SERVICE_USER/.pm2" "$@"; }
health() {
  local attempt
  for attempt in {1..30}; do
    if curl --fail --silent http://127.0.0.1:6696/api/health >/dev/null; then return 0; fi
    sleep 1
  done
  printf 'The health check failed. Inspect logs: %s logs jtg-cloud\n' "$PM2" >&2
  return 1
}
install_node() {
  local arch version filename temp expected
  case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) die 'Only x86_64 and ARM64 are supported.';; esac
  mkdir -p "$RUNTIME"
  temp=$(mktemp -d)
  curl --fail --silent --show-error --location https://nodejs.org/dist/index.json -o "$temp/index.json"
  version=$(python3 - "$temp/index.json" <<'PY'
import json, sys
releases=json.load(open(sys.argv[1]))
for item in releases:
    if item.get('lts') and int(item['version'].split('.')[0][1:]) >= 24:
        print(item['version']); break
else: raise SystemExit('No supported Node.js LTS found')
PY
)
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'Invalid Node.js release response.'
  filename="node-$version-linux-$arch.tar.xz"
  note "Installing current Node.js LTS: $version"
  curl --fail --silent --show-error --location "https://nodejs.org/dist/$version/$filename" -o "$temp/$filename"
  curl --fail --silent --show-error --location "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$temp/SHASUMS256.txt"
  expected=$(awk -v file="$filename" '$2==file {print $1}' "$temp/SHASUMS256.txt")
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || die 'Missing Node.js checksum.'
  printf '%s  %s\n' "$expected" "$temp/$filename" | sha256sum --check --status || die 'Node.js checksum did not match.'
  if [[ ! -d "$RUNTIME/node-$version-linux-$arch" ]]; then tar -xJf "$temp/$filename" -C "$RUNTIME"; fi
  ln -sfn "$RUNTIME/node-$version-linux-$arch" "$RUNTIME/current"
  # This verified mktemp directory contains only downloads created above.
  rm -f -- "$temp/$filename" "$temp/SHASUMS256.txt" "$temp/index.json"
  rmdir -- "$temp"
  run_command npm install --global --prefix "$RUNTIME/pm2" pm2
  success "Node.js $version and PM2 are ready"
}
install_project() {
  require_root
  [[ ! -e "$APP_DIR" ]] || die "$APP_DIR already exists. Use the Update menu; installation never overwrites an existing cloud."
  [[ -f /etc/os-release ]] || die 'Linux OS metadata is missing.'
  # Trusted system metadata, never source a repository configuration file.
  . /etc/os-release
  case "$ID" in ubuntu|debian) ;; *) die 'This installer supports Ubuntu and Debian. See README for manual installation.';; esac
  case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) die 'Only x86_64 and ARM64 are supported.';; esac
  command -v systemctl >/dev/null || die 'A systemd-based VPS is required.'
  local domain email='' proxy
  heading 'NEW CLOUD SETUP'
  note "Source: $REPO_URL"
  note 'Private repository access must be configured before cloning.'
  read -r -p 'Cloud domain (e.g. cloud.example.com, DNS must point to this VPS): ' domain
  [[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$ ]] || die 'Enter a valid domain name.'
  domain=${domain,,}
  printf 'HTTPS options:\n  1) Install Nginx and obtain a Let’s Encrypt certificate\n  2) I already have an HTTPS reverse proxy\n'
  read -r -p 'Choose [1]: ' proxy; proxy=${proxy:-1}
  [[ "$proxy" == 1 || "$proxy" == 2 ]] || die 'Invalid HTTPS option.'
  if [[ "$proxy" == 1 ]]; then
    [[ ! -e /etc/nginx/sites-available/jtg-cloud && ! -e /etc/nginx/sites-enabled/jtg-cloud && ! -L /etc/nginx/sites-enabled/jtg-cloud ]] || die 'An Nginx jtg-cloud configuration already exists. Review it manually.'
    read -r -p 'Email for certificate renewal notices: ' email
    [[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die 'Invalid certificate email.'
    printf 'Ports 80/443 must be reachable and the domain DNS must point here. Existing Nginx sites are preserved.\n'
  fi
  touch "$LOG_FILE"; chmod 600 "$LOG_FILE"
  trap 'install_error "$?" "$LINENO"' ERR
  printf '\nJTG Studio / JTG Cloud install / %s\n' "$(date -u +%FT%TZ)" >>"$LOG_FILE"
  step 1 'Install Linux requirements'
  run_command apt-get update
  run_command apt-get install -y ca-certificates curl git xz-utils python3
  success 'System requirements installed'
  step 2 'Install Node.js LTS and PM2'
  install_node
  step 3 'Clone JTG Cloud and enter the project directory'
  clone_project
  step 4 'Install locked application requirements'
  run_command npm ci --omit=dev --ignore-scripts
  success 'Application requirements installed'
  step 5 'Configure service account and private storage'
  id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --user-group --create-home --home-dir "/home/$SERVICE_USER" --shell /usr/sbin/nologin "$SERVICE_USER"
  cat > .env <<ENV
PORT=6696
HOST=127.0.0.1
NODE_ENV=production
APP_URL=https://$domain
TRUST_PROXY=true
COOKIE_SECURE=true
DATA_DIR=./data
BACKUP_DIR=./backups
REGISTRATION_DOMAIN=
ENV
  chown -R root:root "$APP_DIR"
  chmod -R go-w "$APP_DIR"
  mkdir -p data backups
  chown "$SERVICE_USER:$SERVICE_USER" data backups
  chmod 700 data backups
  chown "root:$SERVICE_USER" .env
  chmod 640 .env
  success 'Port 6696 and storage permissions configured'
  step 6 'Create the owner account'
  note 'The password prompt is private; owner credentials are never written to the installer log.'
  as_cloud node --env-file=.env src/cli.mjs setup
  success 'Owner account created'
  step 7 'Configure HTTPS'
  if [[ "$proxy" == 1 ]]; then
    run_command apt-get install -y nginx certbot python3-certbot-nginx
    cat > /etc/nginx/sites-available/jtg-cloud <<NGINX
server {
    listen 80;
    server_name $domain;
    client_max_body_size 10G;
    client_body_timeout 900s;
    location / {
        proxy_pass http://127.0.0.1:6696;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
    }
}
NGINX
    ln -s /etc/nginx/sites-available/jtg-cloud /etc/nginx/sites-enabled/jtg-cloud
    nginx -t
    systemctl enable --now nginx
    systemctl reload nginx
    certbot --nginx -d "$domain" --email "$email" --agree-tos --non-interactive --redirect
    success 'HTTPS certificate and Nginx configured'
  else
    note "Use your existing proxy to forward https://$domain to 127.0.0.1:6696."
  fi
  step 8 'Start JTG Cloud with PM2'
  as_cloud "$PM2" start ecosystem.config.cjs
  as_cloud "$PM2" save
  step 9 'Enable automatic startup after reboot'
  env PATH="$PATH" "$PM2" startup systemd -u "$SERVICE_USER" --hp "/home/$SERVICE_USER"
  systemctl enable "pm2-$SERVICE_USER"
  step 10 'Verify cloud health'
  health
  trap - ERR
  heading 'INSTALLATION COMPLETE'
  success "JTG Cloud is ready at https://$domain"
  note 'App port: 6696 / Public access: HTTPS 443'
  note 'Sign in with the owner account you just created.'
  note "Installation log: $LOG_FILE"
}
backup_project() {
  require_root; [[ -f "$APP_DIR/.env" ]] || die 'Install JTG Cloud first.'
  cd "$APP_DIR"
  as_cloud "$PM2" stop jtg-cloud
  local result=0
  as_cloud node --env-file=.env src/cli.mjs backup || result=$?
  as_cloud "$PM2" start jtg-cloud
  health
  return "$result"
}
main() {
case "${1:-}" in
  --dry-run) banner; installation_plan; return 0;;
  --help|-h) banner; printf '\nUsage: sudo bash install.sh\n       bash install.sh --dry-run\n\nDebian 12+ / Ubuntu 22.04+; x86_64 or ARM64; systemd.\n'; return 0;;
  '') ;;
  *) die 'Unknown argument. Use --help or --dry-run.';;
esac
banner
while true; do
  heading 'CLOUD MANAGEMENT'
  printf '  %s1%s  Install JTG Cloud\n  %s2%s  Update JTG Cloud\n  %s3%s  Start / restart cloud\n  %s4%s  Stop cloud\n  %s5%s  Service status\n  %s6%s  Reset account password\n  %s7%s  Back up cloud\n  %s8%s  Preview installation plan\n  %s0%s  Exit\n\n' "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET"
  local choice
  read -r -p '  Select an option [0-8]: ' choice || return 0
  choice=${choice%$'\r'}
  case "$choice" in
    1) install_project;;
    2) require_root; [[ -f "$APP_DIR/update.sh" ]] || die 'Install first.'; bash "$APP_DIR/update.sh";;
    3) require_root; [[ -f "$APP_DIR/.env" ]] || die 'Install first.'; cd "$APP_DIR"; as_cloud "$PM2" restart jtg-cloud --update-env; health;;
    4) require_root; as_cloud "$PM2" stop jtg-cloud;;
    5) require_root; as_cloud "$PM2" status;;
    6) require_root; cd "$APP_DIR"; as_cloud node --env-file=.env src/cli.mjs reset-password;;
    7) backup_project;;
    8) installation_plan;;
    0) printf '\n  JTG Studio / See you next time.\n'; return 0;;
    *) printf 'Choose one of the menu options.\n';;
  esac
  printf '\n'
done
}
# Sourcing exposes helpers for deployment checks without starting the menu.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi

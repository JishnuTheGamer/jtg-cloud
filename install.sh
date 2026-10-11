#!/usr/bin/env bash
# JTG Cloud installer for Debian 12+/Ubuntu 22.04+, x86_64 and ARM64.
set -Eeuo pipefail
umask 027
APP_DIR=/opt/jtg-cloud
RUNTIME=/opt/jtg-cloud-runtime
SERVICE_USER=jtgcloud
PM2="$RUNTIME/pm2/bin/pm2"
export PATH="$RUNTIME/current/bin:$RUNTIME/pm2/bin:$PATH"
trap 'printf "\nInstallation stopped at line %s. Fix the reported error, then rerun. Existing data is preserved.\n" "$LINENO" >&2' ERR

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
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
  printf 'Installing current Node.js LTS: %s\n' "$version"
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
  npm install --global --prefix "$RUNTIME/pm2" pm2
}
install_project() {
  require_root
  [[ ! -e "$APP_DIR" ]] || die "$APP_DIR already exists. Use the Update menu; installation never overwrites an existing cloud."
  [[ -f /etc/os-release ]] || die 'Linux OS metadata is missing.'
  # Trusted system metadata, never source a repository configuration file.
  . /etc/os-release
  case "$ID" in ubuntu|debian) ;; *) die 'This installer supports Ubuntu and Debian. See README for manual installation.';; esac
  local repo domain email proxy
  read -r -p 'Git repository URL (HTTPS, project files at repository root): ' repo
  [[ "$repo" =~ ^https://[A-Za-z0-9.-]+/[A-Za-z0-9_./-]+$ ]] || die 'Enter a public HTTPS Git URL without embedded credentials or query parameters.'
  read -r -p 'Cloud domain (e.g. cloud.example.com, DNS must point to this VPS): ' domain
  [[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$ ]] || die 'Enter a valid domain name.'
  domain=${domain,,}
  printf 'HTTPS options:\n  1) Install Nginx and obtain a Let’s Encrypt certificate\n  2) I already have an HTTPS reverse proxy\n'
  read -r -p 'Choose [1]: ' proxy; proxy=${proxy:-1}
  [[ "$proxy" == 1 || "$proxy" == 2 ]] || die 'Invalid HTTPS option.'
  if [[ "$proxy" == 1 ]]; then
    read -r -p 'Email for certificate renewal notices: ' email
    [[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die 'Invalid certificate email.'
    printf 'Ports 80/443 must be reachable and the domain DNS must point here. Existing Nginx sites are preserved.\n'
  fi
  apt-get update
  apt-get install -y ca-certificates curl git xz-utils python3
  install_node
  id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --user-group --create-home --home-dir "/home/$SERVICE_USER" --shell /usr/sbin/nologin "$SERVICE_USER"
  git clone -- "$repo" "$APP_DIR"
  [[ -f "$APP_DIR/src/server.mjs" && -f "$APP_DIR/package.json" ]] || die 'Repository does not contain JTG Cloud at its root. Move the jtg-cloud folder contents to the repository root.'
  cd "$APP_DIR"
  node -e "const p=require('./package.json'); if(p.name!=='jtg-cloud')process.exit(1)" || die 'Unexpected project package.'
  npm ci --omit=dev --ignore-scripts
  cat > .env <<ENV
PORT=6696
HOST=127.0.0.1
NODE_ENV=production
APP_URL=https://$domain
TRUST_PROXY=true
COOKIE_SECURE=true
DATA_DIR=./data
REGISTRATION_DOMAIN=
ENV
  chown -R root:root "$APP_DIR"
  chmod -R go-w "$APP_DIR"
  mkdir -p data backups
  chown "$SERVICE_USER:$SERVICE_USER" data backups
  chmod 700 data backups
  chown "root:$SERVICE_USER" .env
  chmod 640 .env
  as_cloud node --env-file=.env src/cli.mjs setup
  if [[ "$proxy" == 1 ]]; then
    apt-get install -y nginx certbot python3-certbot-nginx
    [[ ! -e /etc/nginx/sites-available/jtg-cloud ]] || die 'An Nginx jtg-cloud configuration already exists. Review it manually.'
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
  fi
  as_cloud "$PM2" start ecosystem.config.cjs
  as_cloud "$PM2" save
  env PATH="$PATH" "$PM2" startup systemd -u "$SERVICE_USER" --hp "/home/$SERVICE_USER"
  systemctl enable "pm2-$SERVICE_USER"
  health
  printf '\nJTG Cloud is installed at https://%s\nApp port: 6696 (loopback; public access uses HTTPS 443).\nOwner setup is complete. Open the cloud and sign in.\n' "$domain"
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
printf '\n  JTG CLOUD\n  Your files. Your server.\n\n'
while true; do
  printf '  1) Install JTG Cloud\n  2) Update JTG Cloud\n  3) Start / restart cloud\n  4) Stop cloud\n  5) Status\n  6) Reset an account password\n  7) Back up cloud\n  0) Exit\n\n'
  read -r -p 'Choose an option: ' choice || exit 0
  choice=${choice%$'\r'}
  case "$choice" in
    1) install_project;;
    2) require_root; [[ -f "$APP_DIR/update.sh" ]] || die 'Install first.'; bash "$APP_DIR/update.sh";;
    3) require_root; [[ -f "$APP_DIR/.env" ]] || die 'Install first.'; cd "$APP_DIR"; as_cloud "$PM2" restart jtg-cloud --update-env; health;;
    4) require_root; as_cloud "$PM2" stop jtg-cloud;;
    5) require_root; as_cloud "$PM2" status;;
    6) require_root; cd "$APP_DIR"; as_cloud node --env-file=.env src/cli.mjs reset-password;;
    7) backup_project;;
    0) exit 0;;
    *) printf 'Choose one of the menu options.\n';;
  esac
  printf '\n'
done

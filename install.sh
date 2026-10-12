#!/usr/bin/env bash
# JTG Cloud installation and management by JTG Studio.
set -Eeuo pipefail
umask 077
APP_DIR=/root/jtg-cloud
LEGACY_DIR=/opt/jtg-cloud
LEGACY_HOME=/home/jtgcloud
LEGACY_RUNTIME=/opt/jtg-cloud-runtime
MANAGER_FILE=/root/jtg-cloud-manager.sh
REPO_URL=https://github.com/JishnuTheGamer/jtg-cloud.git
REPO_BRANCH=jtg-studio
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd -P)
LOG_FILE=/var/log/jtg-cloud-install.log
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export PM2_HOME=/root/.pm2
BOLD='' RESET='' ACCENT='' GREEN='' RED=''
if [[ -z "${NO_COLOR+x}" && "${TERM:-dumb}" != dumb ]] && [[ -t 1 || "${FORCE_COLOR:-0}" == 1 ]]; then
  BOLD=$'\033[1m'; RESET=$'\033[0m'; ACCENT=$'\033[36m'; GREEN=$'\033[32m'; RED=$'\033[31m'
fi
heading() { printf '\n%s%s%s%s\n' "$BOLD" "$ACCENT" "$*" "$RESET"; }
note() { printf '  %s\n' "$*"; }
success() { printf '  %sOK%s  %s\n' "$GREEN" "$RESET" "$*"; }
die() { printf '\n%s%sERROR%s  %s\n' "$BOLD" "$RED" "$RESET" "$*" >&2; exit 1; }
step() { printf '\n%s%s[%02d/10] %s%s\n' "$BOLD" "$ACCENT" "$1" "$2" "$RESET"; }
require_root() { [[ $EUID -eq 0 ]] || die 'Run as root: sudo bash install.sh'; }
run_command() {
  if "$@" >>"$LOG_FILE" 2>&1; then return 0; fi
  printf '\nCommand failed. Recent diagnostic output:\n' >&2
  tail -n 15 "$LOG_FILE" >&2
  return 1
}
install_error() {
  local status=$1 line=$2
  trap - ERR
  printf '\nOperation stopped at line %s. Log: %s\nYour files and owner account are preserved. Fix the reported error and choose Repair / migrate installation to retry.\n' "$line" "$LOG_FILE" >&2
  exit "$status"
}
open_log() {
  [[ ! -L "$LOG_FILE" ]] || die 'The installer log must not be a symbolic link.'
  touch "$LOG_FILE"; chmod 600 "$LOG_FILE"
  printf '\nJTG Studio / %s\n' "$(date -u +%FT%TZ)" >>"$LOG_FILE"
  trap 'install_error "$?" "$LINENO"' ERR
}
banner() {
  printf '\n%s%s  +----------------------------------------------------+\n' "$BOLD" "$ACCENT"
  printf '  |                    JTG CLOUD                       |\n'
  printf '  |          Your files. Your server. Your control.    |\n'
  printf '  +----------------------------------------------------+%s\n' "$RESET"
  printf '  %sJTG Studio%s  /  VPS CONTROL CENTER\n\n' "$BOLD" "$RESET"
  note "Repository  $REPO_URL"
  note "Branch      $REPO_BRANCH"
  note "Directory   $APP_DIR"
  note 'App port    6969'
  note 'PM2         Global install / root account'
  if [[ -f "$APP_DIR/.jtg-installed" ]]; then success 'Installation complete / use Service status to check PM2';
  elif [[ -d "$APP_DIR" || -d "$LEGACY_DIR" ]]; then note 'Status      Existing installation found; choose Repair / migrate';
  else note 'Status      Ready for a new installation'; fi
}
installation_plan() {
  heading 'INSTALLATION PLAN'
  note "git clone --branch $REPO_BRANCH $REPO_URL $APP_DIR"
  note "cd $APP_DIR"
  step 1 'Install Linux requirements'; note 'Git, curl, CA certificates, Python and xz tools.'
  step 2 'Install Node.js LTS and global PM2'; note 'Node.js 24+; npm install -g pm2'
  step 3 'Clone JTG Cloud and enter the project directory'
  step 4 'Install locked application requirements'; note 'npm ci --omit=dev --ignore-scripts'
  step 5 'Configure private storage'; note 'Root owns and runs the cloud; .env and storage stay private.'
  step 6 'Create the owner account'; note 'Username, email and a password entered privately.'
  step 7 'Show service addresses'; note 'Localhost and IPv4 addresses already assigned to the server.'
  step 8 'Start JTG Cloud with PM2'; note 'pm2 start ecosystem.config.cjs --only jtg-cloud'
  step 9 'Enable automatic startup after reboot'; note 'pm2 startup systemd -u root --hp /root; pm2 save'
  step 10 'Verify cloud health'; note 'Open http://localhost:6969 or http://SERVER_IPV4:6969 and sign in.'
}
linux_requirements() {
  [[ -f /etc/os-release ]] || die 'Linux OS metadata is missing.'
  . /etc/os-release
  case "$ID" in ubuntu|debian) ;; *) die 'Use Debian 12+ or Ubuntu 22.04+.';; esac
  case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) die 'Only x86_64 and ARM64 are supported.';; esac
  command -v systemctl >/dev/null || die 'A systemd-based VPS is required.'
  run_command apt-get update
  run_command apt-get install -y ca-certificates curl git xz-utils python3
}
install_node() {
  local arch version filename temp expected destination executable
  # Keep a supported system Node; the old private runtime is not reused.
  if command -v node >/dev/null && command -v npm >/dev/null && [[ "$(command -v node)" != /opt/jtg-cloud-runtime/* ]] && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' && npm --version >/dev/null 2>&1; then
    success "Using Node.js $(node --version)"
    return 0
  fi
  case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) die 'Unsupported CPU architecture.';; esac
  temp=$(mktemp -d)
  curl --fail --silent --show-error --location https://nodejs.org/dist/index.json -o "$temp/index.json"
  version=$(python3 - "$temp/index.json" <<'PY'
import json, sys
for item in json.load(open(sys.argv[1])):
    if item.get('lts') and int(item['version'].split('.')[0][1:]) >= 24:
        print(item['version']); break
else: raise SystemExit('No supported Node.js LTS found')
PY
)
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'Invalid Node.js release response.'
  filename="node-$version-linux-$arch.tar.xz"
  note "Installing Node.js LTS $version"
  curl --fail --silent --show-error --location "https://nodejs.org/dist/$version/$filename" -o "$temp/$filename"
  curl --fail --silent --show-error --location "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$temp/SHASUMS256.txt"
  expected=$(awk -v file="$filename" '$2==file {print $1}' "$temp/SHASUMS256.txt")
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || die 'Missing Node.js checksum.'
  printf '%s  %s\n' "$expected" "$temp/$filename" | sha256sum --check --status || die 'Node.js checksum did not match.'
  destination="/usr/local/lib/nodejs/node-$version-linux-$arch"
  [[ ! -L /usr/local/lib/nodejs && ! -L "$destination" ]] || die 'Node installation directory must not be a symbolic link.'
  mkdir -p /usr/local/lib/nodejs
  if [[ ! -d "$destination" ]]; then (umask 022; tar -xJf "$temp/$filename" -C /usr/local/lib/nodejs); fi
  chmod 755 /usr/local/lib/nodejs
  for executable in node npm npx; do ln -sfn "$destination/bin/$executable" "/usr/local/bin/$executable"; done
  hash -r
  rm -f -- "$temp/$filename" "$temp/SHASUMS256.txt" "$temp/index.json"; rmdir -- "$temp"
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'
  success "Node.js $(node --version) is available globally"
}
install_pm2() {
  # The normal global npm location; no application-specific PM2 binary or daemon.
  (umask 022; export NPM_CONFIG_PREFIX=/usr/local; run_command npm install -g pm2)
  hash -r
  command -v pm2 >/dev/null || die 'Global PM2 is missing after npm installation.'
  success "Global PM2 ready: $(command -v pm2)"
}
clone_project() {
  local source_remote=''
  if [[ -d "$SOURCE_DIR/.git" || -f "$SOURCE_DIR/.git" ]]; then
    source_remote=$(git -c safe.directory="$SOURCE_DIR" -C "$SOURCE_DIR" remote get-url origin 2>/dev/null) || source_remote=''
  fi
  case "$source_remote" in
    "$REPO_URL"|"${REPO_URL%.git}"|git@github.com:JishnuTheGamer/jtg-cloud.git)
      note 'Using the local checkout (committed source only).'
      run_command git -c safe.directory="$SOURCE_DIR" clone --no-hardlinks --branch "$REPO_BRANCH" -- "$SOURCE_DIR" "$APP_DIR" || return 1;;
    *)
      note "Cloning $REPO_URL"
      run_command git clone --branch "$REPO_BRANCH" -- "$REPO_URL" "$APP_DIR" || { printf 'Repository download failed. Check the installer log and network access.\n' >&2; return 1; };;
  esac
  git -C "$APP_DIR" remote set-url origin "$REPO_URL" || return 1
  [[ -f "$APP_DIR/src/server.mjs" && -f "$APP_DIR/package.json" ]] || return 1
  cd "$APP_DIR" || return 1
  node -e "if(require('./package.json').name!=='jtg-cloud')process.exit(1)" || return 1
  success "Source ready in $APP_DIR"
}
validate_directory() {
  local directory=$1 resolved
  case "$directory" in /root/jtg-cloud|/opt/jtg-cloud) ;; *) die 'Refusing an unexpected installation path.';; esac
  [[ -d "$directory" && ! -L "$directory" ]] || die 'The installation must be a real directory, not a symbolic link.'
  resolved=$(realpath -e -- "$directory")
  [[ "$resolved" == "$directory" ]] || die 'The resolved installation path is unsafe.'
  [[ -d "$directory/.git" && -f "$directory/src/server.mjs" && -f "$directory/package.json" ]] || die 'This directory is not a managed JTG Cloud checkout.'
  [[ ! -L "$directory/.git" && "$(realpath -e -- "$directory/package.json")" == "$directory/package.json" && "$(realpath -e -- "$directory/src/server.mjs")" == "$directory/src/server.mjs" ]] || die 'Managed source files must not redirect through symbolic links.'
  if [[ -e "$directory/.env" || -L "$directory/.env" ]]; then
    [[ ! -L "$directory/.env" && "$(realpath -e -- "$directory/.env")" == "$directory/.env" ]] || die 'The managed environment must not be a symbolic link.'
  fi
  node -e "if(require(process.argv[1]).name!=='jtg-cloud')process.exit(1)" "$directory/package.json" || die 'Unexpected application in the installation directory.'
}
validate_storage() {
  [[ -f .env ]] || return 0
  node --env-file=.env --input-type=module - "$PWD" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const root = fs.realpathSync(process.argv[2]);
const inside = value => { const relative=path.relative(root,value); return relative && !relative.startsWith(`..${path.sep}`) && relative!=='..' && !path.isAbsolute(relative); };
const directories=[];
for (const key of ['DATA_DIR','BACKUP_DIR']) {
  const directory=path.resolve(root,process.env[key] || (key==='DATA_DIR'?'data':'backups'));
  let existing=directory;
  while(!fs.existsSync(existing)) existing=path.dirname(existing);
  const resolved=path.resolve(fs.realpathSync(existing),path.relative(existing,directory));
  if(!inside(directory)||!inside(resolved)) throw new Error(`${key} must stay inside the installation for managed migration/uninstall. Move external storage manually first.`);
  directories.push(resolved);
}
const nested=(a,b)=>{const relative=path.relative(a,b);return !relative || (relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative));};
if(nested(directories[0],directories[1])||nested(directories[1],directories[0])) throw new Error('Data and backup directories must not overlap.');
JS
}
configure_environment() {
  [[ -f .env ]] || cp -- .env.example .env
  node --input-type=module - "${1:-$APP_DIR}" "$APP_DIR" <<'JS'
import fs from 'node:fs';
const [oldRoot,newRoot]=process.argv.slice(2);
let text=fs.readFileSync('.env','utf8').replaceAll('\r\n','\n');
// Preserve credentials/custom settings, and rewrite an absolute managed storage path when moving.
if(oldRoot!==newRoot) text=text.replace(/^(DATA_DIR|BACKUP_DIR)=(.*)$/gm,(line,key,value)=>{
  const quote=/^["']/.test(value)?value[0]:'';
  const bare=quote?value.slice(1,-1):value;
  return bare===oldRoot||bare.startsWith(`${oldRoot}/`)?`${key}=${quote}${newRoot}${bare.slice(oldRoot.length)}${quote}`:line;
});
for(const [key,value] of Object.entries({PORT:'6969',HOST:'0.0.0.0',NODE_ENV:'production',APP_URL:'',TRUST_PROXY:'false',COOKIE_SECURE:'false',JTG_NETWORK_MODE:'direct-v1'})) {
  const expression=new RegExp(`^${key}=.*$`,'gm');
  text=expression.test(text)?text.replace(expression,`${key}=${value}`):`${text.trimEnd()}\n${key}=${value}\n`;
}
fs.writeFileSync('.env',text,{mode:0o600});
JS
}
private_permissions() {
  chown -R root:root "$APP_DIR"
  chmod -R go-rwx "$APP_DIR"
  chmod 700 "$APP_DIR"
  chmod 600 "$APP_DIR/.env"
}
process_state() {
  local home=$1
  PM2_HOME="$home" pm2 ping >/dev/null
  PM2_HOME="$home" pm2 jlist | node --input-type=module -e '
    import fs from "node:fs";
    const apps=JSON.parse(fs.readFileSync(0,"utf8")).filter(item=>item.name==="jtg-cloud");
    if(!apps.length) {console.log("missing");process.exit(0);}
    if(apps.some(app=>!["/root/jtg-cloud/src/server.mjs","/opt/jtg-cloud/src/server.mjs"].includes(app.pm2_env?.pm_exec_path))) throw new Error("PM2 name jtg-cloud belongs to a different application. Refusing to change it.");
    console.log(apps[0].pm2_env.status || "unknown");'
}
stop_managed_process() {
  local home=$1 state
  state=$(process_state "$home")
  if [[ "$state" != missing ]]; then PM2_HOME="$home" pm2 stop jtg-cloud; fi
}
delete_managed_process() {
  local home=$1 state
  state=$(process_state "$home")
  if [[ "$state" != missing ]]; then PM2_HOME="$home" pm2 delete jtg-cloud; fi
  # Save twice so PM2's fallback dump also cannot resurrect the removed cloud.
  PM2_HOME="$home" pm2 save --force
  PM2_HOME="$home" pm2 save --force
}
legacy_pm2_exists() { [[ -S /home/jtgcloud/.pm2/rpc.sock || -f /home/jtgcloud/.pm2/dump.pm2 ]]; }
retire_legacy_pm2() {
  LEGACY_PM2_SHARED=0
  legacy_pm2_exists || return 0
  delete_managed_process /home/jtgcloud/.pm2
  # This startup belongs to the previous service account; keep it if other apps use it.
  if PM2_HOME=/home/jtgcloud/.pm2 pm2 jlist | node -e 'let s="";for await(const c of process.stdin)s+=c;process.exit(JSON.parse(s).length?1:0)' --input-type=module; then
    if [[ -f /etc/systemd/system/pm2-jtgcloud.service ]] && grep -q '/home/jtgcloud/.pm2' /etc/systemd/system/pm2-jtgcloud.service; then
      systemctl disable --now pm2-jtgcloud
      rm -f -- /etc/systemd/system/pm2-jtgcloud.service
      systemctl daemon-reload
    fi
    PM2_HOME=/home/jtgcloud/.pm2 pm2 kill
  else
    LEGACY_PM2_SHARED=1
  fi
}
validate_removal_path() {
  local target=$1 parent
  case "$target" in /root/jtg-cloud|/opt/jtg-cloud|/home/jtgcloud|/opt/jtg-cloud-runtime|/root/jtg-cloud-manager.sh) ;; *) die 'Refusing an unexpected removal path.';; esac
  [[ -e "$target" || -L "$target" ]] || return 0
  parent=$(dirname -- "$target")
  [[ "$(realpath -e -- "$parent")" == "$parent" ]] || die 'The removal parent redirects outside the managed path.'
  # A link at the exact named target is only unlinked, never followed.
  if [[ -e "$target" && ! -L "$target" ]]; then
    [[ "$(realpath -e -- "$target")" == "$target" ]] || die 'Unsafe resolved removal path.'
    if command -v findmnt >/dev/null; then
      local mount mounts
      mounts=$(findmnt --raw --noheadings --output TARGET) || die 'Could not check filesystem mounts before uninstall.'
      while IFS= read -r mount; do
        [[ "$mount" != "$target" && "$mount" != "$target/"* ]] || die "Unmount $mount before removing JTG Cloud."
      done <<< "$mounts"
    fi
  fi
}
remove_managed_path() {
  local target=$1
  validate_removal_path "$target"
  [[ -e "$target" || -L "$target" ]] || return 0
  rm -rf --one-file-system -- "$target" || die "Could not remove $target. Check permissions/mounts and run Uninstall again."
  [[ ! -e "$target" && ! -L "$target" ]] || die "Could not completely remove $target. Check permissions/mounts and run Uninstall again."
  success "Removed $target"
}
cleanup_pm2_files() {
  local folder file name
  for folder in /root/.pm2/logs /root/.pm2/pids; do
    [[ -d "$folder" && "$(realpath -e -- "$folder")" == "$folder" ]] || continue
    for file in "$folder"/jtg-cloud-*; do
      name=${file##*/}
      if [[ "$name" =~ ^jtg-cloud-(out|error)(-[0-9]+)?\.log$ || "$name" =~ ^jtg-cloud-[0-9]+\.pid$ ]]; then rm -f -- "$file"; fi
    done
  done
}
health() {
  local attempt
  for attempt in {1..30}; do
    if curl --noproxy '*' --connect-timeout 2 --max-time 3 --fail --silent http://127.0.0.1:6969/api/health | node -e 'try {const body=JSON.parse(require("node:fs").readFileSync(0,"utf8"));process.exit(body.status==="ok"&&body.version===require("./package.json").version?0:1)} catch {process.exit(1)}'; then return 0; fi
    sleep 1
  done
  printf 'Health check failed. Run: pm2 logs jtg-cloud --lines 50\n' >&2
  curl --noproxy '*' --connect-timeout 2 --max-time 3 --silent --show-error http://127.0.0.1:6969/api/health >&2 || true
  if command -v pm2 >/dev/null; then pm2 logs jtg-cloud --lines 30 --nostream >&2 || true; fi
  return 1
}
ensure_owner() {
  if node --env-file=.env --input-type=module - <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const file=path.resolve(process.env.DATA_DIR || 'data','cloud.sqlite');
if(!fs.existsSync(file)) process.exit(3);
const db=new DatabaseSync(file,{readOnly:true});
try { process.exitCode=db.prepare("SELECT id FROM users WHERE role='owner'").get()?0:3; } finally { db.close(); }
JS
  then success 'Existing owner account preserved';
  else
    local status=$?
    [[ "$status" == 3 ]] || return "$status"
    note 'Enter owner details below. The password stays out of the log.'; node --env-file=.env src/cli.mjs setup
  fi
}
show_addresses() { node --env-file=.env --input-type=module -e "import {serviceUrls} from './src/config.mjs'; console.log(serviceUrls(6969).join('\n'))"; }
enable_startup() { pm2 startup systemd -u root --hp /root; pm2 save; }
mark_installed() { printf 'Setup completed: %s\n' "$(date -u +%FT%TZ)" > "$APP_DIR/.jtg-installed"; chmod 600 "$APP_DIR/.jtg-installed"; }
restart_project() {
  require_root; validate_directory "$APP_DIR"; cd "$APP_DIR"
  [[ -f .env ]] || die 'Setup is incomplete. Choose Repair / migrate.'
  command -v pm2 >/dev/null || die 'PM2 is missing. Choose Repair / migrate to install global PM2.'
  process_state "$PM2_HOME" >/dev/null
  # This also recreates a missing PM2 entry, so there is no separate Start menu.
  pm2 startOrRestart ecosystem.config.cjs --only jtg-cloud --update-env --interpreter "$(command -v node)"
  health; pm2 save; success 'JTG Cloud restarted on port 6969'
}
install_project() {
  require_root
  [[ ! -e "$APP_DIR" && ! -L "$APP_DIR" && ! -e "$LEGACY_DIR" && ! -L "$LEGACY_DIR" ]] || die 'An installation already exists. Choose Repair / migrate; files will be preserved.'
  open_log
  step 1 'Install Linux requirements'; linux_requirements
  step 2 'Install Node.js LTS and global PM2'; install_node; install_pm2
  [[ "$(process_state "$PM2_HOME")" == missing ]] || die 'A JTG Cloud PM2 entry already exists. Use Repair / migrate for an existing installation.'
  step 3 'Clone JTG Cloud and enter the project directory'; clone_project
  step 4 'Install locked application requirements'; run_command npm ci --omit=dev --ignore-scripts
  step 5 'Configure private storage'; configure_environment; private_permissions
  step 6 'Create the owner account'; ensure_owner
  step 7 'Show service addresses'; show_addresses
  step 8 'Start JTG Cloud with PM2'; pm2 start ecosystem.config.cjs --only jtg-cloud --interpreter "$(command -v node)"
  step 9 'Enable automatic startup after reboot'; enable_startup
  step 10 'Verify cloud health'; health
  mark_installed
  trap - ERR
  heading 'INSTALLATION COMPLETE'
  success 'JTG Cloud is ready on port 6969'
  note "Directory: $APP_DIR"
  note 'Restart: pm2 restart jtg-cloud --update-env'
  note 'Logs:    pm2 logs jtg-cloud'
  note "Menu:    sudo bash $APP_DIR/install.sh"
}
backup_existing() {
  # Read the existing database without opening/migrating the application's store.
  node --env-file=.env --input-type=module - <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const data=path.resolve(process.env.DATA_DIR || 'data');
if(!fs.existsSync(path.join(data,'cloud.sqlite'))) {console.log('No existing database to back up.');process.exit(0);}
const key=path.join(data,'encryption.key');
if(!fs.existsSync(key)) throw new Error('Encryption key is missing. Repair must not create a replacement for existing data.');
const destination=path.join(path.resolve(process.env.BACKUP_DIR || 'backups'),`jtg-cloud-${Date.now()}-${randomUUID().slice(0,8)}`);
fs.mkdirSync(destination,{recursive:true,mode:0o700});
const db=new DatabaseSync(path.join(data,'cloud.sqlite'));
try {db.prepare('VACUUM INTO ?').run(path.join(destination,'cloud.sqlite'));} finally {db.close();}
fs.cpSync(path.join(data,'blobs'),path.join(destination,'blobs'),{recursive:true});
fs.copyFileSync(key,path.join(destination,'encryption.key'));fs.chmodSync(path.join(destination,'encryption.key'),0o600);
fs.copyFileSync('.env',path.join(destination,'.env'));fs.chmodSync(path.join(destination,'.env'),0o600);
console.log(`Backup saved: ${destination}`);
JS
}
repair_project() {
  require_root
  local existing=$APP_DIR
  [[ ! -e "$APP_DIR" || ! -e "$LEGACY_DIR" ]] || die 'Both installation directories exist. Resolve the duplicate before migrating.'
  if [[ ! -e "$APP_DIR" && -d "$LEGACY_DIR" ]]; then existing=$LEGACY_DIR; fi
  open_log
  heading 'REPAIR / MIGRATE INSTALLATION'
  linux_requirements; install_node; install_pm2
  validate_directory "$existing"; cd "$existing"
  [[ -f .env ]] || cp -- .env.example .env
  validate_storage
  [[ -z "$(git -c safe.directory="$existing" status --porcelain --untracked-files=no)" ]] || die 'Save tracked source changes before repair. Your .env/data are ignored and preserved.'
  git -c safe.directory="$existing" fetch origin "$REPO_BRANCH"
  git -c safe.directory="$existing" merge-base --is-ancestor HEAD "origin/$REPO_BRANCH" || die 'Source has diverged. Repair will not overwrite your commits.'
  process_state "$PM2_HOME" >/dev/null
  if legacy_pm2_exists; then process_state /home/jtgcloud/.pm2 >/dev/null; fi
  stop_managed_process "$PM2_HOME"
  if legacy_pm2_exists; then stop_managed_process /home/jtgcloud/.pm2; fi
  backup_existing
  retire_legacy_pm2
  git -c safe.directory="$existing" merge --ff-only "origin/$REPO_BRANCH"
  if [[ "$(git -c safe.directory="$existing" branch --show-current)" != "$REPO_BRANCH" ]]; then git -c safe.directory="$existing" branch -m "$REPO_BRANCH"; fi
  if [[ "$existing" == "$LEGACY_DIR" ]]; then
    [[ ! -e "$APP_DIR" && ! -L "$APP_DIR" && "$(realpath -e /root)" == /root ]] || die 'The migration destination is unsafe or already exists.'
    # Both source and destination are fixed, validated managed paths.
    cd /root; mv -T -- "$existing" "$APP_DIR"
  fi
  cd "$APP_DIR"
  configure_environment "$existing"; validate_storage; private_permissions
  run_command npm ci --omit=dev --ignore-scripts
  node scripts/check.mjs
  ensure_owner
  restart_project; enable_startup
  mark_installed
  trap - ERR
  success 'Repair complete. Owner, files and encryption key preserved.'
  show_addresses
}
backup_project() {
  require_root; validate_directory "$APP_DIR"; cd "$APP_DIR"; validate_storage
  stop_managed_process "$PM2_HOME"
  local result=0
  backup_existing || result=$?
  restart_project
  return "$result"
}
uninstall_project() {
  require_root
  local confirmation target runtime_shared=0
  if ! command -v pm2 >/dev/null || ! command -v node >/dev/null; then
    export PATH="$PATH:/opt/jtg-cloud-runtime/current/bin:/opt/jtg-cloud-runtime/pm2/bin"
  fi
  # Uninstall must also work for empty/partial folders without .git, package.json or .env.
  for target in "$APP_DIR" "$LEGACY_DIR" "$LEGACY_HOME" "$LEGACY_RUNTIME" "$MANAGER_FILE"; do validate_removal_path "$target"; done
  heading 'UNINSTALL JTG CLOUD'
  note "Permanently removes $APP_DIR and $LEGACY_DIR, including accounts, files, keys and backups inside them."
  note 'Unused old JTG runtime, service home, manager script and cloud logs are also removed.'
  note 'Copy any backup you need outside this directory first.'
  note 'Global Node.js, PM2 and other PM2 applications remain installed.'
  read -r -p '  Delete JTG Cloud and all its stored data? [y/N]: ' confirmation || return 0
  case "${confirmation%$'\r'}" in y|Y|yes|YES|Yes) ;; *) note 'Uninstall cancelled. Nothing removed.'; return 0;; esac
  LEGACY_PM2_SHARED=0
  if command -v pm2 >/dev/null && command -v node >/dev/null; then
    # Check both names before mutating either process list.
    process_state "$PM2_HOME" >/dev/null
    if legacy_pm2_exists; then process_state /home/jtgcloud/.pm2 >/dev/null; fi
    delete_managed_process "$PM2_HOME"; retire_legacy_pm2
    # A running daemon may still load the old runtime's process-container code.
    # Retain it when other apps remain; kill an empty daemon before deleting its old files.
    if pm2 jlist | node --input-type=module -e 'import fs from "node:fs";process.exit(JSON.parse(fs.readFileSync(0,"utf8")).length?1:0)'; then pm2 kill;
    else runtime_shared=1; fi
  elif [[ -S /root/.pm2/rpc.sock ]] || legacy_pm2_exists; then
    die 'Cannot safely remove a running PM2 installation. Install global PM2 or choose Repair first.'
  fi
  cd /root
  remove_managed_path "$APP_DIR"
  remove_managed_path "$LEGACY_DIR"
  if command -v pgrep >/dev/null && id -u jtgcloud >/dev/null 2>&1 && pgrep -u jtgcloud >/dev/null; then LEGACY_PM2_SHARED=1; fi
  if [[ "$LEGACY_PM2_SHARED" == 0 ]]; then remove_managed_path "$LEGACY_HOME";
  elif [[ -e "$LEGACY_HOME" || -L "$LEGACY_HOME" ]]; then note 'The old service home is used by another running service and was preserved.'; fi
  if [[ "$LEGACY_PM2_SHARED" == 0 && "$runtime_shared" == 0 ]]; then remove_managed_path "$LEGACY_RUNTIME";
  elif [[ -e "$LEGACY_RUNTIME" || -L "$LEGACY_RUNTIME" ]]; then note 'Other PM2 apps remain; their potentially shared old runtime was preserved.'; fi
  remove_managed_path "$MANAGER_FILE"
  cleanup_pm2_files
  rm -f -- "$LOG_FILE"
  success 'JTG Cloud is uninstalled. Choose Install for a fresh cloud and a new owner account.'
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
    printf '  %s1%s  Install JTG Cloud\n  %s2%s  Update JTG Cloud\n  %s3%s  Restart cloud\n  %s4%s  Stop cloud\n  %s5%s  Service status\n  %s6%s  Reset account password\n  %s7%s  Back up cloud\n  %s8%s  Preview installation plan\n  %s9%s  Repair / migrate installation\n  %s10%s Uninstall JTG Cloud\n  %s0%s  Exit\n\n' "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET"
    local choice
    read -r -p '  Select an option [0-10]: ' choice || return 0
    choice=${choice%$'\r'}
    case "$choice" in
      1) install_project;;
      2) require_root; [[ -f "$APP_DIR/update.sh" ]] || die 'Install first, or choose Repair / migrate.'; bash "$APP_DIR/update.sh";;
      3) restart_project;;
      4) require_root; command -v pm2 >/dev/null || die 'Choose Repair to install PM2.'; stop_managed_process "$PM2_HOME"; pm2 save;;
      5) require_root; command -v pm2 >/dev/null || die 'Choose Repair to install PM2.'; pm2 status;;
      6) require_root; validate_directory "$APP_DIR"; cd "$APP_DIR"; node --env-file=.env src/cli.mjs reset-password;;
      7) backup_project;;
      8) installation_plan;;
      9) repair_project;;
      10) uninstall_project;;
      0) printf '\n  JTG Studio / See you next time.\n'; return 0;;
      *) note 'Choose one of the menu options.';;
    esac
  done
}
# Helpers may be sourced for deployment checks without starting the menu.
if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then main "$@"; fi

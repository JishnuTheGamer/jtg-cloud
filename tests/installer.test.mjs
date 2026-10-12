import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bash = process.env.INSTALLER_BASH || (process.platform === 'win32' ? 'G:/Git/bin/bash.exe' : 'bash');
const available = spawnSync(bash, ['--version'], { encoding: 'utf8' }).status === 0;
function shell(args, env = {}) {
  const result = spawnSync(bash, args, {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, TERM: 'xterm', NO_COLOR: '1', ...env },
  });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function fixture(callback) {
  const temporary=mkdtempSync(path.join(os.tmpdir(),'jtg-cloud-installer-'));
  try { return callback(temporary,{JTG_TEST_ROOT:temporary.replaceAll('\\','/')}); }
  finally {assert.equal(path.dirname(temporary),os.tmpdir());rmSync(temporary,{recursive:true,force:true});}
}

const mockPm2 = `
  pm2() {
    printf '%s|%s\\n' "$PM2_HOME" "$*" >> "$JTG_TEST_ROOT/actions"
    case "$1" in
      jlist) printf '%s\\n' "$MOCK_PM2_APPS";;
      delete) [[ "$2" == jtg-cloud ]] || return 99; MOCK_PM2_APPS='[{"name":"other-app","pm2_env":{"pm_exec_path":"/srv/other/server.js","status":"online"}}]';;
    esac
  }
`;

const scopedRemoval = `
  APP_DIR="$JTG_TEST_ROOT/app"; LEGACY_DIR="$JTG_TEST_ROOT/legacy"
  LEGACY_HOME="$JTG_TEST_ROOT/home"; LEGACY_RUNTIME="$JTG_TEST_ROOT/runtime"
  MANAGER_FILE="$JTG_TEST_ROOT/manager.sh"; LOG_FILE="$JTG_TEST_ROOT/install.log"
  require_root() { return 0; }
  validate_removal_path() { case "$1" in "$APP_DIR"|"$LEGACY_DIR"|"$LEGACY_HOME"|"$LEGACY_RUNTIME"|"$MANAGER_FILE") return 0;; *) return 99;; esac; }
  cleanup_pm2_files() { return 0; }
  legacy_pm2_exists() { return 1; }
  pgrep() { return 1; }
  cd() { if [[ "$1" == /root ]]; then builtin cd "$JTG_TEST_ROOT"; else builtin cd "$@"; fi; }
  rm() {
    if [[ "$1" == -rf ]]; then
      [[ "$#" == 4 && "$2" == --one-file-system && "$3" == -- && "$PWD" != "$4" ]] || return 99
      validate_removal_path "$4" || return 99
    else [[ "$#" == 3 && "$1" == -f && "$2" == -- && "$3" == "$LOG_FILE" ]] || return 99; fi
    command rm "$@"
  }
`;

test('installer preview is noninteractive and does not invoke system commands', { skip: !available }, () => {
  // Any attempt to perform installation in preview mode must fail the check.
  const output = shell(['-c', `
    apt-get() { exit 97; }; curl() { exit 97; }; git() { exit 97; }
    npm() { exit 97; }; systemctl() { exit 97; }; runuser() { exit 97; }
    export -f apt-get curl git npm systemctl runuser
    bash ./install.sh --dry-run
  `]);
  assert.match(output, /JTG Studio/);
  assert.match(output, /git clone --branch jtg-studio https:\/\/github\.com\/JishnuTheGamer\/jtg-cloud\.git \/root\/jtg-cloud/);
  assert.match(output, /cd \/root\/jtg-cloud\n/);
  assert.match(output, /npm install -g pm2/);
  assert.match(output, /pm2 startup systemd -u root --hp \/root/);
  assert.match(output, /\[10\/10\] Verify cloud health/);
  assert.match(output, /http:\/\/localhost:6969/);
  assert.doesNotMatch(output, /Nginx|Certbot|Cloudflare|Configure HTTPS|DNS|6696/);
  assert.doesNotMatch(output, /\x1b\[/);
});

test('installer supports bold terminals, plain terminals and menu exit', { skip: !available }, () => {
  const env = { ...process.env, TERM: 'xterm', FORCE_COLOR: '1' };
  delete env.NO_COLOR;
  const colored = spawnSync(bash, ['./install.sh', '--dry-run'], { cwd: root, encoding: 'utf8', env });
  assert.equal(colored.status, 0, colored.stderr);
  assert.match(colored.stdout, /\x1b\[1m/);
  assert.doesNotMatch(shell(['./install.sh', '--dry-run'], { TERM: 'dumb' }), /\x1b\[/);
  const menu = shell(['-c', "printf '8\\n0\\n' | bash ./install.sh"]);
  assert.match(menu, /CLOUD MANAGEMENT/);
  assert.match(menu, /INSTALLATION PLAN/);
  assert.match(menu, /See you next time/);
  assert.match(menu, /Restart cloud/);
  assert.doesNotMatch(menu, /Start \/ restart/);
  assert.match(menu, /Repair \/ migrate installation/);
  assert.match(menu, /Uninstall JTG Cloud/);
});

test('private checkout deployment clones committed source without data or Git credentials', { skip: !available }, () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'jtg-cloud-installer-'));
  try {
    const output = shell(['-c', `
      source ./install.sh
      SOURCE_DIR="$JTG_TEST_ROOT/source"
      APP_DIR="$JTG_TEST_ROOT/installed"
      LOG_FILE="$JTG_TEST_ROOT/install.log"
      mkdir -p "$SOURCE_DIR/src" "$SOURCE_DIR/data"
      printf '{"name":"jtg-cloud"}\\n' > "$SOURCE_DIR/package.json"
      printf '// fixture\\n' > "$SOURCE_DIR/src/server.mjs"
      printf '.env\\ndata/\\n' > "$SOURCE_DIR/.gitignore"
      git init --quiet --initial-branch=jtg-studio "$SOURCE_DIR"
      git -C "$SOURCE_DIR" add .
      git -C "$SOURCE_DIR" -c user.name='Installer Test' -c user.email='test@example.invalid' commit --quiet -m fixture
      git -C "$SOURCE_DIR" remote add origin "$REPO_URL"
      git -C "$SOURCE_DIR" config credential.helper 'fixture-private-credential'
      printf 'PRIVATE_TEST_VALUE=local-only\\n' > "$SOURCE_DIR/.env"
      printf 'private data\\n' > "$SOURCE_DIR/data/private.txt"
      printf 'untracked\\n' > "$SOURCE_DIR/untracked.txt"
      printf '{"name":"uncommitted-change"}\\n' > "$SOURCE_DIR/package.json"
      clone_project
      [[ "$PWD" == "$(cd "$APP_DIR" && pwd)" ]]
      [[ "$(git symbolic-ref --short HEAD)" == jtg-studio ]]
      [[ "$(git remote get-url origin)" == "$REPO_URL" ]]
      [[ -z "$(git config --local --get credential.helper || true)" ]]
    `], { JTG_TEST_ROOT: temporary.replaceAll('\\', '/') });
    assert.match(output, /Source ready/);
    const installed = path.join(temporary, 'installed');
    assert.equal(JSON.parse(readFileSync(path.join(installed, 'package.json'))).name, 'jtg-cloud');
    for (const filename of ['.env', 'data', 'untracked.txt']) assert.equal(existsSync(path.join(installed, filename)), false);
  } finally {
    // The target is the exact directory returned by mkdtemp, under the OS temp root.
    assert.equal(path.dirname(temporary), os.tmpdir());
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('failed repository authentication stops cloning before project setup', { skip: !available }, () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'jtg-cloud-installer-'));
  try {
    shell(['-c', `
      source ./install.sh
      SOURCE_DIR="$JTG_TEST_ROOT/nonexistent-source"
      APP_DIR="$JTG_TEST_ROOT/installed"
      LOG_FILE="$JTG_TEST_ROOT/install.log"
      git() { return 128; }
      node() { printf 'ERROR: setup ran after clone failure\\n'; return 99; }
      if clone_project; then exit 98; fi
      [[ ! -e "$APP_DIR" ]]
    `], { JTG_TEST_ROOT: temporary.replaceAll('\\', '/') });
  } finally {
    assert.equal(path.dirname(temporary), os.tmpdir());
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('updater follows a renamed remote branch and refuses divergent history', { skip: !available }, () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'jtg-cloud-installer-'));
  try {
    shell(['-c', `
      source ./update.sh
      repo="$JTG_TEST_ROOT/repository"
      remote="$JTG_TEST_ROOT/remote.git"
      checkout="$JTG_TEST_ROOT/checkout"
      git init --quiet --initial-branch=previous-release "$repo"
      git -C "$repo" -c user.name='Update Test' -c user.email='test@example.invalid' commit --quiet --allow-empty -m initial
      git clone --quiet --bare "$repo" "$remote"
      git clone --quiet "$remote" "$checkout"
      git -C "$repo" branch -m jtg-studio
      git -C "$repo" -c user.name='Update Test' -c user.email='test@example.invalid' commit --quiet --allow-empty -m update
      git -C "$repo" push --quiet "$remote" jtg-studio
      git -C "$remote" symbolic-ref HEAD refs/heads/jtg-studio
      git -C "$remote" branch -D previous-release
      cd "$checkout"
      git fetch --quiet --prune origin
      follow_remote_branch
      [[ "$branch" == jtg-studio ]]
      [[ "$(git symbolic-ref --short HEAD)" == jtg-studio ]]
      [[ "$(git rev-parse --abbrev-ref '@{upstream}')" == origin/jtg-studio ]]
      git merge --quiet --ff-only "origin/$branch"
      # A local commit diverges from a new remote commit after another rename.
      git -c user.name='Update Test' -c user.email='test@example.invalid' commit --quiet --allow-empty -m local-only
      git -C "$repo" branch -m next-release
      git -C "$repo" -c user.name='Update Test' -c user.email='test@example.invalid' commit --quiet --allow-empty -m different-update
      git -C "$repo" push --quiet "$remote" next-release
      git -C "$remote" symbolic-ref HEAD refs/heads/next-release
      git -C "$remote" branch -D jtg-studio
      git fetch --quiet --prune origin
      if follow_remote_branch; then exit 98; fi
      [[ "$(git symbolic-ref --short HEAD)" == jtg-studio ]]
    `], { JTG_TEST_ROOT: temporary.replaceAll('\\', '/') });
  } finally {
    assert.equal(path.dirname(temporary), os.tmpdir());
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('rollback refuses to start version 1.0 against chunked file storage', { skip: !available }, () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'jtg-cloud-installer-'));
  try {
    shell(['-c', `
      source ./update.sh
      APP_DIR="$JTG_TEST_ROOT/application"
      mkdir -p "$APP_DIR/data"
      cd "$APP_DIR"
      printf 'DATA_DIR=./data\\n' > .env
      printf '{"version":"1.0.0"}\\n' > package.json
      previous_restart_safe
      node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/cloud.sqlite');db.exec(\\"CREATE TABLE entries(id TEXT,storage_format TEXT);CREATE TABLE file_parts(entry_id TEXT);CREATE TABLE upload_parts(upload_id TEXT);\\");db.close()"
      previous_restart_safe
      node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/cloud.sqlite');db.exec(\\"INSERT INTO entries VALUES ('file','chunked');INSERT INTO file_parts VALUES ('file');\\");db.close()"
      if previous_restart_safe; then exit 98; fi
      printf '{"version":"1.1.0"}\\n' > package.json
      previous_restart_safe
      printf '{"version":"1.0.0"}\\n' > package.json
      node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/cloud.sqlite');db.exec(\\"DELETE FROM entries;DELETE FROM file_parts;INSERT INTO upload_parts VALUES ('pending');\\");db.close()"
      if previous_restart_safe; then exit 98; fi
    `], { JTG_TEST_ROOT: temporary.replaceAll('\\', '/') });
  } finally {
    assert.equal(path.dirname(temporary), os.tmpdir());
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('updater migrates the previous network setup once and preserves unrelated settings', { skip: !available }, () => {
  const temporary=mkdtempSync(path.join(os.tmpdir(),'jtg-cloud-installer-'));
  try {
    shell(['-c', `
      source ./update.sh
      APP_DIR="$JTG_TEST_ROOT/application"
      mkdir -p "$APP_DIR"
      printf 'PORT=6696\\nHOST=127.0.0.1\\nAPP_URL=https://previous.example\\nTRUST_PROXY=true\\nCOOKIE_SECURE=true\\nDATA_DIR=./kept-data\\nREGISTRATION_DOMAIN=members.example\\n' > "$APP_DIR/.env"
      configure_service_env
      grep -qx 'PORT=6969' "$APP_DIR/.env"
      grep -qx 'HOST=0.0.0.0' "$APP_DIR/.env"
      grep -qx 'APP_URL=' "$APP_DIR/.env"
      grep -qx 'COOKIE_SECURE=false' "$APP_DIR/.env"
      grep -qx 'TRUST_PROXY=false' "$APP_DIR/.env"
      grep -qx 'DATA_DIR=./kept-data' "$APP_DIR/.env"
      grep -qx 'REGISTRATION_DOMAIN=members.example' "$APP_DIR/.env"
      printf 'OPERATOR_CUSTOM_FIELD=keep-me\\n' >> "$APP_DIR/.env"
      configure_service_env
      grep -qx 'OPERATOR_CUSTOM_FIELD=keep-me' "$APP_DIR/.env"
      [[ "$(grep -c '^PORT=' "$APP_DIR/.env")" == 1 ]]
    `],{JTG_TEST_ROOT:temporary.replaceAll('\\','/')});
  } finally {assert.equal(path.dirname(temporary),os.tmpdir());rmSync(temporary,{recursive:true,force:true});}
});

test('PM2 installation uses npm global and the standard root daemon', {skip:!available}, () => fixture((temporary,env)=>{
  shell(['-c',`
    source ./install.sh
    LOG_FILE="$JTG_TEST_ROOT/install.log"
    npm() { printf '%s|%s\\n' "$NPM_CONFIG_PREFIX" "$*" > "$JTG_TEST_ROOT/npm-call"; }
    pm2() { return 0; }
    install_pm2
    [[ "$PM2_HOME" == /root/.pm2 ]]
  `],env);
  assert.equal(readFileSync(path.join(temporary,'npm-call'),'utf8').trim(),'/usr/local|install -g pm2');
}));

test('PM2 ownership checks reject name collisions including duplicate names', {skip:!available}, () => fixture((temporary,env)=>{
  shell(['-c',`
    source ./install.sh
    ${mockPm2}
    MOCK_PM2_APPS='[]'
    [[ "$(process_state "$PM2_HOME")" == missing ]]
    MOCK_PM2_APPS='[{"name":"jtg-cloud","pm2_env":{"pm_exec_path":"/root/jtg-cloud/src/server.mjs","status":"stopped"}}]'
    [[ "$(process_state "$PM2_HOME")" == stopped ]]
    MOCK_PM2_APPS='[{"name":"jtg-cloud","pm2_env":{"pm_exec_path":"/opt/jtg-cloud/src/server.mjs","status":"online"}}]'
    [[ "$(process_state /home/jtgcloud/.pm2)" == online ]]
    MOCK_PM2_APPS='[{"name":"jtg-cloud","pm2_env":{"pm_exec_path":"/srv/other/server.js"}}]'
    if process_state "$PM2_HOME"; then exit 98; fi
    MOCK_PM2_APPS='[{"name":"jtg-cloud","pm2_env":{"pm_exec_path":"/root/jtg-cloud/src/server.mjs"}},{"name":"jtg-cloud","pm2_env":{"pm_exec_path":"/srv/other/server.js"}}]'
    if process_state "$PM2_HOME"; then exit 98; fi
  `],env);
  assert.doesNotMatch(readFileSync(path.join(temporary,'actions'),'utf8'),/delete|stop|kill|save/);
}));

test('managed path guard refuses broad and unexpected removal targets', {skip:!available}, () => fixture((temporary,env)=>{
  shell(['-c',`
    source ./install.sh
    rm() { printf 'UNEXPECTED REMOVE\\n' > "$JTG_TEST_ROOT/unsafe"; return 97; }
    for candidate in / /root /opt /root/jtg-cloud/.. /root/other "$JTG_TEST_ROOT"; do
      if (validate_directory "$candidate"); then exit 98; fi
      if (validate_removal_path "$candidate"); then exit 98; fi
    done
    [[ ! -e "$JTG_TEST_ROOT/unsafe" ]]
  `],env);
  assert.equal(existsSync(path.join(temporary,'unsafe')),false);
}));

test('managed storage refuses external, overlapping and redirected directories', {skip:!available}, () => fixture((temporary,env)=>{
  shell(['-c',`
    source ./install.sh
    mkdir -p "$JTG_TEST_ROOT/app" "$JTG_TEST_ROOT/external"
    cd "$JTG_TEST_ROOT/app"
    printf 'DATA_DIR=./data\\nBACKUP_DIR=./backups\\n' > .env
    validate_storage
    printf 'DATA_DIR=../external\\nBACKUP_DIR=./backups\\n' > .env
    if validate_storage; then exit 98; fi
    printf 'DATA_DIR=./data\\nBACKUP_DIR=./data/backups\\n' > .env
    if validate_storage; then exit 98; fi
    node --input-type=module -e 'import fs from "node:fs";import path from "node:path";fs.symlinkSync(path.resolve("../external"),"linked-data",process.platform==="win32"?"junction":"dir")'
    printf 'DATA_DIR=./linked-data\\nBACKUP_DIR=./backups\\n' > .env
    if validate_storage; then exit 98; fi
  `],env);
}));

test('environment migration rewrites managed absolute paths and preserves custom fields', {skip:!available}, () => fixture((temporary,env)=>{
  shell(['-c',`
    source ./install.sh
    APP_DIR="$JTG_TEST_ROOT/app"
    mkdir -p "$APP_DIR"
    cd "$APP_DIR"
    printf 'PORT=6696\\nDATA_DIR="/opt/jtg-cloud/private-data"\\nBACKUP_DIR=/opt/jtg-cloud/private-backups\\nREGISTRATION_DOMAIN=members.example\\nCUSTOM_VALUE=keep-me\\n' > .env
    MSYS2_ARG_CONV_EXCL=/opt/jtg-cloud configure_environment /opt/jtg-cloud
    configure_environment
    grep -qx 'PORT=6969' .env
    grep -qx 'HOST=0.0.0.0' .env
    grep -qx 'APP_URL=' .env
    grep -qx 'COOKIE_SECURE=false' .env
    grep -qx 'CUSTOM_VALUE=keep-me' .env
    grep -qx 'REGISTRATION_DOMAIN=members.example' .env
    [[ "$(grep -c '^PORT=' .env)" == 1 ]]
  `],env);
  const text=readFileSync(path.join(temporary,'app','.env'),'utf8');
  assert.match(text,new RegExp(`DATA_DIR="${temporary.replaceAll('\\','/').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/app/private-data"`));
  assert.doesNotMatch(text,/\/opt\/jtg-cloud/);
}));

test('offline repair backup and owner check preserve database, blobs, key and environment', {skip:!available}, () => fixture((temporary,env)=>{
  shell(['-c',`
    source ./install.sh
    mkdir -p "$JTG_TEST_ROOT/app/data/blobs"
    cd "$JTG_TEST_ROOT/app"
    printf 'DATA_DIR=./data\\nBACKUP_DIR=./backups\\nCUSTOM_VALUE=kept\\n' > .env
    printf 'encrypted fixture' > data/blobs/encrypted-part
    printf 'private fixture key' > data/encryption.key
    node --input-type=module -e 'import {DatabaseSync} from "node:sqlite";const db=new DatabaseSync("data/cloud.sqlite");db.exec("CREATE TABLE users(id TEXT,role TEXT)");db.prepare("INSERT INTO users VALUES (?,?)").run("existing-owner","owner");db.close()'
    ensure_owner
    backup_existing
    node --input-type=module -e 'import fs from "node:fs";import {DatabaseSync} from "node:sqlite";const backup="backups/"+fs.readdirSync("backups")[0];const db=new DatabaseSync(backup+"/cloud.sqlite",{readOnly:true});if(db.prepare("SELECT id FROM users").get().id!=="existing-owner")process.exit(98);db.close();for(const file of ["encryption.key","blobs/encrypted-part"])if(!fs.readFileSync("data/"+file).equals(fs.readFileSync(backup+"/"+file)))process.exit(98);if(!fs.readFileSync(".env").equals(fs.readFileSync(backup+"/.env")))process.exit(98)'
  `],env);
}));

test('backup refuses a missing encryption key and owner check refuses a corrupt database', {skip:!available}, () => fixture((temporary,env)=>{
  shell(['-c',`
    source ./install.sh
    mkdir -p "$JTG_TEST_ROOT/app/data/blobs" "$JTG_TEST_ROOT/app/src"
    cd "$JTG_TEST_ROOT/app"
    printf 'DATA_DIR=./data\\nBACKUP_DIR=./backups\\n' > .env
    printf 'not-a-database' > data/cloud.sqlite
    printf 'process.exit(98)\\n' > src/cli.mjs
    if backup_existing; then exit 98; fi
    if ensure_owner; then exit 98; fi
    [[ ! -e data/encryption.key && ! -e backups ]]
    [[ "$(cat data/cloud.sqlite)" == not-a-database ]]
  `],env);
}));

test('restart recreates a missing PM2 entry using the global root account', {skip:!available}, () => fixture((temporary,env)=>{
  shell(['-c',`
    source ./install.sh
    APP_DIR="$JTG_TEST_ROOT/app"
    mkdir -p "$APP_DIR/.git"
    printf 'PORT=6969\\n' > "$APP_DIR/.env"
    require_root() { return 0; }
    validate_directory() { [[ "$1" == "$APP_DIR" && -d "$APP_DIR/.git" ]]; }
    health() { printf 'health\\n' >> "$JTG_TEST_ROOT/actions"; }
    ${mockPm2}
    MOCK_PM2_APPS='[]'
    restart_project
  `],env);
  const actions=readFileSync(path.join(temporary,'actions'),'utf8');
  assert.match(actions,/\/root\/\.pm2\|startOrRestart ecosystem.config.cjs --only jtg-cloud --update-env --interpreter /);
  assert.match(actions,/health\n\/root\/\.pm2\|save/);
  assert.doesNotMatch(actions,/runuser|\/home\/jtgcloud|\/opt\/jtg-cloud-runtime/);
}));

test('uninstall uses Y/N, works repeatedly and preserves other apps', {skip:!available}, () => fixture((temporary,env)=>{
  shell(['-c',`
    source ./install.sh
    APP_DIR="$JTG_TEST_ROOT/app"; LEGACY_DIR="$JTG_TEST_ROOT/legacy"
    LEGACY_HOME="$JTG_TEST_ROOT/home"; LEGACY_RUNTIME="$JTG_TEST_ROOT/runtime"; MANAGER_FILE="$JTG_TEST_ROOT/manager.sh"
    LOG_FILE="$JTG_TEST_ROOT/install.log"
    mkdir -p "$APP_DIR/.git" "$APP_DIR/data/blobs" "$APP_DIR/backups"
    printf 'DATA_DIR=./data\\nBACKUP_DIR=./backups\\n' > "$APP_DIR/.env"
    printf 'private content' > "$APP_DIR/data/blobs/file"
    printf 'keep another app' > "$JTG_TEST_ROOT/other-app"
    require_root() { return 0; }
    validate_removal_path() { case "$1" in "$APP_DIR"|"$LEGACY_DIR"|"$LEGACY_HOME"|"$LEGACY_RUNTIME"|"$MANAGER_FILE") return 0;; *) return 99;; esac; }
    cleanup_pm2_files() { return 0; }
    legacy_pm2_exists() { return 1; }
    cd() { if [[ "$1" == /root ]]; then builtin cd "$JTG_TEST_ROOT"; else builtin cd "$@"; fi; }
    rm() {
      if [[ "$1" == -rf ]]; then
        [[ "$#" == 4 && "$2" == --one-file-system && "$3" == -- && "$4" == "$APP_DIR" && "$PWD" != "$APP_DIR" ]] || return 99
        printf 'remove-project\\n' >> "$JTG_TEST_ROOT/actions"
        command rm -rf -- "$APP_DIR"
      else
        [[ "$#" == 3 && "$1" == -f && "$2" == -- && "$3" == "$LOG_FILE" ]] || return 99
      fi
    }
    ${mockPm2}
    MOCK_PM2_APPS='[{"name":"jtg-cloud","pm2_env":{"pm_exec_path":"/root/jtg-cloud/src/server.mjs","status":"online"}},{"name":"other-app","pm2_env":{"pm_exec_path":"/srv/other/server.js","status":"online"}}]'
    uninstall_project <<< 'cancel'
    uninstall_project <<< 'n'
    uninstall_project <<< ''
    [[ -d "$APP_DIR" && ! -e "$JTG_TEST_ROOT/actions" ]]
    uninstall_project <<< 'Y'
    [[ ! -e "$APP_DIR" && -f "$JTG_TEST_ROOT/other-app" ]]
    uninstall_project <<< 'yes'
    [[ ! -e "$APP_DIR" && -f "$JTG_TEST_ROOT/other-app" ]]
    [[ "$MOCK_PM2_APPS" == '[{"name":"other-app","pm2_env":{"pm_exec_path":"/srv/other/server.js","status":"online"}}]' ]]
  `],env);
  const actions=readFileSync(path.join(temporary,'actions'),'utf8');
  assert.match(actions,/delete jtg-cloud\n\/root\/\.pm2\|save --force\n\/root\/\.pm2\|save --force/);
  assert.match(actions,/remove-project/);
  assert.doesNotMatch(actions,/delete other-app|kill|unstartup/);
}));

test('partial and duplicate leftovers uninstall completely, then a new install gets a new owner and key', {skip:!available}, () => fixture((temporary,env)=>{
  shell(['-c',`
    source ./install.sh
    ${scopedRemoval}
    SOURCE_DIR="$JTG_TEST_ROOT/source"
    mkdir -p "$SOURCE_DIR" "$APP_DIR" "$LEGACY_DIR" "$LEGACY_HOME" "$LEGACY_RUNTIME"
    cp -R ./src "$SOURCE_DIR/src"
    cp package.json package-lock.json .env.example .gitignore "$SOURCE_DIR/"
    git init --quiet --initial-branch=jtg-studio "$SOURCE_DIR"
    git -C "$SOURCE_DIR" add .
    git -C "$SOURCE_DIR" -c user.name='Fresh Install Test' -c user.email='test@example.invalid' commit --quiet -m fixture
    git -C "$SOURCE_DIR" remote add origin "$REPO_URL"
    cp -R "$SOURCE_DIR/src" "$APP_DIR/src"
    cp "$SOURCE_DIR/package.json" "$APP_DIR/package.json"
    cp "$SOURCE_DIR/.env.example" "$APP_DIR/.env"
    printf 'partial old source' > "$LEGACY_DIR/leftover"
    printf 'old runtime' > "$LEGACY_RUNTIME/leftover"
    printf 'old home' > "$LEGACY_HOME/leftover"
    printf 'old manager' > "$MANAGER_FILE"
    cd "$APP_DIR"
    printf '%s' '{"displayName":"Old Owner","username":"old-owner","email":"old@example.invalid","password":"Old-fixture-password-123"}' | node --env-file=.env src/cli.mjs setup --stdin
    cp data/encryption.key "$JTG_TEST_ROOT/key-before"
    mkdir backups
    printf 'old backup' > backups/old-backup
    # A half-uninstalled application has no Git metadata or package.json.
    command rm -f package.json .env
    pm2() {
      case "$1" in
        jlist) printf '%s\\n' "$MOCK_PM2_APPS";;
        delete) [[ "$2" == jtg-cloud ]] || return 99; MOCK_PM2_APPS='[]';;
      esac
    }
    MOCK_PM2_APPS='[{"name":"jtg-cloud","pm2_env":{"pm_exec_path":"/root/jtg-cloud/src/server.mjs","status":"errored"}}]'
    uninstall_project <<< 'y'
    for target in "$APP_DIR" "$LEGACY_DIR" "$LEGACY_HOME" "$LEGACY_RUNTIME" "$MANAGER_FILE"; do [[ ! -e "$target" ]]; done
    uninstall_project <<< 'Y'
    linux_requirements() { return 0; }
    npm() { return 0; }
    chown() { return 0; }; chmod() { return 0; }
    health() { return 0; }
    ensure_owner() { printf '%s' '{"displayName":"New Owner","username":"new-owner","email":"new@example.invalid","password":"New-fixture-password-123"}' | node --env-file=.env src/cli.mjs setup --stdin; }
    install_project
    [[ -f "$APP_DIR/.jtg-installed" && ! -e "$APP_DIR/backups/old-backup" ]]
    node --input-type=module - "$JTG_TEST_ROOT/key-before" <<'JS'
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
if(fs.readFileSync('data/encryption.key').equals(fs.readFileSync(process.argv[2]))) process.exit(98);
const db=new DatabaseSync('data/cloud.sqlite',{readOnly:true});
const owners=db.prepare("SELECT username FROM users WHERE role='owner'").all();
if(owners.length!==1||owners[0].username!=='new-owner'||db.prepare("SELECT id FROM users WHERE username='old-owner'").get()) process.exit(98);
db.close();
JS
  `],env);
  assert.equal(existsSync(path.join(temporary,'legacy')),false);
  assert.equal(existsSync(path.join(temporary,'runtime')),false);
  assert.equal(existsSync(path.join(temporary,'home')),false);
  assert.equal(existsSync(path.join(temporary,'manager.sh')),false);
  assert.equal(existsSync(path.join(temporary,'app','.git')),true);
}));

test('failed removal is reported without claiming uninstall success', {skip:!available}, () => fixture((temporary,env)=>{
  shell(['-c',`
    source ./install.sh
    ${scopedRemoval}
    mkdir -p "$APP_DIR"
    printf 'keep until removal succeeds' > "$APP_DIR/leftover"
    rm() { return 1; }
    if (remove_managed_path "$APP_DIR"); then exit 98; fi
    [[ -f "$APP_DIR/leftover" ]]
  `],env);
}));

test('repair migrates an older fixture after a backup and retains its owner and files', {skip:!available}, () => fixture((temporary,env)=>{
  shell(['-c',`
    source ./install.sh
    APP_DIR="$JTG_TEST_ROOT/app"; LEGACY_DIR="$JTG_TEST_ROOT/legacy"
    LOG_FILE="$JTG_TEST_ROOT/install.log"
    mkdir -p "$LEGACY_DIR/data/blobs" "$LEGACY_DIR/src"
    printf '{"name":"jtg-cloud","version":"1.2.0"}\\n' > "$LEGACY_DIR/package.json"
    printf '// fixture\\n' > "$LEGACY_DIR/src/server.mjs"
    printf '.env\\ndata/\\nbackups/\\n' > "$LEGACY_DIR/.gitignore"
    printf 'DATA_DIR=./data\\nBACKUP_DIR=./backups\\nPORT=6696\\n' > "$LEGACY_DIR/.env"
    printf 'saved encrypted part' > "$LEGACY_DIR/data/blobs/part"
    printf 'saved encryption key' > "$LEGACY_DIR/data/encryption.key"
    git init --quiet --initial-branch=jtg-studio "$LEGACY_DIR"
    git -C "$LEGACY_DIR" add .
    git -C "$LEGACY_DIR" -c user.name='Repair Test' -c user.email='test@example.invalid' commit --quiet -m previous
    git clone --quiet --bare "$LEGACY_DIR" "$JTG_TEST_ROOT/remote.git"
    git -C "$LEGACY_DIR" remote add origin "$JTG_TEST_ROOT/remote.git"
    node --input-type=module - "$LEGACY_DIR/data/cloud.sqlite" <<'JS'
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(process.argv[2]);
db.exec('CREATE TABLE users(id TEXT,role TEXT)');
db.prepare('INSERT INTO users VALUES (?,?)').run('preserved-owner','owner');db.close();
JS
    require_root() { return 0; }
    linux_requirements() { printf 'requirements\\n' >> "$JTG_TEST_ROOT/actions"; }
    install_node() { return 0; }
    install_pm2() { return 0; }
    # Keep production guards intact; this fixture validator only admits its two temporary paths.
    validate_directory() { [[ "$1" == "$APP_DIR" || "$1" == "$LEGACY_DIR" ]] && [[ -d "$1/.git" ]]; }
    legacy_pm2_exists() { return 1; }
    health() { printf 'health\\n' >> "$JTG_TEST_ROOT/actions"; }
    show_addresses() { return 0; }
    chown() { printf 'ownership|%s\\n' "$*" >> "$JTG_TEST_ROOT/actions"; }
    chmod() { printf 'permissions|%s\\n' "$*" >> "$JTG_TEST_ROOT/actions"; }
    npm() { printf 'npm|%s\\n' "$*" >> "$JTG_TEST_ROOT/actions"; }
    node() { if [[ "$1" == scripts/check.mjs ]]; then return 0; else command node "$@"; fi; }
    realpath() { if [[ "$*" == '-e /root' ]]; then printf '/root\\n'; else command realpath "$@"; fi; }
    cd() { if [[ "$1" == /root ]]; then builtin cd "$JTG_TEST_ROOT"; else builtin cd "$@"; fi; }
    ${mockPm2}
    MOCK_PM2_APPS='[{"name":"jtg-cloud","pm2_env":{"pm_exec_path":"/opt/jtg-cloud/src/server.mjs","status":"errored"}}]'
    repair_project
    [[ ! -e "$LEGACY_DIR" && -f "$APP_DIR/data/encryption.key" ]]
    grep -qx 'PORT=6969' "$APP_DIR/.env"
    node --env-file=.env --input-type=module -e 'import {DatabaseSync} from "node:sqlite";const db=new DatabaseSync("data/cloud.sqlite",{readOnly:true});if(db.prepare("SELECT id FROM users").get().id!=="preserved-owner")process.exit(98);db.close()'
  `],env);
  const installed=path.join(temporary,'app');
  assert.equal(existsSync(path.join(temporary,'legacy')),false);
  assert.equal(readFileSync(path.join(installed,'data','blobs','part'),'utf8'),'saved encrypted part');
  assert.equal(readFileSync(path.join(installed,'data','encryption.key'),'utf8'),'saved encryption key');
  assert.equal(existsSync(path.join(installed,'.jtg-installed')),true);
  assert.match(readFileSync(path.join(temporary,'actions'),'utf8'),/ownership\|-R root:root/);
  const backups=readdirSync(path.join(installed,'backups'));
  assert.equal(backups.length,1);
  assert.equal(readFileSync(path.join(installed,'backups',backups[0],'.env'),'utf8'),'DATA_DIR=./data\nBACKUP_DIR=./backups\nPORT=6696\n');
}));

test('legacy PM2 retirement preserves another app and its startup service', {skip:!available}, () => fixture((temporary,env)=>{
  shell(['-c',`
    source ./install.sh
    legacy_pm2_exists() { return 0; }
    systemctl() { printf 'UNEXPECTED SYSTEM CHANGE' > "$JTG_TEST_ROOT/unsafe"; return 99; }
    ${mockPm2}
    MOCK_PM2_APPS='[{"name":"jtg-cloud","pm2_env":{"pm_exec_path":"/opt/jtg-cloud/src/server.mjs","status":"stopped"}},{"name":"other-app","pm2_env":{"pm_exec_path":"/srv/other/server.js","status":"online"}}]'
    retire_legacy_pm2
    [[ ! -e "$JTG_TEST_ROOT/unsafe" && "$PM2_HOME" == /root/.pm2 ]]
  `],env);
  const actions=readFileSync(path.join(temporary,'actions'),'utf8');
  assert.match(actions,/\/home\/jtgcloud\/\.pm2\|delete jtg-cloud/);
  assert.doesNotMatch(actions,/kill|stop other-app|\/root\/\.pm2\|delete/);
}));

test('health validation requires the expected cloud response and version', {skip:!available}, () => fixture((temporary,env)=>{
  shell(['-c',`
    source ./install.sh
    mkdir -p "$JTG_TEST_ROOT/app"
    cd "$JTG_TEST_ROOT/app"
    printf '{"version":"1.3.0"}\\n' > package.json
    curl() { printf '%s' "$MOCK_HEALTH"; }
    pm2() { return 0; }
    sleep() { return 0; }
    MOCK_HEALTH='{"status":"ok","version":"1.3.0"}'
    health
    MOCK_HEALTH='{"status":"ok","version":"1.2.0"}'
    if health; then exit 98; fi
    MOCK_HEALTH='unrelated HTTP 200'
    if health; then exit 98; fi
    MOCK_HEALTH='{"status":"error","version":"1.3.0"}'
    if health; then exit 98; fi
  `],env);
}));

test('repair fetch failure stops before touching the running service or existing data', {skip:!available}, () => fixture((temporary,env)=>{
  const result=spawnSync(bash,['-c',`
    source ./install.sh
    APP_DIR="$JTG_TEST_ROOT/app"; LEGACY_DIR="$JTG_TEST_ROOT/legacy"; LOG_FILE="$JTG_TEST_ROOT/install.log"
    mkdir -p "$APP_DIR/.git" "$APP_DIR/data"
    printf 'DATA_DIR=./data\\nBACKUP_DIR=./backups\\n' > "$APP_DIR/.env"
    printf 'preserve-me' > "$APP_DIR/data/existing"
    require_root() { return 0; }
    linux_requirements() { return 0; }; install_node() { return 0; }; install_pm2() { return 0; }
    validate_directory() { [[ "$1" == "$APP_DIR" ]]; }
    git() { if [[ "$3" == status ]]; then return 0; else return 128; fi; }
    pm2() { printf 'UNEXPECTED PM2 ACTION' > "$JTG_TEST_ROOT/unsafe"; return 99; }
    repair_project
  `],{cwd:root,encoding:'utf8',timeout:30_000,env:{...process.env,TERM:'dumb',NO_COLOR:'1',...env}});
  assert.equal(result.status,128,`${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr,/Your files and owner account are preserved/);
  assert.equal(existsSync(path.join(temporary,'unsafe')),false);
  assert.equal(readFileSync(path.join(temporary,'app','data','existing'),'utf8'),'preserve-me');
}));

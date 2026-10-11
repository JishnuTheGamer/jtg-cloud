import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('installer preview is noninteractive and does not invoke system commands', { skip: !available }, () => {
  // Any attempt to perform installation in preview mode must fail the check.
  const output = shell(['-c', `
    apt-get() { exit 97; }; curl() { exit 97; }; git() { exit 97; }
    npm() { exit 97; }; systemctl() { exit 97; }; runuser() { exit 97; }
    export -f apt-get curl git npm systemctl runuser
    bash ./install.sh --dry-run
  `]);
  assert.match(output, /JTG Studio/);
  assert.match(output, /git clone --branch jtg-studio https:\/\/github\.com\/JishnuTheGamer\/jtg-cloud\.git \/opt\/jtg-cloud/);
  assert.match(output, /cd \/opt\/jtg-cloud\n/);
  assert.match(output, /\[10\/10\] Verify cloud health/);
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

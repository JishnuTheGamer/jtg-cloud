# JTG Cloud

Your files. Your server. A responsive storage panel by **JTG Studio**, running on **Node.js 24+**, **SQLite** and **port 6969**, with no third-party application dependencies.

## Features

- Username or email + password login, registration, persistent sessions and password changes.
- One protected owner, administrators and members, enforced by the server.
- File/folder uploads, drag and drop, nested folders, search, rename, move, favorites, image previews and downloads.
- Unlimited per-file upload size by default, within the account quota and available server disk space.
- Default **20 MB upload parts**, owner-configurable from **1 to 80 MB**, with progress, retries, pause, cancellation and resume.
- Secure streaming downloads with HTTP byte-range support for resumable downloads, including older encrypted files.
- Trash, restore, permanent deletion and storage accounting that includes trash.
- New members receive **5 GB** by default; the owner can change registration, quotas, branding, logo, favicon and accent color.
- Premium light/dark/system themes, animations, mobile layouts and reduced-motion support.
- AES-256-GCM encrypted storage, scrypt passwords, hashed server-side sessions, HttpOnly cookies, origin/CSRF checks and request limits.
- Interactive installer, PM2 reboot startup, backups, account recovery and a tested updater.

**Google login is a disabled “Coming soon” option.** Firebase/OAuth, email verification and emailed recovery are not configured. The operator resets forgotten passwords through the CLI.

## Repository

The source is **public** at [JishnuTheGamer/jtg-cloud](https://github.com/JishnuTheGamer/jtg-cloud), on branch **`jtg-studio`**. Keep `.env`, `data/`, `backups/` and credentials out of Git.

## Local startup

Install Node.js 24 or newer, then:

```sh
git clone https://github.com/JishnuTheGamer/jtg-cloud.git
cd jtg-cloud
npm ci
cp .env.example .env
npm run setup
npm start
```

On PowerShell use `Copy-Item .env.example .env`. Open **http://localhost:6969**, or **http://SERVER_IPV4:6969** using an IPv4 address assigned to the server. The app binds to `0.0.0.0:6969` and prints available addresses at startup. Remote access requires your network/firewall to permit that port; the installer does not change firewall rules.

Create the one owner account during terminal setup. There is no default password or web owner-creation endpoint. Passwords must have 8–128 characters; eight digits are also accepted. `npm run dev` restarts the service when source changes.

The service runs directly over HTTP. `APP_URL` is blank by default, so localhost and IP access work without a hostname setup. It checks the request's own origin and service port, rejects arbitrary DNS hostnames in this mode, and retains authenticated-route CSRF protection. Cookies work on direct HTTP and remain HttpOnly/SameSite. `TRUST_PROXY` is false by default.

## VPS installer

Supported: **Debian 12+ / Ubuntu 22.04+**, x86_64 or ARM64, systemd, root/sudo access and enough disk for members' storage. Run the manager from outside the target project directory; the installer installs Git and clones the project itself.

```sh
curl -fsSL https://raw.githubusercontent.com/JishnuTheGamer/jtg-cloud/jtg-studio/install.sh -o /root/jtg-cloud-manager.sh && bash /root/jtg-cloud-manager.sh
```

Choose **1** for a new installation, or **9** to repair an existing installation. Preview without installing: `bash /root/jtg-cloud-manager.sh --dry-run`.

Use the **raw.githubusercontent.com** link above. A GitHub `/blob/` link returns an HTML webpage; passing it to Bash causes an error such as `<!DOCTYPE html>` or `syntax error near unexpected token`. Do not clone a setup checkout into `/root/jtg-cloud` first; that directory is the managed installation target.

The installer clones into **`/root/jtg-cloud`**, installs requirements with `npm ci`, asks for owner details and starts the cloud on **6969**. It keeps an existing working Node.js 24+ installation; otherwise it installs the latest supported LTS with verified SHA-256 downloads and makes `node`/`npm` available globally. PM2 uses the standard **`npm install -g pm2`**, available as `pm2` from `/usr/local/bin`.

Run management commands from the **root account** (`sudo -i`). Source, owner setup, backups, the PM2 process and reboot startup use that same account and **`/root/.pm2`**. This removes the previous mismatch between root-owned source and an inaccessible service-user runtime. `.env` is mode 600; the project and stored data are private to root. Package/Git diagnostics go to `/var/log/jtg-cloud-install.log`; owner passwords are entered privately and never sent to this log.

The bold JTG Studio menu has **Restart cloud** as its primary service action, plus optional Stop, status, update, password reset, backup, preview, **Repair / migrate (9)** and **Uninstall (10)**. Restart also recreates a missing PM2 entry. Use `NO_COLOR=1` for plain output. A fresh installation refuses to overwrite an existing directory; choose Repair after an interrupted setup.

“Installation complete” appears only after startup and the expected cloud health/version succeed. Interrupted setup stays marked for repair; option 5 shows the current PM2 status.

Normal PM2 commands after installation:

```sh
sudo -i
cd /root/jtg-cloud
pm2 restart jtg-cloud --update-env
pm2 status
pm2 logs jtg-cloud --lines 50
```

Initial startup uses `pm2 start ecosystem.config.cjs --only jtg-cloud`, followed by `pm2 startup systemd -u root --hp /root` and `pm2 save`, as described in the [PM2 documentation](https://pm2.io/docs/runtime/guide/installation/).

## Repair an older or interrupted installation

Download the latest management script outside the installed project, then choose **9**:

```sh
sudo -i
curl -fL https://raw.githubusercontent.com/JishnuTheGamer/jtg-cloud/jtg-studio/install.sh -o /root/jtg-cloud-manager.sh
bash /root/jtg-cloud-manager.sh
```

Repair installs global PM2, fetches the current source before stopping the cloud, makes a consistent private backup, removes the old cloud process from the previous PM2 account, updates source and moves `/opt/jtg-cloud` to `/root/jtg-cloud`. It fixes ownership, configures direct port 6969, preserves the existing owner/files/key, and restores PM2 startup. A partial installation without an owner asks for owner details once. Tracked edits, divergent commits, two installation directories, missing encryption keys and storage outside the managed directory are refused for manual recovery. Both data and backups must be inside the project; absolute paths inside the old directory migrate along with it.

## Uninstall

Run the latest manager and choose **10**:

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/JishnuTheGamer/jtg-cloud/jtg-studio/install.sh)
```

Answer **Y** to delete, or **N/Enter** to cancel. Uninstall removes the cloud's PM2 entry, updates both saved process lists and **deletes the complete current and old project directories**, including accounts, uploads, encryption key, environment and backups inside them. It also cleans empty/partial leftovers without requiring `.git`, `package.json` or `.env`. Repeating uninstall is safe. After cleanup, the menu remains open: choose **1** for a fresh installation with a new owner and encryption key. Copy a backup outside the project first if you want to retain it.

Global Node.js/PM2 and other applications remain installed. An empty PM2 daemon is stopped; the shared root startup service remains available. The old `jtgcloud` startup is disabled/removed when its process list is empty. The unused `/home/jtgcloud`, `/opt/jtg-cloud-runtime`, `/root/jtg-cloud-manager.sh` and app-specific logs/PID files are cleaned too. A service home or old runtime potentially shared with other running apps is preserved with a message. Named removal targets are checked; symlinks are only unlinked and filesystem mounts must be unmounted first. Custom storage/backups outside the managed folders are not deleted.

## Roles and quotas

| Action | Owner | Admin | Member |
| --- | --- | --- | --- |
| Manage own private files | Yes | Yes | Yes |
| Create/manage members and their quotas | Yes | Yes | No |
| Appoint/manage administrators | Yes | No | No |
| Create a second owner or delete the owner | No | No | No |
| Change branding, registration or upload settings | Yes | No | No |
| View audit events | Yes | No | No |
| Read another account's files in the panel | No | No | No |

Registration creates members. The initial owner receives 50 GB and can change their allowance; new members receive 5 GB by default. Admins manage members only. Account suspension and permission changes revoke sessions. Users can change their password in account settings.

## Uploads and downloads

**File size** and **part size** are separate settings. The default optional file-size limit is **0 = unlimited**. The previous 512 MB/10 GB application caps are removed. An owner may explicitly set an optional cap later, or leave it at 0. Unlimited file size does not bypass account quota, disk capacity or the server's free-space margin.

The default part is **20 MB** (20 × 1,024² bytes), not a bandwidth speed cap. Set **Cloud settings → Upload part size (MB)** to 1–80. Each upload snapshots its chosen size and sends sequential encrypted parts. Changing the setting affects new transfers.

Pause preserves committed parts for up to 24 hours. To resume after reloading, choose the original unchanged file again and select Resume. Failed acknowledgements safely reuse the upload ID and saved part. Cancel removes unfinished parts and releases the reservation. Browser storage holds only resume metadata, never file contents or passwords.

Downloads stream to the browser without gathering the entire file in JavaScript memory. Byte ranges can resume interrupted downloads. New files authenticate only the requested encrypted parts; legacy files authenticate their whole ciphertext first, which can add startup latency. Quotas, ownership and trash state still apply.

## Updating

For an installation already using this updater:

```sh
sudo bash /root/jtg-cloud/update.sh
```

**Upgrading an older `/opt` installation or fixing a permission error:** use **Repair / migrate** above once. The old updater still targets the old service account; it cannot perform this migration.

The updater stops PM2, saves a consistent database/blob/key backup and a restricted copy of `.env`, fast-forwards source, migrates the previous network settings once to direct port 6969, installs requirements, runs checks and tests, restarts and checks health. User data, quotas and branding remain. The first v1.2 database startup sets the previous per-file cap to unlimited; subsequent restarts preserve explicitly chosen caps.

Tracked local changes and divergent Git history stop the update. A failure restores tracked source and the previous environment. If old source cannot read the storage format, the service remains stopped for backup recovery. Source rollback does not restore the database; retain the full pre-update backup. Before downgrading to v1.0, restore its matching complete backup because it cannot read segmented files.

Use one PM2 fork process: per-account upload locking and reservations assume one service instance. Node security updates are separate from application updates; keep the system LTS runtime current.

## Backups and account recovery

Use installer menu option 7, or stop the service and run:

```sh
pm2 stop jtg-cloud
node --env-file-if-exists=.env src/cli.mjs backup
pm2 restart jtg-cloud
```

Backups contain SQLite, encrypted blobs (including committed upload parts) and the encryption key. Copy them to a protected off-server location. Restore database, `blobs/` and `encryption.key` together into a fresh data directory with private permissions. Do not copy old WAL/SHM/lock files. Preserve `.env` separately. Losing the key makes stored files unreadable; the app refuses to invent a replacement key for an existing database.

Recover an account through installer menu option 6, or:

```sh
node --env-file-if-exists=.env src/cli.mjs reset-password
```

Recovery revokes existing sessions. Automation accepts JSON on stdin with `--stdin`; never put passwords in command arguments or committed files.

## Storage boundaries and validation

Files of any extension are private downloads; they are not executed or unzipped. Only signature-recognized raster images receive inline previews. Other types are attachments with `nosniff`. Store the private data directory outside any static web root.

Trash counts toward quota. Pending transfers reserve quota/disk capacity and release reservations on cancellation or expiry. Encryption is server-side storage encryption; someone controlling the host and its key can decrypt files. This release is not independently security audited or load tested. MFA, virus scanning, distributed storage, public sharing, SMTP verification and email recovery are not implemented.

Listings are limited to 2,000 items per view; search narrows larger collections. Storage labels use binary units: 1 GB = 1,024³ bytes. Audit metadata retains the latest 10,000 events, with the latest 200 visible to the owner.

```sh
npm run check
npm test
```

See [VALIDATION.md](VALIDATION.md) for completed checks and deployment limitations, and [release notes](RELEASE-NOTES.md) for upgrade requirements.

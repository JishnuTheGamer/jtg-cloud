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

Create the one owner account during terminal setup. There is no default password or web owner-creation endpoint. Passwords must have 12–128 characters. `npm run dev` restarts the service when source changes.

The service runs directly over HTTP. `APP_URL` is blank by default, so localhost and IP access work without a hostname setup. It checks the request's own origin and service port, rejects arbitrary DNS hostnames in this mode, and retains authenticated-route CSRF protection. Cookies work on direct HTTP and remain HttpOnly/SameSite. `TRUST_PROXY` is false by default.

## VPS installer

Supported: **Debian 12+ / Ubuntu 22.04+**, x86_64 or ARM64, systemd, root/sudo access and enough disk for members' storage. If Git is missing, install it with `sudo apt-get update` and `sudo apt-get install -y git`.

```sh
git clone https://github.com/JishnuTheGamer/jtg-cloud.git
cd jtg-cloud
bash install.sh --dry-run
sudo bash install.sh
```

The installer uses the repository URL automatically, installs the current supported Node.js LTS and PM2, clones into `/opt/jtg-cloud`, installs locked requirements, prepares the dedicated `jtgcloud` account, asks for owner details, prints localhost/IPv4 addresses and starts the service on **6969** with systemd reboot startup. Existing system Node installations are not overwritten. Node downloads are checked against the official SHA-256 checksum.

The installer asks for owner account information only. It configures the Node service directly; network hosting, DNS and certificates are not installed. Source is root-owned, `.env` is restricted and data/backups are private. Package/Git diagnostics go to `/var/log/jtg-cloud-install.log`; owner passwords are entered privately and never sent to this log.

The bold JTG Studio menu supports install, update, restart, stop, status, password reset, backup and installation preview. Use `NO_COLOR=1` for plain output. A fresh installation refuses to overwrite an existing application directory. If a step fails, inspect the log and repair the failed step without deleting user data.

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
sudo bash /opt/jtg-cloud/update.sh
```

**One-time upgrade from port 6696:** run the latest updater from the fetched source, so the previous updater does not keep checking the old port:

```sh
cd /opt/jtg-cloud
sudo git fetch origin
sudo git show origin/jtg-studio:update.sh | sudo bash
```

The updater stops PM2, saves a consistent database/blob/key backup and a restricted copy of `.env`, fast-forwards source, migrates the previous network settings once to direct port 6969, installs requirements, runs checks and tests, restarts and checks health. User data, quotas and branding remain. The first v1.2 database startup sets the previous per-file cap to unlimited; subsequent restarts preserve explicitly chosen caps.

Tracked local changes and divergent Git history stop the update. A failure restores tracked source and the previous environment. If old source cannot read the storage format, the service remains stopped for backup recovery. Source rollback does not restore the database; retain the full pre-update backup. Before downgrading to v1.0, restore its matching complete backup because it cannot read segmented files.

Use one PM2 fork process, not cluster mode: per-account upload locking and reservations assume one service instance. Node security updates are separate from application updates; keep the scoped LTS runtime current.

## Backups and account recovery

Use installer menu option 7, or stop the service and run:

```sh
pm2 stop jtg-cloud
node --env-file-if-exists=.env src/cli.mjs backup
pm2 start jtg-cloud
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

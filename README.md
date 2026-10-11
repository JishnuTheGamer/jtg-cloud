# JTG Cloud

Your files. Your server. A responsive, self-hosted cloud storage panel running on **Node.js 24+**, **SQLite**, and **port 6696**, with no third-party application dependencies.

## What works

- Email or username + password sign-in, registration, persistent sessions, and password changes.
- One protected **owner**, **administrators**, and **members**, enforced by the server.
- File and folder uploads, multiple files, drag and drop, nested folders, search, rename, move, starred items, image previews, and downloads.
- Trash, recursive restore, permanent deletion, and storage accounting that includes trash.
- Default **5 GB** for new accounts, adjustable per account; owner can change the new-account default or close registration.
- Owner settings for site name, tagline, logo, favicon, accent color, and upload limits.
- Administrator member management, owner-only audit log, suspension, and session revocation.
- AES-256-GCM encryption at rest, scrypt password hashing, hashed server-side session tokens, HttpOnly cookies, CSRF checks, request limits, and account-scoped file access.
- Interactive `install.sh`, backup and recovery commands, PM2 startup, optional Nginx + Let’s Encrypt setup, and `update.sh` with a pre-update backup and source rollback.
- Responsive desktop and mobile layouts, keyboard focus, reduced-motion support, and empty states based on real data.

**Google sign-in is a disabled “Coming soon” option.** Firebase/OAuth is intentionally not configured in this version. Email addresses are account identifiers; SMTP verification and emailed password recovery are not implemented. Forgot-password recovery is performed by the server operator through the CLI.

## Roles

| Action | Owner | Admin | Member |
| --- | --- | --- | --- |
| Manage own private files | Yes | Yes | Yes |
| Create/manage member accounts and quotas | Yes | Yes | No |
| Appoint, demote or manage administrators | Yes | No | No |
| Create another owner / delete the owner | No | No | No |
| Change branding, registration or default quota | Yes | No | No |
| View audit events | Yes | No | No |
| Read someone else’s files through the panel | No | No | No |

The installer creates the **one initial owner** in the VPS terminal. Registration always creates members. The database also enforces one owner; no web endpoint can create owners. The owner starts with 50 GB and can adjust their own allowance in Members; new members start with 5 GB. Admins can manage members only, including suspension, deletion and storage limits. Deleting a user permanently deletes their files, so the UI requires confirmation. Users can change their own password under their account menu.

## Local development

Install [Node.js LTS](https://nodejs.org/en/download) (24 or newer), then open a terminal in this folder:

```sh
npm ci
cp .env.example .env
npm run setup
npm start
```

On PowerShell use `Copy-Item .env.example .env`. On Windows, the project also works without `.env` using the defaults. Open **http://localhost:6696**. Enter the owner details during setup; there are no default passwords and no public owner setup route. An account password must be 12–128 characters. `npm run dev` restarts the app when source changes.

Run validation:

```sh
npm run check
npm test
```

The integration tests use temporary storage and verify authentication, CSRF, account isolation, encryption/downloads, quotas, concurrent uploads, folder cycles, trash/restore, role boundaries, suspension, password recovery, restarts and rate limits.

## Publish the source to your Git repository

This project was created inside `jtg-cloud/` to preserve the existing workspace app. Upload **the contents of this folder at the root of the new JTG Cloud repository**. Include the lockfile, scripts, `src/`, `public/`, and `tests/`. Do not upload `.env`, `data/`, `backups/`, or preview credentials. No GitHub URL is hardcoded; the installer asks for your public HTTPS Git URL.

## Automated VPS installation

Supported: **Debian 12+ / Ubuntu 22.04+**, x86_64 or ARM64, root/sudo access, a domain pointed at the VPS, and free disk space for users’ storage. A small private instance can start with 2 GB RAM; provision disk capacity for actual quotas. The app does not allocate quota-sized disk space in advance.

Clone the project or download and inspect `install.sh`, then run:

```sh
sudo bash install.sh
```

The menu provides install, update, restart, stop, status, account-password reset and backup. Installation:

1. Asks for the repository URL and HTTPS domain.
2. Installs Git, curl, Python and xz tools with apt.
3. Discovers the latest supported **Node.js LTS** from the official Node.js release index, downloads the correct architecture, verifies its SHA-256 checksum, and installs it under `/opt/jtg-cloud-runtime/`. Existing system Node installations are not overwritten.
4. Installs PM2, clones the app into `/opt/jtg-cloud`, and configures port **6696**.
5. Runs the app under a dedicated `jtgcloud` system account; source remains root-owned, `.env` is restricted and data directories are private.
6. Prompts privately for the owner account and password.
7. Optionally installs Nginx and obtains a Let’s Encrypt certificate. For this option, DNS must already resolve to the VPS and public ports 80/443 must be reachable. Existing Nginx site configurations are preserved.
8. Starts PM2, saves the process list, configures systemd reboot startup and checks health.

The app listens on **127.0.0.1:6696**. The public website uses HTTPS on **443**, with Nginx forwarding to 6696. This keeps the unencrypted app port private. If you choose an existing reverse proxy, configure it before opening the cloud. Production refuses an HTTP `APP_URL` and uses secure cookies.

The installer is intended for a new installation and stops rather than overwriting an existing directory. If installation fails, inspect the error, complete the failed configuration step manually and use the existing source/data. Do not delete `data/` to retry.

## Manual production deployment

```sh
git clone YOUR_REPOSITORY_URL jtg-cloud
cd jtg-cloud
npm ci --omit=dev --ignore-scripts
cp .env.example .env
# Edit .env before setup:
# NODE_ENV=production
# APP_URL=https://cloud.example.com
# HOST=127.0.0.1
# COOKIE_SECURE=true
# TRUST_PROXY=true  (only with a trusted proxy on loopback)
npm run setup
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Run the app as a dedicated unprivileged user, keep source read-only, and permit that user to write only `data/` and `backups/`. Follow the command printed by `pm2 startup` to enable restart after reboot. Use `deploy/nginx.conf.example` as the reverse-proxy configuration, substitute your domain, then configure HTTPS with your certificate provider.

`TRUST_PROXY=true` trusts `X-Forwarded-For` for rate limiting. Only use it when direct clients cannot reach port 6696, and have the proxy **replace** that header with the actual client address. The supplied Nginx configuration does this. The service must run as **one PM2 fork process**, not cluster mode; storage locks and per-account upload reservations assume one instance.

## Updating

For a managed installation:

```sh
sudo bash /opt/jtg-cloud/update.sh
```

The updater refuses tracked local modifications and non-fast-forward history. It stops PM2, makes a consistent backup of SQLite + encrypted blobs + key, fast-forwards the source, installs locked dependencies, runs syntax and integration tests, restarts and checks health. On failure it restores the previous tracked source and attempts a restart. `.env`, data and backups are ignored and preserved. A future database migration may require restoring the backup before running older source; application rollback alone is not a database rollback. This first version creates its schema idempotently and has no destructive migrations.

For a manual installation, stop your PM2 process, run the backup command below, update the source with `git pull --ff-only`, run `npm ci`, `npm run check` and `npm test`, then restart PM2. Review release notes before migrations.

Node security updates are separate from application updates. The installer chooses the current LTS during initial installation. Periodically update the scoped runtime from official releases, restart PM2 and its startup service with the new executable, and verify health. Runtime and certificate renewal need normal server maintenance.

## Backups and account recovery

Stop the app before a backup (the CLI refuses a live backup):

```sh
pm2 stop jtg-cloud
node --env-file-if-exists=.env src/cli.mjs backup
pm2 start jtg-cloud
```

For managed installs use menu option 7; it runs the command as `jtgcloud` and restarts automatically. Backups are saved under `backups/jtg-cloud-TIMESTAMP-ID/` (or the directory configured with `BACKUP_DIR`). Copy them to a protected off-server location. Keep enough space for the database and all encrypted files.

To restore: stop PM2, keep a copy of the current data, and restore **`cloud.sqlite`, `blobs/`, and `encryption.key` together** into a fresh `data/` directory. Do not carry old `cloud.sqlite-wal`, `cloud.sqlite-shm`, or `instance.lock` into that directory. Set its owner to the service user and permissions to 700 for directories / 600 for key and database, then restart. Preserve `.env` separately. Losing the encryption key makes stored files unreadable; the server refuses to invent a new key for an existing database.

Reset a forgotten password:

```sh
node --env-file-if-exists=.env src/cli.mjs reset-password
```

For managed installs use menu option 6. All the account’s sessions are revoked. Noninteractive setup/reset accepts a JSON object on stdin with `--stdin`; pass secrets through a secure input channel, never command-line arguments, logs or committed files.

## Storage and security boundaries

- The private `data/` directory contains SQLite, encrypted blobs, upload staging and the encryption key. Store it on a protected persistent disk. Do not serve it using Nginx static aliases.
- Files can have arbitrary extensions, including archives and scripts, because this is private general-purpose storage. They are never executed, unzipped or served as active HTML. Only signature-recognized PNG/JPEG/GIF/WebP files are eligible for same-origin raster preview. Everything else is downloaded as an attachment with `nosniff`.
- Quota includes files in trash. Uploads are streamed to encrypted staging files, limited per file and by remaining account quota. Concurrent uploads for one account are refused to prevent overcommit. The server also reserves disk space and retains a free-space margin. Configure reverse-proxy upload timeouts for large files.
- Public uploads are not offered. There is no public sharing endpoint. Administrators cannot browse another member’s files through the panel.
- Encryption is **server-side encryption at rest**, not end-to-end encryption. Anyone controlling the server or its key can decrypt files. It does not protect against a compromised host. Maintain OS security, TLS, access controls and off-server backups.
- This is a first functional release, not an independently audited equivalent of Google Drive. There is no MFA, antivirus scanning, resumable uploads, distributed storage, public sharing, email verification or automated SMTP password recovery. Integrate those separately if your deployment requires them.
- Audit events cover login, account changes, file changes and settings; the latest 10,000 are retained, with 200 visible in the owner panel. Audit metadata is not a tamper-proof external log.
- Listings are capped at 2,000 items; search narrows larger collections. Large multi-user instances need load testing and a storage/database architecture designed for their scale. Default upload limit is 512 MB, configurable up to 10 GB. The app labels binary units as GB/MB (1 GB = 1,024³ bytes).

The implementation follows relevant [OWASP file upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html): authorized handlers, generated storage names, bounded sizes, CSRF protection, and storage outside the webroot. General-purpose private downloads require additional deployment controls if you allow untrusted public registrations.

## Project layout

```text
src/           HTTP API, SQLite schema, encryption/auth, owner CLI
public/        Responsive UI, styles and SVG brand mark
tests/         Integration and security regression tests
scripts/       Syntax checks
deploy/        Reverse-proxy example
install.sh     Interactive VPS / PM2 / HTTPS installer
update.sh      Backup, tested fast-forward update and source rollback
```

No application packages are downloaded at runtime. SQLite is Node’s built-in `node:sqlite` module. Some Node versions emit an experimental-module warning; this does not indicate a failed startup. Keep the supported LTS runtime current.

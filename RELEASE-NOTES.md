# JTG Cloud 1.3.1

Uninstall now uses **Y/N** confirmation and cleans both current and legacy project directories, including empty/partial leftovers without source metadata. Repeated uninstall succeeds, and the menu stays open for a fresh install. Unused old service-home/runtime artifacts, the downloaded manager and cloud-specific logs/PID files are cleaned; other running applications and shared dependencies are protected. Mounted filesystems are refused before removal.

Regression checks cover uninstall twice, cancellation, failed deletion and cleanup followed by a real new SQLite owner and encryption key. Existing accounts, keys and backups inside the removed project are not reused by the new install.

Minimum password length is now **8 characters** across owner setup, registration, account creation, changes and terminal recovery, with matching web form hints. Eight digits are accepted; existing password hashes continue to work.

The HTTP service now starts when PM2's Linux fork wrapper imports the ESM entrypoint. Previously PM2 could display “online” without an HTTP listener because the direct-launch check failed. PM2 configuration explicitly reads the managed `.env`, replacing stale port/origin/storage values. Health requests bypass proxies, have timeouts, and display the response/server logs on failure.

## JTG Cloud 1.3.0

The VPS installer now uses **`/root/jtg-cloud`**, standard **`npm install -g pm2`** and root's **`/root/.pm2`**. Setup, storage ownership, process management and reboot startup use the same account, resolving the previous source/runtime permission mismatch. Restart recreates a missing process entry; Stop remains optional.

Menu **9** repairs interrupted installations and migrates the previous `/opt` installation, retaining a consistent database/blob/key/environment backup and the existing owner. Menu **10** uninstalls the cloud after a typed confirmation, deleting its entire managed directory and removing its PM2 process from both the current and previous account. Shared Node.js/PM2 and other apps are preserved. See README for the one-time repair command and retained legacy runtime artifacts.

The updater now uses the same global root PM2 setup. Port 6969, default unlimited file size, configurable 20 MB parts, encrypted downloads and themes remain available.

## JTG Cloud 1.2.0

The service now runs directly on **port 6969**, with localhost and automatically available IPv4 addresses. Installation asks for owner credentials and configures the Node/PM2 service. Website hostname, DNS and certificate setup are removed.

Uploads have **no per-file size cap by default**. The optional file-size setting is **0 = unlimited**, while account quota and server disk capacity still apply. Existing per-file caps migrate to unlimited once; later explicit owner settings are preserved. Uploads continue to use **20 MB parts by default**, owner-configurable from 1–80 MB, with retries and pause/resume. Downloads retain authenticated byte ranges and legacy-file support.

The updater preserves a restricted copy of the previous environment and migrates the old network configuration once to direct port 6969. Operators upgrading from the previous port should follow the one-time updater command in README. The source is public on branch `jtg-studio`.

## JTG Cloud 1.1.0

This release adds premium light/dark/system themes and sends browser uploads in configurable 20 MB chunks, helping large files stay below proxy request-size limits. Uploads support progress, retries, pause, cancellation and resuming within 24 hours. New chunked files support authenticated HTTP range downloads.

The owner can set the chunk size from 1 to 80 MB independently of the maximum full-file size. Existing accounts, settings and legacy encrypted files are preserved. The repository remains private on branch `jtg-studio`.

Before upgrading, stop the application and take a consistent backup of the database, encrypted blobs and encryption key. The managed updater does this automatically. New chunked files use a storage format that version 1.0.0 cannot read. **Before downgrading to 1.0.0, restore the matching complete pre-upgrade backup**; running old source against new data can remove unfamiliar encrypted parts during orphan cleanup. A source-only rollback is insufficient after storing files in the new format.

Live VPS service setup still needs deployment verification. Transfers remain subject to resource capacity and network availability.

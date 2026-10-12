# JTG Cloud 1.2.0

The service now runs directly on **port 6969**, with localhost and automatically available IPv4 addresses. Installation asks for owner credentials and configures the Node/PM2 service. Website hostname, DNS and certificate setup are removed.

Uploads have **no per-file size cap by default**. The optional file-size setting is **0 = unlimited**, while account quota and server disk capacity still apply. Existing per-file caps migrate to unlimited once; later explicit owner settings are preserved. Uploads continue to use **20 MB parts by default**, owner-configurable from 1–80 MB, with retries and pause/resume. Downloads retain authenticated byte ranges and legacy-file support.

The updater preserves a restricted copy of the previous environment and migrates the old network configuration once to direct port 6969. Operators upgrading from the previous port should follow the one-time updater command in README. The source is public on branch `jtg-studio`.

## JTG Cloud 1.1.0

This release adds premium light/dark/system themes and sends browser uploads in configurable 20 MB chunks, helping large files stay below proxy request-size limits. Uploads support progress, retries, pause, cancellation and resuming within 24 hours. New chunked files support authenticated HTTP range downloads.

The owner can set the chunk size from 1 to 80 MB independently of the maximum full-file size. Existing accounts, settings and legacy encrypted files are preserved. The repository remains private on branch `jtg-studio`.

Before upgrading, stop the application and take a consistent backup of the database, encrypted blobs and encryption key. The managed updater does this automatically. New chunked files use a storage format that version 1.0.0 cannot read. **Before downgrading to 1.0.0, restore the matching complete pre-upgrade backup**; running old source against new data can remove unfamiliar encrypted parts during orphan cleanup. A source-only rollback is insufficient after storing files in the new format.

Live VPS service setup still needs deployment verification. Transfers remain subject to resource capacity and network availability.

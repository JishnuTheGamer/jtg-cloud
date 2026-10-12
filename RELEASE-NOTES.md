# JTG Cloud 1.1.0

This release adds premium light/dark/system themes and sends browser uploads in configurable 20 MB chunks, helping large files stay below proxy request-size limits. Uploads support progress, retries, pause, cancellation and resuming within 24 hours. New chunked files support authenticated HTTP range downloads.

The owner can set the chunk size from 1 to 80 MB independently of the maximum full-file size. Existing accounts, settings and legacy encrypted files are preserved. The repository remains private on branch `jtg-studio`.

Before upgrading, stop the application and take a consistent backup of the database, encrypted blobs and encryption key. The managed updater does this automatically. New chunked files use a storage format that version 1.0.0 cannot read. **Before downgrading to 1.0.0, restore the matching complete pre-upgrade backup**; running old source against new data can remove unfamiliar encrypted parts during orphan cleanup. A source-only rollback is insufficient after storing files in the new format.

Real Cloudflare Tunnel, certificate issuance and VPS service setup still need deployment verification. Chunking addresses request size; it cannot guarantee uninterrupted transfer through every proxy or network.

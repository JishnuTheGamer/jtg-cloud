# Validation of JTG Cloud 1.2.0

Verified locally on Windows with Node.js 24.19.0:

- 54 passing checks across the application, transfer, runtime and installer suites, including parent tests; no skipped checks.
- Authentication, cookie flags, CSRF, cross-origin protection and rate limits.
- Single-owner setup, owner protection, admin/member role boundaries and session revocation.
- Encrypted upload/decrypted download, private account isolation and blocked path traversal.
- Quotas, concurrent uploads, folder-cycle prevention, recursive trash/restore and permanent cleanup.
- Raster previews and attachment-only serving for active content such as SVG.
- Password recovery and session invalidation.
- Persistent sessions/files across restart, consistent offline backup and successful restoration.
- Missing-key refusal and direct HTTP production configuration.
- JavaScript syntax checks and Bash syntax checks for both shell scripts.
- Installer menu, bold/color and plain output, and noninteractive preview checked in Git Bash.
- Preview refuses to invoke mocked installation/network commands.
- Private-checkout cloning verified with a local Git fixture: committed source only, no environment/data/untracked files or credential configuration copied, correct branch and GitHub origin.
- Failed repository authentication stops before project setup.
- Updater follows a renamed remote default branch; divergent history is refused before renaming the local branch.
- Default service port 6969, all available IPv4 interfaces and localhost access without a website hostname.
- Actual browser login and a 115 MiB + 137 byte upload through the computer's IPv4 address on port 6969.
- The direct-IP file used five 20 MiB parts and one 15 MiB + 137 byte final part; complete download SHA-256 and a range crossing the part boundary passed.
- Arbitrary DNS Host headers, incorrect ports, cross-origin writes and missing CSRF tokens remain rejected in direct-IP mode.
- New default file-size limit 0 (unlimited), legacy cap migration, unchanged account quotas/data/key and optional explicit caps.
- Upload metadata exceeding the previous 512 MiB and 10 GiB caps accepted when account quota and disk capacity allow.
- Portable browser resume-record lookup on HTTP IP pages without SubtleCrypto.
- Installer preview contains port 6969 and no DNS/certificate/network-hosting setup.
- Updater migrates the old network settings once and preserves unrelated environment fields.
- Rollback refuses to start version 1.0 against new chunked storage, including pending parts.
- Chunk setting defaults to 20 MiB and accepts owner-only integer settings from 1–80 MiB.
- Encrypted sequential chunk assembly, exact byte lengths, safe replay and idempotent creation/completion after lost acknowledgements.
- Cancellation, expiry, suspended/deleted accounts, filename/folder reservations and concurrent quota/disk reservations.
- Paused uploads survive restart; missing parts invalidate the session and release its reservation.
- Authenticated GET/HEAD byte ranges, including cross-part, open-ended and suffix requests, and legacy encrypted files.
- Tampered encrypted parts fail authentication before requested plaintext is released.
- Offline backup and restore of encrypted segmented files and key.
- Browser checks for owner sign-in, folder creation, file upload and nested folder upload.
- Browser upload of a 115 MiB + 137 byte fixture used six requests: five 20 MiB parts and one 15 MiB + 137 byte part.
- Native browser download of that fixture matched the original SHA-256 hash.
- Actual browser pause after one committed part, reload/reselect and explicit resume completed successfully; cancellation discarded pending parts.
- Light/dark preference persists across reload. Owner chunk setting changed 20 → 4 → 20 MB and persisted after reload.
- Responsive dashboard and owner settings at desktop (1440px) and mobile (390px); no horizontal overflow observed.
- No new browser console errors or warnings during the final theme/settings verification.

Not verified on a live VPS: apt installation, systemd reboot startup and PM2 updates/rollback. Runtime and data-migration checks used isolated local storage; the checks above do not constitute a load test or independent security audit. See README for operating limits and deployment requirements.

# Validation of the first release

Verified locally on Windows with Node.js 24.19.0:

- 28 passing checks across the integration and installer suites, including the parent test.
- Authentication, cookie flags, CSRF, cross-origin protection and rate limits.
- Single-owner setup, owner protection, admin/member role boundaries and session revocation.
- Encrypted upload/decrypted download, private account isolation and blocked path traversal.
- Quotas, concurrent uploads, folder-cycle prevention, recursive trash/restore and permanent cleanup.
- Raster previews and attachment-only serving for active content such as SVG.
- Password recovery and session invalidation.
- Persistent sessions/files across restart, consistent offline backup and successful restoration.
- Missing-key refusal and HTTPS-only production configuration.
- JavaScript syntax checks and Bash syntax checks for both shell scripts.
- Installer menu, bold/color and plain output, and noninteractive preview checked in Git Bash.
- Preview refuses to invoke mocked installation/network commands.
- Private-checkout cloning verified with a local Git fixture: committed source only, no environment/data/untracked files or credential configuration copied, correct branch and GitHub origin.
- Failed repository authentication stops before project setup.
- Updater follows a renamed remote default branch; divergent history is refused before renaming the local branch.
- Browser checks for owner sign-in, folder creation, file upload and nested folder upload.
- Responsive dashboard and owner settings at desktop (1440px) and mobile (390px); no horizontal overflow observed.
- No browser console errors or warnings during these checks.

Not verified on a live VPS: apt package installation, certificate issuance/renewal, Nginx/systemd startup and PM2 updates/rollback. These require the target Linux server, DNS and private repository access. The project is not independently security audited or load tested. See README for operating limits and deployment requirements.

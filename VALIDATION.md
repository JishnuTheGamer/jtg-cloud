# Validation of the first release

Verified locally on Windows with Node.js 24.19.0:

- 23 passing checks in the integration suite, including the parent test.
- Authentication, cookie flags, CSRF, cross-origin protection and rate limits.
- Single-owner setup, owner protection, admin/member role boundaries and session revocation.
- Encrypted upload/decrypted download, private account isolation and blocked path traversal.
- Quotas, concurrent uploads, folder-cycle prevention, recursive trash/restore and permanent cleanup.
- Raster previews and attachment-only serving for active content such as SVG.
- Password recovery and session invalidation.
- Persistent sessions/files across restart, consistent offline backup and successful restoration.
- Missing-key refusal and HTTPS-only production configuration.
- JavaScript syntax checks and Bash syntax checks for both shell scripts.
- Installer menu opens and exits in Git Bash.
- Browser checks for owner sign-in, folder creation, file upload and nested folder upload.
- Responsive dashboard and owner settings at desktop (1440px) and mobile (390px); no horizontal overflow observed.
- No browser console errors or warnings during these checks.

Not verified on a live VPS: apt package installation, certificate issuance/renewal, Nginx/systemd startup and PM2 updates/rollback. These require the target Linux server, DNS and a real repository URL. The project is not independently security audited or load tested. See README for operating limits and deployment requirements.

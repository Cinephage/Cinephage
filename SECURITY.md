# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

As Cinephage is in active development, security updates are applied to the current stable release. Users are encouraged to keep their installations up to date.

## Reporting a Vulnerability

If you find a security issue, please report it responsibly.

### How to Report

1. **Do not** open a public GitHub issue for security vulnerabilities
2. Email security concerns to the project maintainers (create a private security advisory on GitHub)
3. Use GitHub's private vulnerability reporting feature if available

### What to Include

When reporting a vulnerability, please include:

- A clear description of the vulnerability
- Steps to reproduce the issue
- Potential impact assessment
- Any suggested fixes (optional)
- Your contact information for follow-up questions

### Response Timeline

- **Initial Response**: Within 48 hours of receiving your report
- **Status Update**: Within 7 days with an assessment of the vulnerability
- **Resolution**: Depends on severity and complexity, but we aim to address critical issues within 14 days

### After Reporting

- We will acknowledge receipt of your report
- We will investigate and validate the vulnerability
- We will work on a fix and coordinate disclosure timing with you
- We will credit you in the security advisory (unless you prefer to remain anonymous)

## Security Best Practices

### Network Security

Cinephage is designed for use on trusted local networks. When exposing the application to external networks:

1. **Use a Reverse Proxy**
   - Deploy nginx, Caddy, or Traefik in front of Cinephage
   - Configure SSL/TLS with valid certificates
   - Enable HTTPS-only access

2. **Configure Trusted Origins**
   - Set the `ORIGIN` environment variable to your access URL
   - Example: `ORIGIN=https://cinephage.example.com`
   - Set `BETTER_AUTH_URL` to the same public URL for auth callbacks and redirects
   - When the instance is NOT behind a reverse proxy, set
     `BETTER_AUTH_TRUST_FORWARDED_ORIGINS=false` so a caller cannot nominate
     its own host as trusted via `X-Forwarded-Host`
   - Narrow `BETTER_AUTH_TRUSTED_ORIGINS` to the exact origins you use

3. **Accounts and Roles**
   - The first account created by the setup wizard is the administrator
   - Admins can create additional accounts; non-admin accounts are confined
     to the read-only library/discover/calendar surfaces plus their own
     preferences, sessions, notifications, and media requests
   - Consider VPN access for remote usage

### Application Security

1. **Keep Updated**
   - Regularly update to the current stable release (`latest`) or a newer stable `vX.Y.Z`
   - Monitor the repository for security advisories

2. **Environment Variables**
   - Never commit `.env` files to version control
   - Use appropriate file permissions (600 or 640)
   - Rotate credentials if compromised

3. **API Keys**
   - Store API keys securely
   - Use separate API keys for production and development
   - Revoke or regenerate unused or compromised keys immediately
   - Streaming keys are embedded in `.strm` files and playlist/stream URLs,
     so treat media directories and reverse-proxy logs as credential-adjacent;
     reserve the main API key for automation that needs full API access

4. **File System**
   - Configure appropriate permissions on media directories
   - Limit write access to necessary directories only
   - Review root folder configurations periodically

### Download Client Security

1. **qBittorrent**
   - Use strong passwords for WebUI access
   - Enable HTTPS for qBittorrent WebUI if accessing remotely
   - Consider binding to localhost and using a VPN

2. **Torrent Traffic**
   - Use a VPN for torrent traffic where appropriate
   - Configure your torrent client's privacy settings

## Known Security Considerations

### Authentication and Authorization

Cinephage ships with built-in username/password authentication (Better Auth)
and role-based access:

- The first account created by the setup wizard is the administrator; only
  admins can create further accounts, and the last admin cannot be demoted
  or deleted
- Non-admin accounts are confined to read-only shared surfaces plus their own
  preferences, sessions, notifications, and media requests; admin-only pages
  and API routes return 403
- Sessions are database-backed and revocable; banning an account revokes its
  sessions and disables its API keys
- API access uses per-account keys: a "main" key has full API access, while a
  "streaming" key only authenticates Live TV and streaming endpoints

**Mitigation**: keep `BETTER_AUTH_SECRET` secret (it signs sessions and
encrypts stored API-key material), rotate credentials if the environment or
database was ever exposed, and still restrict network access — the app is
designed for trusted networks.

### Stored Credentials

Integration credentials (indexers, download clients, subtitle providers,
Live TV portals, media servers) and metadata API keys (TMDB/TVDB) are stored
in the SQLite database **encrypted at rest** (schema 161+), and the database
also holds password hashes and session rows. Encryption details:

- AES-256-GCM with per-value random nonces, keys derived via HKDF-SHA256 from
  a master key, and each ciphertext bound to its owning record — relocated
  ciphertexts fail to decrypt
- Key custody: `ENCRYPTION_MASTER_KEY` (or `ENCRYPTION_MASTER_KEY_FILE` for
  Docker secrets) when set; otherwise derived from `BETTER_AUTH_SECRET`
- Key rotation: set the new master key plus `ENCRYPTION_PREVIOUS_KEYS` (old
  secrets), run the `rotate-credentials` task in Settings → Tasks to
  re-encrypt everything, then remove the fallback variable
- Configuration backups deliberately carry credentials in plaintext so they
  restore onto instances with different master keys — protect backup files
  accordingly (the optional backup passphrase encrypts the whole payload)
- A wrong/rotated-away master key fails closed: affected credentials are
  dropped and must be re-entered

Ensure:

- Restrictive file permissions on `data/cinephage.db`, its `-wal`/`-shm`
  companions, `data/logs/`, and the `.env` holding `BETTER_AUTH_SECRET`
  (600/640)
- Backups are stored securely
- The database is not exposed via web server misconfiguration or shared mounts
- Rotate stored credentials if the database or a backup was ever exposed

### Logging

Log files may contain:

- Search queries
- Downloaded file names
- Error messages with paths

**Mitigation**: Review log retention policies and secure log directory access.

## Security Updates

Security updates will be announced through:

- GitHub Security Advisories
- Release notes in CHANGELOG.md
- Repository releases

## Responsible Disclosure

If you report responsibly:

- We'll work with you in good faith
- You'll get credit (unless you want to stay anonymous)
- No legal action against good-faith researchers
- We'll coordinate disclosure timing with you

For security issues, use GitHub's private vulnerability reporting.

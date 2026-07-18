# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Report privately via one of:

- GitHub → **Security** tab → **Report a vulnerability** (private advisory), or
- Email **chetanmarathe1000@gmail.com** with subject `SECURITY: <summary>`.

Please include: affected version/commit, reproduction steps, impact, and any PoC.

## Response targets

| Stage                  | Target                                                |
| ---------------------- | ----------------------------------------------------- |
| Acknowledgement        | within 3 business days                                |
| Triage + severity      | within 7 days                                         |
| Fix or mitigation plan | within 90 days (sooner for actively exploited issues) |

We will credit reporters unless anonymity is requested.

## Scope

This project handles two sensitive credential classes:

- **Virtual keys** (`rk_live_…`) — inbound identity; SHA-256 hashed at rest, never forwarded upstream.
- **Provider credentials** (`sk-…`) — outbound authority; AES-256-GCM envelope-encrypted, decrypted only in worker memory at send time, never logged or echoed.

Reports involving credential leakage, cross-tenant data access (RLS bypass), or key exposure are treated as **critical**.

## Supported versions

Pre-1.0: only the latest tagged release receives security fixes.

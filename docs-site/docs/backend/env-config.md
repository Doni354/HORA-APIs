---
id: env-config
sidebar_position: 3
title: Environment Variables
---

# Environment Variables

Semua config sensitif disimpan di `functions/.env`. **Jangan commit file ini ke git.**

---

## Daftar Variables

### Firebase & Google

| Variable | Keterangan |
|---|---|
| `JWT_SECRET` | Secret key untuk sign/verify JWT token |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path ke `FirebaseServiceKey.json` |

### Google Play API

| Variable | Keterangan |
|---|---|
| `GOOGLE_API_KEY_PATH` | Path ke `GoogleApiKey.json` — untuk Google Play Developer API |
| `GOOGLE_PLAY_PACKAGE_NAME` | Bundle ID app Android, e.g. `com.vorce.app` |

### Apple App Store

| Variable | Keterangan |
|---|---|
| `APPLE_KEY_ID` | Key ID dari App Store Connect (DFA7JV6XTH) |
| `APPLE_ISSUER_ID` | Issuer ID dari App Store Connect |
| `APPLE_PRIVATE_KEY_PATH` | Path ke `.p8` file (`SubscriptionKey_DFA7JV6XTH.p8`) |
| `APPLE_BUNDLE_ID` | Bundle ID app iOS, e.g. `com.vorce.app` |

### Cloudflare R2

| Variable | Keterangan |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare Account ID |
| `R2_ACCESS_KEY_ID` | R2 Access Key |
| `R2_SECRET_ACCESS_KEY` | R2 Secret Key |
| `R2_BUCKET_NAME` | Nama bucket R2 |
| `R2_PUBLIC_URL` | Base URL publik R2, e.g. `https://cdn.vorce.id` |

### Email (Hostinger SMTP)

| Variable | Keterangan |
|---|---|
| `SMTP_HOST` | `smtp.hostinger.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | `cs@vorce.id` |
| `SMTP_PASS` | Password akun email |

---

## Template `.env`

```bash
# JWT
JWT_SECRET=your-super-secret-jwt-key

# Google Play
GOOGLE_PLAY_PACKAGE_NAME=com.vorce.app

# Apple
APPLE_KEY_ID=DFA7JV6XTH
APPLE_ISSUER_ID=your-issuer-id
APPLE_BUNDLE_ID=com.vorce.app

# Cloudflare R2
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
R2_BUCKET_NAME=vorce-storage
R2_PUBLIC_URL=https://cdn.vorce.id

# SMTP
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_USER=cs@vorce.id
SMTP_PASS=your-email-password
```

:::caution
File `.env` sudah ada di `.gitignore`. **Jangan pernah** commit credentials ke repository.
:::

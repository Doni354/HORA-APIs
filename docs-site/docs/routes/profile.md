---
id: profile
sidebar_position: 7
title: Profile Management
---

# Route — `profile.js`

:::note Work in Progress
Dokumentasi lengkap sedang disiapkan.
:::

## Endpoints
- `GET /api/profile` — Ambil profil user
- `PUT /api/profile` — Update profil
- `PUT /api/profile/photo` — Upload foto profil ke R2
- `DELETE /api/profile/photo` — Hapus foto profil
- `POST /api/profile/delete-account` — Request delete akun (set pending_deletion + 90 hari)

## Terkait
- [Account Cleanup Scheduler](../scheduler/scheduler)
- [Upload File Helper](../helper/uploadFile)

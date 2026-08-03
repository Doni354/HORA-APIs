---
id: login
sidebar_position: 6
title: Login & Auth
---

# Route — `login.js`

:::note Work in Progress
Dokumentasi lengkap sedang disiapkan. File ini adalah salah satu route terbesar (~46KB).
:::

## Endpoints Utama
- `POST /api/login` — Login user
- `POST /api/login/register` — Registrasi user baru
- `POST /api/login/register-company` — Registrasi company baru
- `POST /api/login/forgot-password` — Request reset password
- `POST /api/login/reset-password` — Reset password dengan token
- `POST /api/login/refresh-token` — Refresh JWT

## Terkait
- [JWT Middleware](../backend/middleware)
- [Email Helper](../helper/emailHelper)

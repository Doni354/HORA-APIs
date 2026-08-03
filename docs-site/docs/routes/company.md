---
id: company
sidebar_position: 11
title: Company & Device Management
---

# Route — `company.js`

:::note Work in Progress
Dokumentasi lengkap sedang disiapkan. File ini adalah salah satu route terbesar (~41KB).
:::

## Endpoints Utama
- `GET /api/company` — Info company
- `PUT /api/company` — Update data company
- `POST /api/company/invite` — Undang karyawan
- `DELETE /api/company/karyawan/:email` — Keluarkan karyawan
- `GET /api/company/devices` — List device terdaftar
- `DELETE /api/company/devices/:deviceId` — Hapus device binding
- `PUT /api/company/device-lock` — Toggle device lock

## Terkait
- [JWT Middleware — Device Lock](../backend/middleware)
- [Email Helper](../helper/emailHelper)

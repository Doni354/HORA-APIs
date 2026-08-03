---
id: inbox
sidebar_position: 10
title: Inbox & Notifikasi
---

# Route — `inbox.js`

:::note Work in Progress
Dokumentasi lengkap sedang disiapkan. File ini adalah salah satu route terbesar (~45KB).
:::

## Endpoints Utama
- `GET /api/inbox` — Ambil semua pesan inbox
- `PUT /api/inbox/:id/read` — Tandai pesan sebagai dibaca
- `DELETE /api/inbox/:id` — Hapus pesan
- `GET /api/inbox/unread-count` — Jumlah pesan belum dibaca

## Terkait
- [Push Notifications (FCM)](../features/notifications)

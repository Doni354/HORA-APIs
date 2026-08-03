---
id: berkas
sidebar_position: 8
title: Berkas (File Upload)
---

# Route — `berkas.js`

:::note Work in Progress
Dokumentasi lengkap sedang disiapkan.
:::

## Endpoints
- `POST /api/berkas/presign` — Generate presigned URL untuk upload langsung ke R2
- `POST /api/berkas/confirm-upload` — Konfirmasi upload selesai, simpan metadata
- `GET /api/berkas` — List berkas karyawan
- `DELETE /api/berkas/:id` — Hapus berkas

## Konsep Presigned Upload
Flutter upload langsung ke R2 menggunakan presigned URL (tanpa lewat backend), lalu konfirmasi ke `/confirm-upload`. Ini mengurangi beban backend dan mempercepat upload.

## Terkait
- [Storage — Cloudflare R2](../features/storage)
- [Upload File Helper](../helper/uploadFile)
- [Orphan Upload Cleanup](../scheduler/scheduler)

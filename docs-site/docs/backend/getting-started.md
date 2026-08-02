---
id: getting-started
sidebar_position: 1
title: Getting Started & Deployment
---

# Getting Started & Deployment

## Prerequisites

| Tool | Version | Keterangan |
|---|---|---|
| Node.js | 22.x | Runtime backend & docs build |
| Firebase CLI | latest | Deploy functions + hosting |
| npm | 10.x+ | Package manager |

Install Firebase CLI jika belum:
```bash
npm install -g firebase-tools
firebase login
```

---

## Setup Local

```bash
# 1. Clone repo
git clone <repo-url>
cd HORA-APIs   # nama folder repo (project: Vorce)

# 2. Install dependencies backend
cd functions
npm install
cd ..

# 3. Install dependencies docs
npm install --prefix docs-site
```

Buat file `.env` di folder `functions/`:
```bash
cp functions/.env.example functions/.env
# lalu isi value-nya (lihat section Environment Variables)
```

---

## Menjalankan Lokal

### Backend (Firebase Emulator)
```bash
firebase emulators:start
# API tersedia di: http://localhost:5001/hora-7394b/asia-southeast2/api
```

### Docs (Preview)
```bash
npm run docs:dev
# Buka: http://localhost:3000/doc/
```

---

## Deploy Backend (Cloud Functions)

```bash
firebase deploy --only functions
```

Output sukses:
```
✔ functions[api(asia-southeast2)] Successful update operation.
Function URL: https://api-y4ntpb3uvq-et.a.run.app
```

---

## Deploy Dokumentasi (Firebase Hosting)

### Langkah 1 — Build docs

```bash
npm run docs:build
```

Script ini otomatis:
1. Build Docusaurus → `docs-site/build/`
2. Hapus `public/doc/` lama
3. Copy build ke `public/doc/`

### Langkah 2 — Deploy hosting

```bash
firebase deploy --only hosting
```

### Langkah 3 — Verifikasi

Buka: `https://hora-7394b.web.app/doc/`

---

## Deploy Semua Sekaligus

```bash
npm run docs:build && firebase deploy
```

---

## File Penting

| File | Fungsi |
|---|---|
| `functions/.env` | Environment variables (JWT secret, API keys, dll) |
| `firebase.json` | Firebase config (hosting, functions, emulator) |
| `.firebaserc` | Project ID Firebase |
| `scripts/build-docs.js` | Script build + copy docs |
| `AI_Walkthrough.md` | SOP workflow pengembangan |

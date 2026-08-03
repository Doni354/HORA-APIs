---
id: subscriptionService
sidebar_position: 6
title: Subscription Service (Shared Utils)
---

# Helper — `subscriptionService.js`

## Tujuan

Kumpulan fungsi utility yang dipakai bersama oleh semua komponen subscription. Dibuat agar tidak ada duplikasi logic antar `googlePlayService`, `appleSubscriptionService`, dan `rtdn.js`.

## Exports

| Export | Signature | Keterangan |
|---|---|---|
| `resolveBenefits(productId, basePlanId)` | → benefit object \| null | Map product ID + billing period ke storage/devices benefit |
| `mapSubscriptionState(googleState)` | → status string | Konversi Google Play state ke status internal |
| `isActiveState(status)` | → boolean | Cek apakah status dianggap aktif (termasuk grace_period) |
| `recalculateLimits(companyId)` | async → void | Hitung ulang maxStorage + max_devices dari semua subs aktif |

## Digunakan Oleh

- `helper/googlePlayService.js`
- `helper/appleSubscriptionService.js`
- `routes/subscription.js`

## `recalculateLimits` — Formula

```mermaid
flowchart TD
    A["recalculateLimits(companyId)"] --> B["Query subscriptions\nstatus in active, grace_period"]
    B --> C["Loop tiap subscription"]
    C --> D{productType?}
    D -->|tier| E["Simpan tierStorage\nambil yang tertinggi"]
    D -->|velinked| F["Simpan velinkedMaxDevices\nambil yang tertinggi"]
    D -->|addon| G["addonStorage += addedStorage"]
    E & F & G --> H{hasTierPlan?}
    H -->|Ya| I["finalStorage = tierStorage + addonStorage"]
    H -->|Tidak| J["finalStorage = BASE_MAX_STORAGE + addonStorage"]
    I & J --> K["Update companies/{id}\nmaxStorage + max_devices"]
```

## `isActiveState`

```js
// Status yang dianggap AKTIF (user masih dapat benefit):
["active", "grace_period"]

// Grace period = payment gagal tapi masih diberi waktu bayar.
// User tidak langsung kehilangan akses.
```

## Decision Making

**Kenapa `recalculateLimits` idempotent?**  
Function ini bisa dipanggil berkali-kali tanpa efek samping karena selalu menghitung ulang dari **semua subscription aktif saat ini**, bukan incremental. Ini aman meskipun ada race condition atau function dipanggil 2x untuk event yang sama.

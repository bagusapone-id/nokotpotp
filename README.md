# Panel Web Nokos WA

Platform jual-beli nomor kosong (Nokos) WhatsApp berbasis Node.js + Express + Firebase Realtime Database.

## Setup

### 1. Konfigurasi Firebase

**Backend (`.env`):**
```
cp .env.example .env
```
Isi `.env` dengan kredensial Firebase project kamu:
- `FIREBASE_PROJECT_ID` — Project ID dari Firebase Console
- `FIREBASE_CLIENT_EMAIL` — Email dari service account key (JSON)
- `FIREBASE_PRIVATE_KEY` — Private key dari service account key (JSON)
- `FIREBASE_DATABASE_URL` — URL Realtime Database (contoh: `https://nama-project-default-rtdb.firebaseio.com`)
- `TELEGRAM_BOT_TOKEN` — Token bot Telegram dari BotFather
- `ADMIN_CHAT_ID` — Chat ID Telegram admin untuk notifikasi
- `ADMIN_SECRET_UID` — UID user Firebase yang dijadikan admin

**Frontend (`public/js/firebase-config.js`):**
Ganti nilai placeholder di file ini dengan config Firebase web app kamu (dari Firebase Console ? Project Settings ? Your apps).

### 2. Jalankan Server

```bash
npm start
```

Server berjalan di `http://localhost:3000`

- **User Panel:** `http://localhost:3000`
- **Admin Panel:** `http://localhost:3000/admin.html`
- **Health Check:** `http://localhost:3000/healthz`

### 3. Seed Data Firebase (Manual)

Di Firebase Realtime Database, buat struktur data awal:

```json
{
  "countries": {
    "indonesia_reguler": {
      "tab": "indo",
      "country_name": "Indonesia",
      "flag": "????",
      "price": 5000
    },
    "usa_reguler": {
      "tab": "luar",
      "country_name": "United States",
      "flag": "????",
      "price": 15000
    }
  },
  "users": {
    "UID_USER_KAMU": {
      "username": "nama_user",
      "balance": 100000
    }
  }
}
```

Lalu tambah stok nomor dari **Admin Panel ? Tambah Stok**.

## Struktur Folder

```
+-- server.js                    # Entry point Express
+-- src/
¦   +-- config/firebase.js       # Firebase Admin SDK init
¦   +-- middleware/
¦   ¦   +-- authUser.js          # Auth middleware untuk user
¦   ¦   +-- authAdmin.js         # Auth middleware untuk admin
¦   +-- routes/
¦   ¦   +-- purchaseRoutes.js    # POST /api/purchase
¦   ¦   +-- orderRoutes.js       # POST /api/orders/:id/*
¦   ¦   +-- cancelRoutes.js      # POST /api/orders/:id/cancel
¦   ¦   +-- adminRoutes.js       # POST /api/admin/*
¦   +-- services/
¦   ¦   +-- purchaseService.js   # Logika beli + atomic transaction
¦   ¦   +-- orderService.js      # OTP request, resend, submit, complete
¦   ¦   +-- cancelService.js     # Cancel + refund
¦   ¦   +-- expiryGuardian.js    # Background job expiry stok
¦   ¦   +-- telegramService.js   # Kirim notifikasi Telegram
¦   +-- utils/retryTransaction.js
+-- public/
¦   +-- index.html               # User Panel
¦   +-- admin.html               # Admin Panel
¦   +-- js/
¦       +-- firebase-config.js   # Firebase web SDK config
¦       +-- user-panel.js        # Logic user panel
¦       +-- admin-panel.js       # Logic admin panel
```

## Fitur

- ?? **Beli Nomor Instant** — Timer 5 menit, stok di-lock atomik
- ?? **User Panel** — Tab Indo/Luar, saldo real-time, timer countdown
- ?? **Admin Panel** — Monitor order, input OTP, complete, tambah stok
- ?? **Notifikasi Telegram** — OTP request & resend auto-notify admin
- ?? **Resend OTP** — Cooldown 60 detik anti-spam
- ?? **Auto-Refund** — Cancel order = saldo kembali 100%
- ? **Expiry Guardian** — Background job expire order macet otomatis setiap 30 detik

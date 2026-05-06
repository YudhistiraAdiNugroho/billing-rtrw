# RTRWNET Management & Billing System

![ISP Management Hero](public/img/hero.png)

Sistem manajemen ISP yang mengintegrasikan **penagihan**, **GenieACS**, **OLT (SNMP)**, **MikroTik** (PPPoE/hotspot/voucher), **peta jaringan (GIS)**, **inventaris**, **WhatsApp/Telegram**, dan **multi-portal** (admin, teknisi, pelanggan, agen) dalam satu platform.

[![GitHub license](https://img.shields.io/github/license/alijayanet/billing-rtrw)](https://github.com/alijayanet/billing-rtrw/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/alijayanet/billing-rtrw)](https://github.com/alijayanet/billing-rtrw/stargazers)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org/)

---

## Daftar fitur (sesuai modul di aplikasi)

### Peta jaringan & geografis
- **Koordinat kantor / pusat peta**: `office_lat` dan `office_lng` di `settings.json` menjadi titik acuan peta.
- **Peta admin** (`/admin/map`): **Leaflet** dengan basemap **OpenStreetMap** dan **satelit (hybrid)**; marker **pelanggan** dan **ODP**; garis hubung pelanggan–ODP; penyimpanan **jalur kabel** (polyline) per pelanggan; popup detail, status paket, dan **grafik/trafik PPPoE** (real-time dari MikroTik saat online).
- **Peta teknisi** (`/tech/map`): tampilan geografis pelanggan & ODP, garis ke ODP, popup dengan **chat WhatsApp** dan **buka rute di Google Maps**; opsi **lokasi GPS** perangkat teknisi di peta.
- **Pemilih lokasi di form pelanggan**: dialog peta (satelit) untuk mengisi **latitude/longitude** saat tambah/edit data pelanggan.

### Billing, tagihan & pembayaran
- Generate tagihan **per pelanggan** atau **massal**; status lunas/belum bayar; cetak invoice; batalkan pembayaran (unpay) jika diperlukan.
- **Bayar tunggal / bayar massal** dari panel admin; integrasi pembayaran online: **Midtrans**, **Tripay**, **Xendit**, **Duitku** (aktif/nonaktif lewat `settings.json`).
- **QRIS / nominal unik**: penugasan & pembersihan kode unik invoice; cocokkan pembayaran dari notifikasi.
- **Webhook pembayaran generik**: endpoint `POST /api/webhook/v1/payment-notif` (dengan `MY_WEBHOOK_SECRET` di `.env`) untuk mencatat notifikasi teks bank/e-wallet dan **otomatis menandai lunas** jika nominal cocok dengan tagihan unik; log tampilan & pembersihan di admin.
- Callback/redirect pembayaran dari portal pelanggan; halaman **isolir** statis `/isolated` (mis. untuk redirect dari MikroTik).

### MikroTik & jaringan
- **Multi-router**: daftar router MikroTik, tes koneksi, **setup firewall** bawaan, pemilihan router per pelanggan.
- **PPPoE**: profil, user/secret, sesi aktif, **monitor trafik**; **jam kalong** (ganti profil malam/hari lewat cron); **FUP** (ganti profil saat pemakaian bulanan melewati batas paket).
- **Pencatatan pemakaian (usage)**: sinkron periodik dari counter sesi PPPoE ke database (dapat dimatikan lewat pengaturan `usage_tracking_enabled`).
- **Hotspot**: profil user, user hotspot, sesi aktif hotspot.
- **Voucher hotspot**: template voucher, **batch** generate, sinkron ke MikroTik, cetak batch, export **CSV**, hapus batch.
- **Backup konfigurasi** MikroTik dari panel.

### GenieACS (TR-069 / perangkat pelanggan)
- Daftar perangkat, detail per **tag**; ubah **SSID** / **password Wi‑Fi**, **reboot** CPE; operasi **bulk SSID**.
- Integrasi ke data pelanggan (tag GenieACS) untuk monitoring dari admin/teknisi.

### OLT PON (SNMP)
- Manajemen **OLT** (host, community SNMP, port, merek, kredensial web).
- **Statistik ONU** per port; aksi **reboot ONU**, **rename**, **otorisasi ONU**, **konfigurasi WAN** (melalui integrasi OLT).

### ODP & infrastruktur pasif
- CRUD **ODP** (titik distribusi) dengan koordinat; ditampilkan di peta bersama pelanggan.

### Pelanggan & data
- CRUD pelanggan: paket, PPPoE, profil isolir, **hari isolir per pelanggan**, **isolir otomatis** per pelanggan, tag GenieACS, **tipe koneksi** / ODP / koordinat.
- **Isolir / buka isolir** manual dari admin (sinkron ke MikroTik).
- **Ekspor** daftar pelanggan; **impor** dari berkas (Excel) dengan upload.
- **Bulk tools** untuk operasi terhadap banyak peranggan/perangkat sekaligus.

### Paket layanan
- CRUD paket harga, kecepatan, deskripsi; opsi **jam kalong** (profil malam); opsi **FUP** (batas GB + profil turun kecepatan).

### Inventaris (gudang)
- Kategori & item; penyesuaian stok; peringatan stok rendah (sesuai implementasi di panel).

### Tiket dukungan
- Daftar tiket (admin); pelanggan dapat **membuat tiket** dari portal; teknisi **ambil tiket** dan **update** penanganan.

### Laporan & dashboard
- Laporan keuangan/agregasi di panel admin; dashboard ringkasan (sesuai halaman utama admin).

### Monitoring & kesehatan sistem
- Halaman **monitoring** (admin/teknisi): CPU, RAM, disk, konektivitas ke layanan terkait.
- API **`/health`** (publik ringan) dan API metrik/stats untuk panel.

### WhatsApp (Baileys)
- Status koneksi, **broadcast** massal dengan jeda/antrian, jeda/lanjut/stop broadcast.
- Pengaturan **pengingat tagihan otomatis** (template pesan + jadwal via cron).
- Tes notifikasi, reset sesi autentikasi bot; integrasi ke tagihan (kirim info invoice via WhatsApp).

### Telegram (opsional)
- Bot admin (aktifkan di `settings.json`); sinkronisasi dari panel bila tersedia.

### Manajemen pengguna internal
- **Super admin / admin / kasir**: sesi terpisah; pembatasan aksi sensitif untuk peran tertentu (`restrictToAdmin`).
- **Teknisi**: akun terpisah, area tugas.
- **Kasir**: akun untuk operasi kasir.
- **Audit log**: riwayat aktivitas sensitif (super admin).

### Agen / mitra penjualan
- Portal agen: **bayar tagihan** pelanggan (uang saldo agen), **jual voucher**, **cetak struk** transaksi.
- Admin: kelola agen, **top-up saldo**, **harga khusus** per agen, laporan agen.

### Portal pelanggan (self-service)
- Halaman informasi: **syarat & ketentuan**, **privasi**, **tentang**, **kontak**.
- **Cek tagihan** tanpa login (nomor/ID sesuai alur di aplikasi).
- **Registrasi** pelanggan baru (online); login; opsi **login OTP** bila diaktifkan di pengaturan.
- **Dashboard**: status layanan, tagihan, pembayaran; **grafik/trafik PPPoE** untuk akun sendiri.
- Ubah **SSID / password Wi‑Fi**, **reboot** CPE, ubah identitas/tag perangkat (sesuai kebijakan yang diaktifkan).
- **Beli voucher** (publik/halaman voucher) dengan alur pembayaran.
- Buat **tiket** keluhan ke provider.

### Portal teknisi
- Ringkasan tugas, **pool** tiket, **riwayat** penanganan.
- **Peta jaringan** (lihat bagian peta).
- **Monitoring** sistem.
- **Input pelanggan baru** dari lapangan (dengan bantuan API MikroTik & ODP/port).
- Akses ringkas ke **perangkat GenieACS** (detail, SSID, password, reboot) untuk pelanggan yang ditangani.

### Otomatisasi terjadwal (cron)
- Tanggal **1 jam 00:01**: generate **tagihan bulanan**.
- Setiap hari **jam 02:00**: **isolir otomatis** pelanggan aktif yang lewat jatuh tempo/isolir (sesuai hari & flag per pelanggan).
- **Jam 09:00**: pengingat tagihan via **WhatsApp** (H-1 dari hari isolir, jika fitur diaktifkan).
- **00:00 & 06:00**: **jam kalong** — ganti profil PPPoE malam/siang untuk paket yang mengaktifkannya.
- Setiap **10 menit**: **sinkron pemakaian data** dari sesi **PPPoE aktif** di MikroTik (jika tracking diaktifkan).
- Setiap **jam**: pengecekan **FUP** dan penurunan profil bila kuota habis.

### Backup & pemeliharaan
- **Backup & restore** database dari panel admin; pembersihan file backup lama.
- **Jalur update** (halaman update + eksekusi skrip) untuk pemeliharaan server (sesuai implementasi `update.sh` / panel).

### Bahasa antarmuka (i18n)
- Pilihan bahasa lewat **query `?lang=`**, sesi, atau pintasan **`/lang/:lang`**; berkas teks di folder `locales/`.

---

## Ringkasan tech stack

- **Runtime**: Node.js **≥ 20** (disarankan LTS terbaru 20.x)
- **Backend**: Express.js
- **Database**: SQLite lewat **better-sqlite3** (file utama: `database/billing.db` — dibuat/dimigrasi otomatis saat pertama jalan)
- **Tampilan**: EJS, Bootstrap 5, Bootstrap Icons
- **Peta**: Leaflet + tile OpenStreetMap / satelit (Google hybrid) di panel admin & teknisi
- **Integrasi**: GenieACS REST API, MikroTik RouterOS API, SNMP (`net-snmp`) untuk OLT, Baileys (WhatsApp), bot Telegram (opsional), gateway pembayaran (sesuai konfigurasi), parsing spreadsheet (**xlsx**) untuk impor data

---

## Instalasi

### Prasyarat
- Node.js **20 atau lebih baru** (`engines` di `package.json`)
- Akses jaringan ke GenieACS / MikroTik jika fitur tersebut dipakai

### Langkah

```bash
git clone https://github.com/alijayanet/billing-rtrw.git
cd billing-rtrw
npm install
```

### Konfigurasi

1. Salin atau edit **`settings.json`** di root proyek: URL GenieACS, kredensial MikroTik, `session_secret`, kredensial admin default, gateway pembayaran, WhatsApp/Telegram, dan **`server_port`** / **`server_host`**.
2. **Penting untuk produksi**: Ganti password admin default, `session_secret`, dan API key; batasi akses file konfigurasi di server.
3. Variabel lingkungan opsional: file **`.env`** (mis. `NODE_ENV=production`) — lihat penggunaan di kode jika Anda menambah secret di `.env`.

### Menjalankan aplikasi

```bash
npm start
```

Mode pengembangan (auto-restart dengan nodemon):

```bash
npm run dev
```

Entry point aplikasi adalah **`app-customer.js`** (bukan `app.js`).

### PM2 (proses daemon)

```bash
npm install pm2 -g
pm2 start app-customer.js --name billing-rtrw
```

---

## Akses portal (setelah server jalan)

Port mengikuti **`server_port`** di `settings.json` (default **3001**). Ganti `[IP-SERVER]` dengan IP atau hostname mesin Anda.

| Portal | URL contoh |
|--------|------------|
| Beranda | `http://[IP-SERVER]:3001/` → mengarah ke login pelanggan |
| Pelanggan | `http://[IP-SERVER]:3001/customer/login` (alias singkat: `/login`) |
| Admin | `http://[IP-SERVER]:3001/admin/login` |
| Teknisi | `http://[IP-SERVER]:3001/tech/login` |
| Agen | `http://[IP-SERVER]:3001/agent/login` |
| Kolektor | `http://[IP-SERVER]:3001/collector/login` |
| Health check | `http://[IP-SERVER]:3001/health` |

Kredensial admin **awal** biasanya sesuai `admin_username` / `admin_password` di `settings.json` (contoh bawaan sering `admin` / `admin123`) — **wajib diganti** sebelum dipakai publik.

---

## Catatan platform

- **Linux (Ubuntu / Armbian)**: pola di atas langsung dipakai.
- **Windows**: sama (`npm install` / `npm start`); pastikan Node 20+ dan firewall mengizinkan port yang dipakai aplikasi.

---

## Kontribusi

Fork, buat branch fitur, lalu kirim Pull Request.

## Lisensi

**ISC** — lihat berkas `LICENSE`.

Dibuat untuk operasional ISP lokal & RTRW-Net.  
Managed by [Ali Jaya Net](https://github.com/alijayanet)

## Info & donasi

081947215703 — https://wa.me/6281947215703

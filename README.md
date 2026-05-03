# 🚀 RTRWNET Management & Billing System

![ISP Management Hero](public/img/hero.png)

Sistem manajemen ISP modern yang mengintegrasikan **Penagihan (Billing)**, **Manajemen ONU (GenieACS)**, **Manajemen Bandwidth (MikroTik)**, **Inventaris Gudang**, dan **Notifikasi WhatsApp** dalam satu platform terpadu.

[![GitHub license](https://img.shields.io/github/license/alijayanet/billing-rtrw)](https://github.com/alijayanet/billing-rtrw/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/alijayanet/billing-rtrw)](https://github.com/alijayanet/billing-rtrw/stargazers)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

---

## ✨ Fitur Utama

### 💰 1. Billing & Penagihan Otomatis
- **Automated Invoicing**: Pembuatan tagihan otomatis setiap bulan untuk semua pelanggan aktif.
- **Isolir Otomatis**: Integrasi dengan MikroTik untuk memutus layanan (block) pelanggan yang menunggak dan membuka layanan (unblock) secara instan setelah pembayaran.
- **Payment Gateway**: Integrasi dengan **Midtrans** dan **Tripay** untuk pembayaran otomatis via VA, E-Wallet, dan Retail Outlet.
- **Manajemen Invoice**: Cetak invoice profesional dan kelola riwayat pembayaran.
- **Laporan Keuangan**: Statistik pendapatan bulanan, akumulasi pendapatan, dan data tunggakan.

### 📡 2. Monitoring & Otomatisasi Jaringan (MikroTik)
- **Dynamic Speed (Jam Kalong)**: Otomatis menaikkan/mengubah profil kecepatan pelanggan pada jam malam (00:00 - 06:00) untuk meningkatkan kepuasan pelanggan.
- **FUP (Fair Usage Policy)**: Pemantauan kuota pemakaian real-time. Otomatis menurunkan profil kecepatan pelanggan jika pemakaian bulanan melebihi batas (GB) yang ditentukan.
- **Real-time Usage Tracking**: Visualisasi penggunaan data pelanggan (GB) langsung di daftar pelanggan.

### 📦 3. Manajemen Inventaris (Warehouse)
- **Stok Gudang**: Kelola stok perangkat (ONT, Router, Kabel, dll) secara terorganisir.
- **Inventory Tracking**: Pantau barang masuk, keluar (dipasang ke pelanggan), dan penyesuaian stok.
- **Serial Number Management**: Mendukung pencatatan SN perangkat untuk memudahkan pelacakan garansi dan pemasangan.
- **Low Stock Alert**: Peringatan otomatis jika stok barang di gudang sudah menipis.

### 🔍 4. Monitoring ONU (GenieACS TR-069)
- **Real-time Dashboard**: Pantau status Online/Offline, Redaman (RX Power), Uptime, dan IP Address.
- **Remote WiFi Settings**: Ubah SSID (Nama WiFi) dan Password langsung dari panel admin atau portal pelanggan.
- **Remote Reboot**: Restart perangkat ONU pelanggan secara jarak jauh.
- **Connected Devices**: Lihat jumlah perangkat yang sedang terhubung ke WiFi pelanggan.

### 🛠️ 5. Portal Teknisi & Diagnosa
- **Customer Diagnostics**: Alat diagnosa cepat untuk mengecek status billing, sesi MikroTik, dan sinyal ONU pelanggan dalam satu klik.
- **System Health Monitoring**: Pantau kesehatan server (CPU, RAM, Disk) dan status konektivitas ke MikroTik, GenieACS, serta WhatsApp Bot.
- **Ticket Management**: Kelola dan selesaikan keluhan pelanggan secara efisien melalui portal teknisi yang responsif.

### 📲 6. Integrasi WhatsApp (Baileys API)
- **Broadcast Massal**: Kirim pengumuman atau info maintenance ke seluruh pelanggan dengan satu klik.
- **WhatsApp Bot Self-Service**: Pelanggan bisa cek status, cek tagihan, hingga ganti password WiFi melalui pesan WhatsApp.
- **Notifikasi Otomatis**: Pengingat tagihan otomatis (H-3, H-1) dan notifikasi isolir via WhatsApp.

### 👥 7. Manajemen User & Keamanan
- **Role Based Access Control**: Super Admin, Kasir, dan Teknisi dengan hak akses yang berbeda.
- **Audit Trail (Log Aktivitas)**: Mencatat setiap aktivitas sensitif (tambah/edit/hapus data) yang dilakukan oleh admin untuk keperluan audit keamanan.

---

## 🛠️ Tech Stack

- **Backend**: Node.js (v20 Recommended), Express.js
- **Database**: SQLite (Better-SQLite3)
- **Templates**: EJS (Embedded JavaScript)
- **Styling**: Vanilla CSS, Bootstrap 5, Bootstrap Icons
- **Integrasi**: 
  - **GenieACS REST API** (Management ONU)
  - **MikroTik RouterOS API** (Management Bandwidth/Isolir)
  - **Baileys** (WhatsApp API)
  - **Payment Gateway** (Midtrans & Tripay)

---

## 🚀 Cara Instalasi (Ubuntu / Armbian)

### 1. Persiapan
Pastikan Anda memiliki akses `root` atau `sudo`.

```bash
# Clone repository
git clone https://github.com/alijayanet/billing-rtrw.git
cd billing-rtrw
```

### 2. Jalankan Installer Package
```bash
npm install
```
### 3. Jalankan Aplikasi
```bash
npm start
```

### 3. Akses Portal
Setelah instalasi berhasil, portal dapat diakses melalui browser:
- **Admin Portal**: `http://[IP-SERVER]:3001/admin/login`
                    (User : admin Pass : admin123)
- **Teknisi Portal**: `http://[IP-SERVER]:3001/tech/login`
- **Customer Portal**: `http://[IP-SERVER]:3001/login`

## ⚙️ Jalankan Aplikasi Menggunakan pm2

```bash
npm install pm2 -g
pm2 start app.js --name billing-rtrw
```

## 🤝 Kontribusi

Kontribusi selalu terbuka! Silakan fork repository ini, buat branch baru, dan kirimkan Pull Request.

## 📄 Lisensi

Didistribusikan di bawah Lisensi **ISC**. Lihat `LICENSE` untuk detailnya.

🚀 **Dibuat untuk memudahkan operasional ISP Lokal & RTRW-Net.**
Managed by [Ali Jaya Net](https://github.com/alijayanet)

## info & donasi 081947215703
https://wa.me/6281947215703

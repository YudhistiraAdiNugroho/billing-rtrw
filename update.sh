#!/bin/bash
# ============================================================
#  UPDATE RINGAN (LOW CPU) - Portal Pelanggan GenieACS
#  Untuk Ubuntu / Armbian / Debian
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}║     UPDATE PORTAL PELANGGAN (LOW CPU MODE)       ║${NC}"
echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# Cek root
if [ "$EUID" -ne 0 ]; then
  echo -e "${YELLOW}[WARN]${NC} Jalankan dengan: ${BOLD}sudo bash update.sh${NC}"
  exit 1
fi

cd "$SCRIPT_DIR"

# 1. Backup settings.json sebelum update
echo -e "${BLUE}[INFO]${NC} Backup settings.json..."
cp settings.json settings.json.bak 2>/dev/null || true
echo -e "${GREEN}[OK]${NC} Backup tersimpan di settings.json.bak"

# 2. Git Pull (Low priority via nice)
echo -e "${BLUE}[INFO]${NC} Menarik pembaruan dari GitHub..."
HEAD_BEFORE=$(git rev-parse HEAD 2>/dev/null || echo "old")
nice -n 19 git pull origin main 2>/dev/null || nice -n 19 git pull 2>/dev/null || true
HEAD_AFTER=$(git rev-parse HEAD 2>/dev/null || echo "new")

# 3. Cek apakah package.json mengalami perubahan
PKG_CHANGED=false
if [ "$HEAD_BEFORE" != "old" ] && [ "$HEAD_BEFORE" != "$HEAD_AFTER" ]; then
  if git diff --name-only "$HEAD_BEFORE" "$HEAD_AFTER" | grep -q "package.json"; then
    PKG_CHANGED=true
  fi
fi

# 4. Update npm HANYA jika package.json berubah (dengan bendera hemat CPU)
if [ "$PKG_CHANGED" = true ]; then
  echo -e "${YELLOW}[INFO]${NC} Deteksi perubahan package.json. Memperbarui dependensi NPM (Low-CPU Mode)..."
  UV_THREADPOOL_SIZE=2 nice -n 19 npm install --omit=dev --no-audit --no-fund --prefer-offline
  echo -e "${GREEN}[OK]${NC} Dependensi diperbarui."
else
  echo -e "${GREEN}[OK]${NC} package.json tidak berubah. Melewati 'npm install' (Sangat Hemat CPU & Hemat Waktu!)."
fi

# 5. Reload aplikasi secara halus (Graceful Reload)
echo -e "${BLUE}[INFO]${NC} Menerapkan pembaruan via PM2..."
pm2 reload app-customer 2>/dev/null || pm2 restart app-customer
echo -e "${GREEN}[OK]${NC} Aplikasi berhasil diperbarui."

# Tampilkan status PM2
pm2 status app-customer 2>/dev/null || true

echo ""
echo -e "${GREEN}${BOLD}Update Ringan Selesai!${NC}"
echo -e "Konfigurasi lama tersimpan di: ${YELLOW}settings.json.bak${NC}"
echo ""

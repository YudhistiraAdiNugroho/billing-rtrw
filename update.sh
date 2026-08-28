#!/bin/bash

# ============================================================
# UPDATE PORTAL PELANGGAN DARI GITHUB
#
# Aman untuk:
# - VPS baru
# - VPS dengan PM2
# - VPS dengan systemd
# - VPS Node.js manual
#
# DATA LOKAL YANG DILINDUNGI:
# - settings.json
# - database/
# - public/uploads/
# - data/
# - logs/
# - node_modules/
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

REPO="https://github.com/YudhistiraAdiNugroho/billing-rtrw"
BRANCH="main"

TMP_DIR="/tmp/billing-rtrw-update-$$"
SOURCE_DIR="$TMP_DIR/source"

BACKUP_DIR="$SCRIPT_DIR/.update-backup-$(date +%Y%m%d-%H%M%S)"

cleanup() {
    rm -rf "$TMP_DIR"
}

trap cleanup EXIT

echo ""
echo -e "${CYAN}${BOLD}====================================================${NC}"
echo -e "${CYAN}${BOLD}        UPDATE PORTAL PELANGGAN DARI GITHUB       ${NC}"
echo -e "${CYAN}${BOLD}====================================================${NC}"
echo ""

# ============================================================
# ROOT
# ============================================================

if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}[ERROR]${NC} Jalankan dengan:"
    echo "sudo bash update.sh"
    exit 1
fi

cd "$SCRIPT_DIR"

# ============================================================
# CEK TOOL
# ============================================================

echo -e "${BLUE}[CHECK]${NC} Memeriksa tool..."

for CMD in curl tar rsync node npm; do
    if ! command -v "$CMD" >/dev/null 2>&1; then
        echo -e "${RED}[ERROR]${NC} $CMD tidak ditemukan."
        exit 1
    fi
done

echo -e "${GREEN}[OK]${NC} Semua tool tersedia."

# ============================================================
# BACKUP
# ============================================================

echo ""
echo -e "${BLUE}[1/7]${NC} Membuat backup data lokal..."

mkdir -p "$BACKUP_DIR"

# ------------------------------------------------------------
# SETTINGS
# ------------------------------------------------------------

if [ ! -f "$SCRIPT_DIR/settings.json" ]; then
    echo -e "${RED}[ERROR]${NC} settings.json tidak ditemukan."
    echo -e "${RED}[ERROR]${NC} Update dihentikan untuk mencegah kehilangan konfigurasi."
    exit 1
fi

SETTINGS_SIZE=$(stat -c%s "$SCRIPT_DIR/settings.json")

if [ "$SETTINGS_SIZE" -lt 50 ]; then
    echo -e "${RED}[ERROR]${NC} settings.json terlalu kecil (${SETTINGS_SIZE} bytes)."
    echo -e "${RED}[ERROR]${NC} Update dihentikan."
    exit 1
fi

if ! node -e \
    "JSON.parse(require('fs').readFileSync('$SCRIPT_DIR/settings.json'))" \
    >/dev/null 2>&1; then

    echo -e "${RED}[ERROR]${NC} settings.json tidak valid."
    echo -e "${RED}[ERROR]${NC} Update dihentikan."
    exit 1
fi

cp -a "$SCRIPT_DIR/settings.json" \
      "$BACKUP_DIR/settings.json"

echo -e "${GREEN}[OK]${NC} settings.json dibackup (${SETTINGS_SIZE} bytes)."

# ------------------------------------------------------------
# DATABASE
# ------------------------------------------------------------

if [ -d "$SCRIPT_DIR/database" ]; then

    cp -a "$SCRIPT_DIR/database" \
          "$BACKUP_DIR/database"

    echo -e "${GREEN}[OK]${NC} database dibackup."

fi

# ------------------------------------------------------------
# UPLOADS
# ------------------------------------------------------------

if [ -d "$SCRIPT_DIR/public/uploads" ]; then

    mkdir -p "$BACKUP_DIR/public"

    cp -a "$SCRIPT_DIR/public/uploads" \
          "$BACKUP_DIR/public/uploads"

    echo -e "${GREEN}[OK]${NC} public/uploads dibackup."

fi

# ------------------------------------------------------------
# DATA
# ------------------------------------------------------------

if [ -d "$SCRIPT_DIR/data" ]; then

    cp -a "$SCRIPT_DIR/data" \
          "$BACKUP_DIR/data"

    echo -e "${GREEN}[OK]${NC} data dibackup."

fi

# ============================================================
# DOWNLOAD GITHUB
# ============================================================

echo ""
echo -e "${BLUE}[2/7]${NC} Mengambil source terbaru dari GitHub..."

mkdir -p "$SOURCE_DIR"

curl -fL --retry 3 \
    "$REPO/archive/refs/heads/$BRANCH.tar.gz" \
    -o "$TMP_DIR/source.tar.gz"

tar -xzf "$TMP_DIR/source.tar.gz" \
    -C "$SOURCE_DIR"

EXTRACTED_DIR=$(find "$SOURCE_DIR" \
    -mindepth 1 \
    -maxdepth 1 \
    -type d \
    | head -1)

if [ -z "$EXTRACTED_DIR" ]; then
    echo -e "${RED}[ERROR]${NC} Source GitHub gagal diekstrak."
    exit 1
fi

echo -e "${GREEN}[OK]${NC} Source berhasil diambil."

# ============================================================
# VALIDASI SOURCE
# ============================================================

echo ""
echo -e "${BLUE}[3/7]${NC} Validasi source..."

for FILE in \
    app-customer.js \
    package.json \
    routes/adminPortal.js
do

    if [ ! -f "$EXTRACTED_DIR/$FILE" ]; then

        echo -e "${RED}[ERROR]${NC} $FILE tidak ditemukan."
        echo -e "${RED}[ERROR]${NC} Update dihentikan."

        exit 1

    fi

done

echo -e "${GREEN}[OK]${NC} Source valid."

# ============================================================
# CEK PACKAGE
# ============================================================

PACKAGE_CHANGED=false

if [ ! -f "$SCRIPT_DIR/package.json" ]; then

    PACKAGE_CHANGED=true

elif ! cmp -s \
    "$SCRIPT_DIR/package.json" \
    "$EXTRACTED_DIR/package.json"; then

    PACKAGE_CHANGED=true

fi

# ============================================================
# UPDATE SOURCE
# ============================================================

echo ""
echo -e "${BLUE}[4/7]${NC} Memperbarui source aplikasi..."

rsync -a \
    --exclude='settings.json' \
    --exclude='database/' \
    --exclude='node_modules/' \
    --exclude='public/uploads/' \
    --exclude='data/' \
    --exclude='logs/' \
    "$EXTRACTED_DIR/" \
    "$SCRIPT_DIR/"

echo -e "${GREEN}[OK]${NC} Source diperbarui."

# ============================================================
# RESTORE DATA LOKAL
# ============================================================

echo ""
echo -e "${BLUE}[5/7]${NC} Mengembalikan data lokal..."

# ------------------------------------------------------------
# SETTINGS
# ------------------------------------------------------------

cp -af \
    "$BACKUP_DIR/settings.json" \
    "$SCRIPT_DIR/settings.json"

# VERIFIKASI SETTINGS SETELAH RESTORE

if [ ! -f "$SCRIPT_DIR/settings.json" ]; then
    echo -e "${RED}[ERROR]${NC} settings.json hilang setelah update."
    exit 1
fi

if ! node -e \
    "JSON.parse(require('fs').readFileSync('$SCRIPT_DIR/settings.json'))" \
    >/dev/null 2>&1; then

    echo -e "${RED}[ERROR]${NC} settings.json rusak setelah update."
    exit 1

fi

echo -e "${GREEN}[OK]${NC} settings.json aman."

# ------------------------------------------------------------
# DATABASE
# ------------------------------------------------------------

if [ -d "$BACKUP_DIR/database" ]; then

    mkdir -p "$SCRIPT_DIR/database"

    cp -a \
        "$BACKUP_DIR/database/." \
        "$SCRIPT_DIR/database/"

    echo -e "${GREEN}[OK]${NC} database aman."

fi

# ------------------------------------------------------------
# UPLOADS
# ------------------------------------------------------------

if [ -d "$BACKUP_DIR/public/uploads" ]; then

    mkdir -p "$SCRIPT_DIR/public/uploads"

    cp -a \
        "$BACKUP_DIR/public/uploads/." \
        "$SCRIPT_DIR/public/uploads/"

    echo -e "${GREEN}[OK]${NC} uploads aman."

fi

# ------------------------------------------------------------
# DATA
# ------------------------------------------------------------

if [ -d "$BACKUP_DIR/data" ]; then

    mkdir -p "$SCRIPT_DIR/data"

    cp -a \
        "$BACKUP_DIR/data/." \
        "$SCRIPT_DIR/data/"

    echo -e "${GREEN}[OK]${NC} data aman."

fi

# ============================================================
# NPM
# ============================================================

echo ""
echo -e "${BLUE}[6/7]${NC} Memeriksa dependency..."

NEED_NPM=false

# package.json berubah
if [ "$PACKAGE_CHANGED" = true ]; then
    NEED_NPM=true
fi

# node_modules tidak ada
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    NEED_NPM=true
fi

# Express tidak bisa diload
cd "$SCRIPT_DIR"

if ! node -e "require('express')" >/dev/null 2>&1; then
    NEED_NPM=true
fi

if [ "$NEED_NPM" = true ]; then

    echo -e "${YELLOW}[INFO]${NC} Dependency perlu diperbarui."

    UV_THREADPOOL_SIZE=2 \
    nice -n 19 npm install \
        --omit=dev \
        --no-audit \
        --no-fund \
        --prefer-offline

    echo -e "${GREEN}[OK]${NC} Dependency berhasil diperbarui."

else

    echo -e "${GREEN}[OK]${NC} Dependency sudah tersedia."

fi

# VERIFIKASI EXPRESS

if ! node -e "require('express')" >/dev/null 2>&1; then

    echo -e "${RED}[ERROR]${NC} Express masih tidak bisa diload."
    echo -e "${RED}[ERROR]${NC} Aplikasi tidak akan direstart."

    exit 1
fi

echo -e "${GREEN}[OK]${NC} Express dapat diload."

# ============================================================
# RESTART
# ============================================================

echo ""
echo -e "${BLUE}[7/7]${NC} Mendeteksi runtime aplikasi..."

cd "$SCRIPT_DIR"

# ============================================================
# PM2
# ============================================================

PM2_FOUND=false

if command -v pm2 >/dev/null 2>&1; then

    if pm2 describe app-customer >/dev/null 2>&1; then
        PM2_FOUND=true
    fi

fi

if [ "$PM2_FOUND" = true ]; then

    echo -e "${BLUE}[INFO]${NC} PM2 terdeteksi."

    pm2 reload app-customer

    sleep 3

    if pm2 describe app-customer >/dev/null 2>&1; then

        echo -e "${GREEN}[OK]${NC} Aplikasi berhasil di-reload via PM2."

    else

        echo -e "${RED}[ERROR]${NC} PM2 gagal menjalankan aplikasi."
        pm2 status

        exit 1

    fi

# ============================================================
# SYSTEMD
# ============================================================

elif systemctl list-unit-files 2>/dev/null \
    | grep -q "^billing-rtrw\.service"; then

    echo -e "${BLUE}[INFO]${NC} Systemd billing-rtrw.service terdeteksi."

    systemctl restart billing-rtrw.service

    sleep 3

    if systemctl is-active --quiet billing-rtrw.service; then

        echo -e "${GREEN}[OK]${NC} Aplikasi berhasil direstart via systemd."

    else

        echo -e "${RED}[ERROR]${NC} billing-rtrw.service gagal berjalan."

        systemctl status billing-rtrw.service --no-pager

        exit 1

    fi

# ============================================================
# NODE MANUAL
# ============================================================

else

    echo -e "${YELLOW}[INFO]${NC} PM2/systemd tidak ditemukan."
    echo -e "${BLUE}[INFO]${NC} Menggunakan Node.js manual."

    PIDS=$(pgrep -f "[n]ode app-customer.js" || true)

    if [ -n "$PIDS" ]; then

        echo "PID aplikasi: $PIDS"

        kill $PIDS 2>/dev/null || true

        sleep 2

        PIDS_LEFT=$(pgrep -f "[n]ode app-customer.js" || true)

        if [ -n "$PIDS_LEFT" ]; then

            kill -9 $PIDS_LEFT 2>/dev/null || true

            sleep 1

        fi

    fi

    nohup node app-customer.js \
        > "$SCRIPT_DIR/app.log" 2>&1 &

    NEW_PID=$!

    sleep 3

    if kill -0 "$NEW_PID" 2>/dev/null; then

        echo -e "${GREEN}[OK]${NC} Aplikasi berhasil berjalan."
        echo "PID: $NEW_PID"

    else

        echo -e "${RED}[ERROR]${NC} Aplikasi gagal start."
        echo ""
        echo "Log:"
        tail -50 "$SCRIPT_DIR/app.log"

        exit 1

    fi

fi

# ============================================================
# SELESAI
# ============================================================

echo ""
echo -e "${GREEN}${BOLD}====================================================${NC}"
echo -e "${GREEN}${BOLD}              UPDATE BERHASIL                     ${NC}"
echo -e "${GREEN}${BOLD}====================================================${NC}"
echo ""

echo "Backup lokal:"
echo "  $BACKUP_DIR"

echo ""

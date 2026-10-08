#!/bin/bash
# Genera los iconos web (favicon/PWA/apple/OG) a partir del SVG del proyecto.
# Uso: bash scripts/generate-web-icons.sh
set -e
cd "$(dirname "$0")/.."

command -v rsvg-convert >/dev/null 2>&1 || {
  echo "Falta rsvg-convert (sudo apt install librsvg2-bin)"; exit 1; }

mkdir -p public/icons

rsvg-convert -w  32 -h  32 public/favicon.svg -o public/icons/icon-32x32.png
rsvg-convert -w 180 -h 180 public/favicon.svg -o public/icons/apple-touch-icon.png
rsvg-convert -w 192 -h 192 public/favicon.svg -o public/icons/icon-192x192.png
rsvg-convert -w 512 -h 512 public/favicon.svg -o public/icons/icon-512x512.png
rsvg-convert -w 512 -h 512 scripts/icon-maskable.svg -o public/icons/icon-512x512-maskable.png
rsvg-convert -w 1200 -h 630 scripts/og-image.svg -o public/icons/og-1200x630.png

echo "Iconos generados en public/icons/:"
ls -l public/icons/

#!/bin/bash
echo "=== Linux ffmpeg ==="
if command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -version | head -2
else
  echo "SIN FFMPEG"
fi
echo "--- filtros ---"
FIL=$(ffmpeg -hide_banner -filters 2>/dev/null)
for f in cas hqdn3d curves unsharp minterpolate framerate eq scale nlmeans deband colorbalance colorchannelmixer fps gblur geq lutyuv; do
  printf "  %-20s " "$f"
  echo "$FIL" | grep -qE "[ ,]$f " && echo SI || echo NO
done
echo "--- encoders ---"
ENC=$(ffmpeg -hide_banner -encoders 2>/dev/null)
for e in libx264 libx265 h264_vaapi h264_v4l2m2m h264_mediacodec mpeg4; do
  printf "  %-20s " "$e"
  echo "$ENC" | grep -qE "[ ]$e[ ]" && echo SI || echo NO
done
echo "--- hw ---"
echo "nproc: $(nproc)"
free -g | head -2
ls /dev/dri 2>/dev/null || echo "sin /dev/dri (sin GPU)"
echo "--- rust/node ---"
source $HOME/.cargo/env 2>/dev/null
cargo --version 2>/dev/null || echo "sin cargo"
echo "--- espacio ---"
df -h /home | tail -1

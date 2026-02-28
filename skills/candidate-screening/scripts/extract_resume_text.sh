#!/usr/bin/env bash
set -euo pipefail

# Usage: extract_resume_text.sh <input_dir> <output_dir>
IN_DIR="${1:-}"
OUT_DIR="${2:-}"

if [[ -z "$IN_DIR" || -z "$OUT_DIR" ]]; then
  echo "usage: $0 <input_dir> <output_dir>" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

find "$IN_DIR" -type f \( -iname '*.pdf' -o -iname '*.html' -o -iname '*.htm' \) | while read -r f; do
  base="$(basename "$f")"
  stem="${base%.*}"
  out="$OUT_DIR/${stem}.txt"

  case "${f,,}" in
    *.pdf)
      if command -v pdftotext >/dev/null 2>&1; then
        pdftotext "$f" "$out" || true
      else
        echo "pdftotext missing for $f" > "$out"
      fi
      ;;
    *.html|*.htm)
      sed -E 's/<[^>]+>/ /g' "$f" | tr -s ' ' > "$out"
      ;;
  esac
done

echo "resume text extraction complete: $OUT_DIR"

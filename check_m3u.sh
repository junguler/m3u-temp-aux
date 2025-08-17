#!/usr/bin/env bash
# m3u_keep_200.sh
set -Eeuo pipefail
shopt -s nullglob

# Tunables (env overrides)
CONCURRENCY="${CONCURRENCY:-32}"         # parallel workers
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-3}"  # seconds to connect
MAX_TIME="${MAX_TIME:-10}"               # overall budget per request
HEAD_FIRST="${HEAD_FIRST:-1}"            # try HEAD first
HEAD_FALLBACK_GET="${HEAD_FALLBACK_GET:-1}" # fallback to tiny GET
FOLLOW_REDIRECTS="${FOLLOW_REDIRECTS:-1}"   # follow redirects (default ON)
USER_AGENT="${USER_AGENT:-Mozilla/5.0 (m3u-checker)}"

# Optional headers for picky servers
REFERER="${REFERER:-}"   # e.g. https://example.com/
ORIGIN="${ORIGIN:-}"     # e.g. https://example.com
UPDATE_REDIRECTS="${UPDATE_REDIRECTS:-0}" # 1=replace URLs with final url_effective

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

process_playlist() {
  local in="$1"
  echo ">> checking: $in" >&2

  local base out tmpargs tmpres
  base="$(basename "$in")"
  out="200-$base"
  tmpargs="$(mktemp)"
  tmpres="$(mktemp)"
  trap 'rm -f "$tmpargs" "$tmpres"' RETURN

  # Parse into (META, URLS)
  declare -a META=()
  declare -a URLS=()
  local line meta_buf=""
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}" # strip CR
    if [[ ${#URLS[@]} -eq 0 && "$line" == \#EXTM3U* ]]; then
      continue
    fi
    if [[ "$line" == \#* ]]; then
      [[ -n "$meta_buf" ]] && meta_buf+=$'\n'
      meta_buf+="$line"
      continue
    fi
    [[ -z "$line" ]] && continue
    URLS+=("$line")
    META+=("$meta_buf")
    meta_buf=""
  done < "$in"

  [[ "${#URLS[@]}" -eq 0 ]] && { echo ">> no URLs in $in" >&2; return; }

  # Work items: "index|url" (NUL-delimited)
  for i in "${!URLS[@]}"; do
    printf "%s|%s\0" "$i" "${URLS[$i]}"
  done > "$tmpargs"

  export CONNECT_TIMEOUT MAX_TIME HEAD_FIRST HEAD_FALLBACK_GET FOLLOW_REDIRECTS USER_AGENT REFERER ORIGIN

  # Parallel check -> "idx<TAB>code<TAB>orig<TAB>effective"
  xargs -0 -n1 -P "$CONCURRENCY" -I {} bash -c '
    set -Eeuo pipefail
    arg="$1"
    idx="${arg%%|*}"
    url="${arg#*|}"

    declare -a CARGS
    CARGS=(-A "$USER_AGENT" -sS -o /dev/null --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME")
    [ "${FOLLOW_REDIRECTS}" -eq 1 ] && CARGS+=(-L)
    [ -n "${ORIGIN:-}" ] && CARGS+=(-H "Origin: $ORIGIN")
    [ -n "${REFERER:-}" ] && CARGS+=(-H "Referer: $REFERER")

    run_head() { curl "${CARGS[@]}" -I -w "%{http_code} %{url_effective}" "$url"; }
    run_get()  { curl "${CARGS[@]}" --range 0-0 -w "%{http_code} %{url_effective}" "$url"; }

    res=""
    if [ "${HEAD_FIRST}" -eq 1 ]; then
      res="$(run_head || true)"
      code="${res%% *}"; eff="${res#* }"
      case "$code" in 000|400|401|403|405)
        [ "${HEAD_FALLBACK_GET}" -eq 1 ] && res="$(run_get || true)";;
      esac
    else
      res="$(run_get || true)"
    fi

    code="${res%% *}"
    eff="${res#* }"
    printf "%s\t%s\t%s\t%s\n" "$idx" "$code" "$url" "$eff"
  ' _ < "$tmpargs" > "$tmpres"

  # Build 200-only playlist (preserve order and metadata)
  local wrote=0
  while IFS=$'\t' read -r idx code url eff; do
    [[ "$code" =~ ^2..$ ]] || continue
    if (( wrote == 0 )); then
      printf "#EXTM3U\n" > "$out"
      wrote=1
    fi
    [[ -n "${META[$idx]}" ]] && printf "%s\n" "${META[$idx]}" >> "$out"
    if [[ "$UPDATE_REDIRECTS" -eq 1 && -n "$eff" && "$eff" != "$url" ]]; then
      printf "%s\n" "$eff" >> "$out"
    else
      printf "%s\n" "$url" >> "$out"
    fi
  done < <(LC_ALL=C sort -n -k1,1 "$tmpres")

  if (( wrote )); then
    local good total
    good=$(awk -F'\t' '$2 ~ /^2../ {c++} END{print c+0}' "$tmpres")
    total=$(wc -l < "$tmpres" | tr -d " ")
    echo ">> wrote: $out ($good of $total entries are 2xx)" >&2
  else
    rm -f "$out"
    echo ">> no 2xx entries for $in (nothing written)" >&2
  fi
}

files=( *.m3u *.m3u8 )
(( ${#files[@]} )) || { echo "no .m3u/.m3u8 files found." >&2; exit 1; }
for f in "${files[@]}"; do process_playlist "$f"; done
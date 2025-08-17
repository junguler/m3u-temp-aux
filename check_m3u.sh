#!/usr/bin/env bash
set -euo pipefail

# 1. Rename .m3u files: replace spaces with underscores
for f in *.m3u; do
  mv -- "$f" "${f// /_}"
done

# 2. Prepare a temporary directory
tmpdir=$(mktemp -d)
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

# 3. Process each .m3u file in parallel
for infile in *.m3u; do
  outfile="cleaned_${infile}"
  {
    echo "#EXTM3U"                              # add header immediately
    # Read input, group lines into [info,line] pairs
    awk 'BEGIN {RS="\r?\n"; ORS="\n"} /^#/ {info=$0; next} {print info "\n" $0}' "$infile" \
      | paste - - \
      | while IFS=$'\t' read -r info url; do
          # Check URL status with curl (fast, follows no redirects)
          status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 --head --location-trusted --url "$url")
          if [[ $status -eq 200 ]]; then
            # restore spaces in title, print block
            echo "${info//_/ }"
            echo "$url"
          fi
        done
  } > "$outfile" &
done

wait  # wait for all background jobs to finish

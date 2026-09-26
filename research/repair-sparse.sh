#!/usr/bin/env bash
# Repair sparse checkouts in research/.
#
# Bug: fetch.sh's "existing clone" path called `sparse-checkout set $sparse`
# without `--no-cone`, so git wrote the default non-cone pattern
# (`/*` + `!/*/`) which materialises NOTHING. Eleven clones ended up with a
# valid .git but an empty working tree.
#
# This re-applies each repo's declared patterns in CONE mode (robust, and
# cone mode always includes root-level files), then verifies the tree is
# actually populated. Cone mode takes bare directory names, so we strip the
# leading/trailing slashes and wildcard forms from repos.tsv.
#
#   ./repair-sparse.sh          apply + verify, report only
#   ./repair-sparse.sh --fix    actually run the git commands

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TSV="$HERE/repos.tsv"
FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

pass=0; fail=0; fixed=0
printf '%-38s %-8s %s\n' "REPO" "FILES" "STATE"
printf '%s\n' "----------------------------------------------------------------------"

while IFS=$'\t' read -r tier dir url purpose sparse; do
  case "$tier" in ''|'#'*) continue ;; esac
  case "$url" in http*) ;; *) continue ;; esac
  [ -n "$sparse" ] && [ "$sparse" != "-" ] || continue
  dest="$HERE/$tier/$dir"
  [ -d "$dest/.git" ] || continue

  # repos.tsv patterns look like: /packages/ /content/  or  /*.py
  # cone mode accepts bare names; glob patterns must stay in no-cone mode.
  glob=0
  case "$sparse" in *'*'*) glob=1 ;; esac

  dirs=""
  for p in $sparse; do
    case "$p" in
      /*) glob=1; continue ;;
      *'*'*) glob=1; continue ;;
    esac
    d="${p#/}"; d="${d%/}"
    [ -n "$d" ] && dirs="$dirs $d"
  done

  if [ "$glob" -eq 1 ]; then
    # mixed/glob patterns: rebuild the pattern file by hand
    if [ "$FIX" -eq 1 ]; then
      {
        echo "/*"
        for p in $sparse; do
          case "$p" in
            /*) echo "/${p#/}" ;;
            *)  echo "/*" ;;
          esac
        done
      } > "$dest/.git/info/sparse-checkout"
      git -C "$dest" read-tree -mu HEAD >/dev/null 2>&1
    fi
  else
    # pure directory patterns: cone mode is the robust path
    if [ "$FIX" -eq 1 ]; then
      git -C "$dest" sparse-checkout disable >/dev/null 2>&1
      # shellcheck disable=SC2086
      git -C "$dest" sparse-checkout set --cone $dirs >/dev/null 2>&1
    fi
  fi

  n=$(find "$dest" -type f -not -path '*/.git/*' 2>/dev/null | wc -l | tr -d ' ')
  kb=$(du -sk "$dest" 2>/dev/null | cut -f1)
  if [ "$n" -gt 5 ]; then
    printf '%-38s %-8s %s\n' "$tier/$dir" "$n" "ok (${kb}KB)"
    pass=$((pass+1))
  else
    printf '%-38s %-8s %s\n' "$tier/$dir" "$n" "EMPTY - needs manual fix"
    fail=$((fail+1))
  fi
  [ "$FIX" -eq 1 ] && [ "$n" -gt 5 ] && fixed=$((fixed+1))
done < "$TSV"

printf '%s\n' "----------------------------------------------------------------------"
printf 'populated: %s   empty: %s' "$pass" "$fail"
[ "$FIX" -eq 1 ] && printf '   repaired: %s' "$fixed"
echo
[ "$fail" -eq 0 ] || { echo; echo "For any still-empty repo, run:"; echo "  git -C <path> sparse-checkout disable && git -C <path> checkout HEAD"; }

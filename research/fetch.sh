#!/usr/bin/env bash
# TripFit reference-repo fetcher.
#
# Clones every reference repo in repos.tsv into research/<tier>/<dir>/, then
# writes MANIFEST.json recording the commit each directory is pinned to.
#
#   ./fetch.sh            clone anything missing, refresh manifest
#   ./fetch.sh --update   also git-fetch existing clones and reset to origin/HEAD
#   ./fetch.sh --force    delete and re-clone everything from scratch
#   ./fetch.sh --verify   check each pinned commit still resolves on origin
#   ./fetch.sh --resparse re-clone using sparse patterns from repos.tsv (drops the
#                         datasets/docs/fixtures picked up by earlier full clones)
#
# Clones are shallow (--depth 1). Rows carrying a sparse pattern additionally use
# a blobless partial clone (--filter=blob:none), so we never download datasets,
# docs sites, test fixtures or logs we will not read. These repos exist so we can
# READ patterns; runtime dependencies come from the npm registry, not from here.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TSV="$HERE/repos.tsv"
MANIFEST="$HERE/MANIFEST.json"
WORKER="$HERE/.worker.sh"
JOBS="${JOBS:-6}"

MODE="fetch"
case "${1:-}" in
  "")         MODE="fetch" ;;
  --update)   MODE="update" ;;
  --force)    MODE="force" ;;
  --verify)   MODE="verify" ;;
  --resparse) MODE="resparse" ;;
  -h|--help)  sed -n '2,18p' "$0"; exit 0 ;;
  *) echo "unknown flag: $1 (try --help)" >&2; exit 2 ;;
esac

command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# ------------------------------------------------------------- worker program
cat > "$WORKER" <<'WORKER_EOF'
#!/usr/bin/env bash
set -uo pipefail
HERE="$1"; MODE="$2"; entry="$3"

tier="${entry%%$'\t'*}";  entry="${entry#*$'\t'}"
dir="${entry%%$'\t'*}";   entry="${entry#*$'\t'}"
url="${entry%%$'\t'*}";   entry="${entry#*$'\t'}"
sparse="${entry%%$'\t'*}"

emit() { printf '%s|%s|%s|%s\n' "$1" "$tier" "$dir" "${4:-}"; }

# ---- alias rows: point at an existing clone, never clone anything
case "$url" in
  alias:*)
    target="${url#alias:}"
    if [ -d "$HERE/$target/.git" ]; then
      emit ALIAS "$tier" "$dir" "$target"
    else
      emit BROKENALIAS "$tier" "$dir" "$url"
    fi
    exit 0
    ;;
  raw:*)
    target="${url#raw:}"
    out="$HERE/$tier/$dir"
    mkdir -p "$out"
    if curl -fsSL --max-time 60 -o "$out/README.md" "$target" 2>/dev/null; then
      bytes="$(wc -c < "$out/README.md" | tr -d ' ')"
      emit RAW "$tier" "$dir" "$target ($bytes bytes)"
    else
      emit FAILED "$tier" "$dir" "$target"
    fi
    exit 0
    ;;
esac

dest="$HERE/$tier/$dir"
use_sparse=0
[ "$sparse" != "-" ] && [ -n "$sparse" ] && use_sparse=1

if [ "$MODE" = "verify" ]; then
  sha="$(git -C "$dest" rev-parse HEAD 2>/dev/null)" || { emit MISSING "$tier" "$dir" "$url"; exit 0; }
  if git -C "$dest" fetch -q --depth 1 origin 2>/dev/null &&
     git -C "$dest" cat-file -e "$sha^{commit}" 2>/dev/null; then
    emit OK "$tier" "$dir" "$sha"
  else
    emit STALE "$tier" "$dir" "$sha"
  fi
  exit 0
fi

# --resparse: any row that declares patterns gets rebuilt as a blobless partial
# clone, whether or not a directory is already there.
rebuild=0
[ "$MODE" = "resparse" ] && [ "$use_sparse" -eq 1 ] && rebuild=1
[ "$MODE" = "force" ] && rebuild=1

if [ "$rebuild" -eq 1 ] && [ -d "$dest" ]; then rm -rf "$dest"; fi

if [ ! -d "$dest/.git" ]; then
  mkdir -p "$(dirname "$dest")"
  if [ "$use_sparse" -eq 1 ]; then
    if git clone -q --depth 1 --single-branch --filter=blob:none --sparse "$url" "$dest" 2>/dev/null; then
      # shellcheck disable=SC2086
      if git -C "$dest" sparse-checkout set --no-cone $sparse >/dev/null 2>&1; then
        emit CLONED "$tier" "$dir" "partial"
      else
        # sparse set failed: fall back to a full blobless checkout rather than
        # leaving the repo half-populated
        git -C "$dest" sparse-checkout disable >/dev/null 2>&1
        emit CLONED "$tier" "$dir" "partial-full"
      fi
      exit 0
    fi
  else
    if git clone -q --depth 1 --single-branch "$url" "$dest" 2>/dev/null; then
      emit CLONED "$tier" "$dir" "full"
      exit 0
    fi
  fi
  rm -rf "$dest"
  emit FAILED "$tier" "$dir" "$url"
  exit 0
fi

# Existing clone.
if [ "$MODE" = "update" ]; then
  git -C "$dest" fetch -q --depth 1 origin 2>/dev/null &&
    git -C "$dest" reset -q --hard FETCH_HEAD 2>/dev/null
fi
if [ "$use_sparse" -eq 1 ] && [ ! -f "$dest/.git/info/sparse-checkout" ]; then
  # existing full clone that never got patterns applied.
  # NOTE: --no-cone is REQUIRED on both calls. Omitting it made git write the
  # default `/*` + `!/*/` pattern, which materialises an empty working tree.
  git -C "$dest" sparse-checkout init --no-cone >/dev/null 2>&1
  # shellcheck disable=SC2086
  git -C "$dest" sparse-checkout set --no-cone $sparse >/dev/null 2>&1
  # verify we actually got a populated tree, else fall back to everything
  if [ "$(find "$dest" -type f -not -path '*/.git/*' 2>/dev/null | wc -l)" -lt 5 ]; then
    git -C "$dest" sparse-checkout disable >/dev/null 2>&1
    emit TRIMMED "$tier" "$dir" "sparse-empty-fallback-full"
  else
    emit TRIMMED "$tier" "$dir" "sparse-applied"
  fi
  exit 0
fi
emit CACHED "$tier" "$dir"
WORKER_EOF
chmod +x "$WORKER"
trap 'rm -f "$WORKER"' EXIT

# --------------------------------------------------------------- read config
entries=()
while IFS=$'\t' read -r tier dir url purpose sparse; do
  case "$tier" in ''|'#'*) continue ;; esac
  [ -n "$url" ] || continue
  entries+=("$tier"$'\t'"$dir"$'\t'"$url"$'\t'"${sparse:--}")
done < "$TSV"
log "config: ${#entries[@]} entries | mode=$MODE | JOBS=$JOBS"

# ------------------------------------------------------------------ run fleet
# Stream worker lines to stdout as they land (tee) instead of capturing into a
# variable, so a long fleet shows progress rather than going silent.
RESULTS_FILE="$HERE/.results"
: > "$RESULTS_FILE"
printf '%s\n' "${entries[@]}" \
  | xargs -P "$JOBS" -I{} "$WORKER" "$HERE" "$MODE" {} 2>/dev/null \
  | tee -a "$RESULTS_FILE"
results="$(cat "$RESULTS_FILE")"

count() { printf '%s\n' "$results" | grep -c "^$1|" || true; }
echo
for k in CLONED CACHED TRIMMED ALIAS RAW OK; do printf '%-7s %s\n' "$k" "$(count $k)"; done
for k in FAILED MISSING STALE BROKENALIAS; do printf '%-12s %s\n' "$k" "$(count $k)"; done
echo
printf '%s\n' "$results" | grep -E '^(FAILED|MISSING|STALE|BROKENALIAS)\|' | sed 's/^/  !! /'
echo

[ "$MODE" = "verify" ] && exit 0
[ "$(count FAILED)" -gt 0 ] && log "some clones failed - rerun to retry"

# ------------------------------------------------------------------ manifest
python3 - "$HERE" "$MANIFEST" <<'PY'
import json, os, subprocess, sys, datetime

here, manifest_path = sys.argv[1], sys.argv[2]
licenses = ("LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING",
            "LICENSE-MIT", "LICENSE-APACHE")
manifests = ("package.json", "pyproject.toml", "Cargo.toml", "setup.py", "pom.xml", "build.gradle")

def run(*args, cwd=None):
    try:
        return subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                              timeout=90).stdout.strip()
    except Exception:
        return ""

def dirsize(path):
    out = run("du", "-sb", path)
    head = out.split()[:1]
    return int(head[0]) if head and head[0].isdigit() else None

entries = []
with open(os.path.join(here, "repos.tsv"), encoding="utf-8") as fh:
    for line in fh:
        if not line.strip() or line.startswith("#"):
            continue
        p = line.rstrip("\n").split("\t")
        if len(p) < 3:
            continue
        tier, name, url = p[0], p[1], p[2]
        purpose = p[3] if len(p) > 3 else ""
        sparse = p[4] if len(p) > 4 else "-"
        path = os.path.join(here, tier, name)
        rec = {"tier": tier, "name": name, "url": url, "purpose": purpose,
               "sparse": sparse, "path": f"research/{tier}/{name}"}

        if url.startswith("alias:"):
            rec["kind"] = "alias"
            rec["alias_of"] = url[len("alias:"):]
            rec["present"] = os.path.isdir(os.path.join(here, rec["alias_of"], ".git"))
        elif url.startswith("raw:"):
            rec["kind"] = "raw_file"
            f = os.path.join(path, "README.md")
            rec["present"] = os.path.exists(f)
            rec["size_bytes"] = os.path.getsize(f) if rec["present"] else None
        else:
            rec["kind"] = "clone"
            if os.path.isdir(os.path.join(path, ".git")):
                rec["present"] = True
                rec["commit"] = run("git", "rev-parse", "HEAD", cwd=path)
                rec["commit_date"] = run("git", "log", "-1", "--format=%cI", cwd=path)
                rec["partial_clone"] = bool(run("git", "config", "--get", "remote.origin.promisor", cwd=path))
                sc = os.path.join(path, ".git", "info", "sparse-checkout")
                rec["sparse_applied"] = os.path.exists(sc)
                rec["license_file"] = next((n for n in licenses
                                            if os.path.exists(os.path.join(path, n))), "")
                rec["manifest_file"] = next((f for f in manifests
                                             if os.path.exists(os.path.join(path, f))), "")
                rec["size_bytes"] = dirsize(path)
                top = sorted(d for d in os.listdir(path) if not d.startswith("."))
                rec["top_level"] = top[:14]
            else:
                rec["present"] = False
        entries.append(rec)

real = [e for e in entries if e.get("kind") == "clone" and e.get("present")]
out = {
    "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "generator": "research/fetch.sh",
    "clone_mode": "shallow (--depth 1); blobless partial (--filter=blob:none) where a sparse pattern is declared",
    "counts": {
        "entries": len(entries),
        "clones_present": len(real),
        "clones_missing": sum(1 for e in entries if e.get("kind") == "clone" and e.get("present") is False),
        "aliases": sum(1 for e in entries if e.get("kind") == "alias"),
        "raw_files": sum(1 for e in entries if e.get("kind") == "raw_file"),
        "partial_clones": sum(1 for e in real if e.get("partial_clone")),
        "by_tier": {t: sum(1 for e in entries if e["tier"] == t)
                    for t in sorted({e["tier"] for e in entries})},
        "total_size_bytes": sum(e.get("size_bytes") or 0 for e in entries),
    },
    "repos": entries,
}
with open(manifest_path, "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=2)
    fh.write("\n")

c = out["counts"]
print("wrote", manifest_path)
print(f"  entries        {c['entries']}")
print(f"  clones present {c['clones_present']}  (missing {c['clones_missing']})")
print(f"  partial        {c['partial_clones']}")
print(f"  aliases        {c['aliases']}   raw files {c['raw_files']}")
print(f"  by tier        {c['by_tier']}")
print(f"  total size     {c['total_size_bytes'] / 1048576:.1f} MiB")
PY

du -sh "$HERE" 2>/dev/null

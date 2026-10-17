#!/usr/bin/env bash
# set-deepgram-key.sh — put a Deepgram API key into .env without it ever reaching the transcript.
#
# The key is typed once, hidden, and travels by stdin — never by argv (argv is world-readable in the process
# list and lands in shell history). Writing it is atomic and mode 600. Verification uses a 0600 header file
# because `curl -H "Authorization: Token …"` would expose the value on the command line.
#
# usage:  ./scripts/set-deepgram-key.sh                    # prompts, verifies, writes ./.env
#         ./scripts/set-deepgram-key.sh --file ~/.dsh/.env # write somewhere else
#         ./scripts/set-deepgram-key.sh --no-verify        # skip the API check (offline)
#         read -rs K && printf '%s' "$K" | ./scripts/set-deepgram-key.sh   # non-interactive
#
# exit: 0 written · 1 refused (bad key, tracked file, unwritable) · 2 usage
set -u
umask 077

FILE=".env"
VERIFY=1
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --file) FILE="${2:-}"; shift 2 ;;
    --file=*) FILE="${1#*=}"; shift ;;
    --no-verify) VERIFY=0; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# --- read the key, hidden, from a terminal or from stdin --------------------------------------------
KEY=""
if [ -t 0 ]; then
  printf 'Deepgram API key (paste, input hidden): ' >&2
  IFS= read -rs KEY
  printf '\n' >&2
else
  IFS= read -rs KEY
fi
# Trim surrounding whitespace and any stray CR — a pasted key with a newline is the most common failure.
KEY="$(printf '%s' "$KEY" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

if [ -z "$KEY" ]; then
  echo "refused: no key entered" >&2
  exit 1
fi
if printf '%s' "$KEY" | grep -q '[^A-Za-z0-9._-]'; then
  echo "refused: the key contains characters a Deepgram key never has (spaces? quotes? shell prompt?)" >&2
  exit 1
fi
if [ "${#KEY}" -lt 24 ] || [ "${#KEY}" -gt 96 ]; then
  echo "refused: ${#KEY} characters is not a Deepgram key length (expected 24–96)" >&2
  exit 1
fi

# --- refuse to write where git can see it ----------------------------------------------------------
case "$FILE" in
  *'*'*|'?'*) echo "refused: no globs in --file" >&2; exit 1 ;;
esac
DIR="$(cd "$(dirname "$FILE")" 2>/dev/null && pwd)" || { echo "refused: no such directory for $FILE" >&2; exit 1; }
TARGET="$DIR/$(basename "$FILE")"
if command -v git >/dev/null 2>&1; then
  # Only ask git about a path inside its work tree. `check-ignore` on a path outside one exits non-zero with
  # "is outside repository", which is not the same answer as "not ignored" — treating the two alike refused
  # every legitimate --file under /tmp until this was fixed.
  TOP="$(cd "$DIR" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$TOP" ]; then
    REL="${TARGET#"$TOP"/}"
    if git -C "$TOP" ls-files --error-unmatch -- "$REL" >/dev/null 2>&1; then
      echo "refused: $TARGET is TRACKED by git — a key written here would be committed" >&2
      exit 1
    fi
    if ! git -C "$TOP" check-ignore -q -- "$REL"; then
      echo "warning: $TARGET is not gitignored — add it before committing anything" >&2
      [ "$FORCE" -eq 1 ] || { echo "refused (pass --force if you are certain)"; exit 1; }
    fi
  fi
fi

# --- verify against the API, reporting only a code -------------------------------------------------
# 200 = accepted · 403 = accepted but this key's role cannot mint a token (still a live key) ·
# 401 = rejected · 402 = live but out of credit. The response BODY is discarded: it contains a token.
VERDICT="unverified"
if [ "$VERIFY" -eq 1 ]; then
  HDR="$(mktemp "${TMPDIR:-/tmp}/dg-hdr.XXXXXX")"
  printf 'Authorization: Token %s\n' "$KEY" > "$HDR"
  CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
            -H "@$HDR" https://api.deepgram.com/v1/auth/token 2>/dev/null || echo 000)"
  rm -f "$HDR"
  case "$CODE" in
    200) VERDICT="valid — the API accepted it" ;;
    402) VERDICT="valid, but the project is out of credit — add funds before the probe runs" ;;
    403) VERDICT="valid — accepted, but this key's role cannot mint a token (fine for the probe)" ;;
    401) VERDICT="REJECTED (401) — wrong key, revoked, or a partial paste" ;;
    000) VERDICT="unverified — no network to api.deepgram.com" ;;
    *)   VERDICT="unverified — the check returned HTTP $CODE" ;;
  esac
  case "$VERDICT" in
    REJECTED*)
      if [ "$FORCE" -ne 1 ]; then
        echo "refused: $VERDICT" >&2
        echo "  nothing written. re-run with --force only if you know this key is valid." >&2
        exit 1
      fi
      echo "warning: $VERDICT — writing anyway because --force" >&2 ;;
  esac
fi

# --- write atomically, preserving every other line -------------------------------------------------
TMP="$(mktemp "$DIR/.env-new.XXXXXX")" || { echo "refused: cannot write beside $TARGET" >&2; exit 1; }
if [ -f "$TARGET" ]; then
  grep -v '^[[:space:]]*DEEPGRAM_API_KEY=' "$TARGET" > "$TMP" || true
fi
printf 'DEEPGRAM_API_KEY=%s\n' "$KEY" >> "$TMP"
chmod 600 "$TMP"
mv -f "$TMP" "$TARGET" || { rm -f "$TMP"; echo "refused: could not replace $TARGET" >&2; exit 1; }

# --- report without the value ---------------------------------------------------------------------
echo "wrote  DEEPGRAM_API_KEY to $TARGET"
echo "       ${#KEY} characters · mode $(stat -f '%Sp' "$TARGET" 2>/dev/null || stat -c '%a' "$TARGET") · $VERDICT"
echo "       (the value was never printed, and is not in this output or in shell history)"
echo
echo "load it into a shell:"
case "$TARGET" in
  "$(pwd)/.env"|.env) echo "  set -a; . ./.env; set +a" ;;
  *) echo "  set -a; . \"$TARGET\"; set +a" ;;
esac
echo
echo "then review what the probe would send, and run it:"
echo "  pnpm probe:deepgram -- --plan"
echo "  pnpm probe:deepgram -- --out deepgram-probe.json"

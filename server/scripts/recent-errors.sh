#!/usr/bin/env bash
set -euo pipefail

# Pull recent prod backend logs from Azure App Service and surface
# the 5xx tracebacks grouped by endpoint + exception class. The
# point is to answer "what is failing right now" in one command
# instead of the manual ``az webapp log download`` + zipgrep dance
# we did during today's outage triage.
#
# Usage from the repo root:
#
#     ./server/scripts/recent-errors.sh              # default: last 60 min
#     ./server/scripts/recent-errors.sh 15           # last 15 min
#     ./server/scripts/recent-errors.sh 120 verbose  # show full tracebacks
#
# Requires ``az`` CLI logged into the Vita_Intelligence subscription
# and ``python3`` on PATH.

RESOURCE_GROUP="${RESOURCE_GROUP:-Vita_NPD}"
BACKEND_APP="${BACKEND_APP:-vita-npd-backend}"

MINUTES="${1:-60}"
MODE="${2:-summary}"

WORKDIR=$(mktemp -d)
ARCHIVE="${WORKDIR}/logs.zip"
LOG_DIR="${WORKDIR}/extracted"

cleanup() { rm -rf "${WORKDIR}"; }
trap cleanup EXIT

echo "[step 1/3] downloading App Service logs from ${BACKEND_APP}..."
az webapp log download \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${BACKEND_APP}" \
    --log-file "${ARCHIVE}" \
    --output none

echo "[step 2/3] extracting docker logs..."
mkdir -p "${LOG_DIR}"
unzip -q -o "${ARCHIVE}" "LogFiles/*default_docker*.log" -d "${LOG_DIR}" 2>/dev/null || true

# Cutoff in ISO-8601 UTC; the log lines use the same prefix shape
# so a string comparison is a sound filter.
if date --version >/dev/null 2>&1; then
    CUTOFF=$(date -u -d "${MINUTES} minutes ago" +"%Y-%m-%dT%H:%M:%S")
else
    CUTOFF=$(date -u -v-"${MINUTES}"M +"%Y-%m-%dT%H:%M:%S")
fi
echo "[step 3/3] grouping 5xx events since ${CUTOFF}Z..."
echo

LOG_FILES=()
while IFS= read -r f; do
    LOG_FILES+=("${f}")
done < <(find "${LOG_DIR}" -name "*default_docker*.log" -type f | sort)

if [ "${#LOG_FILES[@]}" -eq 0 ]; then
    echo "[error] no docker logs found in archive — App Service may not be writing yet"
    exit 1
fi

# Write the parser to a temp file and feed every docker log via
# stdin. ``python3 -`` reads its script body from stdin so it
# can't share stdin with the log data; an actual file keeps the
# pipeline clean. Keeps the regex + grouping logic readable +
# portable (GNU vs BSD awk diverge on the 3-arg ``match()`` form).
PYTHON="${PYTHON:-python3}"
PYSCRIPT="${WORKDIR}/parse.py"
cat > "${PYSCRIPT}" <<'PYEOF'
import re
import sys
from collections import Counter

cutoff = sys.argv[1]
mode = sys.argv[2]
log_text = sys.stdin.read()

uuid_re = re.compile(
    r"/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)
# Azure prepends ``YYYY-MM-DDTHH:MM:SS.fffffffZ `` to every line —
# strip it before any content-level regex so anchors like ``^`` and
# ``\b`` see the real start of the message.
azure_prefix_re = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+"
)
header_re = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})"
    r".*ERROR django\.request.*Internal Server Error: (?P<path>\S+)"
)
ts_re = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")
app_frame_re = re.compile(r'File "(/app/apps/[^"]+)", line (\d+), in (\S+)')
exc_re = re.compile(
    r"^(?P<exc>[a-zA-Z_][a-zA-Z0-9_.]*"
    r"(?:Error|Exception|Locked|Conflict|NotFound|Required|Invalid"
    r"|Failed|Denied|Mismatch|Forbidden|Exists|Taken|Empty|Timeout))(?::|$|\s)"
)

events: list[tuple[str, str, str, str]] = []
in_block = False
current_ts = ""
current_path = ""
current_exc = ""
current_frame = ""

def flush() -> None:
    if current_path:
        norm = uuid_re.sub("/<uuid>", current_path)
        events.append(
            (current_ts, norm, current_exc or "(unknown)", current_frame)
        )

for raw in log_text.splitlines():
    line = raw.rstrip()
    # Header regex matches the raw line (Azure timestamp + ERROR
    # marker + path). Content regexes (exception name, app frame)
    # need the per-line timestamp stripped because they anchor on
    # ``^`` / ``\b``.
    content = azure_prefix_re.sub("", line)
    header = header_re.search(line)
    if header:
        if in_block:
            flush()
        ts = header.group("ts")
        if ts < cutoff:
            in_block = False
            current_ts = ""
            current_path = ""
            continue
        in_block = True
        current_ts = ts
        current_path = header.group("path")
        current_exc = ""
        current_frame = ""
        continue
    if not in_block:
        continue
    stripped = content.lstrip()
    frame_m = app_frame_re.search(stripped)
    if frame_m:
        current_frame = (
            f"{frame_m.group(1)}:{frame_m.group(2)} in {frame_m.group(3)}"
        )
        continue
    exc_m = exc_re.match(stripped)
    if exc_m:
        current_exc = exc_m.group("exc")
        continue
    # Heuristic: a fresh ERROR / INFO log line ends the current
    # traceback block. ``Traceback`` and ``File "...`` lines are
    # part of the block and don't terminate it.
    if (stripped.startswith(("INFO:", "WARNING:", "ERROR ", "[20"))
            and "Traceback" not in stripped
            and "File " not in stripped):
        flush()
        in_block = False
        current_ts = ""
        current_path = ""
        current_exc = ""
        current_frame = ""

if in_block:
    flush()

if not events:
    print(f"No 5xx errors since {cutoff}Z.")
    sys.exit(0)

print("=" * 60)
print(f"5xx events captured: {len(events)}")
print("=" * 60)
print()
print("── TOP OFFENDERS (endpoint × exception) ──")
print()
header_fmt = "{:>6}  {:<58}  {:<42}  {}"
print(header_fmt.format("count", "endpoint", "exception", "window"))
print(header_fmt.format("-----", "-" * 58, "-" * 42, "-" * 24))

key_counter: Counter[tuple[str, str]] = Counter()
window: dict[tuple[str, str], tuple[str, str]] = {}
first_frame: dict[tuple[str, str], str] = {}
for ts, path, exc, frame in events:
    key = (path, exc)
    key_counter[key] += 1
    if key not in window:
        window[key] = (ts, ts)
    else:
        first, _ = window[key]
        window[key] = (first, ts)
    if frame and key not in first_frame:
        first_frame[key] = frame

for (path, exc), count in key_counter.most_common(20):
    first, last = window[(path, exc)]
    span = f"{first[11:]}..{last[11:]}"
    print(header_fmt.format(count, path[:58], exc[:42], span))

print()
print("── FIRST APP-LEVEL FRAME (where the raise lives) ──")
print()
shown = 0
for (path, exc), _ in key_counter.most_common(10):
    frame = first_frame.get((path, exc))
    if not frame:
        continue
    print(f"{path}  →  {exc}")
    print(f"    {frame}")
    print()
    shown += 1
if shown == 0:
    print("(no app-frame info captured — tracebacks may be truncated)")

if mode == "verbose":
    print()
    print("── RAW EVENTS ──")
    print()
    for ts, path, exc, frame in events:
        print(f"{ts}  {path}  {exc}  {frame}")
PYEOF

cat "${LOG_FILES[@]}" | "${PYTHON}" "${PYSCRIPT}" "${CUTOFF}" "${MODE}"

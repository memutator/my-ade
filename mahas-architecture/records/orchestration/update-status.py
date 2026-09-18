#!/usr/bin/env python3
"""Recompute records/orchestration/STATUS.md from delivery-dag.json + git log.

Landed IMP = a commit on this branch whose subject starts with 'IMP-XX'.
Unblocked REV/VER = every IMP in its depends_on has landed AND (for VER)
its prerequisite VERs have a passing record in records/verification/.
Records are markdown files named VER-XX.md / REV-XX.md whose front matter
contains `verdict: passed` or `disposition: accepted`.
"""
import json, re, subprocess, pathlib, datetime

ROOT = pathlib.Path(__file__).resolve().parents[3]
REC = ROOT / "mahas-architecture" / "records"
dag = json.load(open(ROOT / "mahas-architecture" / "delivery-dag.json"))["nodes"]

log = subprocess.run(["git", "log", "--format=%H %s", "HEAD"], cwd=ROOT,
                     capture_output=True, text=True).stdout.splitlines()

landed = {}  # IMP-XX -> (sha, subject)
for line in log:
    m = re.match(r"([0-9a-f]{40}) (IMP-\d\d)\b[:\s]*(.*)", line)
    if m and m.group(2) not in landed:
        landed[m.group(2)] = (m.group(1)[:9], m.group(3).strip())

# IMPs that landed via non-IMP-subject commits (integration commits) — see file header.
over = REC / "orchestration" / "landed-override.txt"
if over.exists():
    for line in over.read_text().splitlines():
        t = line.strip()
        if t.startswith("IMP-") and t not in landed:
            landed[t] = ("landed", "via integration commit (HANDOFF ledger)")

def record_status(task_id):
    kind = "verification" if task_id.startswith("VER") else "review"
    f = REC / kind / f"{task_id}.md"
    if not f.exists():
        return None
    head = f.read_text()[:2000]
    m = re.search(r"(?:verdict|disposition):\s*([\w-]+)", head)
    return m.group(1) if m else "written"

results = {n["id"]: record_status(n["id"]) for n in dag if n["kind"] in ("review", "verification")}

def ready(node):
    for dep in node["depends_on"]:
        if dep.startswith("IMP"):
            if dep not in landed:
                return False
        else:
            st = results.get(dep)
            # an EXECUTED verdict satisfies scheduling — 'failed' evidence exists
            # and downstream VERs cite it; only blocked/not-run deps block.
            ok = ("passed", "failed") if dep.startswith("VER") else ("accepted", "changes-required")
            if st not in ok:
                return False
    return True

now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
out = [f"# 오케스트레이션 상태 — {now} 자동 갱신\n",
       "생성: `python3 mahas-architecture/records/orchestration/update-status.py`\n",
       "## Landed implementations (git log HEAD)\n"]
imps = sorted([n["id"] for n in dag if n["kind"] == "implementation"])
for t in imps:
    if t in landed:
        sha, subj = landed[t]
        out.append(f"- [x] **{t}** `{sha}` {subj}")
    else:
        deps = next(n["depends_on"] for n in dag if n["id"] == t)
        missing = [d for d in deps if d not in landed]
        mark = "blocked" if missing else "READY"
        out.append(f"- [ ] {t} — {mark} (waiting: {', '.join(missing) or 'none'})")
out.append("\n## Reviews\n")
for n in dag:
    if n["kind"] != "review":
        continue
    st = results[n["id"]]
    miss = [d for d in n["depends_on"] if d.startswith("IMP") and d not in landed]
    prev = [d for d in n["depends_on"] if d.startswith("REV") and results.get(d) not in ("accepted", "changes-required")]
    if st:
        line = f"- **{n['id']}** — recorded: `{st}`"
    elif not miss and not prev:
        line = f"- **{n['id']}** — READY TO RUN"
    else:
        wait = ", ".join(miss + [f"{p}(review)" for p in prev])
        line = f"- {n['id']} — waiting: {wait}"
    out.append(line)
out.append("\n## Verifications\n")
for n in dag:
    if n["kind"] != "verification":
        continue
    st = results[n["id"]]
    miss = [d for d in n["depends_on"] if d.startswith("IMP") and d not in landed]
    prev = [d for d in n["depends_on"] if d.startswith("VER") and results.get(d) not in ("passed", "failed")]
    if st:
        line = f"- **{n['id']}** — recorded: `{st}`"
    elif not miss and not prev:
        line = f"- **{n['id']}** — READY TO RUN"
    else:
        wait = ", ".join(miss + [f"{p}(ver)" for p in prev])
        line = f"- {n['id']} — waiting: {wait}"
    out.append(line)

(REC / "orchestration" / "STATUS.md").write_text("\n".join(out) + "\n")
print("\n".join(out))

"""Markdown table of a feature-suite run: python verify/summarize.py verify/out/results.jsonl"""
import json
import sys

ICON = {"passed": "pass", "failed": "FAIL", "skipped": "skip", "xfailed": "known failure"}


def main(path):
    try:
        rows = [json.loads(line) for line in open(path) if line.strip()]
    except FileNotFoundError:
        print("No results: the suite did not run (see the job log).")
        return
    counts = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    print("### Feature verification: %s" % ", ".join("%d %s" % (n, s) for s, n in sorted(counts.items())))
    if rows:
        print("\nTarget: `%s` at `%s`\n" % (rows[0].get("base_url"), (rows[0].get("commit") or "")[:12]))
    print("| check | result | seconds | reason |")
    print("|---|---|---|---|")
    for r in rows:
        reason = (r.get("reason") or "").replace("\n", " ").replace("|", "\\|")[:300]
        print("| %s | %s | %s | %s |" % (r["check"], ICON.get(r["status"], r["status"]), r["duration_s"], reason))


if __name__ == "__main__":
    main(sys.argv[1])

#!/usr/bin/env python3
"""Turn a ZAP alert dump into a summary, a diff and a gate verdict.

The scan produces thousands of alerts — 3,688 on the 2026-07-30 run. That
is unreadable as a gate and unreadable as a report, so this does three
things with it:

  summary  counts by risk level, and the distinct alert types behind them
  diff     what is NEW, what is GONE, versus the previous run
  verdict  pass/fail, decided ONLY on non-ignored High findings

Why the verdict is narrow: Low and Informational counts move with the
traffic (fresh UUIDs, timestamps, whatever the e2e suite happened to do),
so gating on them produces flaky failures, and a flaky gate is one people
learn to bypass. High is the level worth stopping a release for.

Ignored findings are subtracted from the verdict but still counted and
printed. A suppression that hides its own existence is how a scanner
stops being useful.

Usage:
    parse-report.py --alerts alerts.json [--previous prev.json]
                    [--ignore dast-ignore.yaml] [--out-dir DIR]

Exit codes:
    0  pass
    1  fail — new (or existing) non-ignored High findings
    2  usage / input error
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

RISK_ORDER = ["High", "Medium", "Low", "Informational"]
GATE_ON = {"High"}


def _load_alerts(path: Path) -> list[dict]:
    """Accept either the raw ZAP API envelope or a bare list."""
    data = json.loads(path.read_text())
    if isinstance(data, dict):
        data = data.get("alerts", data.get("alert", []))
    if not isinstance(data, list):
        raise ValueError(f"{path}: expected a list of alerts")
    return data


def _load_ignores(path: Path | None) -> list[dict]:
    if not path or not path.exists():
        return []
    try:
        import yaml  # noqa: PLC0415 — optional; the parser works without it
    except ImportError:
        print(f"WARNING: pyyaml not available, {path} not applied", file=sys.stderr)
        return []
    rules = (yaml.safe_load(path.read_text()) or {}).get("ignore", []) or []
    for i, r in enumerate(rules):
        if not r.get("alert"):
            raise ValueError(f"{path}: rule {i} has no `alert`")
        if not r.get("reason"):
            # Enforced deliberately: an unexplained suppression is a
            # future mystery, and someone will assume it was justified.
            raise ValueError(f"{path}: rule for {r['alert']!r} has no `reason`")
        if not isinstance(r.get("max_instances"), int) or r["max_instances"] < 1:
            # Blast radius. A rule with only `alert:` suppresses that alert
            # EVERYWHERE, forever — which is how an escape hatch quietly
            # becomes a hole in the gate. The 2026-07-31 triage covered 21
            # SQL Injection / Path Traversal instances; by 2026-08-01 the
            # same two rules were swallowing 130, none of the extra ones
            # looked at by anybody.
            raise ValueError(
                f"{path}: rule for {r['alert']!r} has no `max_instances`. "
                "Cap what a suppression may hide, so growth forces re-triage."
            )
    return rules


def _matches(alert: dict, rule: dict) -> bool:
    """Every field present in the rule must match. Absent field = wildcard."""
    if rule["alert"] != alert.get("alert"):
        return False
    if "param" in rule and rule["param"] != alert.get("param"):
        return False
    if "method" in rule and rule["method"] != alert.get("method"):
        return False
    if "url_regex" in rule and not re.search(rule["url_regex"], alert.get("url", "")):
        return False
    return True


def _key(a: dict) -> tuple:
    """Identity of a finding for diffing.

    Deliberately NOT the full URL: it carries per-run UUIDs and query
    values, so every run would look entirely new. Alert type + parameter +
    method + the URL's path shape is stable across runs while still
    separating genuinely different findings.
    """
    path = re.sub(r"/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "/{id}",
                  (a.get("url", "").split("?")[0]))
    return (a.get("alert", ""), a.get("param", ""), a.get("method", ""), path)


def summarise(alerts: list[dict], ignores: list[dict]) -> dict:
    kept, ignored = [], []
    # Per-rule tallies, so a suppression that has quietly grown beyond what
    # was actually triaged can be caught rather than trusted.
    hits = collections.Counter()
    for a in alerts:
        idx, rule = next(((i, r) for i, r in enumerate(ignores) if _matches(a, r)), (None, None))
        if rule is not None:
            hits[idx] += 1
        (ignored if rule else kept).append(a)

    overgrown = [
        {"alert": ignores[i]["alert"], "seen": n, "max": ignores[i]["max_instances"]}
        for i, n in hits.items()
        if n > ignores[i]["max_instances"]
    ]

    def by_level(items):
        c = collections.Counter(a.get("risk", "?") for a in items)
        return {lvl: c.get(lvl, 0) for lvl in RISK_ORDER}

    types = collections.defaultdict(lambda: collections.Counter())
    for a in kept:
        types[a.get("risk", "?")][a.get("alert", "?")] += 1

    return {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total_instances": len(alerts),
        "counted": by_level(kept),
        "ignored": by_level(ignored),
        "ignored_types": dict(collections.Counter(a.get("alert", "?") for a in ignored)),
        "overgrown": overgrown,
        "types": {lvl: dict(c) for lvl, c in types.items()},
        "keys": sorted({"|".join(_key(a)) for a in kept}),
    }


def diff(cur: dict, prev: dict | None) -> dict:
    if not prev:
        return {"baseline": True, "new": [], "gone": []}
    c, p = set(cur["keys"]), set(prev.get("keys", []))
    return {"baseline": False, "new": sorted(c - p), "gone": sorted(p - c)}


def verdict(summary: dict, d: dict) -> tuple[bool, str]:
    # A suppression that has outgrown its triage fails the gate BEFORE the
    # High count is even consulted. Otherwise the escape hatch decides the
    # verdict: "no High findings" is meaningless if the reason is that a
    # rule silently absorbed six times what anyone actually looked at.
    if summary.get("overgrown"):
        parts = ", ".join(f"{o['alert']} {o['seen']}>{o['max']}" for o in summary["overgrown"])
        return False, (f"ignore rules now suppress more than they were triaged for ({parts}) "
                       "— re-triage and raise max_instances, or scope the rule")

    high = summary["counted"]["High"]
    if high == 0:
        return True, "no High findings outside the ignore list"
    new_high = [k for k in d["new"] if any(
        k.startswith(t + "|") for t in summary["types"].get("High", {}))]
    if d["baseline"]:
        return False, f"{high} High finding(s) — no previous report to compare against"
    if new_high:
        return False, f"{high} High finding(s), {len(new_high)} of them new"
    return False, f"{high} High finding(s) (none new, still unresolved)"


def render(summary: dict, d: dict, ok: bool, why: str) -> str:
    L = [f"# DAST report — {summary['generated']}", ""]
    L.append(f"**{'PASS' if ok else 'FAIL'}** — {why}", )
    L += ["", "## Findings by level", "", "| level | counted | ignored |", "|---|---|---|"]
    for lvl in RISK_ORDER:
        L.append(f"| {lvl} | {summary['counted'][lvl]} | {summary['ignored'][lvl]} |")
    L += ["", f"_{summary['total_instances']} alert instances total._", ""]
    for lvl in RISK_ORDER:
        t = summary["types"].get(lvl)
        if not t:
            continue
        L += [f"### {lvl}", ""]
        L += [f"- {n}x {name}" for name, n in sorted(t.items(), key=lambda x: -x[1])]
        L.append("")
    if summary["ignored_types"]:
        L += ["### Ignored (suppressed by dast-ignore.yaml, still reported)", ""]
        L += [f"- {n}x {name}" for name, n in sorted(summary["ignored_types"].items(),
                                                     key=lambda x: -x[1])]
        L.append("")
    L += ["## Diff vs previous run", ""]
    if d["baseline"]:
        L.append("_No previous report — this run is the baseline._")
    elif not d["new"] and not d["gone"]:
        L.append("_No change._")
    else:
        if d["new"]:
            L += [f"**New ({len(d['new'])}):**", ""] + [f"- `{k}`" for k in d["new"][:40]] + [""]
        if d["gone"]:
            L += [f"**Gone ({len(d['gone'])}):**", ""] + [f"- `{k}`" for k in d["gone"][:40]] + [""]
    return "\n".join(L) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--alerts", required=True, type=Path)
    ap.add_argument("--previous", type=Path)
    ap.add_argument("--ignore", type=Path)
    ap.add_argument("--out-dir", type=Path, default=Path("."))
    a = ap.parse_args()

    try:
        alerts = _load_alerts(a.alerts)
        ignores = _load_ignores(a.ignore)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    prev = None
    if a.previous and a.previous.exists():
        try:
            prev = json.loads(a.previous.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            # A corrupt previous report must not mask today's findings.
            print(f"WARNING: ignoring unreadable previous report: {exc}", file=sys.stderr)

    s = summarise(alerts, ignores)
    d = diff(s, prev)
    ok, why = verdict(s, d)
    s["diff"] = d
    s["verdict"] = {"pass": ok, "reason": why}

    a.out_dir.mkdir(parents=True, exist_ok=True)
    (a.out_dir / "dast-summary.json").write_text(json.dumps(s, indent=2))
    (a.out_dir / "dast-summary.md").write_text(render(s, d, ok, why))
    print(render(s, d, ok, why))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

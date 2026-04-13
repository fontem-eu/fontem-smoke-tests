#!/usr/bin/env python3
"""Upload a ZAP HTML report to BookStack.

Usage:
    python3 upload-zap-report.py <report_file> <zap_api_url> <run_id>

Environment:
    BOOKSTACK_URL, BOOKSTACK_TOKEN_ID, BOOKSTACK_TOKEN_SECRET
"""
import json
import os
import sys
import urllib.request
import urllib.error

BOOKSTACK_URL = os.environ["BOOKSTACK_URL"]
TOKEN_ID = os.environ["BOOKSTACK_TOKEN_ID"]
TOKEN_SECRET = os.environ["BOOKSTACK_TOKEN_SECRET"]
AUTH = f"Token {TOKEN_ID}:{TOKEN_SECRET}"


def api(method, path, data=None):
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(
        f"{BOOKSTACK_URL}/api/{path}",
        data=body,
        method=method,
        headers={
            "Authorization": AUTH,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def find_or_create_shelf():
    shelves = api("GET", "shelves")["data"]
    for s in shelves:
        if s["name"] == "Security":
            return s["id"]
    result = api("POST", "shelves", {
        "name": "Security",
        "description": "Security testing reports and findings",
    })
    print(f"  Created shelf: Security (ID: {result['id']})")
    return result["id"]


def find_or_create_book(shelf_id):
    books = api("GET", "books")["data"]
    for b in books:
        if b["name"] == "OWASP ZAP":
            return b["id"]
    result = api("POST", "books", {
        "name": "OWASP ZAP",
        "description": "DAST scan reports from OWASP ZAP",
    })
    book_id = result["id"]
    print(f"  Created book: OWASP ZAP (ID: {book_id})")
    # Assign to shelf
    api("PUT", f"shelves/{shelf_id}", {"books": [book_id]})
    return book_id


def get_alerts_summary(zap_url, target):
    """Get alert summary from ZAP API."""
    try:
        req = urllib.request.Request(
            f"{zap_url}/JSON/alert/view/alertsSummary/?baseurl={target}"
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())["alertsSummary"]
    except Exception:
        return {}


def get_alerts(zap_url, target):
    """Get alert details from ZAP API."""
    try:
        req = urllib.request.Request(
            f"{zap_url}/JSON/alert/view/alerts/?baseurl={target}&start=0&count=200"
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())["alerts"]
    except Exception:
        return []


def build_summary_html(summary, alerts):
    """Build an HTML summary page from ZAP alerts."""
    html = "<h2>Summary</h2><table><tr><th>Severity</th><th>Count</th></tr>"
    order = {"High": 0, "Medium": 1, "Low": 2, "Informational": 3}
    for k, v in sorted(summary.items(), key=lambda x: order.get(x[0], 4)):
        if int(v) > 0:
            html += f"<tr><td><strong>{k}</strong></td><td>{v}</td></tr>"
    html += "</table>"

    # Deduplicated alert table
    html += "<h2>Alerts</h2><table><tr><th>Risk</th><th>Name</th><th>Confidence</th><th>Description</th></tr>"
    seen = set()
    for a in alerts:
        key = (a.get("risk", ""), a.get("name", ""))
        if key in seen:
            continue
        seen.add(key)
        desc = a.get("description", "")[:300].replace("<", "&lt;").replace(">", "&gt;")
        html += (
            f"<tr><td>{a.get('risk','')}</td>"
            f"<td>{a.get('name','')}</td>"
            f"<td>{a.get('confidence','')}</td>"
            f"<td>{desc}</td></tr>"
        )
    html += "</table>"
    return html


def main():
    report_file = sys.argv[1]
    zap_url = sys.argv[2]
    run_id = sys.argv[3]
    target = sys.argv[4] if len(sys.argv) > 4 else ""

    print(f"Uploading ZAP report: {run_id}")

    # Get alerts from ZAP (may fail if ZAP is already stopped)
    summary = get_alerts_summary(zap_url, target)
    alerts = get_alerts(zap_url, target)

    total = sum(int(v) for v in summary.values())
    desc = f"{total} alerts"
    if summary:
        desc += f" (High:{summary.get('High',0)} Med:{summary.get('Medium',0)} Low:{summary.get('Low',0)} Info:{summary.get('Informational',0)})"
    print(f"  {desc}")

    # BookStack structure: Security > OWASP ZAP > run_YYYYMMDD_HHMM
    shelf_id = find_or_create_shelf()
    book_id = find_or_create_book(shelf_id)

    # Create chapter
    chapter = api("POST", "chapters", {
        "book_id": book_id,
        "name": run_id,
        "description": desc,
    })
    chapter_id = chapter["id"]
    print(f"  Created chapter: {run_id} (ID: {chapter_id})")

    # Upload HTML report as a page
    with open(report_file) as f:
        report_html = f.read()

    api("POST", "pages", {
        "chapter_id": chapter_id,
        "name": "ZAP Full Report",
        "html": report_html,
    })
    print("  Uploaded full report")

    # Upload summary page
    if summary:
        summary_html = build_summary_html(summary, alerts)
        api("POST", "pages", {
            "chapter_id": chapter_id,
            "name": "Alert Summary",
            "html": summary_html,
        })
        print("  Uploaded alert summary")

    print(f"  Done: Security > OWASP ZAP > {run_id}")


if __name__ == "__main__":
    main()

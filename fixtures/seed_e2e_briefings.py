"""Prepare the Briefings feature for the e2e gate, then materialise it.

Runs as an init container of the e2e Job, in the community-api image, before
Playwright starts. It does three things, in order, and any of them failing
fails the gate:

1. SEEDS A SYNTHETIC BRIEFING whose query invents its own rows.

   The obvious alternative was to write fake Contract and Authority nodes into
   the shared Neo4j. That was rejected: the shared graph is read by STAGING as
   well as testing, so invented awards would show up in a human-facing UI; the
   fixture would need credentials, a teardown, and protection from the ETL;
   and worst of all the assertions would be tied to real data that changes
   daily, which is how a promotion gate becomes flaky.

   A Cypher UNWIND over a literal list needs no graph at all. It is
   deterministic, dated relative to today so it always falls inside the
   runner's window, and it spans regions and magnitudes so the region filter
   and the volume ranking are both genuinely exercised. Every row says
   SMOKE TEST FIXTURE in its title, so nobody mistakes one for a finding.

2. RE-VALIDATES EVERY PUBLISHED QUERY, including the real ones.

   This is the part a fixture alone would miss. A fixture proves the pipeline
   works; it says nothing about whether `public-contracts` still matches the
   graph after somebody renames a property. Validation runs each query against
   the live stores and reports subscribable/not, so a real query that has
   quietly stopped matching fails the gate here — early, and with the check
   name that broke — instead of silently serving an empty feed.

3. RUNS THE FEED REFRESH, so feed_items has something in it when the browser
   arrives. Otherwise every UI assertion would be racing a 6-hourly CronJob.
"""
import asyncio
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

import asyncpg
import jwt

BASE = os.environ.get("CAPI_URL", "http://fontem-community-api:8001")
SLUG = "e2e-smoke-fixture"
GROUP_SLUG = "e2e-smoke"

# The catalogue is admin-only to write, and the gate needs to write to it.
# Rather than add an admin id to the smoke credentials — a secret to provision
# in two environments and to keep in step — the fixture owns its own identity:
# a deterministic UUID5 derived from a fixed subject, promoted to admin
# directly in the database this script already has a connection string for.
# auth.py would auto-create the row on first request, but at new_user, which
# is not enough.
SEED_SUB = "e2e-briefings-fixture"
SEED_ID = str(uuid.uuid5(uuid.NAMESPACE_URL, SEED_SUB))
SEED_EMAIL = "e2e-briefings-fixture@fontem.internal"

# Dates are relative to today, and the DAY IS PART OF THE item_id, so the
# fixture genuinely never ages out. Without the day in the id it did:
# feed_items upserts ON CONFLICT DO NOTHING (to protect first_seen_at), so
# a row keeps the item_time it was first collected with no matter how
# often the query re-runs. The dates froze at first collection and drifted
# out of the runner's FEED_WEEKS window, and every edit to the rows below
# — a region, a value — was silently ignored for the same reason.
#
# Regions are deliberately nested — PT192 is inside PT19 is inside PT — so
# a prefix filter has something to actually discriminate.
QUERY = """UNWIND [
  {n: 1, region: 'PT192', value: 4200000.0},
  {n: 2, region: 'PT150', value: 1750000.0},
  {n: 3, region: 'ES300', value: 980000.0},
  {n: 4, region: 'DE300', value: 12500000.0},
  {n: 5, region: 'PT1A',  value: 640000.0}
] AS f
WITH f, toString(date() - duration({days: f.n})) AS day
WHERE day > left($since, 10)
  AND ('EU' IN $nuts OR any(p IN $nuts WHERE f.region STARTS WITH p))
RETURN
  'smoke-fixture:' + toString(f.n) + ':' + day AS item_id,
  day AS item_time,
  [f.region] AS nuts,
  f.value AS rank_value,
  'SMOKE TEST FIXTURE ' + toString(f.n) + ' — synthetic award of ' +
    toString(toInteger(f.value)) + ' EUR in ' + f.region AS title,
  'https://fontem.eu/briefings' AS link,
  'Synthetic item created by the e2e promotion gate. Not real data.' AS summary
ORDER BY item_time DESC, rank_value DESC"""

DESCRIPTION = (
    "Synthetic fixture for the end-to-end promotion gate. Every item is "
    "invented by the query itself — it reads nothing from the graph — so the "
    "gate asserts against fixed rows rather than against data that changes "
    "daily. Safe to delete; the gate recreates it."
)


def call(method, path, body=None, token=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {token}"},
        data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:500]


def die(message):
    print(f"::error::{message}", file=sys.stderr)
    sys.exit(1)


def upsert(kind, path, body, token):
    status, existing = call("GET", path, token=token)
    if status != 200:
        die(f"cannot list {kind}: {status} {existing}")
    found = next((x for x in existing if x["slug"] == body["slug"]), None)
    verb, target = ("PATCH", f"{path}/{found['id']}") if found else ("POST", path)
    status, out = call(verb, target, body, token=token)
    if status not in (200, 201):
        die(f"cannot save {kind} {body['slug']}: {status} {out}")
    print(f"  {'updated' if found else 'created'} {kind} {body['slug']}")
    return out


async def ensure_admin(dsn: str) -> None:
    """Make sure the fixture's own identity exists and is an admin.

    failed_login_attempts is NOT NULL with no default, so an INSERT that omits
    it fails — which is exactly the kind of thing that only shows up the first
    time this runs in a fresh environment.
    """
    conn = await asyncpg.connect(dsn)
    try:
        await conn.execute(
            """
            INSERT INTO users (id, email, name, trust_level,
                               failed_login_attempts, created_at, email_verified_at)
            VALUES ($1, $2, 'E2E briefings fixture', 'admin', 0, NOW(), NOW())
            ON CONFLICT (id) DO UPDATE SET trust_level = 'admin'
            """,
            SEED_ID, SEED_EMAIL)
    finally:
        await conn.close()


def main():
    secret = os.environ.get("JWT_SECRET")
    database_url = os.environ.get("DATABASE_URL")
    if not secret or not database_url:
        die("JWT_SECRET and DATABASE_URL are required to seed the briefings fixture")

    # asyncpg wants a bare postgresql:// DSN; the app's URL names its driver.
    asyncio.run(ensure_admin(database_url.replace("postgresql+asyncpg://",
                                                  "postgresql://")))
    token = jwt.encode({"sub": SEED_ID, "email": SEED_EMAIL, "name": "e2e"},
                       secret, algorithm="HS256")

    print("seeding the fixture briefing")
    query = upsert("query", "/admin/named-queries", {
        "slug": SLUG, "name": "E2E smoke fixture", "lang": "cypher",
        "query": QUERY, "description": DESCRIPTION,
    }, token)
    group = upsert("group", "/admin/query-groups", {
        "slug": GROUP_SLUG, "name": "E2E smoke", "sort_order": 999,
        "description": "Synthetic briefing used by the promotion gate.",
        "visibility": "public",
    }, token)
    status, out = call("PUT", f"/admin/query-groups/{group['id']}/queries",
                       {"query_ids": [query["id"]]}, token=token)
    if status != 200:
        die(f"cannot attach the fixture query to its group: {status} {out}")

    print("\nvalidating every published query, the real ones included")
    status, catalogue = call("GET", "/admin/named-queries", token=token)
    if status != 200:
        die(f"cannot read the catalogue: {status} {catalogue}")

    broken = []
    for entry in catalogue:
        # Validate what is published plus the fixture we just wrote, which is
        # still a draft on a first run.
        if entry["status"] != "published" and entry["slug"] != SLUG:
            continue
        status, out = call("POST", f"/admin/named-queries/{entry['id']}/validate",
                           token=token)
        if status != 200:
            die(f"validating {entry['slug']} failed outright: {status} {out}")
        report = out["contract_report"]
        failed = [c["id"] for c in report["checks"] if not c["passed"] and not c["waived"]]
        mark = "ok " if report["subscribable"] else "BROKEN"
        print(f"  {mark} {entry['slug']}: {report['duration_ms']} ms, "
              f"{report['row_count']} rows"
              + (f" — failing: {', '.join(failed)}" if failed else ""))
        if not report["subscribable"]:
            broken.append(entry["slug"])
        else:
            call("PATCH", f"/admin/named-queries/{entry['id']}",
                 {"status": "published"}, token=token)

    if broken:
        # The point of doing this in the gate: a query that has quietly
        # stopped matching the graph serves an empty feed forever, and an
        # empty feed looks exactly like a quiet week.
        die("these published queries no longer satisfy the feed contract: "
            + ", ".join(broken))

    print("\nmaterialising, so the browser has something to read")
    result = subprocess.run([sys.executable, "-m", "src.jobs.run_feeds"],
                            check=False, capture_output=True, text=True)
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.returncode != 0:
        die(f"the feed refresh failed (exit {result.returncode})")


if __name__ == "__main__":
    main()

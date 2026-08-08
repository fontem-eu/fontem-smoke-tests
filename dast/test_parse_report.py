"""Key stability for the DAST diff.

The gate fails on any NEW finding, so the key has one job: identify the
same finding across runs. Anything volatile left in it turns a pre-existing
non-issue into a release blocker.

That is not hypothetical. On 2026-08-06 the prod gate failed on a Low
"Timestamp Disclosure - Unix" that had been sitting in the frontend bundle
for months. Nothing changed about it except the filename — Vite
content-hashes bundles, so `index-DhLHBDQ7.js` becomes something else on
every build, and the key moved with it.

Run: python3 -m pytest dast/test_parse_report.py
"""
import importlib.util
import pathlib

_spec = importlib.util.spec_from_file_location(
    "parse_report", pathlib.Path(__file__).parent / "parse-report.py"
)
parse_report = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(parse_report)

_key = parse_report._key  # pylint: disable=protected-access


def alert(url, name="Timestamp Disclosure - Unix"):
    return {"alert": name, "param": "", "method": "GET", "url": url}


BASE = "https://fontem.dast.void42.internal"


def test_a_rebuilt_bundle_is_the_same_finding():
    # The exact failure that blocked the prod promotion.
    before = _key(alert(f"{BASE}/assets/index-DhLHBDQ7.js"))
    after = _key(alert(f"{BASE}/assets/index-Zq9X2mKp.js"))
    assert before == after


def test_it_holds_across_asset_types():
    for ext in ("js", "css", "mjs", "woff2", "svg", "map"):
        a = _key(alert(f"{BASE}/assets/vendor-AAAAAAAA.{ext}"))
        b = _key(alert(f"{BASE}/assets/vendor-BBBBBBBB.{ext}"))
        assert a == b, ext


def test_different_bundles_stay_different():
    # Collapsing the hash must not collapse the bundle name with it, or two
    # genuinely different findings merge and one disappears from the diff.
    a = _key(alert(f"{BASE}/assets/index-AAAAAAAA.js"))
    b = _key(alert(f"{BASE}/assets/vendor-AAAAAAAA.js"))
    assert a != b


def test_real_paths_are_untouched():
    for path in ("/capi/users/me", "/reports/my-long-slug-name", "/about"):
        assert path in _key(alert(BASE + path))[3]


def test_a_short_suffix_is_not_treated_as_a_hash():
    # `-ab.js` is a name, not a content hash. Collapsing it would merge
    # unrelated files.
    assert _key(alert(f"{BASE}/assets/short-ab.js")) != _key(
        alert(f"{BASE}/assets/short-cd.js")
    )


def test_uuid_and_numeric_churn_still_collapse():
    # The behaviour this change sits alongside; guard it has not regressed.
    u1 = _key(alert(f"{BASE}/reports/9b3184a7-2c11-4d0e-8a55-71f0c2d4e001"))
    u2 = _key(alert(f"{BASE}/reports/3f21aa08-6b74-49c2-9f1a-0d5b7c8e2002"))
    assert u1 == u2
    n1 = _key(alert(f"{BASE}/contracts/123456"))
    n2 = _key(alert(f"{BASE}/contracts/987654"))
    assert n1 == n2


def test_key_version_was_bumped():
    # A key change must re-baseline, otherwise every old finding reads as
    # new exactly once and the next run fails for the wrong reason.
    assert parse_report.KEY_VERSION >= 3

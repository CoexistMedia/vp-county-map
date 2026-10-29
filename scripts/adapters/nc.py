#!/usr/bin/env python3
"""North Carolina results adapter (NC State Board of Elections).

NC publishes one tab-separated file per election with every precinct's votes split
by vote type: Election Day, Early Voting (called "One Stop" in 2020), Absentee by
Mail and Provisional. Early and mail ballots are tallied in "precincts" whose Real
Precinct flag is N; Election Day votes come from the real precincts.

  https://s3.amazonaws.com/dl.ncsbe.gov/ENRS/{YYYY_MM_DD}/results_pct_{YYYYMMDD}.zip

The bucket sends no CORS headers, so a browser can't read it directly; this script
fetches it and writes JSON the page can read.

Two jobs:

  baseline  Build data/nc/{year}.json from a past election (county x vote type,
            plus Election Day votes by precinct for the replay).
              python3 scripts/adapters/nc.py baseline 2020 2024

  live      Write the Election night feed for a 2026 race, with vote types. Expected
            early and mail votes come from the ballots NC has already accepted
            (absentee_{date}.zip), so the page knows how much of each is still out.
              python3 scripts/adapters/nc.py live --race 2026_SEN_NC --contest "US SENATE" --loop 60

            Run it on election night next to `python3 -m http.server`. It re-downloads
            the results file every --loop seconds and rewrites data/live/{race}.json.
            If the contest name isn't found it prints the ones that are.

Only counts are read from the absentee file; nothing identifying is written out.
"""
import argparse, collections, csv, io, json, sys, time, urllib.request, zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
S3 = "https://s3.amazonaws.com/dl.ncsbe.gov/ENRS"
DATES = {2020: "20201103", 2022: "20221108", 2024: "20241105", 2026: "20261103"}
TYPE_COLS = {"Election Day": "eday", "Early Voting": "early", "One Stop": "early",
             "Absentee by Mail": "mail", "Provisional": "prov"}
PARTY = {"DEM": "dem", "REP": "rep"}


def url(date, name):
    return f"{S3}/{date[:4]}_{date[4:6]}_{date[6:]}/{name}_{date}.zip"


def fetch_zip(u):
    req = urllib.request.Request(u, headers={"User-Agent": "vp-county-map/1.0", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return zipfile.ZipFile(io.BytesIO(r.read()))


def rows(z):
    name = next(n for n in z.namelist() if n.endswith(".txt") or n.endswith(".csv"))
    return csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8", errors="replace"), delimiter="\t")


def county_fips():
    """NC county name (upper case) -> FIPS, from the baseline file's county names."""
    b = json.loads((ROOT / "data/baseline-2024.json").read_text())
    return {u[0].upper().removesuffix(" COUNTY"): f for f, u in b["units"].items() if u[1] == "NC"}


def tally(z, contest, with_precincts=False):
    fips = county_fips()
    cells = collections.defaultdict(lambda: {"dem": 0, "rep": 0, "total": 0})
    eday = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0, 0]))
    seen = set()
    for r in rows(z):
        seen.add(r["Contest Name"])
        if r["Contest Name"] != contest:
            continue
        f = fips.get(r["County"].strip().upper())
        if not f:
            continue
        party = PARTY.get(r["Choice Party"].strip())
        for col, t in TYPE_COLS.items():
            if col not in r:
                continue
            v = int(r[col] or 0)
            c = cells[(f, t)]
            c["total"] += v
            if party:
                c[party] += v
            if with_precincts and t == "eday" and r.get("Real Precinct", "Y").strip() == "Y":
                p = eday[f][r["Precinct"]]
                p[2] += v
                if party == "dem": p[0] += v
                if party == "rep": p[1] += v
    if not cells:
        sys.exit(f"Contest {contest!r} not found. Contests in the file:\n  " + "\n  ".join(sorted(seen)))
    return cells, eday


def baseline(year, contest="US PRESIDENT"):
    cells, eday = tally(fetch_zip(url(DATES[year], "results_pct")), contest, with_precincts=True)
    counties = collections.defaultdict(dict)
    for (f, t), c in cells.items():
        counties[f][t] = [c["dem"], c["rep"], c["total"]]
    out = {
        "year": year, "contest": contest, "source": url(DATES[year], "results_pct"),
        "fields": ["dem", "rep", "total"],
        "counties": counties,
        # Election Day votes by real precinct, for replaying the count in a realistic order.
        "eday_precincts": {f: [v for v in ps.values() if v[2] > 0] for f, ps in eday.items()},
    }
    (ROOT / "data/nc").mkdir(exist_ok=True)
    path = ROOT / f"data/nc/{year}.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"NC {year} {contest}: {len(counties)} counties -> {path.relative_to(ROOT)}")


def accepted_ballots(date):
    """Accepted early and mail ballots per county, from the voter-level absentee file."""
    fips = county_fips()
    z = fetch_zip(url(date, "absentee"))
    name = z.namelist()[0]
    out = collections.defaultdict(lambda: {"early": 0, "mail": 0})
    for r in csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8", errors="replace")):
        if not r["ballot_rtn_status"].startswith("ACCEPTED"):
            continue
        t = "mail" if r["ballot_req_type"].strip().upper() == "MAIL" else "early"  # "EARLY VOTING", or "ONE-STOP" in older files
        f = fips.get(r["county_desc"].strip().upper())
        if f:
            out[f][t] += 1
    return out


def live(args):
    date = args.date
    expected = accepted_ballots(date) if not args.no_absentee else {}
    print(f"accepted ballots read for {len(expected)} counties" if expected else "no expected early/mail counts")
    dest = ROOT / f"data/live/{args.race}.json"
    while True:
        try:
            cells, _ = tally(fetch_zip(url(date, "results_pct")), args.contest)
            counties = []
            for f in sorted({f for f, _ in cells}):
                by_type, tot = {}, {"dem": 0, "rep": 0, "total": 0}
                for t in ("early", "mail", "eday", "prov"):
                    c = cells.get((f, t))
                    if not c:
                        continue
                    cell = dict(c)
                    exp = expected.get(f, {}).get(t)
                    if exp:  # early and mail: share counted of ballots already accepted
                        cell["expected_vote"] = exp
                        cell["pct_in"] = round(min(1.0, c["total"] / exp), 4)
                    by_type[t] = cell
                    for k in tot:
                        tot[k] += c[k]
                counties.append({"fips": f, **tot, "by_type": by_type})
            dest.write_text(json.dumps({
                "race_id": args.race, "source": url(date, "results_pct"),
                "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "counties": counties,
            }, separators=(",", ":")))
            print(f"{datetime.now():%H:%M:%S} wrote {dest.relative_to(ROOT)} ({len(counties)} counties)")
        except Exception as e:  # keep the last good file; the page keeps showing it
            print(f"{datetime.now():%H:%M:%S} fetch failed: {e}", file=sys.stderr)
        if not args.loop:
            break
        time.sleep(args.loop)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("baseline"); b.add_argument("years", nargs="+", type=int)
    l = sub.add_parser("live")
    l.add_argument("--race", default="2026_SEN_NC")
    l.add_argument("--contest", default="US SENATE")
    l.add_argument("--date", default=DATES[2026])
    l.add_argument("--loop", type=int, default=0, help="seconds between refreshes (0 = once)")
    l.add_argument("--no-absentee", action="store_true", help="skip the 90 MB accepted-ballot file")
    a = ap.parse_args()
    if a.cmd == "baseline":
        for y in a.years:
            baseline(y)
    else:
        live(a)

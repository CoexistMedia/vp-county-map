#!/usr/bin/env python3
"""Build data/baseline-{year}.json from county-level presidential results.

Source: github.com/tonmcg/US_County_Level_Election_Results_08-24 (scraped from
news-site results; MIT Election Data and Science Lab publishes an official
equivalent on Harvard Dataverse if you prefer it).

A state becomes a single "statewide" unit when its results use units the
county shapes don't have (Alaska reports by state house district; Connecticut's
2024 results use the planning regions that replaced its counties in 2022).

Usage:  python3 scripts/build_baseline.py 2020 2024
"""
import csv, io, json, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ("https://raw.githubusercontent.com/tonmcg/"
       "US_County_Level_Election_Results_08-24/master/{y}_US_County_Level_Presidential_Results.csv")

STATE_FIPS = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE",
    "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA",
    "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
    "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM",
    "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
    "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
    "54": "WV", "55": "WI", "56": "WY",
}


def build(year):
    topo = json.loads((ROOT / "data/counties-10m.json").read_text())
    shapes = {g["id"] for g in topo["objects"]["counties"]["geometries"]}

    with urllib.request.urlopen(SRC.format(y=year)) as r:
        rows = list(csv.DictReader(io.StringIO(r.read().decode("utf-8"))))

    counties, states = {}, {}
    for row in rows:
        fips = row["county_fips"].zfill(5)
        st = STATE_FIPS.get(fips[:2])
        if not st:
            continue
        dem, rep, tot = (int(float(row[k])) for k in ("votes_dem", "votes_gop", "total_votes"))
        counties[fips] = [row["county_name"], st, dem, rep, tot]
        s = states.setdefault(st, {"fips": fips[:2], "dem": 0, "rep": 0, "total": 0})
        s["dem"] += dem; s["rep"] += rep; s["total"] += tot

    statewide = sorted({c[1] for f, c in counties.items() if f not in shapes})
    units = {f: c for f, c in counties.items() if c[1] not in statewide}
    for st in statewide:
        s = states[st]
        units[s["fips"]] = [STATE_NAMES.get(st, st) + " (statewide)", st, s["dem"], s["rep"], s["total"]]

    out = {
        "year": year,
        "source": SRC.format(y=year),
        "fields": ["name", "state", "dem", "rep", "total"],
        "statewide_states": statewide,
        "units": units,
        "states": states,
    }
    path = ROOT / f"data/baseline-{year}.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"{year}: {len(units)} units, statewide fallback for {statewide} -> {path.name}")


STATE_NAMES = {"AK": "Alaska", "CT": "Connecticut"}

if __name__ == "__main__":
    for y in sys.argv[1:] or ["2024"]:
        build(int(y))

#!/usr/bin/env python3
"""Snapshot every 2026 Senate and Governor forecast into data/races.json, and each
race's day-by-day published history into data/history.json.

The page refreshes these from the live API on load (CORS is open); this file is
the fallback when the API can't be reached, and the list of which races exist.

Usage:  python3 scripts/snapshot_forecasts.py
"""
import json, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://votepredictor.com/api/v1"
STATES = ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ "
          "NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY").split()


def get(path):
    req = urllib.request.Request(API + path, headers={"User-Agent": "vp-county-map/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError:
        return None


def slim(d):
    f = d.get("forecast") or {}
    return {
        "race_id": d["race_id"], "office": d.get("office"), "state": d["location"],
        "state_name": d.get("state_name"), "as_of": d.get("as_of"),
        "pred_margin": f.get("pred_margin"), "p_dem_win": f.get("p_dem_win"),
        "rating": f.get("rating"), "source": f.get("source"),
        "no_forecast_reason": (d.get("no_forecast") or {}).get("reason"),
        "candidates": d.get("candidates"), "url": d.get("url"),
    }


def main():
    senate = get("/chamber/senate") or {"seats": []}
    ids = [s["race_id"] for s in senate["seats"]] + [f"2026_GOV_{s}" for s in STATES]
    with ThreadPoolExecutor(6) as ex:
        races = [slim(d) for d in ex.map(lambda i: get(f"/race/{i}"), ids) if d and "race_id" in d]
    races.sort(key=lambda r: (r["office"] or "", r["state"]))
    (ROOT / "data/races.json").write_text(json.dumps({"races": races}, indent=1))
    print(f"{len(races)} races -> data/races.json "
          f"({sum(r['pred_margin'] is None for r in races)} without a published margin)")

    # The number the site PUBLISHED each day (as_published), not the backcast: the
    # backcast is today's model rerun on old polls, which never appeared on the site.
    with ThreadPoolExecutor(6) as ex:
        hists = list(ex.map(lambda r: (r["race_id"], get(f"/race/{r['race_id']}/history")), races))
    history = {rid: [[p["date"], p.get("pred_margin"), p.get("p_dem_win")] for p in ((h or {}).get("as_published") or {}).get("points") or []]
               for rid, h in hists}
    (ROOT / "data/history.json").write_text(json.dumps({"basis": "as_published", "races": history}, separators=(",", ":")))
    print(f"history for {sum(bool(v) for v in history.values())} races -> data/history.json")


if __name__ == "__main__":
    main()

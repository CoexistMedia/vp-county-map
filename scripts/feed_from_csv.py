#!/usr/bin/env python3
"""Turn a county results CSV into the live-feed JSON the Election night tab polls.

This is the adapter template. Each state publishes results differently (Clarity
ENR exports, state board text files, AP or Decision Desk if you license one), so
write one small adapter per source that ends in this CSV shape, or emit the JSON
directly. See docs/live-feed.md.

CSV columns: fips,dem,rep,total[,pct_in]
  fips    5-digit county FIPS; 2-digit state FIPS for Alaska (02) and Connecticut (09)
  dem/rep votes for the Democratic and Republican candidate in THIS race
  total   all votes counted in this race, including other candidates
  pct_in  optional, 0-1: the source's own estimate of how much of the county is in.
          Leave it out and the page uses 2024 turnout x the midterm ratio instead.

Usage:  python3 scripts/feed_from_csv.py results.csv 2026_SEN_NC  > data/live/2026_SEN_NC.json
"""
import csv, json, sys
from datetime import datetime, timezone


def main(path, race_id):
    counties = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            fips = row["fips"].strip()
            fips = fips.zfill(2) if len(fips) <= 2 else fips.zfill(5)
            c = {"fips": fips, "dem": int(row["dem"]), "rep": int(row["rep"]), "total": int(row["total"])}
            if row.get("pct_in"):
                c["pct_in"] = float(row["pct_in"])
            counties.append(c)
    json.dump({
        "race_id": race_id,
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "counties": counties,
    }, sys.stdout, indent=1)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])

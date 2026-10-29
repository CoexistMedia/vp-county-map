# Live feed format

The Election night tab polls one JSON file per race, `data/live/{race_id}.json` by default. You can
type any URL into the Feed URL box. If the feed is on another host, that host must allow
cross-origin requests.

```json
{
  "race_id": "2026_SEN_NC",
  "updated_at": "2026-11-03T23:41:00Z",
  "counties": [
    { "fips": "37119", "dem": 180000, "rep": 95000, "total": 280000, "pct_in": 0.6 },
    { "fips": "37001", "dem": 25000,  "rep": 33000, "total": 59000 }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `fips` | yes | 5-digit county FIPS. Use the 2-digit state FIPS for statewide units (`"02"` Alaska, `"09"` Connecticut). |
| `dem`, `rep` | yes | Votes counted so far for the Democratic and Republican candidates **in this race**. |
| `total` | yes | All votes counted so far in this race, including other candidates. |
| `pct_in` | no | The source's own estimate (0–1) of how much of the county's vote is counted. If it is missing, the page uses 2024 turnout × the midterm ratio box. |

### Vote types (optional)

Add `by_type` to a county to split it by how the votes were cast. The page then uses the vote-type
method described in the README. Keys are `early`, `mail`, `eday` and `prov`. Each one takes the
same fields as a county, plus `expected_vote` when the number of ballots of that type is known
(NC publishes accepted early and mail ballots before polls close):

```json
{ "fips": "37001", "dem": 25866, "rep": 32866, "total": 60013,
  "by_type": {
    "early": { "dem": 15225, "rep": 16757, "total": 32495, "expected_vote": 32610, "pct_in": 0.9965 },
    "mail":  { "dem": 1907,  "rep": 909,   "total": 2870,  "expected_vote": 2881,  "pct_in": 0.9962 },
    "eday":  { "dem": 8690,  "rep": 15135, "total": 24536 },
    "prov":  { "dem": 44,    "rep": 65,    "total": 112 } } }
```

The county-level `dem`, `rep` and `total` should still be the sum across types.
`scripts/adapters/nc.py live` writes exactly this shape.

### Notes

- `counties` may also be an object keyed by FIPS: `{"37119": {"dem": …}}`.
- Counties that haven't reported can be left out.
- Report cumulative totals, not changes since the last update.
- Votes for an independent with no Democrat in the race (Nebraska, South Dakota) don't fit this
  shape. Those races have no forecast and aren't offered.

`pct_in` matters more than anything else in the file. "Precincts reporting" is **not** a substitute,
because a precinct can count its mail and report before its Election Day votes. If the source has
no expected-vote estimate, leave `pct_in` out rather than filling it with precincts reporting.

To build a feed from a CSV:

```
python3 scripts/feed_from_csv.py results.csv 2026_SEN_NC > data/live/2026_SEN_NC.json
```

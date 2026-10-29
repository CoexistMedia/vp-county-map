# County Forecast Map

**Live demo:** https://vp-county-map.pages.dev/

A static HTML, CSS and JavaScript site that draws VotePredictor's 2026 Senate and Governor forecasts
by county, and tracks results by county on election night. There is no build step and no framework.
It uses d3 and topojson-client from a pinned CDN, and everything else is in this folder.

```
python3 -m http.server 8000      # then open http://localhost:8000
node tests/model.test.mjs        # replay tests, a few seconds
```

Serve the folder over HTTP rather than opening `index.html` as a file, because browsers block
module scripts and `fetch` on `file://`.

## The two views

### 1 · Forecast

Each county starts from its 2024 presidential margin. Every county in a state then moves by the
same amount: the gap between VotePredictor's statewide forecast and the state's 2024 presidential
result. This is the uniform-swing rule the House model already uses, applied one level down.

It is a **projection of the statewide forecast, not a county model.** Weighted by 2024 votes, the
counties add back up to the statewide forecast (within rounding where a county hits the ±100 cap).
It ignores candidate effects such as a local incumbent's home base, and it treats a Governor race
as if it followed the presidential map. The page says so wherever county numbers appear.

Forecasts load from `data/races.json` first, then refresh from `https://votepredictor.com/api/v1/race/{id}`
in the browser (the API allows cross-origin requests). Races published with `forecast: null`
(Nebraska and South Dakota Senate, with an independent challenger) are left grey, as on the site.

The **timeline** under the controls shows the map as VotePredictor published it on any day since
24 June 2026. Drag it or press Play. It uses each race's `as_published` history from
`/api/v1/race/{id}/history`, the number that was actually on the site each day, and never the
backcast, which is today's model rerun on old polls. A race with no published number by the chosen
date is grey. Histories load from `data/history.json` first and then refresh from the API.

### 2 · Election night

For one race, the page polls a results feed (`data/live/{race_id}.json` by default, every 30 seconds)
and estimates the final statewide margin.

1. **Expected margin per county:** the Forecast view's number.
2. **Expected vote per county:** 2024 votes × a midterm turnout ratio (default 0.72, editable).
   When the feed supplies `pct_in`, the feed's own estimate is used instead.
3. **Swing:** in counties that have finished counting (≥95% in), the vote-weighted average of
   actual minus expected margin. It is shrunk toward zero using the forecast's own uncertainty,
   which is read from `pred_margin` and `p_dem_win`. With nothing counted, the estimate *is* the
   VotePredictor forecast.
4. **Projection:** every county still counting is projected to finish at expected + swing. It is
   anchored on that **final** margin, not on the votes still to come. If a county's early mail ran
   8 points bluer than where it will finish, the remaining ballots are assumed to be redder by enough
   to land there.
5. **Range:** the swing's uncertainty, plus a term for the order in which vote types are counted,
   plus county-to-county scatter. All of it applies only to vote in counties that aren't finished.
   Until any county is complete, the swing comes from partial counts. The page flags that as
   **provisional** and widens the range.

#### Split by vote type

When the feed splits each county by vote type (early in person, mail, Election Day, provisional),
the tracker uses a different method (`estimateTyped` in `js/model.js`):

- **Early and mail ballots are counted but not read as a swing.** They usually arrive first and
  lean differently from Election Day. The size of that gap changes every cycle as voters switch
  methods: NC's 2024 mail ran D+27, early R+3 and Election Day R+13, and all three differed from
  2020. Reading the early batch against last cycle's pattern overshot by more than 2 points in
  testing. This matches the site's own rule that early-vote splits are not forecasts.
- **A county reveals its swing once its Election Day votes start arriving.** Its final margin is
  estimated by extending each vote type at the margin it is running. That swing is trusted in
  proportion to how much of the Election Day vote is in.
- **Every other county is anchored on expected + swing,** as before. Its uncounted Election Day
  vote absorbs whatever lean its early and mail ballots had.
- **The NC adapter tells the page how many early and mail ballots exist**, from the state's
  accepted-ballot file. So the page knows exactly how much of each county is still Election Day vote.

**Replay sources**

- **North Carolina 2024, real vote types** (the default) replays the state's real certified file
  in NC's real reporting order: every county's early and mail ballots at poll close, then Election
  Day precincts through the night. Expected values come from the 2020 file. Untick
  *Split by vote type* to watch the county-totals method misread the same count.
- **Any state, 2024 vs 2020** uses simulated batches, because county-level vote-type data isn't
  free for most states.

The **Replay** sources run this on a real election with no feed needed. The expected values are
2020 presidential results, and the "live" results are the 2024 results released county by county
in batches. You can pick the reporting order and how far early batches lean. The tracker has to
find the 2024 swing on its own, and the panel shows the true final result for comparison.

### What the replay test shows

`tests/model.test.mjs` replays every state (48, excluding Alaska and Connecticut) under three
reporting patterns and checks the estimate at 25%, 50% and 75% of batches:

| Pattern | 90% range covered the final result |
|---|---|
| Random county order | 98–100% |
| Small counties first, cities last | 81–100% |
| Random order, early batches 8 pts bluer | 98–100% |
| All 432 checks | 96.8% |

North Carolina 2024, real vote types, real reporting order, 30 shuffles of precinct order, checked
at four points after poll close (120 checks):

| Method | Average miss | 90% range covered the result |
|---|---|---|
| Split by vote type | 0.87 pts | 99% |
| County totals only | 2.09 pts | 93% |

Right after poll close, when about 80% of NC's vote is early and mail, the county-totals method is
3 points too blue on the default replay. The split method stays at the forecast until Election Day
votes arrive, and is within 1 point once about 40 precinct batches are in.

The range is conservative when the counting order is random. It is weakest when the order is
correlated with how places swing. In 2024, rural counties swung differently from cities, so a
"small counties first" night is the hard case. An earlier version that projected only the uncounted
votes scored **2%** coverage under the 8-point early-mail lean. Anchoring on each county's final margin
is the fix, and the test pins it.

**This is not calibrated on real election nights.** A replay can't reproduce how a real count runs:
which counties report first, mail counted before or after Election Day votes, recounts, or batch
corrections. Backtest it on archived real-time feeds before relying on the probabilities.

## Porting to votepredictor.com

The page uses votepredictor.com's own design so it can move over with little restyling:

- **Same colour token names and values** as the site's light and dark themes (`--bg`, `--surface`,
  `--line`, `--ink`, `--ink-2`, `--dem`, `--rep`, `--dem-soft`, `--rep-soft`, `--track`, `--radius`).
  Dark mode follows the `.dark` class the site uses, as well as the system setting.
- **Same fonts:** Instrument Sans for text, IBM Plex Mono for figures and the uppercase eyebrows.
  Here they come from Google Fonts; on the site, use the `next/font` faces it already loads.
- **Same components:** white cards with a 1px border, the "X favored" line in party colour, the
  big chance-to-win and margin figures, the thin probability bar, mono tables.
- `js/model.js` (the maths) and `js/map.js` (drawing, tooltip, mobile sheet, legend) don't depend
  on any framework. In React, give `render()` a ref to the `<svg>` inside a `useEffect`, and keep
  the panels in JSX; `app.js` is only the glue and the panel HTML, which become components.
- Map colours are read from the CSS tokens when the map is drawn, so the map follows the theme.
  Redraw when the theme changes (`app.js` does this for the system setting).

Mobile: below 768px, or on touch screens, tapping a county opens a bottom sheet instead of the
hover tooltip. The sheet has a button to open the state's race from the national view.

## Data

| File | What | Rebuild with |
|---|---|---|
| `data/counties-10m.json` | Census county and state shapes ([us-atlas 3.0.1](https://github.com/topojson/us-atlas)) | vendored |
| `data/baseline-2024.json`, `-2020.json` | County presidential results ([tonmcg](https://github.com/tonmcg/US_County_Level_Election_Results_08-24)) | `python3 scripts/build_baseline.py 2020 2024` |
| `data/races.json`, `data/history.json` | Snapshot of all 71 Senate and Governor forecasts and their day-by-day published history | `python3 scripts/snapshot_forecasts.py` |
| `data/nc/2020.json`, `2024.json` | NC president by county × vote type, plus Election Day votes by precinct | `python3 scripts/adapters/nc.py baseline 2020 2024` |
| `data/live/*.json` | Results feeds (see `docs/live-feed.md`) | your adapter |

For the official equivalent of the county baselines, use the MIT Election Data and Science Lab's
county presidential returns on Harvard Dataverse. They load the same way.

Units that don't match county shapes are shown **statewide**:

- **Alaska:** results by state house district.
- **Connecticut:** 2024 results use the planning regions that replaced its counties in 2022.
- **DC:** coded differently in the 2024 file. There is no 2026 race.

Hawaii's Kalawao County has no separate results and stays grey. Virginia's independent cities are
their own units in both the shapes and the results, so they join as usual.

## Live results

The feed is deliberately simple (`docs/live-feed.md`), so that each source needs only one small adapter:

- **Clarity ENR.** Many counties and some states (Georgia, among others) publish results through
  Clarity's ENR system, with downloadable per-county detail.
- **State boards.** For example, North Carolina posts results files during the count. North Carolina
  also splits every county by vote type (Election Day, early, mail), which suggests the next
  improvement below.
- **AP or Decision Desk HQ.** Licensed national feeds with `pct_in` (expected vote) already
  estimated. This is what the TV networks use.

**North Carolina is wired:** `scripts/adapters/nc.py`. It reads the State Board's per-precinct
results file, which splits every county by vote type, and its accepted-ballot file, which gives
how many early and mail ballots exist in each county:

```
python3 scripts/adapters/nc.py live --race 2026_SEN_NC --contest "US SENATE" --loop 60
```

Run it next to the web server on election night. It rewrites `data/live/2026_SEN_NC.json` every
minute, and the page polls that file. Checked against certified files: 2024 president
(2,715,375 D / 2,898,423 R) and 2022 Senate (1,784,049 / 1,905,786) match the official totals
exactly. Accepted ballots predicted the counted early and mail votes to within 0.5% in 2022.
**Unconfirmed:** how often NC refreshes the results file on election night. The adapter
re-downloads it on whatever schedule you set and keeps the last good file. Check the contest name
on the night: if it's wrong, the script lists the ones in the file.

The bucket sends no CORS headers, so the browser can't read it directly. That is why a small
script does the fetching.

`scripts/feed_from_csv.py` turns `fips,dem,rep,total[,pct_in]` into the feed JSON for any other source.
`docs/sample-results.csv` is a sample with **invented numbers**, to show the format.

## Not in this version, in order of value

1. **More state adapters.** Georgia, Pennsylvania, Arizona, Michigan and others publish results in
   their own formats. Each needs a converter into `docs/live-feed.md`. Licensed AP or Decision Desk
   feeds cover every state at once.
2. **Expected early and mail margins from the ballot file.** NC's accepted-ballot file has each
   voter's party registration. A calibrated party-to-vote model could read the early vote before
   any is counted, but only after it passes a backtest.
3. **Backtest on archived live feeds.** For example, North Carolina's 2022 and 2024 snapshots.
   This calibrates the range for real.
4. **House districts.** This needs district shapes on the lines in use for 2026. Several states
   redrew mid-decade, so the Census 2024 district files are out of date for them. It also needs
   county–district splits for the baseline.
5. **Candidate effects in the forecast map.** For example, a home-county bonus, tested the way the
   site tests everything else, before any of it reaches the map.

## Deploying

The live demo is a Cloudflare Pages project. To publish your own copy, log in with
`npx wrangler login`, create a Pages project once, then run:

```
scripts/deploy-pages.sh <project-name>
```

It uploads only `index.html`, `css/`, `js/` and `data/`. Any static host works the same way.

## Files

```
index.html          page shell, two tabs
css/styles.css      light and dark themes, mobile layout
js/model.js         all the arithmetic (pure, no DOM; shared with the test)
js/replay.js        builds the replays (simulated batches; NC with real vote types)
js/map.js           d3 rendering, tooltip, legend
js/app.js           loading, controls, panels, feed polling
scripts/            data builders, the NC adapter, the feed adapter template
tests/              node replay test
docs/live-feed.md   feed format
```

Data is used under its sources' terms. VotePredictor's API asks for attribution to votepredictor.com.

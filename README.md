# Ferrari Strategy Desk

Re-run Lewis Hamilton's 2026 Singapore Grand Prix with your own pit strategy. A ghost car races
Ferrari's real strategy, replayed from the real lap data, and Claude Opus 5.5 plays your race engineer.

## Run it

```
npm install
echo ANTHROPIC_API_KEY=sk-ant-... > .env   # optional: without it the radio uses built-in lines
npm start                                  # http://localhost:5173
```

## How it works

- `scripts/build_data.py` pulls the race from OpenF1: lap times, stints, pit stops, race control,
  and every car's position feed. Each position sample is snapped to the track outline, so the map
  shows where each car really was, including pit-lane crawls and VSC slowdowns. Rebuild with
  `npm run data` (position downloads are cached in `scripts/.cache`).
- The ghost replays Hamilton's real laps and swaps in only what your strategy changes: tyre pace from
  a model fitted on 1,045 clean laps (fuel burn, soft vs medium, wear, and a cliff fitted on Hamilton's
  own 44-lap soft stint) and pit cost (23.6s green, 13.8s under the VSC, both measured from real stops).
  Within each lap it borrows the real car's motion, so it slows where he slowed.
- Traffic follows the ghost. While it is within 0.5s of where Hamilton really was, it gets his real lap,
  including whoever he was stuck behind and whoever he passed. Anywhere else it runs his clean-air pace
  into the real cars at that spot.
- Passing odds come from every Singapore GP on OpenF1 (2023 to 2026, `scripts/fit_passing.py`): 575 laps
  where a car started within 1.0s of the one ahead, 64 passes. A logistic fit on pace advantage gives about
  8% a lap at equal pace, 13% at 1s a lap quicker and 19% at 2s. Each lap in range the ghost rolls against
  those odds. A pass costs 1.1s against its own pace; a car that can't get by sits 0.7s behind at the line.
  No passing under the VSC, and cars in the pit lane don't block.
- The rolls are seeded per lap and car, so a race replays the same way, and two strategies that meet the same
  car on the same lap get the same luck. The finish card reruns your strategy 200 times with different luck
  and shows how often each position came up.
- `npm test` checks that Ferrari's strategy reproduces all 62 of Hamilton's laps exactly under any luck, that
  the ghost stays on the real car all race, that position data agrees with official timing, that the full
  classification matches the official result, that every pass the ghost makes came from Hamilton or a winning
  roll, that the fitted odds match what happened in each band of pace advantage, and that moves come off as
  often as the odds say.
- `server.mjs` serves the page and asks Opus for the team radio and the post-race debrief.

## Known limits

- The other cars run their real race and don't react to the ghost: nobody defends, and a car the ghost
  passes doesn't change its own pace or strategy.
- Cars that started a lap behind the ghost and finish it ahead get past for free; only the ghost rolls.
- Pace advantage in the passing fit is each car's clean-air pace nearby, which is noisy when a car spends
  long spells in traffic.
- Hard tyres weren't raced, so only softs and mediums are offered.
- The medium-tyre cliff is assumed (10 laps after the soft's); no medium ran long enough to show one.

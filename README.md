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
- `npm test` checks that Ferrari's strategy reproduces all 62 of Hamilton's laps exactly, that the
  ghost stays on the real car all race, that position data agrees with official timing, and that the
  full classification matches the official result.
- `server.mjs` serves the page and asks Opus for the team radio and the post-race debrief.

## Known limits

- The ghost keeps Hamilton's real traffic lap by lap, but cars don't react to it: it can pass anyone
  without being held up.
- Hard tyres weren't raced, so only softs and mediums are offered.
- The medium-tyre cliff is assumed (10 laps after the soft's); no medium ran long enough to show one.

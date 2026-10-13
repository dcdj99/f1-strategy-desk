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

- `scripts/build_data.py` pulls the race from OpenF1 (lap times, stints, pit stops, VSC laps, car
  positions for the track outline) and fits the tyre model. Rebuild with `npm run data`.
- The tyre model is fitted on 1,045 clean laps: fuel burn, soft vs medium pace, linear wear, and a
  wear cliff fitted on Hamilton's own 44-lap soft stint. Pit loss is 23.6s green and 13.8s under the VSC,
  both measured from real stops.
- `public/sim.js` runs the ghost. `npm test` checks that Ferrari's real strategy reproduces Hamilton's
  real race to within 3 seconds and his real P6.
- `server.mjs` serves the page and asks Opus for the team radio and the post-race debrief.

## Known limits

- The ghost doesn't get stuck in traffic, so it overtakes more easily than a real car at Marina Bay.
- Hard tyres weren't raced, so only softs and mediums are offered.
- The medium-tyre cliff is assumed (10 laps after the soft's); no medium ran long enough to show one.

# Ferrari Strategy Desk

Re-run Lewis Hamilton's 2026 Singapore Grand Prix with your own pit strategy. A ghost car races
Ferrari's real strategy, replayed from the real lap data, with a race engineer on the radio.
Everything runs offline: the race data, the engineer's lines and the fonts ship with the app.

An unofficial fan project, not affiliated with Formula 1, Scuderia Ferrari or OpenF1. Race data comes
from the free [OpenF1](https://openf1.org) API.

## Run it

You need [Node.js](https://nodejs.org) 22.9 or newer.

```
git clone https://github.com/dcdj99/f1-strategy-desk.git
cd f1-strategy-desk
npm install
npm start
```

Then open http://localhost:5173. To use another port, set `PORT` (for example `PORT=8080 npm start`).
Stop the server with Ctrl+C.

## Use it

1. **Plan your strategy.** The bar along the bottom is your race, lap 1 to 62, with Ferrari's real
   strategy shown underneath. It starts as a copy of Ferrari's call.
   - Pick your starting tyre (soft or medium).
   - Click the bar to add a pit stop at that lap, or use **Add stop**. Up to three stops.
   - Drag a stop along the bar to move it, or use the arrows next to it in the pit sheet. With a stop
     selected, the arrow keys move it and Delete removes it; the × in the pit sheet removes it too.
   - Choose the tyre each stop fits. You must use both compounds or the ghost is disqualified.
   - The marks under the bar show when the VSCs and retirements happened. The pit sheet shows what each
     stop costs (cheaper under the VSC).
   - **Reset to Ferrari's call** puts back the real strategy.
2. **Press Race.** Your ghost Hamilton (white) races Ferrari's real Hamilton (red) through the field.
   - Pick a replay speed (1× is real time) and drag along the timeline to jump to any lap.
   - The timing tower shows the order, the big number shows your gap to Ferrari's call, and the pit
     wall talks on the radio: box calls, traffic, the odds of passing the car you're stuck behind.
   - **Pause**, **Restart**, or **Change strategy** to go back to planning.
3. **Read the finish card.** Your result against Ferrari's, how often each position came up over 200
   reruns with different passing luck, and the race engineer's debrief. **Try another strategy** to go again.

## Optional: Claude as race engineer

To have Claude Opus 5.5 rewrite the radio and debrief for each race, put both of these in a `.env` file
in the project folder, then restart the server:

```
OPUS_ENGINEER=1
ANTHROPIC_API_KEY=sk-ant-...
```

The built-in lines play straight away either way; Opus replaces the ones that haven't played yet.

## Rebuild the data (optional)

The built race data ships in `public/data`. To pull it again from OpenF1 you need Python 3 (standard
library only): run `npm run data` on Windows, or `python3 scripts/build_data.py public/data/race.json`
elsewhere. Run the tests with `npm test`.

## How it works

- `scripts/build_data.py` pulls the race from OpenF1: lap times, stints, pit stops, race control,
  and every car's position feed. Each position sample is snapped to the track outline, so the map
  shows where each car really was, including pit-lane crawls and VSC slowdowns. Cars that start
  from the pit lane would snap onto the track ahead of the grid, so they wait behind the last car
  until the field has gone past the pit exit. Rebuild with `npm run data` (position downloads are
  cached in `scripts/.cache`).
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
- The race engineer is built in. `public/data/engineer.json` holds pre-written radio and debrief lines for
  every situation the replay produces: the start, pit calls (normal, early, late, under the VSC), where a
  stop rejoins, staying out under the VSC, being stuck behind a car with the odds of getting by, passes
  made and lost, tyres past the cliff, the gap to Ferrari's call, Hamilton's Turn 1 moment, retirements,
  and the flag. `public/engineer.js` reads the race and picks the lines, the same lines for the same plan.
  The debrief names whatever cost or gained the most time, and says if the race was luckier or unluckier
  than usual. Tests check every line in the bank comes up in some race and every slot gets filled.
- `server.mjs` serves the page. With `OPUS_ENGINEER=1` it also asks Opus for the radio and debrief.
- Fonts: Barlow and Barlow Condensed, bundled in `public/fonts` under the SIL Open Font License.

## Known limits

- The other cars run their real race and don't react to the ghost: nobody defends, and a car the ghost
  passes doesn't change its own pace or strategy.
- Cars that started a lap behind the ghost and finish it ahead get past for free; only the ghost rolls.
- Pace advantage in the passing fit is each car's clean-air pace nearby, which is noisy when a car spends
  long spells in traffic.
- Hard tyres weren't raced, so only softs and mediums are offered.
- The medium-tyre cliff is assumed (10 laps after the soft's); no medium ran long enough to show one.

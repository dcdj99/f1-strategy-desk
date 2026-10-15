# Ferrari Strategy Desk

Re-run Lewis Hamilton's 2026 Singapore Grand Prix with your own pit strategy. A ghost car races
Ferrari's real strategy, replayed from the real lap data, with a race engineer on the radio.
Everything runs offline: the race data, the engineer's lines and the fonts ship with the app.

An unofficial fan project, not affiliated with Formula 1, Scuderia Ferrari or OpenF1. Race data comes
from the free [OpenF1](https://openf1.org) API.

## Play it online

**https://darrenchow.me/f1-strategy-desk/**, published from `public/` by GitHub Pages on every push to
`main` once the tests pass (`.github/workflows/pages.yml`). The online version uses the built-in race engineer.

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
   - Click or tap the bar to add a pit stop at that lap, or use **Add stop**. Up to three stops.
   - Drag a stop along the bar to move it, or use the arrows next to it in the pit sheet. With a stop
     selected, the arrow keys move it and Delete removes it; the × in the pit sheet removes it too.
   - Choose the tyre each stop fits. You must use both compounds or the ghost is disqualified.
     Each is the kind of set Ferrari fitted: every soft has 3 laps on it, every medium is new. The tyre
     readout marks a used set.
   - The marks under the bar show when the VSCs, retirements and Hamilton's Turn 1 moment happened, each
     where the playhead will be at that moment (on Hamilton's laps while you plan, yours once you race).
     The hatched bands run from when each VSC came out to when it ended. The pit sheet shows what each
     stop costs: cheaper only when you come in with the VSC out, which means boxing at the end of lap 8 or 39.
   - **Reset to Ferrari's call** puts back the real strategy.
2. **Press Race.** Your ghost Hamilton (white) races the real Hamilton on Ferrari's strategy (red) through
   the field.
   - Pick a replay speed (1× is real time) and drag along the timeline to jump to any lap. While you or
     Hamilton are in the pit lane the replay drops to 8×, so you can see the stop.
   - The timing tower shows the order, the big number shows your gap to Ferrari's call, and the pit
     wall talks on the radio: box calls, traffic, the odds of passing the car you're stuck behind. Each
     call plays just after what it talks about: a VSC call once the VSC is out, a pass once you're past.
   - The map rings a car the moment something happens to it: going off at a corner, or stopping. A car
     that retires stays where it stopped, crossed out, for three minutes of race time.
   - **Pause**, **Restart**, or **Change strategy** to go back to planning.
3. **Read the finish card.** Your result against Ferrari's, how often each position came up over 200
   reruns with different passing luck, and the race engineer's debrief. **Try another strategy** to go again.

On a phone, or a tablet held upright, the page is one column: the lap and your gap first, then the map,
the radio and race control, the strategy bar and controls, and the standings. Drag sideways along the
bar to move a stop or scrub the race; swipe up and down to scroll.

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
  and every car's position feed. Each position sample (about four a second) is snapped to the track
  outline, so the map shows where each car really was, including VSC slowdowns. Rebuild with
  `npm run data` (position downloads are cached in `scripts/.cache`).
- The feed's timestamps jitter by about a tenth of a second, so speed between neighbouring samples
  swings by ±40%. Three things keep the motion smooth:
  - Lap fraction is measured on a typical lap's clock: how far through a lap, by time, a car usually
    is at each point round the track, taken from 410,000 samples on every clean lap and smoothed. A car
    at steady progress then brakes and accelerates the way the field did. (Taking it from one lap's
    clock baked that lap's jitter into the outline: a steady car seemed to swing between 140 and
    430 km/h down the main straight.)
  - Each car's progress is smoothed with a straight-line fit over ±1.5s and stored once a second.
  - The app joins those seconds with a monotone cubic, so speed changes smoothly instead of stepping
    each second, and a car never runs backwards or overshoots a standstill.
  A lap now shows about 50 rises and falls in drawn speed, close to the ~40 of real driving, where it
  showed about 180.
- The pit lane is traced from every car's stops: samples more than 6 m off the racing line around a timed
  stop. It runs from 5% of a lap before the timing line to 8% after it, up to 18 m from the racing line. The map draws it pushed further out so it reads as its own lane, and draws cars
  in it while the position feed puts them there. Cars that start from the pit lane wait at the pit exit
  and drop to the back of the order until the field has gone by.
- The ghost replays Hamilton's real laps and swaps in only what your strategy changes: tyre pace from
  a model fitted on 1,045 clean laps (fuel burn, soft vs medium, wear, and a cliff fitted on Hamilton's
  own 44-lap soft stint) and pit cost (23.6s green, 13.8s under the VSC, both measured from real stops).
  A stop counts as under the VSC only when the VSC is out as the car comes in: boxing a lap earlier,
  the car is back out before it's deployed, and a lap later it has ended.
  Within each lap it borrows the real car's motion, so it slows where he slowed. Every stop, green or VSC,
  drives Hamilton's real 33s run down the pit lane, standstill included, lined up on the timing line.
- Tyre sets are the ones Ferrari had. Every soft either car fitted in the race (Leclerc's start, both
  cars' soft stops) had 3 laps on it, as the last two qualifying runs (out lap, push lap, in lap) left
  them, and every medium was new. So a soft you plan starts 3 laps old, at the start or at any stop,
  and a medium starts new. Leclerc raced both of his 3-lap softs; Hamilton raced one of his two, so
  the other was there for a second stop.
- Ferrari double-stacks. Both cars use the same box, about 5.5s past the timing line. If the ghost gets
  there while Leclerc is in it, it waits a second short of the box until he has moved off, stops in the
  box 3s after he does, then gets its normal stop. The wait goes on the out-lap, the map shows "You
  (stacked behind LEC)" and the pit wall says so. Nobody double-stacked in this race, so the 3s comes
  from other races on OpenF1 since 2023: where the second car was held right behind the box, it stopped
  2.5 to 3.2s after its teammate moved off (eight cases; Ferrari's three, 3.0 to 3.1s). Those were timed
  on the cars' speed traces, and so is the ghost's wait: the position feed behind the map is smoothed to
  a one-second clock and has Hamilton stopped in the box 0.6s before his speed trace does. Boxing on lap
  24 off a soft start, the ghost gets there 2.1s after Leclerc and waits 3.7s.
- Traffic follows the ghost. While it is within 0.5s of where Hamilton really was, it gets his real lap,
  including whoever he was stuck behind and whoever he passed. Anywhere else it runs his clean-air pace
  into the real cars at that spot.
- Passing odds come from every Singapore GP on OpenF1 (2023 to 2026, `scripts/fit_passing.py`): 575 laps
  where a car started within 1.0s of the one ahead, 64 passes. A logistic fit on pace advantage gives about
  8% a lap at equal pace, 13% at 1s a lap quicker and 19% at 2s. Each lap in range the ghost rolls against
  those odds. A pass costs 1.1s against its own pace; a car that can't get by sits 0.7s behind at the line.
  No passing under the VSC, and cars in the pit lane don't block.
- Race events sit where they happened. The stewards post an incident a minute or more after it, and each
  message gives the local clock time it happened (an update corrects it: Sainz's Turn 1 moment was on
  lap 1, not lap 7). The map shows the car going off at that moment, where it was. A retired car is held
  where the position feed shows it stopping (under 10 m in 10 s), not back at the line; Albon stopped in
  the pit lane. The radio is timed on the race clock from the same events, and a pass call waits until
  the map shows the ghost past.
- The ticker, the map, the timing tower and the marks under the strategy bar take their times from one
  list (`public/moments.js`), so they show each event together. A stop shows when the car turns into the
  pit lane (OpenF1 stamps it near the exit, about 27s later). A retired car counts as out once it stops,
  not when its last timed lap ends. Marks under the bar go by time, not by the car's own lap count, which
  put lapped cars' retirements up to two laps early. The ticker's lap is the leader's, as in the lap counter.
- The rolls are seeded per lap and car, so a race replays the same way, and two strategies that meet the same
  car on the same lap get the same luck. The finish card reruns your strategy 200 times with different luck
  and shows how often each position came up.
- `npm test` checks that Ferrari's strategy reproduces all 62 of Hamilton's laps exactly under any luck, that
  the ghost stays on the real car all race, that position data agrees with official timing, that the full
  classification matches the official result, that every pass the ghost makes came from Hamilton or a winning
  roll, that the fitted odds match what happened in each band of pace advantage, that moves come off as
  often as the odds say, that every ghost stop stands still as long as Hamilton's real one without jumping
  or reversing, that every timed stop shows up as one spell in the pit lane, that cars speed up and
  slow down on the map like real cars, that every radio call comes after what it talks about (no VSC
  talk before the VSC is out, no pass call before the map shows the pass), that a stop is priced as
  under the VSC only when the ghost comes in with it out, that retired cars stop where the feed shows,
  that each incident is placed when it happened, and that the ticker, map, tower and marks under the bar
  agree on when each thing happened, that the speed trace and the position feed find the same Ferrari
  box stops, and that a ghost reaching the box while Leclerc is in it stops there 3s after he has gone.
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
- Every ghost stop is Hamilton's one real stop replayed: the same time in the pit lane and in the box.
- Leclerc's stops are his real ones. If the ghost reaches the box first it goes first, and Leclerc still
  stops when he really did, even if the ghost hasn't left yet.
  The pit cost in the strategy comes from all the real stops, so a slow or quick stop doesn't change it.
- Hard tyres weren't raced, so only softs and mediums are offered.
- Every soft is a 3-lap set however many you plan, but Hamilton had only two such sets; a third would
  have had 6 or more laps on it. OpenF1 doesn't show which sets went back to Pirelli, so even the
  second is inferred from qualifying.
- Opus tags its radio by lap, not by moment. Each Opus line takes the time of the built-in line on the
  same lap, so it usually lands just after the event, but a line about something the built-in radio
  didn't mention plays 40% into its lap.
- The medium-tyre cliff is assumed (10 laps after the soft's); no medium ran long enough to show one.

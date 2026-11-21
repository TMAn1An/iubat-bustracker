# IUBAT Bus Tracker

Students sign in, see **all routes**, and tap a route to follow its bus live on a 3D map: where it is coming from / going to
(both inbound to campus and outbound from campus), next stop, arrival time and the departure schedule.
Admins manage buses (number, route, departure times), routes and stops, and publish **notices** that appear in every student app within seconds.

```
Bus phone (Android) --GPS every 3+ s--> /api/track --> Turso (one row per bus)
Student browser <--poll every 4 s-- /api/buses <--------┘
Admin dashboard  --> /api/admin  (bus numbers, routes, stops, tracker tokens)
Map: MapLibre + OpenFreeMap (OpenStreetMap data, free, no API key). Route snapping: OSRM.
```

## Run locally
```sh
npm install
npm run seed        # local.db + Rajendrapur route / Bus 11 + demo logins + tracker token (.bus-tokens.json)
npm run dev         # http://localhost:3000   (admin: /admin/)
npm run simulate    # another terminal: fake GPS from the bus phones, driving both directions
```
One dummy student login (`2025001` / `demo1234` locally) exists only to view the prototype. Remove it with `node db/seed.js --remove-dummy`.
Demo admin (local only): `admin` / `admin1234`.

## Install as an app
The site is a Progressive Web App: on Android, Chrome shows **Install app** (button in the top bar) and the tracker opens full-screen
from the home screen with the IUBAT icon; on iPhone use Share, then Add to Home Screen. MapLibre and three.js are served from `/vendor`,
so the app does not depend on third-party CDNs (only map tiles and fonts are external).

## Pages
| Path | What |
|---|---|
| `/` | Student app (sign in, bus list, bus detail, 3D map) |
| `/admin/` | Admin dashboard: **Buses** (number, route, departure times, tracker token), **Routes** (stops on a map, saved snapped to roads), **Notices** (broadcast to all apps, optional expiry) |
| `/privacy.html` | What the app does with sign-in and location data |
| `/tracker/` | Lightweight page for the bus phone (geolocation + wake lock). Or use the **Traccar Client** app: Server URL `https://<site>/api/osmand`, device identifier = bus token |

## Admin: how to set up a bus
1. **Routes → New route** (or pick a route): add stops *in driving order from the far end*; the route always ends at IUBAT Campus.
   - **Add stops in bulk**: paste the stop list from the schedule sheet, one per line, with an optional pick-up time
     (e.g. `BIPSOT 6:32 AM`). Each stop is looked up on OpenStreetMap near the route (spelling variants are tried); found stops are
     marked **Check**, unfound ones **No location**: press 📍 **Place** and click the map. Drag any marker to correct it.
   - Or click the map, or search a place and press **Add as stop**.
   - Pick-up times are shown to students and make the "Estimated" position follow the real timetable stop by stop.
   - On save the route is snapped to roads; if it is implausibly long you get a warning (a stop is probably misplaced or out of order).
2. **Buses → Add bus**: enter the bus number, pick the route. A **tracker token** is shown once; open the link on the bus phone.
3. Changing a bus number or route in the table takes effect in student apps within a few seconds (no reload).

Route stops currently only include the **start point** of Rajendrapur (Bus 11); add the stoppages in the admin dashboard.

## Crowd mode: students share the bus location
A signed-in student on the bus can tap **Share location** on that bus's page. No extra bus device is needed; others then see the bus move.
Every fix is checked on the server (`api/share.js`) before anyone else sees it:
- GPS accuracy must be 60 m or better, and the phone must be within about 80 m of the route's road;
- it must travel at least 400 m along the route over at least 90 s at vehicle speed (8–120 km/h), so sharing from home beside the highway never qualifies;
- impossible jumps (over 120 km/h between fixes) are ignored; sitting still for 6 min (e.g. got off the bus) pauses the share;
- with several riders, the one verified first wins and a newcomer more than 500 m away from it is ignored;
- the official bus phone always has priority, and riders become a standby backup;
- other students never see who is sharing; the admin **Sharing** tab shows sharers and can block them or switch the mode off.
Limitation: a fake-GPS app that imitates a moving bus along the route cannot be fully detected from a web app; the rules above, first-verified-wins and admin blocking limit the damage.
Test locally: `npm run dev`, then `node scripts/simulate-crowd.js` (five simulated riders: honest, at home, off route, jumping, conflicting).

## 3D buses and timetable estimates
- Buses are drawn as real 3D models (yellow IUBAT bus with windows, wheels, red stripe and lights) using three.js inside a MapLibre
  custom layer (`js/bus3d.js`). three.js loads after the map is ready; if it cannot load, simple 3D boxes are shown instead.
- When a bus has **no live signal**, the app estimates where it should be from its timetable (departure time and days set in the admin
  dashboard, Bangladesh time, about 22 km/h along the route). It is clearly labelled **Estimated** with `~` on times and a note,
  and any live signal (bus phone or rider) replaces it immediately.

## Free-tier budget
Everything runs on free plans (Vercel Hobby, Turso free). To stay inside Vercel's ~1M requests/month:
bus phones and riders send a position every **10 s**, the app polls every **8 s** (only while it is open and visible),
and between updates the app moves each bus along its route at its last speed (dead reckoning), so it still looks live.
Rough cost: one bus phone ≈ 360 requests/hour; one student with the app open ≈ 450 requests/hour.
A pilot (a few bus phones, a few hundred students a day) fits; the whole university at once needs a bigger plan or a free
always-on server (e.g. Oracle Cloud Always Free).

## Login protection
5 wrong passwords on one account lock it for 5 minutes (the wait doubles on further failures, max 60 min); 20 failures from one IP lock that IP the same way. A correct login resets the counter.

## Production (Vercel + Turso)
The Vercel project is connected to this GitHub repo: every push to `ccr-31ad4227-axu7x6` deploys to production automatically.

Env vars: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SESSION_SECRET` (long random string).
```sh
node db/seed.js --no-demo                     # tables, Rajendrapur route, Bus 11 (+ token in .bus-tokens.json), dummy student (override with DUMMY_STUDENT_ID / DUMMY_STUDENT_PASSWORD)
node db/seed.js --admin <username> <password> # create an admin (8+ chars)
node db/seed.js --students students.csv       # columns: id,name,password
```

## Known limitations / next
- Student login uses **one dummy account** for the prototype (`--remove-dummy` deletes it). When the university provides its student database, only `verifyStudent()` in `api/_students.js` needs to change (nothing else depends on where students are stored).
- Notices show inside the app (live, no reload). Push notifications to phones when the app is closed (Web Push) are not built yet.
- A browser page on the bus phone can be paused by Android when the screen is off; keep it charging with screen on, or use Traccar Client.

# Keel

A focus timer, time tracker, task planner and app-activity dashboard that runs in your browser, in the spirit of desktop trackers like Rize. Everything stays on your own devices.

- **Dashboard**: a calendar view of your day (time entries, computer activity, completed tasks) with a summary of work hours, focus time, focus score and time by project.
- **Timer**: Pomodoro or stopwatch focus sessions, automatic breaks and break reminders. It also asks what to do with time you spent away from the tab.
- **Tasks**: quick add with shortcuts (`#project !high tomorrow 45m`), steps, notes and estimates, and one-click focus.
- **Task planner**: a small on-device machine-learning model that guesses how heavy each task is and how long it will really take. It learns when you focus best and suggests an order for your day with start times and breaks. It improves as you correct it. See [docs/planner-research.md](docs/planner-research.md).
- **Activity**: which apps and websites you used, sorted into productive, neutral and distracting categories, recorded by the Keel tracker on your Mac.
- **Reports**: hours per day by project, a daily breakdown, your top tasks, and a CSV copy.
- **Storage cleanup**: the browser and the tracker both delete old data on their own. You choose how long to keep it in Settings.

## Run it

Keel is one static page (`index.html`). There's no build step and no server.

**GitHub Pages:** push this repository, then go to **Settings → Pages → Deploy from a branch → `main` / root**. Your site will be at `https://<your-username>.github.io/<repo>/`. You can install it as an app from your browser's address bar.

**Locally:** run `python3 -m http.server 8000` in this folder, then open http://localhost:8000.

Your data is saved in your browser's local storage on each device. Use **Settings → Back up** to copy it, and **Restore** to move it to another browser.

## App tracking on macOS

The tracker records which app is in front and, for browsers, which site and tab title. It doesn't take screenshots or record keystrokes. It skips idle time and only listens on your own Mac.

```bash
mkdir -p ~/"Keel Activity"
cp tracker/keel_tracker.py ~/"Keel Activity"/
python3 ~/"Keel Activity"/keel_tracker.py install   # runs now and at every login
```

Other commands: `status`, `pause [minutes]`, `resume`, `cleanup` and `uninstall`.

**Let your site talk to the tracker.** The tracker only answers pages listed in `~/Keel Activity/config.json`:

```json
{ "allowed_origins": ["https://<your-username>.github.io"], "keep_days": 30, "max_file_mb": 20 }
```

`localhost` is always allowed. After you change the file, run `install` again to restart the tracker. When the site connects, the sidebar shows **Tracking apps**, with **Pause** and **Resume** buttons, and your activity loads every minute. If your browser asks to allow access to devices on your local network, choose **Allow**. Chrome, Arc, Brave and Edge support this connection. If yours doesn't, use **Activity → Import activity file**.

The first time you use Chrome or Safari, macOS will ask whether `python3` may control that browser. Allow it so Keel can see which site you're on.

**Storage:** the tracker keeps 30 days by default. It drops tab titles older than 7 days, caps its file at 20 MB, trims its log at 1 MB, and cleans up every hour.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `1`–`8` | Switch pages |
| `S` | Start a focus session, or finish the current one |
| `P` | Pause or resume |
| `N` | New task |
| `L` | Log time by hand |
| `?` | Show all shortcuts |

## Files

| Path | What it is |
|---|---|
| `index.html` | The whole app |
| `manifest.json`, `sw.js`, `icon*.svg` | Installable app and offline support |
| `tracker/keel_tracker.py` | macOS app tracker, with no dependencies (Python 3.9+) |
| `docs/planner-research.md` | Research behind the task planner |

## Development & testing

```bash
npm ci                                   # test tooling (the app itself needs no build)
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.lock
npx playwright install                   # Chromium, Firefox, WebKit
npm test                                 # lint + Python tests + browser tests (no paid AI calls)
npm run eval                             # model / AI evaluations (separate)
npm run audit                            # dependency vulnerability audit
```

Tests run against a local server with a fresh browser profile each time. The Daily coach is replaced by recorded responses. Tracker tests use a temporary home folder, so your real activity data is never touched. Versions of the app, planner model, coach prompt and eval data are recorded in `eval/manifest.json`.

### Running the browser tests on a Mac
- If your shell sets `NODE_ENV=production`, install with `npm ci --include=dev` (otherwise no test tools are installed).
- If your home folder's name ends in a dot (e.g. `/Users/name.`), Firefox can't start from its default location. Use:
  `PLAYWRIGHT_BROWSERS_PATH=/Users/Shared/ms-playwright CFFIXED_USER_HOME=/Users/Shared/pw-home npx playwright test --project=firefox --project=webkit`

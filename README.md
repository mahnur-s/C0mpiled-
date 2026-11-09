# Haru: an AI safety net for older adults living alone

> When an older person living alone goes quiet, nobody notices for days. Haru notices in hours.

Started at **c0mpiled-17 Seoul** for YC's Request for Startups: **AI for the Aging Population**,
now set up for a small US pilot.

## How it works
1. **Passive monitoring.** A small Android app on the senior's phone reports when the phone was last used.
   The senior does nothing.
2. **Unusual silence.** No use for longer than their usual window (outside their quiet hours).
3. **Check-in call.** Haru, a voice agent, phones them: "Are you okay?"
4. **AI reads the answer.** Fine, concern, emergency, or no answer.
5. **Family alert.** Concern and emergencies go to family on Telegram with last activity, phone battery, and home
   address. No answer means one retry, then an urgent alert. Urgent alerts repeat until someone taps **I'm on it**.

Families see everything on a web dashboard: status, what Haru did and why, call transcripts, and buttons to
call now or pause monitoring.

Haru is not an emergency service.

## Run it locally

Requires Node 22.5+. No `npm install`: the server has zero dependencies.

```bash
npm test
npm start        # or double-click start.bat / start.command
```

Open http://localhost:3000 and log in with the demo admin the console prints on first start. With
`DEMO_MODE=1` (the default in `.env`), calls are simulated and the **Simulator** page plays the senior's phone.

**To run the real pilot, follow [docs/SETUP.md](docs/SETUP.md)**: Fly.io deployment, Telegram bot,
Vapi phone calls, the Android app, and onboarding families.

## Repo layout

| Path | What |
|---|---|
| `server/` | Node backend: `monitor.js` (the safety loop), `routes/`, `providers/` (Vapi, Telegram), SQLite via `node:sqlite` |
| `public/` | Web app: login, family dashboard, admin, demo simulator (vanilla JS) |
| `android/` | Companion app (Kotlin), built by `.github/workflows/android.yml` |
| `test/` | `node:test` suite with a fake clock and fake providers |
| `haru-prompt.md` | Voice assistant setup for Vapi |

## Stack
Node 22 (built-in `http` and `node:sqlite`), vanilla HTML/JS, Kotlin + WorkManager, Vapi (outbound calls),
OpenAI (transcript classification, keyword fallback), Telegram Bot API, Fly.io.

## Why it matters
- In Korea, people 65+ accounted for **4,310 unclaimed deaths in 2025** (60.1% of the total), up about 133% since 2021.
- **2.13 million** Korean seniors live alone. In the US, **24 million** adults 50+ live alone.
- **63 million** US family caregivers (1 in 4 adults) can't be there every day.

## Roadmap
- iPhone support (no equivalent of Usage Access; likely a check-in schedule instead)
- SMS alerts as a second channel, and KakaoTalk for Korea
- Learning each person's normal daily rhythm instead of a fixed window

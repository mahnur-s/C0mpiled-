# Haru: an AI safety net for older adults living alone

> When an older person living alone goes quiet, nobody notices for days. Haru notices in hours.

Built at **c0mpiled-17 Seoul** for YC's Request for Startups: **AI for the Aging Population**.

## The problem
- In Korea, people 65+ accounted for **4,310 unclaimed deaths in 2025** (60.1% of the total), up about 133% since 2021.
- **2.13 million** Korean seniors live alone. In the US, **24 million** adults 50+ live alone.
- **63 million** US family caregivers (1 in 4 adults) can't be there every day.

## How it works
1. **Passive monitoring.** Haru watches for normal phone activity. The senior does nothing.
2. **Unusual silence detected.** No activity past their normal window.
3. **AI check-in call.** Haru (a voice agent) calls: "Are you okay?"
4. **AI reads the answer.** Classified as `ok`, `concern`, `emergency`, or `no_answer`.
5. **Family alert.** Concern or emergency sends a Telegram alert with last activity and home location. Fine just gets logged.

No app to learn, no button to press, no new device.

## Run it
Requires Node 18+ (https://nodejs.org). No `npm install` needed (zero dependencies).

**Quickest:** double-click `start.bat` (Windows) or `start.command` (Mac). Your browser opens at http://localhost:3000.

Or from a terminal:

```bash
node server.js         # keys go in .env (all optional)
# open http://localhost:3000
```

Without any keys it runs in demo mode (demo buttons simulate the call, alerts show on the dashboard).

| Feature | Key(s) in `.env` | Without it |
|---|---|---|
| Real voice call | `VAPI_PUBLIC_KEY`, `VAPI_ASSISTANT_ID` (setup: `haru-prompt.md`) | Demo answer buttons |
| Telegram alert | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Alert shown on dashboard |
| AI classification | `OPENAI_API_KEY` | Keyword rules (English + Korean) |

## Demo flow
1. Click **Demo: fast-forward 6 hours**. Dashboard turns yellow, Haru starts calling.
2. Click **Answer** and say *"I fell in the bathroom, I can't get up."*
3. Dashboard turns red and the family gets an urgent Telegram alert.

## Stack
Node (built-in `http`), vanilla HTML/JS, Vapi Web SDK (voice), OpenAI (classification), Telegram Bot API (alerts).

## API
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/status` | Current state for the dashboard |
| POST | `/api/heartbeat` | Phone activity |
| POST | `/api/fast-forward` | Demo: jump the clock `{hours}` |
| POST | `/api/call-result` | `{transcript, userText}` from the call, classify and alert |
| POST | `/api/reset` | Reset demo |

## Roadmap
- Real phone activity signal (Android usage stats, iOS Screen Time API partners)
- Outbound phone calls to landlines (Twilio), KakaoTalk alerts in Korea
- Learn each person's routine instead of a fixed threshold
- Escalation chain: family member 1, then 2, then neighbor or care manager, then 119/911

*Haru does not give medical advice and is not an emergency service.*

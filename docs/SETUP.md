# Running the Haru pilot

This guide takes you from this repo to real families using Haru. Do the steps in order; each one ends with a check
so you know it worked before moving on. Budget about two hours the first time.

You will need: a credit card for Fly.io and Vapi (costs are a few dollars a month plus about $0.10 per check-in
call), a Telegram account, an Android phone for testing, and the GitHub repo.

---

## 1. Try it locally (10 minutes)

Requires Node 22.5 or newer.

```bash
npm test     # all tests should pass
npm start    # or double-click start.bat
```

The first time, the console prints a demo login (`admin@haru.local` and a password). Open
http://localhost:3000 and log in. `.env` has `DEMO_MODE=1`, so calls are simulated and there is a
**Simulator** page that plays the senior's phone. Add a person on **Admin**, then use **Simulator** to skip ahead
6 hours and answer the call.

**Check:** the dashboard turns red after you answer "I fell".

> Quiet hours use the real clock in the senior's timezone. If it is night there, Haru waits instead of
> calling. That's correct behaviour; for demos, set both quiet-hour times to the same value.

## 2. Deploy the server to Fly.io (20 minutes)

1. Install flyctl. On Windows (PowerShell): `iwr https://fly.io/install.ps1 -useb | iex`. Then `fly auth login`.
2. In `fly.toml`, change `app = "haru-pilot"` to a unique name. Keep `primary_region` near your seniors
   (`iad` = Virginia, `ord` = Chicago, `sjc` = California).
3. Create the app and its disk (the database lives on the disk):
   ```bash
   fly apps create <your-app-name>
   fly volumes create haru_data --size 1 --region iad
   ```
4. Set secrets. Generate the webhook secret first:
   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   fly secrets set PUBLIC_URL=https://<your-app-name>.fly.dev OPENAI_API_KEY=sk-... VAPI_WEBHOOK_SECRET=<the random string>
   ```
   Never set `DEMO_MODE` on Fly.
5. Deploy and create your admin account on the server:
   ```bash
   fly deploy
   fly ssh console -C "node scripts/create-admin.js you@example.com 'Your Name'"
   ```

**Check:** `https://<your-app-name>.fly.dev/healthz` shows `{"ok":true}` and you can log in.

Fly keeps daily snapshots of the volume for 5 days (`fly volumes snapshots list <volume-id>`).
Run exactly one machine: the monitor runs inside the server, and SQLite is a single file. `fly.toml` already
sets this up; don't `fly scale count 2`.

## 3. Telegram alerts (10 minutes)

1. In Telegram, message **@BotFather**, send `/newbot`, pick a name and a username ending in `bot`.
2. Set the secrets (the username without `@`):
   ```bash
   fly secrets set TELEGRAM_BOT_TOKEN=123456:AA... TELEGRAM_BOT_USERNAME=your_haru_bot
   ```
   The server registers its own webhook on startup; there is nothing else to configure.
3. On the Haru dashboard, press **Connect Telegram**, then **Start** in Telegram.

**Check:** the bot replies "Connected". Admins who connect Telegram also receive every emergency alert as a backstop.

## 4. Phone calls with Vapi (30 minutes)

1. Sign up at https://dashboard.vapi.ai and add billing.
2. **Phone number:** Phone Numbers > Create. A free Vapi US number works for testing; Vapi limits how many
   outbound calls free numbers can make per day, so for the pilot buy a Twilio number (about $1.15/month)
   and import it into Vapi. Copy the number's **ID** (not the phone number itself).
3. **Assistant:** follow [haru-prompt.md](../haru-prompt.md). Copy the assistant **ID**.
4. **Private API key:** on the dashboard's API Keys page, copy the **private** key (keep it secret; it only goes in Fly secrets).
5. Set the secrets:
   ```bash
   fly secrets set VAPI_PRIVATE_KEY=... VAPI_ASSISTANT_ID=... VAPI_PHONE_NUMBER_ID=...
   ```

**Check:** add yourself as a person on Admin with your own mobile number, open their dashboard, and press
**Ask Haru to call now**. Your phone rings; say "I'm fine" and the call appears under Check-in calls with a transcript
within a minute. Then try "I fell" and confirm the Telegram alert arrives.

If the result never arrives, the server asks Vapi for it after 5 minutes, so you'll still see it, just late.
Check `fly logs` for `Vapi` errors if calls don't start at all; the dashboard also logs "the call could not be completed".

## 5. The Android app (20 minutes)

The app is built by GitHub Actions, so you don't need Android Studio.

1. On GitHub: **Settings > Secrets and variables > Actions > Variables > New variable**:
   `HARU_SERVER_URL` = `https://<your-app-name>.fly.dev`.
2. Push the repo (or run the **Android app** workflow by hand from the Actions tab).
3. Open the finished run and download the **haru-debug-apk** artifact (a zip containing `app-debug.apk`).
4. Copy the APK to the senior's phone and open it. Android will ask to allow installs from that source; allow it.
5. In Haru on the phone: choose **This is the phone of the person Haru looks after**, then enter the 6-digit
   code from **Admin > Phone app > Get a pairing code**.
6. Complete the yellow steps the app shows:
   - **Usage access:** find Haru in the list and turn it on.
   - **Run in background:** allow. On Samsung phones also open Settings > Apps > Haru > Battery > **Unrestricted**;
     on Xiaomi, enable **Autostart**. See https://dontkillmyapp.com for other brands.
   - **Medicine reminders:** tap **Allow** so Haru can show "Time for your …" notifications with
     **I took it** / **Skip** buttons (Android 13+ asks; on older phones it opens notification settings only if
     they were turned off).
7. Optional: **Share location.** Tap **Share location** and allow it (precise or approximate both work). On
   Android 10 and newer a second step follows: tap **Continue** and choose **Allow all the time**, because Haru
   checks in every 15 minutes with the app closed. The senior can tap **No thanks**; everything else still works,
   the family just won't see whether they're at home.

**Check:** on the dashboard, "Their phone" shows the battery level, and "Last phone activity" updates within
about 15 minutes of using the phone. Press **I'm OK** in the app to see an immediate update.

### Optional: a room sensor

A spare Android phone or tablet (Android 8+) can stay at home as a room sensor. It watches the living room with
its camera and microphone, but **all video and audio are analysed on the device and discarded immediately**: only
numbers (movement and sound levels per 15 minutes) and alerts (possible fall, smoke alarm, loud bang) are sent.

1. Install the same APK on the spare device (steps 3–4 above) and get a new pairing code for the same senior.
2. In Haru: choose **This is a room sensor (a spare phone or tablet that stays at home)**, then enter the code.
3. Complete the steps the app shows: **allow the camera and microphone**, **let Haru run in the background**
   (plus the Samsung/Xiaomi settings above), and **keep it plugged in**.
4. Prop it up facing the main living area, back camera towards the room, on its charger.

The screen then says **Watching the living room** with live movement and sound bars, and a quiet
"Haru room sensor is on. Nothing is recorded." notification stays in the status bar. **Pause for 1 hour** turns
the camera and microphone off and back on by themselves. After the device restarts, Android 15+ (and sometimes
older versions) won't let Haru turn the camera back on by itself: open Haru once, or tap the
"Haru room sensor stopped" notification.

Falls and smoke alarms are detected with simple on-device rules, not a trained model: expect some false alarms
and misses, and don't rely on it instead of a real smoke alarm or a fall-alert pendant.

## 6. Onboarding a family

1. **Admin > Add a person.** Only tick the consent box after the senior has agreed to monitoring and to automated
   calls. Use their mobile number in `+1...` format and their timezone.
2. Pick a sensible inactivity window. 4 hours suits most people; use longer if they nap a lot or rarely use their phone.
3. Pair their phone (step 5).
4. Invite at least one family member: **Family > Create invite link**, and send the link yourself
   (text or email). It works once, for 7 days.
5. Make sure the family member presses **Connect Telegram**. The dashboard warns "No Telegram" until they do,
   and alerts that reach nobody show up in red in the feed.

## 7. Before real seniors depend on it

- [ ] All checks above passed on your own phone first.
- [ ] An external uptime monitor (for example UptimeRobot, free) pings `/healthz` every 5 minutes and alerts *you*.
      `/healthz` fails if the monitor loop stops, not just if the server is down.
- [ ] You've connected Telegram as admin, so emergencies reach you too.
- [ ] Families understand Haru is **not an emergency service**: it checks in, it does not dispatch help.
- [ ] Families know how to pause monitoring before a trip or hospital stay.

## How Haru decides what to do

| Situation | What happens |
|---|---|
| Phone used within the window | Nothing. "Last phone activity" updates. |
| No use past the window, quiet hours | Waits; calls when quiet hours end (unless the phone is used first). |
| No use past the window | Calls. |
| Answers "I'm fine" | Logged; the window restarts. |
| Mentions pain, dizziness, missed meals or medicine, low mood | Concern alert on Telegram. |
| Mentions a fall, chest pain, breathing trouble, bleeding, or asks for help | Urgent alert, re-sent every 15 minutes (up to 4 times) until someone taps **I'm on it**. |
| No answer, voicemail, or the call fails | Tries again 10 minutes later, then sends an urgent alert. |
| Phone silent for 2+ hours | Noted in the feed; included in any alert ("may be off or out of battery"). |
| Senior presses **I'm OK** | Counts as activity; cancels a pending retry call. |
| Monitoring paused | No calls or alerts until the chosen time. |

Transcripts are deleted after 90 days and feed events after a year.

## Configuration reference

| Variable | Purpose |
|---|---|
| `PUBLIC_URL` | The https address of the server. Needed for webhooks, invite links and the Telegram webhook. |
| `DB_PATH` | SQLite file. Set to `/data/haru.db` on Fly by `fly.toml`. |
| `DEMO_MODE` | `1` = simulated calls and the Simulator page. Local only. |
| `VAPI_PRIVATE_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID` | Outbound calls. |
| `VAPI_WEBHOOK_SECRET` | Shared secret Vapi sends back with call results. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | Alerts and account linking. |
| `TELEGRAM_WEBHOOK_SECRET` | Optional; derived from the bot token if unset. |
| `OPENAI_API_KEY`, `LLM_MODEL` | AI reading of call transcripts. Keyword rules are used if unset or if OpenAI fails. |
| `CALL_TIMEOUT_MINUTES`, `RETRY_AFTER_MINUTES`, `ESCALATE_AFTER_MINUTES`, `MAX_ALERTS_PER_INCIDENT` | Override the defaults (5, 10, 15, 4). |

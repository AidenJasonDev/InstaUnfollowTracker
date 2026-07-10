# UnfollowTracker — Usage Guide

## How it works

The first check builds your **master list** — everyone who follows you and
everyone you follow — and saves it to `data/list.json`. Every check after that
fetches a fresh list, compares it against the stored one, appends the
differences to `data/changes.log`, and the fresh list becomes the new master.

## First-time setup

```sh
npm install
cp .env.example .env
```

Edit `.env` and fill in your Instagram credentials:

```ini
IG_USERNAME=your_username
IG_PASSWORD=your_password
```

The password is only used the very first time (and again if the saved session
ever expires). After a successful login, the session is stored in
`.session.json` and reused — later runs don't re-enter your password.

### Do the first login with `login`

```sh
node main.js login
```

Instagram almost always guards the first programmatic login with a **security
code** ("We can send you an email to help you get back into your account") or,
if you have it enabled, a **2FA code**. The code has to be typed into this
terminal so the library can finish the login — tapping **Approve** in the
Instagram app does **not** complete it (and often shows "login request no
longer valid"; see [troubleshooting](#login-request-no-longer-valid) below).

`node main.js login` walks you through it interactively:

- **2FA** — it asks for the code from your authenticator app or SMS.
- **Security-code challenge** — Instagram emails/texts a code and it prompts
  you to type it in (with up to 3 tries if you fumble it).

**Before you run `login`:**

1. Do **not** also run `check` or `watch` — those attempt password login when
   there is no session and will invalidate the pending challenge.
2. Prefer an **authenticator app (TOTP)** over SMS; unofficial clients handle
   TOTP more reliably. A **backup code** from Instagram's 2FA settings also
   works at the same prompt.
3. In Instagram: **Settings → Accounts Center → Password and security →
   Two-factor authentication → your account → Additional methods** — turn
   **off Login Approvals / Login requests**. With that on, Instagram pushes an
   in-app Approve prompt that this tool cannot finish; with it off, you get a
   normal SMS or authenticator code.

Once it prints `session saved to .session.json`, run `check` or `watch` — they
reuse that session and never need to prompt again (until it eventually
expires, at which point re-run `login`). Keep `.session.json`; deleting it
forces another password login and another challenge.

> If a `check`/`watch` ever hits a fresh login that needs a code, it stops with
> a message telling you to run `node main.js login` — because an unattended
> run can't prompt you for a code.

## Discord notifications (optional)

Every check that finds changes can also post them to a Discord channel:

1. In your Discord server: **Server Settings → Integrations → Webhooks →
   New Webhook**, pick the channel, **Copy Webhook URL**.
2. Paste it into `.env`:

   ```ini
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1234.../abcd...
   ```

That's it — the next `check`/`watch` run picks it up. What gets posted:

- **Baseline created** — a one-time confirmation message when the first check
  builds the master list, so you know the webhook works.
- **Changes** — an embed with the same categories as the console output
  (unfollowed you, new followers, gone from following, renames). Red accent
  when you lost followers, green otherwise. Long lists are truncated with an
  "…and N more" line (the full list is always in `data/changes.log`).
- **Nothing** on checks with no changes — the channel only hears from the
  tracker when something happened.

A webhook failure (bad URL, Discord outage) never breaks the check itself —
the changes are already saved locally; the error is just printed. Treat the
webhook URL like a password: anyone who has it can post to your channel.

## Trigger a check from Discord: `/check` (optional)

Webhooks are send-only — Discord gives no way to receive commands through
them — so triggering needs a small bot alongside the webhook. While
`node main.js watch` is running, the bot listens for a `/check` slash command;
typing it runs a check immediately, and any changes are posted **through the
same webhook** as the scheduled checks.

Setup (one time, ~2 minutes):

1. Go to <https://discord.com/developers/applications> → **New Application**,
   name it (e.g. "UnfollowTracker").
2. **Bot** tab → **Reset Token** → copy it into `.env` as `DISCORD_BOT_TOKEN`.
   No privileged intents are needed — leave all the toggles off.
3. Invite the bot to your server. The foolproof way: in the developer portal
   open **OAuth2 → URL Generator**, tick the `bot` and `applications.commands`
   scopes (no bot permissions needed), and open the generated URL at the
   bottom of the page.

   If you'd rather build the URL by hand, it's
   `https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands`
   where `YOUR_APP_ID` is the numeric **Application ID** (17–19 digits) from
   the **General Information** tab — not the bot token and not the public key.
   A wrong or mangled `client_id` makes Discord show an **"Invalid Form
   Body"** error on the invite page.
4. Recommended: put your server's ID in `.env` as `DISCORD_GUILD_ID` so
   `/check` registers instantly (enable Settings → Advanced → Developer Mode
   in Discord, then right-click the server icon → **Copy Server ID**).
   Without it, global registration can take up to an hour to appear.
5. Start `node main.js watch` — you'll see
   `Discord bot ready as ... — /check registered.`

How `/check` behaves:

- It replies with a short summary (baseline created / no changes / N changes);
  the detailed changes embed arrives via the webhook as usual. If you haven't
  configured a webhook, the embed is attached to the `/check` reply instead.
- A manual `/check` never overlaps a scheduled check — if one is already
  running you get a "hang on" reply, and the running check's results post
  normally.
- The command only works while `watch` is running; stop the process and the
  bot goes offline.
- Anyone in the server can use `/check` (it only triggers a read-only check,
  never exposes credentials). To restrict it: **Server Settings →
  Integrations → your bot → Command Permissions**.
- Manual checks don't reset the schedule — the next interval check still
  happens at its usual time, and will simply report "no changes" if nothing
  happened since your manual one.

## Commands

### `login` — interactive first-time login

```sh
node main.js login
```

Logs in and saves the session, handling 2FA and Instagram's security-code
challenge interactively (see [the first login](#do-the-first-login-with-login)
above). Run this once before your first `check`. Safe to re-run — if a valid
session already exists it just says so and exits.

### `check` — fetch, compare, log

```sh
node main.js check
# or: npm run check
```

The very first run just builds the baseline:

```
Fetching followers... 843
Fetching following... 512

Baseline list saved: 843 followers, 512 following.
Run again later — future checks compare against this list and log the differences.
```

Every run after that prints the differences and appends them to the log:

```
Changes since 7/10/2026, 9:00:00 AM:

🔻 Unfollowed you (or blocked/deactivated) (1):
  @some_user (Some User)

🔺 New followers (1):
  @new_fan

  ✏️  @carol_old is now @carol_new

3 change(s) appended to data/changes.log
```

### `watch` — check on a repeating interval

```sh
node main.js watch              # every 6 hours (default)
node main.js watch --every 12   # every 12 hours
```

Runs a `check` immediately, then repeats every N hours until you stop it with
`Ctrl+C`. The process must stay running — if you close the terminal or reboot,
the watch stops. For something that survives reboots, run `check` from cron
instead:

```sh
# crontab -e — run every 6 hours
0 */6 * * * cd /Users/aiden/Documents/GitHub/UnfollowTracker && /usr/local/bin/node main.js check >> tracker.log 2>&1
```

### `status` — current list summary

```sh
node main.js status
```

No network calls — reads the stored master list and prints:

- follower / following counts
- **Doesn't follow you back** — accounts you follow that don't follow you
- **You don't follow back** — accounts that follow you but you don't follow

### `log` — show the change log

```sh
node main.js log            # the whole log
node main.js log -n 20      # just the last 20 lines
```

Every difference ever detected, one timestamped line each:

```
[2026-07-10T15:00:00.000Z] baseline created (843 followers, 512 following)
[2026-07-10T21:00:00.000Z] LOST FOLLOWER      @some_user (Some User) — unfollowed you, blocked you, or deactivated
[2026-07-10T21:00:00.000Z] NEW FOLLOWER       @new_fan
[2026-07-10T21:00:00.000Z] RENAMED            @carol_old -> @carol_new
[2026-07-11T03:00:00.000Z] checked — no changes (843 followers, 512 following)
```

Checks that find no changes write a single `checked — no changes` line, so the
log doubles as proof that the tracker actually ran.

## How to read the differences

Instagram's API only tells you *what* the lists look like now, not *why* they
changed. The labels reflect that ambiguity:

| Log entry | What it can mean |
|---|---|
| `LOST FOLLOWER` | They unfollowed you, blocked you, or deactivated their account |
| `NEW FOLLOWER` | They followed you (or reactivated) |
| `GONE FROM FOLLOWING` | You unfollowed them, **they removed you as a follower**, they blocked you, or they deactivated |
| `STARTED FOLLOWING` | You followed them |
| `RENAMED` | Same account, new username — *not* an unfollow |

So: if someone shows up as `GONE FROM FOLLOWING` and you know you didn't
unfollow them, they either removed you as a follower or blocked you.

## Files on disk

| File | What it is | Committed to git? |
|---|---|---|
| `.env` | Your credentials + optional Discord webhook/bot settings | No (gitignored) |
| `.session.json` | Saved Instagram session | No (gitignored) |
| `data/list.json` | The current master list (followers + following) | No (gitignored) |
| `data/changes.log` | Append-only history of every difference detected | No (gitignored) |

Both data files are plain text — safe to inspect or back up. Deleting
`data/list.json` makes the next check start a fresh baseline; deleting
`.session.json` forces a fresh password login on the next run. The change log
is never overwritten, only appended to.

## Troubleshooting

<a id="login-request-no-longer-valid"></a>

**Instagram app says "login request no longer valid" when you tap Approve**
That notification is Instagram's in-app login approval. This tool does **not**
finish login that way — it needs a numeric code (SMS, authenticator, or backup
code) entered in the terminal. Approving in the app does nothing useful here,
and the request expires within minutes or as soon as another login attempt
starts.

What usually causes it:

- You tapped Approve instead of entering the code in the CLI.
- You ran `login` / `check` / `watch` more than once — each new password login
  creates a fresh challenge and invalidates the previous one.
- "Login Approvals" is enabled, so Instagram shows Approve instead of (or in
  addition to) a code this tool can use.

What to do:

1. Stop retrying for **30–60 minutes** after several failures (rapid retries
   look like bot traffic and keep killing challenges).
2. Turn **off Login Approvals / Login requests** under 2FA → Additional
   methods (path above). Prefer an authenticator app or a backup code.
3. Run **only** `node main.js login` (no `watch`/`check` in parallel).
4. When prompted, paste the **SMS / TOTP / backup code** into the terminal
   promptly — do not rely on Approve in the app.
5. Once `.session.json` exists, leave it alone and use `check` / `watch`.

**Check fails with "467" / body "Unsupported" (e.g. `current_user - 467`)**
Two different Instagram responses share HTTP `467`. Check the message:

1. **Body `Unsupported` (or `unsupported_version`)** — Meta rejected the
   emulated Instagram app version. This project overrides the stock library's
   ancient `222.x` client to a current one (`416.x`). Stop any running `watch`,
   then retry `node main.js check`. If it still fails, delete `.session.json`
   and run `node main.js login` once so the new client mints a fresh session.
2. **Bare `467` / `429` with no useful body** — temporary soft-block / rate
   limit from too much recent activity (burst of logins, then immediate
   `watch`, etc.). Your `.session.json` is still valid. What to do:
   - **Stop and wait** several hours (overnight is safest). Each attempt while
     blocked can extend it.
   - **Don't delete `.session.json` and don't re-run `login`.**
   - When you resume, use a longer interval (`watch --every 12`) and avoid
     spamming manual `/check`.

`watch` prints a clear notice for both cases and retries at the next interval.

**Login fails with "400 Bad Request" / "We can send you an email to help you
get back into your account"**
This is **Instagram** rejecting the login with a security-code challenge — not
a Discord/webhook error (the webhook is only ever contacted *after* a
successful fetch). Run `node main.js login` and enter the code Instagram
emails/texts you. Approving the prompt in the Instagram app alone does **not**
complete the login for the API.

**"This account has two-factor authentication enabled" / login needs a 2FA code**
Run `node main.js login` — it prompts for the code from your authenticator app
or SMS and finishes the login. `check`/`watch` can't prompt, so they defer to
`login` for any fresh login that needs a code. Authenticator (TOTP) is more
reliable than SMS for this flow; backup codes work at the same prompt.

**"Missing IG_USERNAME"**
You haven't created `.env` yet — `cp .env.example .env` and fill it in.

**"No valid session and no IG_PASSWORD set"**
The saved session expired and `IG_PASSWORD` isn't set in `.env`. Add it and run
`node main.js login` again, after which the new session is saved.

**A lost follower reappears in the next check without re-following**
Occasionally Instagram's pagination drops a user from one fetch. If someone
shows as `LOST FOLLOWER` and then `NEW FOLLOWER` again immediately, it was
almost certainly an API hiccup, not a real unfollow/refollow.

## Why not the official Instagram API?

Meta's Graph API can return follower **counts** (and media/insights for
Business/Creator accounts), but it does **not** expose who follows you or who
you follow. The old Basic Display API (which covered personal accounts) was
shut down in December 2024. Unfollow detection needs the actual lists, so this
tool uses Instagram's private mobile API via `instagram-private-api` — the same
approach used by similar trackers — and relies on a saved session so you only
fight 2FA once.

## Staying under Instagram's radar

- Keep the interval at **6 hours or more** — the default. Checking every few
  minutes is the fastest way to get the account rate-limited or locked.
- Don't run the tracker from multiple machines with the same account; each
  machine would create its own device fingerprint and session.
- Don't delete `.session.json` unnecessarily — every fresh password login is
  another chance for Instagram to raise a challenge.
- Don't spam `login` when a challenge fails; wait, then try once with a code
  ready (authenticator preferred).

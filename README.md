# UnfollowTracker

CLI that builds a master list of your Instagram followers/following, then
periodically fetches a fresh list, compares the two, and logs the differences:
who unfollowed you, who removed you as a follower, new followers, and username
renames.

## Setup

```sh
npm install
cp .env.example .env   # then fill in IG_USERNAME / IG_PASSWORD
```

The password is only used for the first login. The session is saved to
`.session.json` and reused after that, which is both faster and far less likely
to trigger Instagram's suspicious-login checks than logging in fresh each time.

## Usage

```sh
node main.js login            # one-time interactive login (handles 2FA + security codes)
node main.js check            # fetch fresh lists, compare to stored, log differences
node main.js watch --every 6  # check now, then repeat every 6 hours (Ctrl+C to stop)
node main.js status           # current counts + who doesn't follow you back
node main.js log              # show the change log (-n 20 for the last 20 lines)
```

Run `login` first — Instagram guards the first login with a security-code or
2FA challenge that has to be entered interactively. After that the session in
`.session.json` is reused and `check`/`watch` run unattended.

The master list lives in `data/list.json`; every difference ever detected is
appended to `data/changes.log`. Comparisons are keyed by user ID, so someone
changing their username shows up as a rename, not an unfollow.

Set `DISCORD_WEBHOOK_URL` in `.env` to also have changes posted to a Discord
channel on every check, and `DISCORD_BOT_TOKEN` to get a `/check` slash command
that triggers a check on demand while `watch` is running (results go through
the same webhook). See [usage.md](usage.md#discord-notifications-optional).

See [usage.md](usage.md) for the full guide.

## Notes on what the diff means

- **Gone from followers** — they unfollowed you, blocked you, or deactivated.
- **Gone from following** — you unfollowed them, they removed you as a
  follower, they blocked you, or they deactivated. Instagram doesn't
  distinguish these server-side, so if *you* didn't unfollow them, it was one
  of the others.

## Caveats

- This uses [instagram-private-api](https://github.com/dilame/instagram-private-api),
  which emulates the mobile app. Automation is against Instagram's ToS; the
  practical risk is a "suspicious login" challenge or temporary lock. Keep the
  interval at 6h or more and don't run it from multiple machines at once.
- If Instagram raises a checkpoint, approve the login in the official app and
  run the command again.
- If you have 2FA enabled, the first login will fail — you'll need a session
  from an app-password-style flow; ask and we can add TOTP support.

#!/usr/bin/env node
require('dotenv').config({ quiet: true });
const { Command } = require('commander');
const { getClient, interactiveLogin, saveSession, isRateLimit, isUnsupportedClient } = require('./lib/client');
const { fetchLists } = require('./lib/fetch');
const store = require('./lib/store');
const discord = require('./lib/discord');

const program = new Command();

function requireUsername() {
  const username = process.env.IG_USERNAME;
  if (!username) {
    console.error('Missing IG_USERNAME. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }
  return username;
}

function displayName(u) {
  return `@${u.username}${u.fullName ? ` (${u.fullName})` : ''}`;
}

function printUserList(label, users) {
  if (users.length === 0) return;
  console.log(`\n${label} (${users.length}):`);
  for (const u of users) console.log(`  ${displayName(u)}`);
}

function printDiff(diff) {
  console.log(`\nChanges since ${new Date(diff.since).toLocaleString()}:`);

  printUserList('🔻 Unfollowed you (or blocked/deactivated)', diff.followers.lost);
  printUserList('🔺 New followers', diff.followers.gained);
  printUserList(
    '➖ Gone from your following (you unfollowed, they removed you as a follower, or blocked you)',
    diff.following.lost
  );
  printUserList('➕ You started following', diff.following.gained);

  for (const r of store.dedupeRenames(diff)) {
    console.log(`  ✏️  @${r.from} is now @${r.to}`);
  }
}

/** Turns a diff into the lines appended to data/changes.log. */
function diffToLogLines(diff, counts) {
  const lines = [];
  for (const u of diff.followers.lost)
    lines.push(`LOST FOLLOWER      ${displayName(u)} — unfollowed you, blocked you, or deactivated`);
  for (const u of diff.followers.gained)
    lines.push(`NEW FOLLOWER       ${displayName(u)}`);
  for (const u of diff.following.lost)
    lines.push(
      `GONE FROM FOLLOWING ${displayName(u)} — you unfollowed, they removed you as a follower, or blocked you`
    );
  for (const u of diff.following.gained)
    lines.push(`STARTED FOLLOWING  ${displayName(u)}`);
  for (const r of store.dedupeRenames(diff))
    lines.push(`RENAMED            @${r.from} -> @${r.to}`);

  if (lines.length === 0) {
    lines.push(`checked — no changes (${counts.followers} followers, ${counts.following} following)`);
  }
  return lines;
}

async function runCheck() {
  const username = requireUsername();
  const ig = await getClient(username, process.env.IG_PASSWORD);
  const lists = await fetchLists(ig);

  // Instagram rotates session cookies as you use the API. Persisting them after
  // every successful run keeps the session alive longer, which is what avoids
  // being bounced back to a fresh login (and another approval prompt).
  try {
    await saveSession(ig);
  } catch (err) {
    console.error(`Could not refresh saved session: ${err.message}`);
  }

  const prev = store.loadList();
  const curr = store.saveList(lists);
  const counts = {
    followers: Object.keys(curr.followers).length,
    following: Object.keys(curr.following).length,
  };

  const webhook = process.env.DISCORD_WEBHOOK_URL;

  if (!prev) {
    store.appendLog([`baseline created (${counts.followers} followers, ${counts.following} following)`]);
    console.log(
      `\nBaseline list saved: ${counts.followers} followers, ${counts.following} following.` +
        '\nRun again later — future checks compare against this list and log the differences.'
    );
    if (webhook) {
      await notifyDiscord(() => discord.notifyBaseline(webhook, username, counts));
    }
    return { baseline: true, changes: 0, counts, diff: null };
  }

  const diff = store.diffLists(prev, curr);
  printDiff(diff);

  const lines = diffToLogLines(diff, counts);
  store.appendLog(lines);
  const noChanges = lines.length === 1 && lines[0].startsWith('checked');
  if (noChanges) {
    console.log('  No changes.');
  } else {
    console.log(`\n${lines.length} change(s) appended to ${store.LOG_FILE}`);
  }

  if (webhook && !noChanges) {
    await notifyDiscord(async () => {
      await discord.notifyDiff(webhook, username, diff);
      console.log('Changes posted to Discord.');
    });
  }

  return { baseline: false, changes: noChanges ? 0 : lines.length, counts, diff };
}

/** A webhook failure shouldn't fail the check — the log is already written. */
async function notifyDiscord(send) {
  try {
    await send();
  } catch (err) {
    console.error(`Discord webhook failed: ${err.message}`);
  }
}

// The scheduled interval and the Discord /check command share this lock so
// two checks never hit Instagram concurrently with the same session.
let checkInProgress = false;
async function runCheckExclusive() {
  if (checkInProgress) {
    const err = new Error('a check is already in progress');
    err.code = 'BUSY';
    throw err;
  }
  checkInProgress = true;
  try {
    return await runCheck();
  } finally {
    checkInProgress = false;
  }
}

program
  .name('unfollowtracker')
  .description('Track Instagram follower/following changes over time');

program
  .command('login')
  .description('Interactively log in (handles 2FA and security-code challenges) and save the session')
  .action(async () => {
    const username = requireUsername();
    await interactiveLogin(username, process.env.IG_PASSWORD);
  });

program
  .command('check')
  .description('Fetch fresh lists, compare against the stored list, log the differences')
  .action(async () => {
    await runCheck();
  });

program
  .command('watch')
  .description('Run a check now, then repeat on an interval')
  .option('-e, --every <hours>', 'hours between checks', '6')
  .action(async (opts) => {
    const hours = parseFloat(opts.every);
    if (!(hours > 0)) {
      console.error('--every must be a positive number of hours');
      process.exit(1);
    }
    const run = async () => {
      try {
        await runCheckExclusive();
      } catch (err) {
        if (err.code === 'BUSY') return; // a /check-triggered run is underway
        if (err.code === 'RATE_LIMIT' || isRateLimit(err)) {
          console.error(`\n⏳ ${err.message}`);
        } else if (err.code === 'UNSUPPORTED_CLIENT' || isUnsupportedClient(err)) {
          console.error(`\n⚠️  ${err.message}`);
        } else {
          console.error(`Check failed: ${err.message}`);
        }
      }
      const next = new Date(Date.now() + hours * 3600 * 1000);
      console.log(`\nNext check at ${next.toLocaleString()} (every ${hours}h). Ctrl+C to stop.`);
    };

    const token = process.env.DISCORD_BOT_TOKEN;
    if (token) {
      const { startBot } = require('./lib/bot');
      try {
        await startBot({
          token,
          guildId: process.env.DISCORD_GUILD_ID,
          username: requireUsername(),
          runCheck: runCheckExclusive,
        });
      } catch (err) {
        console.error(`Discord bot failed to start: ${err.message} — continuing without /check.`);
      }
    }

    await run();
    setInterval(run, hours * 3600 * 1000);
  });

program
  .command('status')
  .description('Show the stored list summary and mutual-follow breakdown')
  .action(() => {
    const list = store.loadList();
    if (!list) {
      console.log('No list yet. Run `node main.js check` first.');
      return;
    }
    console.log(`List last updated: ${new Date(list.updatedAt).toLocaleString()}`);
    console.log(`Followers: ${Object.keys(list.followers).length}`);
    console.log(`Following: ${Object.keys(list.following).length}`);
    printUserList("Doesn't follow you back", store.notFollowingBack(list));
    printUserList("You don't follow back", store.youDontFollowBack(list));
  });

program
  .command('log')
  .description('Show the change log')
  .option('-n, --lines <count>', 'only show the last N lines')
  .action((opts) => {
    const log = store.readLog();
    if (!log) {
      console.log('No changes logged yet.');
      return;
    }
    let lines = log.trimEnd().split('\n');
    if (opts.lines) lines = lines.slice(-parseInt(opts.lines, 10));
    console.log(lines.join('\n'));
  });

program.parseAsync().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

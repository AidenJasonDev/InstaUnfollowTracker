const { dedupeRenames } = require('./store');

const MAX_FIELD_CHARS = 1024; // Discord's per-field value limit

function fmtUsers(users) {
  // Backticks stop Discord from reading underscores in usernames as markdown.
  const lines = users.map(
    (u) => `\`@${u.username}\`${u.fullName ? ` — ${u.fullName}` : ''}`
  );
  const out = [];
  let len = 0;
  for (let i = 0; i < lines.length; i++) {
    if (len + lines[i].length + 1 > MAX_FIELD_CHARS - 20) {
      out.push(`…and ${lines.length - i} more`);
      break;
    }
    out.push(lines[i]);
    len += lines[i].length + 1;
  }
  return out.join('\n');
}

/** Builds the changes embed, or returns null when the diff is empty. */
function buildDiffEmbed(username, diff) {
  const fields = [];
  const add = (name, users) => {
    if (users.length > 0)
      fields.push({ name: `${name} (${users.length})`, value: fmtUsers(users) });
  };

  add('🔻 Unfollowed you (or blocked/deactivated)', diff.followers.lost);
  add('🔺 New followers', diff.followers.gained);
  add('➖ Gone from your following', diff.following.lost);
  add('➕ You started following', diff.following.gained);

  const renames = dedupeRenames(diff);
  if (renames.length > 0) {
    fields.push({
      name: `✏️ Renamed (${renames.length})`,
      value: renames
        .map((r) => `\`@${r.from}\` → \`@${r.to}\``)
        .join('\n')
        .slice(0, MAX_FIELD_CHARS),
    });
  }

  if (fields.length === 0) return null;
  return {
    title: `Instagram changes for @${username}`,
    color: diff.followers.lost.length > 0 ? 0xe74c3c : 0x2ecc71,
    fields,
    timestamp: new Date().toISOString(),
  };
}

async function postWebhook(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook returned ${res.status}: ${await res.text()}`);
  }
}

/** Posts the diff to Discord. Returns false when there was nothing to post. */
async function notifyDiff(url, username, diff) {
  const embed = buildDiffEmbed(username, diff);
  if (!embed) return false;
  await postWebhook(url, { embeds: [embed] });
  return true;
}

async function notifyBaseline(url, username, counts) {
  await postWebhook(url, {
    embeds: [
      {
        title: `UnfollowTracker is watching @${username}`,
        description:
          `Baseline saved: **${counts.followers}** followers, ` +
          `**${counts.following}** following.\nFuture changes will be posted here.`,
        color: 0x3498db,
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

module.exports = { notifyDiff, notifyBaseline, buildDiffEmbed };

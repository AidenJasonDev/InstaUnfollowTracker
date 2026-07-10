const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LIST_FILE = path.join(DATA_DIR, 'list.json');
const LOG_FILE = path.join(DATA_DIR, 'changes.log');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Loads the stored master list. Falls back to the newest snapshot-*.json
 * from the old storage format so existing data carries over.
 */
function loadList() {
  ensureDataDir();
  if (fs.existsSync(LIST_FILE)) {
    return JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
  }
  const snaps = fs
    .readdirSync(DATA_DIR)
    .filter((f) => /^snapshot-.*\.json$/.test(f))
    .sort();
  if (snaps.length > 0) {
    const snap = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, snaps[snaps.length - 1]), 'utf8')
    );
    return { updatedAt: snap.takenAt, followers: snap.followers, following: snap.following };
  }
  return null;
}

function saveList(lists) {
  ensureDataDir();
  const list = {
    updatedAt: new Date().toISOString(),
    followers: lists.followers,
    following: lists.following,
  };
  fs.writeFileSync(LIST_FILE, JSON.stringify(list, null, 2));
  return list;
}

/**
 * Diffs the stored list against a freshly fetched one, keyed by user id so
 * username changes are detected as renames instead of a fake
 * unfollow + new follower pair.
 */
function diffLists(prev, curr) {
  const diffSet = (before, after) => {
    const gained = [];
    const lost = [];
    const renamed = [];
    for (const id of Object.keys(after)) {
      if (!(id in before)) gained.push(after[id]);
      else if (before[id].username !== after[id].username)
        renamed.push({ from: before[id].username, to: after[id].username });
    }
    for (const id of Object.keys(before)) {
      if (!(id in after)) lost.push(before[id]);
    }
    return { gained, lost, renamed };
  };

  return {
    since: prev.updatedAt,
    until: curr.updatedAt,
    followers: diffSet(prev.followers, curr.followers),
    following: diffSet(prev.following, curr.following),
  };
}

/** A mutual follow who renames appears in both lists — collapse to unique pairs. */
function dedupeRenames(diff) {
  const seen = new Set();
  return [...diff.followers.renamed, ...diff.following.renamed].filter((r) => {
    const key = `${r.from}>${r.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Appends timestamped lines to data/changes.log. */
function appendLog(lines) {
  ensureDataDir();
  const stamp = new Date().toISOString();
  const text = lines.map((l) => `[${stamp}] ${l}`).join('\n') + '\n';
  fs.appendFileSync(LOG_FILE, text);
}

function readLog() {
  if (!fs.existsSync(LOG_FILE)) return null;
  return fs.readFileSync(LOG_FILE, 'utf8');
}

function notFollowingBack(list) {
  return Object.keys(list.following)
    .filter((id) => !(id in list.followers))
    .map((id) => list.following[id]);
}

function youDontFollowBack(list) {
  return Object.keys(list.followers)
    .filter((id) => !(id in list.following))
    .map((id) => list.followers[id]);
}

module.exports = {
  DATA_DIR,
  LIST_FILE,
  LOG_FILE,
  loadList,
  saveList,
  diffLists,
  dedupeRenames,
  appendLog,
  readLog,
  notFollowingBack,
  youDontFollowBack,
};

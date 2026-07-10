const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Random delay between paginated requests so fetching a large list
// doesn't look like a burst of automated traffic.
const pageDelay = () => sleep(1500 + Math.random() * 2000);

async function drainFeed(feed) {
  const users = {};
  do {
    const items = await feed.items();
    for (const u of items) {
      users[u.pk] = {
        username: u.username,
        fullName: u.full_name || '',
      };
    }
    if (feed.isMoreAvailable()) await pageDelay();
  } while (feed.isMoreAvailable());
  return users;
}

/**
 * Fetches the full followers and following lists for the logged-in account.
 * Returns { followers, following } where each is a map of userId -> {username, fullName}.
 */
async function fetchLists(ig) {
  const userId = ig.state.cookieUserId;

  process.stdout.write('Fetching followers... ');
  const followers = await drainFeed(ig.feed.accountFollowers(userId));
  console.log(`${Object.keys(followers).length}`);

  process.stdout.write('Fetching following... ');
  const following = await drainFeed(ig.feed.accountFollowing(userId));
  console.log(`${Object.keys(following).length}`);

  return { followers, following };
}

module.exports = { fetchLists };

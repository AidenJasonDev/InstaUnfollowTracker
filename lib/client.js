const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
  IgApiClient,
  IgLoginRequiredError,
  IgLoginBadPasswordError,
  IgLoginInvalidUserError,
  IgLoginTwoFactorRequiredError,
  IgCheckpointError,
  IgChallengeWrongCodeError,
} = require('instagram-private-api');

const SESSION_FILE = path.join(__dirname, '..', '.session.json');

// Stock instagram-private-api 1.46.1 still advertises Instagram 222.x. Meta now
// rejects that client with HTTP 467 + body "Unsupported" (or checkpoint_url
// .../unsupported_version/). Same bump used by actively maintained clients
// (e.g. instagram-cli). Overridden at runtime so npm install doesn't wipe it.
const APP_VERSION = '416.0.0.47.66';
const APP_VERSION_CODE = '382206157';

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

async function saveSession(ig) {
  const state = await ig.state.serialize();
  delete state.constants; // device constants are regenerated, not persisted
  fs.writeFileSync(SESSION_FILE, JSON.stringify(state), { mode: 0o600 });
}

async function restoreSession(ig) {
  if (!fs.existsSync(SESSION_FILE)) return false;
  try {
    await ig.state.deserialize(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')));
    await ig.account.currentUser(); // throws if the session is dead
    return true;
  } catch (err) {
    if (err instanceof IgLoginRequiredError) return false;
    if (err instanceof SyntaxError) return false;
    throw err;
  }
}

function newClient(username) {
  const ig = new IgApiClient();
  ig.state.constants = {
    ...ig.state.constants,
    APP_VERSION,
    APP_VERSION_CODE,
  };
  ig.state.generateDevice(username);
  return ig;
}

function responseBody(err) {
  const body = err && err.response && err.response.body;
  if (body == null) return '';
  return typeof body === 'string' ? body : JSON.stringify(body);
}

// Meta rejects the library's ancient app version with 467 + "Unsupported"
// (sometimes wrapped as checkpoint_required / unsupported_version).
function isUnsupportedClient(err) {
  const body = responseBody(err).toLowerCase();
  return body.includes('unsupported');
}

// Soft throttle: bare 467/429 with no useful body. Distinct from Unsupported.
function isRateLimit(err) {
  const code = err && err.response && err.response.statusCode;
  if (code !== 467 && code !== 429) return false;
  return !isUnsupportedClient(err);
}

function rateLimitError(code) {
  const e = new Error(
    `Instagram is temporarily rate-limiting this account/IP (HTTP ${code}). ` +
      'Your saved session is still valid — this is a soft block from too much recent ' +
      'activity, not a login problem. Wait several hours (ideally leave it overnight) ' +
      'before checking again, and avoid repeated runs: each attempt while blocked can ' +
      'extend it. Do NOT delete .session.json or re-login — that adds more activity.'
  );
  e.code = 'RATE_LIMIT';
  return e;
}

function unsupportedClientError() {
  const e = new Error(
    `Instagram rejected this client as an unsupported app version (HTTP 467). ` +
      `This project now emulates Instagram ${APP_VERSION}. Stop the running watch, ` +
      'then retry `node main.js check`. If it still fails, delete .session.json and ' +
      'run `node main.js login` once to mint a session with the updated client.'
  );
  e.code = 'UNSUPPORTED_CLIENT';
  return e;
}

// Turns Instagram's login rejections into messages that say what to actually do,
// instead of leaking a raw "400 Bad Request" that looks like a Discord/webhook error.
function explainLoginError(err) {
  if (err instanceof IgLoginBadPasswordError) {
    return 'Instagram rejected the password. Check IG_PASSWORD in .env.';
  }
  if (err instanceof IgLoginInvalidUserError) {
    return `Instagram says that username doesn't exist. Check IG_USERNAME in .env.`;
  }
  if (err instanceof IgLoginTwoFactorRequiredError) {
    return 'This account has two-factor authentication enabled. Run `node main.js login` to enter your 2FA code (a raw check/watch cannot prompt you).';
  }
  if (err instanceof IgCheckpointError) {
    return 'Instagram wants to verify this login with a security code (challenge). Run `node main.js login` to receive and enter that code once; afterwards the saved session is reused.';
  }
  return null;
}

/**
 * Returns a logged-in client for unattended use (check/watch). Reuses the saved
 * session; if it must log in fresh and Instagram demands 2FA or a challenge,
 * it fails with a clear instruction to run the interactive `login` command
 * rather than leaking a raw HTTP error.
 */
async function getClient(username, password) {
  const ig = newClient(username);

  try {
    if (await restoreSession(ig)) return ig;
  } catch (err) {
    // Soft block / unsupported-client during validation must not fall through
    // to a fresh password login — that piles more activity onto the problem.
    if (isUnsupportedClient(err)) throw unsupportedClientError();
    if (isRateLimit(err)) throw rateLimitError(err.response.statusCode);
    throw err;
  }

  if (!password) {
    throw new Error(
      'No valid session and no IG_PASSWORD set. Run `node main.js login` (or set IG_PASSWORD in .env) for the first login.'
    );
  }

  console.log(`No valid session found, logging in as @${username}...`);
  try {
    await ig.simulate.preLoginFlow();
    await ig.account.login(username, password);
  } catch (err) {
    const explained = explainLoginError(err);
    if (explained) throw new Error(explained);
    throw err;
  }
  await saveSession(ig);
  console.log('Logged in, session saved for reuse.');
  return ig;
}

async function resolveTwoFactor(ig, username, err) {
  const info = err.response.body.two_factor_info;
  const isTotp = info.totp_two_factor_on;
  const method = isTotp ? '0' : '1'; // 0 = authenticator app, 1 = SMS
  const where = isTotp
    ? 'your authenticator app'
    : `SMS sent to ${info.obfuscated_phone_number || 'your phone'}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const code = await prompt(`Enter the 2FA code from ${where}: `);
    try {
      await ig.account.twoFactorLogin({
        username,
        verificationCode: code,
        twoFactorIdentifier: info.two_factor_identifier,
        verificationMethod: method,
        trustThisDevice: '1',
      });
      return;
    } catch (e) {
      if (e instanceof IgChallengeWrongCodeError && attempt < 3) {
        console.log('That code was rejected, try again.');
        continue;
      }
      throw e;
    }
  }
}

async function resolveCheckpoint(ig) {
  // Ask Instagram to send a security code (email or SMS) for this challenge.
  await ig.challenge.auto(true);
  const contact = ig.state.challenge && ig.state.challenge.step_data;
  const dest =
    (contact && (contact.contact_point || contact.email || contact.phone_number)) || 'your email/SMS';
  console.log(`Instagram sent a security code to ${dest}.`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const code = await prompt('Enter the security code: ');
    try {
      await ig.challenge.sendSecurityCode(code);
      return;
    } catch (e) {
      if (e instanceof IgChallengeWrongCodeError && attempt < 3) {
        console.log('That code was rejected, try again.');
        continue;
      }
      throw e;
    }
  }
}

/**
 * Interactive first-time login. Handles the normal case, two-factor auth, and
 * Instagram's security-code challenge, then saves the session for reuse.
 */
async function interactiveLogin(username, password) {
  if (!password) throw new Error('Set IG_PASSWORD in .env before running login.');
  const ig = newClient(username);

  try {
    if (await restoreSession(ig)) {
      console.log('A valid session already exists — nothing to do.');
      return ig;
    }
  } catch (err) {
    if (isUnsupportedClient(err)) throw unsupportedClientError();
    if (isRateLimit(err)) throw rateLimitError(err.response.statusCode);
    throw err;
  }

  console.log(`Logging in as @${username}...`);
  await ig.simulate.preLoginFlow();
  try {
    await ig.account.login(username, password);
  } catch (err) {
    if (err instanceof IgLoginTwoFactorRequiredError) {
      await resolveTwoFactor(ig, username, err);
    } else if (err instanceof IgCheckpointError) {
      await resolveCheckpoint(ig);
    } else if (err instanceof IgLoginBadPasswordError) {
      throw new Error('Instagram rejected the password. Check IG_PASSWORD in .env.');
    } else if (err instanceof IgLoginInvalidUserError) {
      throw new Error(`Instagram says @${username} doesn't exist. Check IG_USERNAME in .env.`);
    } else if (isUnsupportedClient(err)) {
      throw unsupportedClientError();
    } else if (isRateLimit(err)) {
      throw rateLimitError(err.response.statusCode);
    } else {
      throw err;
    }
  }

  await saveSession(ig);
  console.log('Logged in — session saved to .session.json. Future runs reuse it.');
  return ig;
}

module.exports = {
  getClient,
  interactiveLogin,
  saveSession,
  isRateLimit,
  isUnsupportedClient,
  SESSION_FILE,
};

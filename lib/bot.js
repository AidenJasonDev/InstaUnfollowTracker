const {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const { buildDiffEmbed } = require('./discord');

/**
 * Starts a minimal Discord bot exposing a /check slash command.
 * `runCheck` must return { baseline, changes, counts, diff } and may throw
 * an error with code 'BUSY' when a check is already in progress.
 */
async function startBot({ token, guildId, username, runCheck }) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, async () => {
    const command = new SlashCommandBuilder()
      .setName('check')
      .setDescription('Run an UnfollowTracker check now and post any changes')
      .toJSON();
    const rest = new REST().setToken(token);
    try {
      if (guildId) {
        await rest.put(
          Routes.applicationGuildCommands(client.application.id, guildId),
          { body: [command] }
        );
        console.log(`Discord bot ready as ${client.user.tag} — /check registered.`);
      } else {
        await rest.put(Routes.applicationCommands(client.application.id), {
          body: [command],
        });
        console.log(
          `Discord bot ready as ${client.user.tag} — /check registered globally ` +
            '(can take up to an hour to appear; set DISCORD_GUILD_ID for instant registration).'
        );
      }
    } catch (err) {
      console.error(`Failed to register /check command: ${err.message}`);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'check') return;

    // Fetching both lists takes longer than Discord's 3s reply window.
    await interaction.deferReply();
    try {
      const result = await runCheck();
      await interaction.editReply(summarize(result));
    } catch (err) {
      if (err.code === 'BUSY') {
        await interaction.editReply('⏳ A check is already running — results will land shortly.');
      } else {
        await interaction.editReply(`❌ Check failed: ${err.message}`);
      }
    }
  });

  function summarize(result) {
    const { baseline, changes, counts, diff } = result;
    const size = `${counts.followers} followers, ${counts.following} following`;
    if (baseline) return `✅ Baseline created — ${size}. Future checks compare against it.`;
    if (changes === 0) return `✅ Check complete — no changes (${size}).`;
    if (process.env.DISCORD_WEBHOOK_URL) {
      return `✅ Check complete — ${changes} change(s), posted above via the webhook.`;
    }
    // No webhook configured: attach the changes embed to the reply itself.
    return {
      content: `✅ Check complete — ${changes} change(s).`,
      embeds: [buildDiffEmbed(username, diff)],
    };
  }

  await client.login(token);
  return client;
}

module.exports = { startBot };

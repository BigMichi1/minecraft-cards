import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction, MessageCreateOptions } from 'discord.js';
import { runCheck, type RunDeps } from './check/runner';
import { createScheduler } from './check/scheduler';
import * as adminCommand from './commands/admin';
import * as helpCommand from './commands/help';
import * as missingCommand from './commands/missing';
import { ConfigError, loadConfig, type Config } from './config';
import { catalogManager } from './database/catalogManager';
import { closeDatabase, initializeDatabase } from './database/db';
import { userManager } from './database/userManager';
import { handleCatalogButton } from './interactions/catalogImport';
import { handleReportButton, handleReportModal, handleReportReason } from './interactions/report';
import { buttonRoute, isReportModal } from './interactions/router';
import {
  createCachedEmbedder,
  createTransformersEmbedder,
  type ImageEmbedder,
} from './matcher/embedder';
import { createDiscordSender } from './notify/sender';
import { createBlueOceanAdapter } from './shops/blueOcean';
import { createEbayAdapter } from './shops/ebay';
import { createSammelEnteAdapter } from './shops/sammelEnte';
import type { ShopAdapter } from './shops/types';
import { errorMessage } from './utils/async';
import { replyWithError } from './utils/interactionReply';
import logger from './utils/logger';

const DM_FAILURE_NOTICE = "I couldn't send you a DM — please allow DMs from server members.";

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  logger.error(`Invalid configuration: ${error.message}`);
  process.exit(1);
}

initializeDatabase();
catalogManager.seedIfEmpty();
logger.info('Card catalog ready');

let embedder: ImageEmbedder | null = null;
/** Set when the model failed to load; the admin gets one DM about it once Discord is ready. */
let modelLoadFailure: string | null = null;
try {
  embedder = createCachedEmbedder(
    await createTransformersEmbedder({ model: config.imageModel, cacheDir: config.modelCacheDir })
  );
  logger.info(`Image model ${config.imageModel} loaded`);
} catch (error) {
  modelLoadFailure = `Image model ${config.imageModel} could not be loaded, running without image matching: ${errorMessage(error)}`;
  logger.error(modelLoadFailure);
}

const adapters: ShopAdapter[] = [createSammelEnteAdapter(), createBlueOceanAdapter()];
if (config.ebay) {
  adapters.push(createEbayAdapter(config.ebay));
} else {
  logger.warn('eBay disabled: EBAY_CLIENT_ID/EBAY_CLIENT_SECRET not set');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
});

async function dmAdmin(message: string | MessageCreateOptions): Promise<void> {
  const admin = await client.users.fetch(config.botAdminId);
  await admin.send(message);
}

const runDeps: RunDeps = {
  adapters,
  embedder,
  threshold: config.imageMatchThreshold,
  sender: createDiscordSender(client),
  alertAdmin: (text) => dmAdmin(text),
  now: Date.now,
  intervalMs: config.checkIntervalMs,
};
const scheduler = createScheduler(() => runCheck(runDeps), config.checkIntervalMs);

// Commands are imported statically: dynamic scanning breaks the compiled bundle.
const commands: Record<
  string,
  { data: { name: string }; execute: (i: ChatInputCommandInteraction) => Promise<void> }
> = {
  [adminCommand.data.name]: {
    data: adminCommand.data,
    execute: (i) =>
      adminCommand.execute(i, { adminId: config.botAdminId, trigger: () => scheduler.trigger() }),
  },
  [helpCommand.data.name]: helpCommand,
  [missingCommand.data.name]: missingCommand,
};
const commandData = [adminCommand.data, helpCommand.data, missingCommand.data];

client.on(Events.ClientReady, async (ready) => {
  logger.info(`Logged in as ${ready.user.tag}`);
  try {
    if (config.guildId) {
      const guild = await ready.guilds.fetch(config.guildId);
      await guild.commands.set(commandData);
      logger.info(`Registered ${commandData.length} commands in guild ${config.guildId}`);
    } else {
      await ready.application.commands.set(commandData);
      logger.info(`Registered ${commandData.length} global commands`);
    }
  } catch (error) {
    logger.error(`Registering slash commands failed: ${errorMessage(error)}`);
  }
  if (modelLoadFailure) {
    const text = modelLoadFailure;
    modelLoadFailure = null;
    try {
      await dmAdmin(text);
    } catch (error) {
      logger.warn(`Could not tell the admin about the image model: ${errorMessage(error)}`);
    }
  }
  scheduler.start();
  logger.info(`Stock check scheduled every ${config.checkIntervalMs / 60_000} minutes`);
});

/** True once if a DM to this user failed since they last ran a command; never throws. */
function takeDmFailure(userId: string): boolean {
  try {
    return userManager.takeDmFailure(userId);
  } catch (error) {
    logger.warn(`Reading the DM failure flag for ${userId} failed: ${errorMessage(error)}`);
    return false;
  }
}

async function runChatCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const command = commands[interaction.commandName];
  if (!command) return;
  const dmFailed = takeDmFailure(interaction.user.id);
  logger.info(`[COMMAND] /${interaction.commandName} from ${interaction.user.tag}`);
  try {
    await command.execute(interaction);
  } catch (error) {
    logger.error(`[COMMAND] /${interaction.commandName} failed: ${errorMessage(error)}`);
    await replyWithError(interaction, 'Command failed', 'Something went wrong. Please try again.');
  }
  if (dmFailed && (interaction.replied || interaction.deferred)) {
    try {
      await interaction.followUp({ content: DM_FAILURE_NOTICE, flags: MessageFlags.Ephemeral });
    } catch (error) {
      logger.warn(`Could not send the DM failure notice: ${errorMessage(error)}`);
    }
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await runChatCommand(interaction);
    } else if (interaction.isButton()) {
      switch (buttonRoute(interaction.customId)) {
        case 'report':
          await handleReportButton(interaction);
          break;
        case 'report-reason':
          await handleReportReason(interaction);
          break;
        case 'catalog':
          // No store argument: the module-level store is the one /admin catalog import fills.
          await handleCatalogButton(interaction, { adminId: config.botAdminId });
          break;
        case null:
          break;
      }
    } else if (interaction.isModalSubmit() && isReportModal(interaction.customId)) {
      await handleReportModal(interaction, dmAdmin);
    }
  } catch (error) {
    logger.error(`[INTERACTION] unhandled error: ${errorMessage(error)}`);
    if (interaction.isRepliable()) {
      await replyWithError(interaction, 'Something went wrong', 'Please try again later.');
    }
  }
});

// SIGINT comes from a terminal; SIGTERM is what `docker stop` sends.
let shuttingDown = false;
async function shutdown(reason: string, code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Shutting down (${reason})...`);
  scheduler.stop();
  await client.destroy();
  await closeDatabase();
  process.exit(code);
}

process.on('SIGINT', () => void shutdown('SIGINT', 0));
process.on('SIGTERM', () => void shutdown('SIGTERM', 0));

// Without these, a rejection inside an async discord.js listener can take the
// process down with no diagnostic.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
});

try {
  await client.login(config.discordToken);
} catch (error) {
  logger.error(`Discord login failed: ${errorMessage(error)}`);
  await shutdown('login failed', 1);
}

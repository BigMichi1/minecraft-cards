import { Client, Events, GatewayIntentBits } from 'discord.js';
import type { MessageCreateOptions } from 'discord.js';
import { throttledAlert } from './check/adminAlert';
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
import {
  handleReportButton,
  handleReportModal,
  handleReportReason,
  retryUnsentReports,
} from './interactions/report';
import { buttonRoute, isReportModal } from './interactions/router';
import { createShutdown, runChatCommand, type ChatCommand } from './lifecycle';
import {
  createCachedEmbedder,
  createTransformersEmbedder,
  type ImageEmbedder,
} from './matcher/embedder';
import { createDiscordSender } from './notify/sender';
import { createShopAdapters } from './shops/adapters';
import { errorMessage } from './utils/async';
import { replyWithError } from './utils/interactionReply';
import logger, { logError } from './utils/logger';

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
  logError(`Image model ${config.imageModel} could not be loaded`, error);
}

const adapters = createShopAdapters(config.ebay);

/** The shops this process checks; `/missing status` shows the others as not enabled. */
const enabledShops = adapters.map((a) => a.id);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
});

async function dmAdmin(message: string | MessageCreateOptions): Promise<void> {
  const admin = await client.users.fetch(config.botAdminId);
  await admin.send(message);
}

/** How long shutdown waits for a check in progress before closing the client and database. */
const SHUTDOWN_GRACE_MS = 5_000;

// The scheduler is created below; shutdown only runs once the process is up.
let stopScheduler: () => Promise<void> = async () => {};
const { shutdown, isShuttingDown } = createShutdown({
  stopScheduler: () => stopScheduler(),
  destroyClient: () => client.destroy(),
  closeDatabase,
  exit: (code) => process.exit(code),
  graceMs: SHUTDOWN_GRACE_MS,
});

const alertAdmin = (text: string) => dmAdmin(text);
const runDeps: RunDeps = {
  adapters,
  embedder,
  threshold: config.imageMatchThreshold,
  sender: createDiscordSender(client, {
    isShuttingDown,
    alert: throttledAlert(alertAdmin, Date.now),
  }),
  alertAdmin,
  now: Date.now,
  intervalMs: config.checkIntervalMs,
  retryReports: () => retryUnsentReports(dmAdmin),
  // A failing reference picture is tried again once a day, across runs.
  referenceFailures: new Map(),
};
const scheduler = createScheduler(() => runCheck(runDeps), config.checkIntervalMs);
stopScheduler = () => scheduler.stop();

// Commands are imported statically, so `bun run build` can still bundle the bot into one
// binary (a dynamic directory scan would not be bundled).
const commands: Record<string, ChatCommand> = {
  [adminCommand.data.name]: {
    execute: (i) =>
      adminCommand.execute(i, { adminId: config.botAdminId, trigger: () => scheduler.trigger() }),
  },
  [helpCommand.data.name]: helpCommand,
  [missingCommand.data.name]: { execute: (i) => missingCommand.execute(i, { enabledShops }) },
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
    logError('Registering slash commands failed', error);
    try {
      await dmAdmin(
        `Registering the slash commands failed, so they may be missing or outdated: ${errorMessage(error)}`
      );
    } catch (dmError) {
      logError('Could not tell the admin about the command registration', dmError, 'warn');
    }
  }
  if (modelLoadFailure) {
    const text = modelLoadFailure;
    modelLoadFailure = null;
    try {
      await dmAdmin(text);
    } catch (error) {
      logError('Could not tell the admin about the image model', error, 'warn');
    }
  }
  scheduler.start();
  logger.info(`Stock check scheduled every ${config.checkIntervalMs / 60_000} minutes`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await runChatCommand(interaction, {
        commands,
        hasDmFailure: (id) => userManager.hasDmFailure(id),
        clearDmFailure: (id) => userManager.clearDmFailure(id),
      });
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
    logError('[INTERACTION] unhandled error', error);
    if (interaction.isRepliable()) {
      await replyWithError(interaction, 'Something went wrong', 'Please try again later.');
    }
  }
});

// SIGINT comes from a terminal; SIGTERM is what `docker stop` sends.
process.on('SIGINT', () => void shutdown('SIGINT', 0));
process.on('SIGTERM', () => void shutdown('SIGTERM', 0));

// Without these, a rejection inside an async discord.js listener can take the
// process down with no diagnostic.
process.on('unhandledRejection', (reason) => {
  logError('Unhandled promise rejection', reason);
});
// After an uncaught exception the process state is unknown: log it and stop.
process.on('uncaughtException', (error) => {
  logError('Uncaught exception', error);
  void shutdown('uncaught exception', 1);
});

try {
  await client.login(config.discordToken);
} catch (error) {
  logError('Discord login failed', error);
  await shutdown('login failed', 1);
}

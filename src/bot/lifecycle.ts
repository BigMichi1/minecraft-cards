import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { settlesWithin } from './utils/async';
import { replyWithError } from './utils/interactionReply';
import logger, { logError } from './utils/logger';

export const DM_FAILURE_NOTICE = "I couldn't send you a DM — please allow DMs from server members.";

export interface ShutdownDeps {
  /** Stops the scheduler; resolves once a check in progress has finished. */
  stopScheduler: () => Promise<void>;
  destroyClient: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  exit: (code: number) => void;
  /** How long to wait for a check in progress before closing anyway. */
  graceMs: number;
}

export interface Shutdown {
  /** Stop everything and exit with `code` (1 when a step failed); a second call does nothing. */
  shutdown(reason: string, code: number): Promise<void>;
  /** True once shutdown() was called; DMs failing then are the client going away. */
  isShuttingDown(): boolean;
}

/**
 * Orderly stop: scheduler (waiting at most `graceMs` for a check in progress), Discord client,
 * database. Every step runs even when an earlier one failed, and the process always exits.
 */
export function createShutdown(deps: ShutdownDeps): Shutdown {
  let shuttingDown = false;
  return {
    isShuttingDown: () => shuttingDown,
    async shutdown(reason, code) {
      if (shuttingDown) return;
      shuttingDown = true;
      let exitCode = code;
      const step = async (name: string, run: () => Promise<unknown>) => {
        try {
          await run();
        } catch (error) {
          logError(`Shutdown: ${name} failed`, error);
          exitCode = exitCode || 1;
        }
      };
      try {
        logger.info(`Shutting down (${reason})...`);
        await step('stopping the scheduler', async () => {
          if (!(await settlesWithin(deps.stopScheduler(), deps.graceMs))) {
            logger.warn(
              `A check was still running after ${deps.graceMs / 1000} s; stopping anyway`
            );
          }
        });
        await step('closing the Discord client', deps.destroyClient);
        await step('closing the database', deps.closeDatabase);
      } finally {
        deps.exit(exitCode);
      }
    },
  };
}

export interface ChatCommand {
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

export interface ChatCommandDeps {
  commands: Record<string, ChatCommand>;
  /** True when a DM to this user failed since their last notice (userManager.hasDmFailure). */
  hasDmFailure: (userId: string) => boolean;
  /** Clear that flag once the user saw the notice (userManager.clearDmFailure). */
  clearDmFailure: (userId: string) => void;
}

/** The DM failure flag, or false (logged) when it cannot be read. */
function dmFailed(deps: ChatCommandDeps, userId: string): boolean {
  try {
    return deps.hasDmFailure(userId);
  } catch (error) {
    logError(`Reading the DM failure flag for ${userId} failed`, error);
    return false;
  }
}

/**
 * Run a slash command. When a DM to the user failed, add an ephemeral notice after the
 * command's own reply; the flag is cleared only once that notice went out, so a command that
 * did not reply (or a failed follow-up) keeps it for the next command.
 */
export async function runChatCommand(
  interaction: ChatInputCommandInteraction,
  deps: ChatCommandDeps
): Promise<void> {
  const command = deps.commands[interaction.commandName];
  if (!command) return;
  const userId = interaction.user.id;
  logger.info(`[COMMAND] /${interaction.commandName} from ${interaction.user.tag}`);
  try {
    await command.execute(interaction);
  } catch (error) {
    logError(`[COMMAND] /${interaction.commandName} failed`, error);
    await replyWithError(interaction, 'Command failed', 'Something went wrong. Please try again.');
  }
  if (!(interaction.replied || interaction.deferred) || !dmFailed(deps, userId)) return;
  try {
    await interaction.followUp({ content: DM_FAILURE_NOTICE, flags: MessageFlags.Ephemeral });
  } catch (error) {
    logError('Could not send the DM failure notice', error, 'warn');
    return;
  }
  try {
    deps.clearDmFailure(userId);
  } catch (error) {
    logError(`Clearing the DM failure flag for ${userId} failed`, error);
  }
}

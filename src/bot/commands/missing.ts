import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { formatCardList } from '../cards/cardId';
import { userManager, type ListChange } from '../database/userManager';
import { joinWithinLimit } from '../utils/messageLimit';
import { replyWithError } from '../utils/interactionReply';
import logger from '../utils/logger';

const LIST_OPTION_MAX_LENGTH = 6000;

export const data = new SlashCommandBuilder()
  .setName('missing')
  .setDescription('Manage the list of cards you are missing')
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Replace your missing list')
      .addStringOption((o) =>
        o
          .setName('list')
          .setDescription('Card numbers, e.g. 12, 45, LE8 or 20-25')
          .setRequired(true)
          .setMaxLength(LIST_OPTION_MAX_LENGTH)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add cards to your missing list')
      .addStringOption((o) =>
        o
          .setName('list')
          .setDescription('Card numbers, e.g. 12, 45, LE8 or 20-25')
          .setRequired(true)
          .setMaxLength(LIST_OPTION_MAX_LENGTH)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove cards from your missing list')
      .addStringOption((o) =>
        o
          .setName('list')
          .setDescription('Card numbers, e.g. 12, 45, LE8 or 20-25')
          .setRequired(true)
          .setMaxLength(LIST_OPTION_MAX_LENGTH)
      )
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('Show your missing list'))
  .addSubcommand((sub) => sub.setName('clear').setDescription('Empty your missing list'));

function describeChange(change: ListChange): string {
  if (change.ok) {
    return joinWithinLimit(
      `Your missing cards (${change.ids.length}): `,
      formatCardList(change.ids).split(', ')
    );
  }
  if (change.invalid.length === 0) return 'No card numbers found. Example: 12, 45, LE8';
  return joinWithinLimit('Nothing changed. Unknown or invalid: ', [...new Set(change.invalid)]);
}

function run(interaction: ChatInputCommandInteraction): string {
  const userId = interaction.user.id;
  const sub = interaction.options.getSubcommand();
  switch (sub) {
    case 'set':
      return describeChange(
        userManager.setList(userId, interaction.options.getString('list', true))
      );
    case 'add':
      return describeChange(
        userManager.addToList(userId, interaction.options.getString('list', true))
      );
    case 'remove':
      return describeChange(
        userManager.removeFromList(userId, interaction.options.getString('list', true))
      );
    case 'list': {
      const ids = userManager.getList(userId);
      return ids.length === 0
        ? 'You have no missing cards on your list.'
        : describeChange({ ok: true, ids });
    }
    case 'clear':
      userManager.clearList(userId);
      return 'Your missing list is now empty.';
    default:
      throw new Error(`Unknown /missing subcommand: ${sub}`);
  }
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const content = run(interaction);
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch (error) {
    logger.error('[MISSING COMMAND] Error:', error);
    await replyWithError(interaction, 'Error', 'Something went wrong while updating your list.');
  }
}

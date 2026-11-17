import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import logger from '../utils/logger';
import { replyWithError } from '../utils/interactionReply';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show how to use the bot');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const embed = new EmbedBuilder()
      .setColor(0x0099ff)
      .setTitle('Minecraft Cards Bot - Help')
      .setDescription(
        'Tell the bot which Minecraft cards you are missing and it sends you a DM when one is available in a shop.'
      )
      .addFields(
        {
          name: '/missing set list:<cards>',
          value: 'Replace your list. Example: `12, 45, LE8`',
        },
        {
          name: '/missing add / remove list:<cards>',
          value: 'Add or remove cards. Ranges work too: `20-25`',
        },
        {
          name: '/missing list / clear',
          value: 'Show your list, or empty it.',
        },
        {
          name: 'Wrong card?',
          value:
            'If a notification shows the wrong card, press the wrong-card button on that message to report it.',
        },
        {
          name: 'Good to know',
          value:
            'Allow DMs from server members, otherwise the bot cannot reach you. The bot checks the shops every hour.',
        }
      );

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  } catch (error) {
    logger.error('[HELP COMMAND] Error:', error);
    await replyWithError(interaction, 'Error', 'An error occurred while displaying help.');
  }
}

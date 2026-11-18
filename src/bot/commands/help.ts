import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { logError } from '../utils/logger';
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
          name: '/missing status',
          value: 'Your missing cards with what each shop last showed, and how fresh that is.',
        },
        {
          name: '/stock [only:all|missing|in-stock]',
          value:
            'Every card and which shop has it in stock (`x`), page by page with ◀ ▶. `only:missing` shows your list, `only:in-stock` the cards available somewhere.',
        },
        {
          name: '/card number:<id> [shop:<shop>]',
          value:
            'One card in every shop (or just `shop:`), with buttons to the cheapest offer per shop. Example: `/card number:LE8`',
        },
        {
          name: 'Wrong card?',
          value:
            'If a notification shows the wrong card, press ❌ Wrong in the row with the same number (1️⃣, 2️⃣, …) as that card.',
        },
        {
          name: 'Good to know',
          value:
            'Allow DMs from server members, otherwise the bot cannot reach you. The bot checks the shops every hour (the admin can change the interval).',
        }
      );

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  } catch (error) {
    logError('[HELP COMMAND] failed', error);
    await replyWithError(interaction, 'Error', 'An error occurred while displaying help.');
  }
}

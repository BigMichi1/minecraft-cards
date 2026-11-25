import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { logError } from '../utils/logger';
import { replyWithError } from '../utils/interactionReply';
import { COLLECTIONS } from '../collections/index';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show how to use the bot');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const embed = new EmbedBuilder()
      .setColor(0x0099ff)
      .setTitle('Minecraft Cards Bot - Help')
      .setDescription(
        'Tell the bot which cards you are missing, per collection, and it sends you a DM when one is available in a shop.'
      )
      .addFields(
        {
          name: 'Collections',
          value: `Every card command names its collection (\`collection:\`), each with its own list: ${COLLECTIONS.map((c) => c.name).join(', ')}.`,
        },
        {
          name: '/missing set collection:<c> list:<cards>',
          value: 'Replace your list. Example: `12, 45, LE8`',
        },
        {
          name: '/missing add / remove collection:<c> list:<cards>',
          value: 'Add or remove cards. Ranges work too: `20-25`',
        },
        {
          name: '/missing list / clear collection:<c>',
          value: 'Show your list, or empty it.',
        },
        {
          name: '/missing status collection:<c>',
          value: 'Your missing cards with what each shop last showed, and how fresh that is.',
        },
        {
          name: '/stock collection:<c> [only:all|missing|in-stock]',
          value:
            'Every card and which shop has it in stock (`x`), page by page with ◀ ▶. `only:missing` shows your list, `only:in-stock` the cards available somewhere.',
        },
        {
          name: '/card collection:<c> number:<id> [shop:<shop>]',
          value:
            'One card in every shop (or just `shop:`), with buttons to the cheapest offer per shop. Example: `/card collection:lego-minecraft-3 number:LE8`',
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

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { ChatInputCommandInteraction, SlashCommandStringOption } from 'discord.js';
import { formatCardList, normalizeCardId, type CardId } from '../cards/cardId';
import { formatSyncOutcome, type SyncOutcome } from '../catalog/sync';
import { manualRefusal, removeRow, removeStore } from '../interactions/catalogRemove';
import { MAX_URL, validUrl } from '../notify/messages';
import { parseChecklist } from '../cards/starterCatalog';
import type { PictureCounts, RunSummary } from '../check/runner';
import { PICTURE_REJECTIONS, type PictureRejection } from '../matcher/matchStatus';
import { catalogManager, parseKnownCardList, type ManualRefusal } from '../database/catalogManager';
import { listingManager, type StoredListing } from '../database/listingManager';
import { runManager, shopEntries } from '../database/runManager';
import type { AdminDeps } from '../interactions/adminActions';
import { buildPreviewText, importStore } from '../interactions/catalogImport';
import { errorMessage } from '../utils/async';
import { ephemeral, replyWithError } from '../utils/interactionReply';
import { logError } from '../utils/logger';
import { DISCORD_MESSAGE_LIMIT, clipText, joinWithinLimit } from '../utils/messageLimit';
import type { CollectionId } from '../collections/ids';
import { collectionName } from '../collections/index';
import { collectionOption, readCollection, UNKNOWN_COLLECTION } from './collectionOption';

const LIST_OPTION_MAX_LENGTH = 6000;

export interface AdminContext extends AdminDeps {
  trigger: () => Promise<RunSummary | 'busy' | 'stopping'>;
  /**
   * Sync the collection's catalog from laststicker now (`/admin catalog sync`); undefined when
   * it has no laststicker set.
   */
  syncCatalog: (collection: CollectionId) => Promise<SyncOutcome | undefined>;
}

/** `#XXL123` with room to spare; a card id is never longer. */
const CARD_MAX_LENGTH = 10;
const NAME_MAX_LENGTH = 100;

const cardOption = (o: SlashCommandStringOption, required = true) =>
  o
    .setName('card')
    .setDescription('Card number, e.g. 135 or LE8')
    .setRequired(required)
    .setMaxLength(CARD_MAX_LENGTH);
const nameOption = (o: SlashCommandStringOption, required: boolean) =>
  o.setName('name').setDescription('Card name').setRequired(required).setMaxLength(NAME_MAX_LENGTH);
const pictureOption = (o: SlashCommandStringOption) =>
  o.setName('picture').setDescription('Reference picture URL');

export const data = new SlashCommandBuilder()
  .setName('admin')
  .setDescription('Bot administration')
  // Hidden from non-administrators in the command picker; execute() still checks adminId.
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('map')
      .setDescription('Set the collection and cards of a stored listing')
      .addStringOption(collectionOption)
      .addStringOption((o) => o.setName('url').setDescription('Listing URL').setRequired(true))
      .addStringOption((o) =>
        o.setName('cards').setDescription('Card numbers, e.g. 12, LE8').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('clear')
      .setDescription('Lift the hold on a listing and resolve its reports')
      .addStringOption((o) => o.setName('url').setDescription('Listing URL').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Show the last check run and listings on hold')
  )
  .addSubcommand((sub) => sub.setName('run').setDescription('Run a check now'))
  .addSubcommandGroup((group) =>
    group
      .setName('catalog')
      .setDescription('Manage the card catalog')
      .addSubcommand((sub) =>
        sub
          .setName('import')
          .setDescription('Import a pasted laststicker checklist')
          .addStringOption(collectionOption)
          .addStringOption((o) =>
            o
              .setName('list')
              .setDescription('The pasted checklist')
              .setRequired(true)
              .setMaxLength(LIST_OPTION_MAX_LENGTH)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('sync')
          .setDescription('Sync the catalog from laststicker now')
          .addStringOption(collectionOption)
      )
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a card laststicker lacks')
          .addStringOption(collectionOption)
          .addStringOption((o) => cardOption(o))
          .addStringOption((o) => nameOption(o, true))
          .addStringOption(pictureOption)
      )
      .addSubcommand((sub) =>
        sub
          .setName('edit')
          .setDescription('Change a manual card')
          .addStringOption(collectionOption)
          .addStringOption((o) => cardOption(o))
          .addStringOption((o) => nameOption(o, false))
          .addStringOption(pictureOption)
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a manual card (asks first)')
          .addStringOption(collectionOption)
          .addStringOption((o) => cardOption(o))
      )
      .addSubcommand((sub) =>
        sub
          .setName('release')
          .setDescription('Hand a manual card to laststicker')
          .addStringOption(collectionOption)
          .addStringOption((o) => cardOption(o))
      )
  );

/** A picture option: its URL when valid, `null` when not given, the refusal when invalid. */
function readPicture(
  interaction: ChatInputCommandInteraction
): { url: string | null } | { refusal: string } {
  const raw = interaction.options.getString('picture');
  if (raw === null) return { url: null };
  const url = validUrl(raw.trim());
  if (url) return { url };
  return {
    refusal: `Not a valid picture URL (http or https, at most ${MAX_URL} characters): ${clipText(raw.trim(), 200)}`,
  };
}

/**
 * The card's reference picture changed (a manual card's new picture, a release): compare its
 * mismatches again. The change itself is made either way; a failure is logged and returned as
 * the line the admin's reply adds.
 */
function rematchCard(collection: CollectionId, cardId: CardId, retry: string): string {
  try {
    listingManager.rematchMismatches(collection, [cardId]);
    return '';
  } catch (error) {
    logError(`re-matching the mismatches of #${cardId} failed`, error);
    return `\n⚠️ Its mismatches could not be compared again (${errorMessage(error)}); ${retry}.`;
  }
}

/** `/admin catalog sync|add|edit|remove|release` for one collection. */
async function catalogCardCommand(
  interaction: ChatInputCommandInteraction,
  sub: string,
  collection: CollectionId,
  ctx: AdminContext
): Promise<void> {
  const inCollection = collectionName(collection);
  if (sub === 'sync') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const outcome = await ctx.syncCatalog(collection);
    await interaction.editReply({
      content: outcome
        ? formatSyncOutcome(outcome)
        : 'Nothing to sync: this collection has no laststicker set.',
    });
    return;
  }
  const token = interaction.options.getString('card', true).trim();
  const cardId = normalizeCardId(token);
  if (!cardId) {
    await interaction.reply(ephemeral(clipText(`Not a card number: ${token}`, 200)));
    return;
  }
  const now = Date.now();
  const refused = (reason: ManualRefusal) =>
    interaction.reply(ephemeral(manualRefusal(reason, cardId, inCollection)));
  switch (sub) {
    case 'add': {
      const name = interaction.options.getString('name', true).trim();
      if (!name) {
        await interaction.reply(ephemeral('A card needs a name.'));
        return;
      }
      const picture = readPicture(interaction);
      if ('refusal' in picture) {
        await interaction.reply(ephemeral(picture.refusal));
        return;
      }
      const result = catalogManager.addManual(collection, cardId, name, picture.url, now);
      if (!result.ok) {
        await refused(result.reason);
        return;
      }
      await interaction.reply(ephemeral(`Added #${cardId} ${name} to ${inCollection} (manual).`));
      return;
    }
    case 'edit': {
      const name = interaction.options.getString('name')?.trim();
      const picture = readPicture(interaction);
      if ('refusal' in picture) {
        await interaction.reply(ephemeral(picture.refusal));
        return;
      }
      if (!name && picture.url === null) {
        await interaction.reply(ephemeral('Nothing to change: give name or picture.'));
        return;
      }
      const result = catalogManager.editManual(
        collection,
        cardId,
        { ...(name ? { name } : {}), ...(picture.url ? { pictureUrl: picture.url } : {}) },
        now
      );
      if (!result.ok) {
        await refused(result.reason);
        return;
      }
      const warning = picture.url
        ? rematchCard(collection, cardId, 'run the edit with the picture again to retry')
        : '';
      const card = catalogManager.getCard(collection, cardId);
      await interaction.reply(ephemeral(`#${cardId} now: ${card?.name ?? '(no name)'}.${warning}`));
      return;
    }
    case 'remove': {
      const manual = catalogManager.manualCard(collection, cardId);
      if (!manual.ok) {
        await refused(manual.reason);
        return;
      }
      const { card } = manual;
      const users = catalogManager.wantedCount(collection, cardId);
      await interaction.reply({
        content: `Remove manual card #${cardId}${card.name ? ` ${card.name}` : ''}? ${users} user(s) have it on their missing list.`,
        components: [removeRow(removeStore.put(collection, cardId))],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    case 'release': {
      const result = catalogManager.releaseManual(collection, cardId, now);
      if (!result.ok) {
        await refused(result.reason);
        return;
      }
      // The next sync sets its scan, a changed reference, and re-matches it then (repictured).
      const warning = rematchCard(
        collection,
        cardId,
        'the next catalog sync does it with its scan'
      );
      await interaction.reply(
        ephemeral(`#${cardId} now follows laststicker from the next sync.${warning}`)
      );
      return;
    }
    default:
      throw new Error(`Unknown /admin catalog subcommand: ${sub}`);
  }
}

const REJECTION_TEXT: Record<PictureRejection, string> = {
  undecided: 'undecided',
  puzzle: 'puzzle',
  twin: 'twin',
  incomplete: 'incomplete reference set',
  title_fits: 'title card fits too',
};

/** `Pictures: 3 decided · not counted: 5 undecided, 1 puzzle` (zero counts left out). */
function picturesLine(pictures: PictureCounts): string {
  const rejected = PICTURE_REJECTIONS.filter((r) => pictures[r]).map(
    (r) => `${pictures[r]} ${REJECTION_TEXT[r]}`
  );
  return `Pictures: ${pictures.decided ?? 0} decided${rejected.length > 0 ? ` · not counted: ${rejected.join(', ')}` : ''}`;
}

export function formatSummary(summary: RunSummary): string {
  const lines: string[] = [];
  let heading: CollectionId | null = null;
  for (const { collection, shop, entry: s } of shopEntries(summary)) {
    if (collection !== heading) {
      lines.push(`${collectionName(collection)}:`);
      heading = collection;
    }
    let line = `${shop}: ${s.listings} listings`;
    if (s.error) line += ` — error: ${s.error}`;
    if (s.skippedNoId) line += ` (skipped ${s.skippedNoId} without card number)`;
    if (s.skippedExcluded)
      line += ` (skipped ${s.skippedExcluded} not single cards of this collection)`;
    if (s.truncated) {
      line += ` (${s.truncated} ${s.truncated === 1 ? 'search' : 'searches'} cut at the page cap)`;
    }
    if (s.skippedInvalid) line += ` (skipped ${s.skippedInvalid} without link or title)`;
    lines.push(line);
  }
  if (summary.error) lines.push(`Run failed: ${summary.error}`);
  if (summary.pictures) lines.push(picturesLine(summary.pictures));
  if (summary.rematch) {
    lines.push(
      `Re-match: ${summary.rematch.compared} compared, ${summary.rematch.changed} changed`
    );
  }
  lines.push(`Notified: ${summary.notified} · DM failures: ${summary.dmFailures}`);
  return lines.join('\n').slice(0, DISCORD_MESSAGE_LIMIT);
}

const MAX_HOLDS_SHOWN = 10;

/** `On hold: N listings` and up to 10 `url (#ids)` lines, cut to what fits in `room`. */
function holdsText(held: StoredListing[], room: number): string {
  let text = `On hold: ${held.length} listings`;
  let shown = 0;
  for (const l of held.slice(0, MAX_HOLDS_SHOWN)) {
    const ids = l.cardIds.map((id) => `#${id}`).join(', ') || 'no cards';
    const line = `\n- ${l.url} (${ids})`;
    const rest = held.length - shown - 1;
    const tail = rest > 0 ? `\n… and ${rest} more` : '';
    if (text.length + line.length + tail.length > room) break;
    text += line;
    shown++;
  }
  if (shown < held.length) text += `\n… and ${held.length - shown} more`;
  return text.slice(0, room);
}

function statusText(): string {
  const last = runManager.last();
  const run = last
    ? `Last run: <t:${Math.floor(last.finishedAt / 1000)}:R>\n${formatSummary(last)}`
    : 'No check has run yet.';
  const held = listingManager.onHold();
  if (held.length === 0) return run.slice(0, DISCORD_MESSAGE_LIMIT);
  // With holds to list, the run summary may take at most half, so the holds always get room.
  const head = run.slice(0, DISCORD_MESSAGE_LIMIT / 2);
  return `${head}\n\n${holdsText(held, DISCORD_MESSAGE_LIMIT - head.length - 2)}`;
}

function mapCards(url: string, collection: CollectionId, cardsInput: string): string {
  const stored = listingManager.getByUrl(url);
  // A listing moved to a collection its shop is not checked for would never be updated again
  // (listingManager.overrideCards), so moves wait for per-collection shops. Checked before the
  // cards, which are read in the chosen collection and would give the wrong reason.
  if (stored && stored.collection !== collection) {
    return `Nothing changed: the listing is in collection ${collectionName(stored.collection)}; moving a listing to another collection is not supported yet.`;
  }
  const parsed = parseKnownCardList(collection, cardsInput);
  if (!parsed.ok) {
    return parsed.reason === 'empty'
      ? 'No card numbers found. Example: 12, LE8'
      : joinWithinLimit('Nothing changed. Unknown or invalid: ', [...new Set(parsed.invalid)]);
  }
  if (!stored) return 'No stored listing with that URL.';
  const listing = listingManager.overrideCards(url, { collection, ids: parsed.ids }, Date.now());
  if (!listing) return 'No stored listing with that URL.';
  return joinWithinLimit(
    `Listing now maps to ${collectionName(collection)}: `,
    formatCardList(listing.cardIds).split(', ')
  );
}

async function importCatalog(
  interaction: ChatInputCommandInteraction,
  collection: CollectionId
): Promise<void> {
  const { ids, invalid } = parseChecklist(interaction.options.getString('list', true));
  if (invalid.length > 0) {
    await interaction.reply(
      ephemeral(joinWithinLimit('Nothing stored. Invalid tokens: ', [...new Set(invalid)]))
    );
    return;
  }
  if (ids.length === 0) {
    await interaction.reply(ephemeral('No card ids found. Nothing changed.'));
    return;
  }
  const token = importStore.put(collection, ids);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`catalog-save:${token}`)
      .setLabel('Save')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`catalog-cancel:${token}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );
  await interaction.reply({
    content: buildPreviewText(collection, catalogManager.previewImport({ collection, ids })),
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: AdminContext
): Promise<void> {
  if (interaction.user.id !== ctx.adminId) {
    await interaction.reply(ephemeral('Only the bot admin can use this.'));
    return;
  }
  try {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    if (group === 'catalog') {
      const collection = readCollection(interaction);
      if (!collection) await interaction.reply(ephemeral(UNKNOWN_COLLECTION));
      else if (sub === 'import') await importCatalog(interaction, collection);
      else await catalogCardCommand(interaction, sub, collection, ctx);
      return;
    }
    switch (sub) {
      case 'map': {
        const collection = readCollection(interaction);
        await interaction.reply(
          ephemeral(
            collection
              ? mapCards(
                  interaction.options.getString('url', true),
                  collection,
                  interaction.options.getString('cards', true)
                )
              : UNKNOWN_COLLECTION
          )
        );
        return;
      }
      case 'clear': {
        const listing = listingManager.clearHold(interaction.options.getString('url', true));
        await interaction.reply(
          ephemeral(
            listing ? 'Hold lifted and reports resolved.' : 'No stored listing with that URL.'
          )
        );
        return;
      }
      case 'status':
        await interaction.reply(ephemeral(statusText()));
        return;
      case 'run': {
        // A check takes minutes (shops + images); acknowledge within Discord's 3 s window.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let content: string;
        try {
          const result = await ctx.trigger();
          content =
            result === 'busy'
              ? 'A check is already running.'
              : result === 'stopping'
                ? 'The bot is shutting down; no check was started.'
                : formatSummary(result);
        } catch (error) {
          logError('[ADMIN COMMAND] /admin run failed', error);
          content = `Check failed: ${errorMessage(error)}`.slice(0, DISCORD_MESSAGE_LIMIT);
        }
        await interaction.editReply({ content });
        return;
      }
      default:
        throw new Error(`Unknown /admin subcommand: ${sub}`);
    }
  } catch (error) {
    logError('[ADMIN COMMAND] failed', error);
    await replyWithError(interaction, 'Error', 'Something went wrong running the admin command.');
  }
}

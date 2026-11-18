export const DISCORD_MESSAGE_LIMIT = 2000;

/** `text` cut to at most `max` characters, ending in `…` when it was cut. */
export function clipText(text: string, max: number = DISCORD_MESSAGE_LIMIT): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Join items after a prefix; when over `limit` keep what fits plus `… and K more`. */
export function joinWithinLimit(
  prefix: string,
  items: string[],
  limit: number = DISCORD_MESSAGE_LIMIT
): string {
  const full = prefix + items.join(', ');
  if (full.length <= limit) return full;
  for (let keep = items.length - 1; keep >= 0; keep--) {
    const shown = items.slice(0, keep);
    const text = `${prefix}${shown.length > 0 ? `${shown.join(', ')} ` : ''}… and ${items.length - keep} more`;
    if (text.length <= limit) return text;
  }
  return `${prefix}… and ${items.length} more`.slice(0, limit);
}

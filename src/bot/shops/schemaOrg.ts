/** schema.org values the shops' product microdata carries. */

// schema.org ItemAvailability values, lowercased, and whether each means "can be ordered now".
const AVAILABILITY = new Map<string, boolean>([
  ['instock', true],
  ['limitedavailability', true],
  ['onlineonly', true],
  ['outofstock', false],
  ['soldout', false],
  ['discontinued', false],
  ['backorder', false],
  ['preorder', false],
  ['presale', false],
  ['madetoorder', false],
  ['instoreonly', false],
  ['reserved', false],
]);
// `https://schema.org/InStock`, `http://schema.org/InStock` or a bare `InStock`.
const AVAILABILITY_VALUE = /^(?:(?:https?:)?\/\/(?:www\.)?schema\.org\/)?([a-z]+)$/i;

/** Whether an availability href means in stock; null when it is not a known schema.org value. */
export function readAvailability(href: string): boolean | null {
  const tail = AVAILABILITY_VALUE.exec(href.trim())?.[1]?.toLowerCase();
  return tail === undefined ? null : (AVAILABILITY.get(tail) ?? null);
}

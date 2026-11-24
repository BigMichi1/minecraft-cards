import { type CardId, parseCardList } from './cardId';

/**
 * The laststicker checklist of the `lego-minecraft-3` starter catalog (its definition's
 * `starterChecklist`): 228 base cards, LE1-LE22 and XXL1.
 */
export const STARTER_CHECKLIST =
  '1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, LE1, LE2, LE3, LE4, LE5, LE6, LE7, LE8, LE9, LE10, LE11, LE12, LE13, LE14, LE15, LE16, LE17, LE18, LE19, LE20, LE21, LE22, XXL1';

/** A leading header such as `Prüfliste für Nummern diese Sammlung:`: text without digits or commas, then `:`. */
const INLINE_HEADER = /^[^\d,:]*:/;

/**
 * Parse a pasted laststicker checklist. Header lines ending in `:` are ignored, and so is a
 * header in front of the ids on the same line: a Discord string option cannot hold newlines,
 * so `/admin catalog import` receives the whole paste as one line.
 */
export function parseChecklist(text: string): { ids: CardId[]; invalid: string[] } {
  const body = text
    .split(/\r?\n/)
    .filter((line) => !line.trim().endsWith(':'))
    .map((line) => line.replace(INLINE_HEADER, ''))
    .join(',');
  return parseCardList(body);
}

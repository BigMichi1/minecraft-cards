import { CONFIRM_PREFIX, DISMISS_PREFIX, RIGHT_PREFIX } from './buttonIds';

/** customId prefix to handler route; the route union is read from this table. */
const BUTTON_PREFIXES = [
  ['report:', 'report'],
  ['report-reason:', 'report-reason'],
  [RIGHT_PREFIX, 'right'],
  [CONFIRM_PREFIX, 'admin-confirm'],
  [DISMISS_PREFIX, 'admin-dismiss'],
  ['catalog-save:', 'catalog'],
  ['catalog-cancel:', 'catalog'],
  ['catalog-remove:', 'catalog-remove'],
  ['catalog-keep:', 'catalog-remove'],
  // The /stock paging buttons; handleStockButton validates the rest of the id.
  ['stock:', 'stock'],
] as const;

/** Which handler a button belongs to, by its customId prefix. */
export type ButtonRoute = (typeof BUTTON_PREFIXES)[number][1];

export function buttonRoute(customId: string): ButtonRoute | null {
  for (const [prefix, route] of BUTTON_PREFIXES) {
    if (customId.startsWith(prefix)) return route;
  }
  return null;
}

/** One handler per route; each already holds the interaction it answers. */
export type ButtonHandlers = Record<ButtonRoute, () => Promise<void>>;

/** Run the handler of `customId`'s route; false (nothing run) for a button of no route. */
export async function dispatchButton(customId: string, handlers: ButtonHandlers): Promise<boolean> {
  const route = buttonRoute(customId);
  if (route === null) return false;
  await handlers[route]();
  return true;
}

export function isReportModal(customId: string): boolean {
  return customId.startsWith('report-modal:');
}

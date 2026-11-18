/** Which handler a button belongs to, by its customId prefix. */
export type ButtonRoute = 'report' | 'report-reason' | 'catalog' | 'stock';

const BUTTON_PREFIXES: [prefix: string, route: ButtonRoute][] = [
  ['report:', 'report'],
  ['report-reason:', 'report-reason'],
  ['catalog-save:', 'catalog'],
  ['catalog-cancel:', 'catalog'],
  // The /stock paging buttons; handleStockButton validates the rest of the id.
  ['stock:', 'stock'],
];

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

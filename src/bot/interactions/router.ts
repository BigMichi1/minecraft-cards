/** Which handler a button belongs to, by its customId prefix. */
export type ButtonRoute = 'report' | 'report-reason' | 'catalog';

const BUTTON_PREFIXES: [prefix: string, route: ButtonRoute][] = [
  ['report:', 'report'],
  ['report-reason:', 'report-reason'],
  ['catalog-save:', 'catalog'],
  ['catalog-cancel:', 'catalog'],
];

export function buttonRoute(customId: string): ButtonRoute | null {
  for (const [prefix, route] of BUTTON_PREFIXES) {
    if (customId.startsWith(prefix)) return route;
  }
  return null;
}

export function isReportModal(customId: string): boolean {
  return customId.startsWith('report-modal:');
}

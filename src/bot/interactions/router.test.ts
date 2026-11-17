import { describe, expect, test } from 'bun:test';
import { buttonRoute, isReportModal, type ButtonRoute } from './router';

describe('buttonRoute', () => {
  test.each<[string, ButtonRoute]>([
    ['report:12', 'report'],
    ['report-reason:12:wrong_number', 'report-reason'],
    ['catalog-save:abc', 'catalog'],
    ['catalog-cancel:abc', 'catalog'],
  ])('routes %p to %p', (customId, route) => {
    expect(buttonRoute(customId)).toBe(route);
  });

  test.each(['codes:1', 'reportx:1', 'report-modal:1:other', 'catalog:abc', ''])(
    'ignores %p',
    (customId) => {
      expect(buttonRoute(customId)).toBeNull();
    }
  );
});

describe('isReportModal', () => {
  test('matches the report modal prefix only', () => {
    expect(isReportModal('report-modal:12:other')).toBe(true);
    expect(isReportModal('report:12')).toBe(false);
    expect(isReportModal('other-modal:1')).toBe(false);
  });
});

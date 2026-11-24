import { describe, expect, test } from 'bun:test';
import { buttonRoute, dispatchButton, isReportModal, type ButtonRoute } from './router';

describe('buttonRoute', () => {
  test.each<[string, ButtonRoute]>([
    ['report:12', 'report'],
    ['report-reason:12:wrong_number', 'report-reason'],
    ['catalog-save:abc', 'catalog'],
    ['catalog-cancel:abc', 'catalog'],
    ['catalog-remove:abc', 'catalog-remove'],
    ['catalog-keep:abc', 'catalog-remove'],
    ['stock:2:all', 'stock'],
    ['stock:anything', 'stock'],
    ['right:5', 'right'],
    ['admin-confirm:5:12', 'admin-confirm'],
    ['admin-dismiss:5', 'admin-dismiss'],
  ])('routes %p to %p', (customId, route) => {
    expect(buttonRoute(customId)).toBe(route);
  });

  test.each([
    'codes:1',
    'reportx:1',
    'report-modal:1:other',
    'catalog:abc',
    'stocks:1:all',
    'rights:1',
    'admin-confirmx:1',
    '',
  ])('ignores %p', (customId) => {
    expect(buttonRoute(customId)).toBeNull();
  });
});

describe('isReportModal', () => {
  test('matches the report modal prefix only', () => {
    expect(isReportModal('report-modal:12:other')).toBe(true);
    expect(isReportModal('report:12')).toBe(false);
    expect(isReportModal('other-modal:1')).toBe(false);
  });
});

describe('dispatchButton', () => {
  function handlers() {
    const called: ButtonRoute[] = [];
    const h = (route: ButtonRoute) => async () => {
      called.push(route);
    };
    return {
      called,
      handlers: {
        report: h('report'),
        'report-reason': h('report-reason'),
        right: h('right'),
        'catalog-remove': h('catalog-remove'),
        'admin-confirm': h('admin-confirm'),
        'admin-dismiss': h('admin-dismiss'),
        catalog: h('catalog'),
        stock: h('stock'),
      },
    };
  }

  test.each<[string, ButtonRoute]>([
    ['stock:2:all', 'stock'],
    ['report:12', 'report'],
    ['report-reason:12:wrong_number', 'report-reason'],
    ['catalog-save:abc', 'catalog'],
    ['right:5', 'right'],
    ['admin-confirm:5:12', 'admin-confirm'],
    ['admin-dismiss:5', 'admin-dismiss'],
  ])('%p runs only the %p handler', async (customId, route) => {
    const { called, handlers: hs } = handlers();
    expect(await dispatchButton(customId, hs)).toBe(true);
    expect(called).toEqual([route]);
  });

  test('a button of no route runs nothing', async () => {
    const { called, handlers: hs } = handlers();
    expect(await dispatchButton('codes:1', hs)).toBe(false);
    expect(called).toEqual([]);
  });
});

import { describe, test, expect } from 'bun:test';
import logger from './logger';

describe('logger', () => {
  test('defaults to info level when LOG_LEVEL is unset', () => {
    // The test preload does not set LOG_LEVEL.
    expect(process.env.LOG_LEVEL).toBeUndefined();
    expect(logger.level).toBe('info');
  });

  test('exposes the custom levels including debug and trace', () => {
    expect(logger.levels).toEqual({ error: 0, warn: 1, info: 2, debug: 3, trace: 4 });
  });

  test('suppresses debug at info level and enables error', () => {
    expect(logger.isLevelEnabled('debug')).toBe(false);
    expect(logger.isLevelEnabled('error')).toBe(true);
  });
});

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Writable } from 'node:stream';
import winston from 'winston';
import logger, { formatConsoleLine, logError, resolveLogLevel } from './logger';

describe('logger', () => {
  const initialLevel = logger.level;
  afterEach(() => {
    logger.level = initialLevel;
  });

  test('the level comes from LOG_LEVEL, info when unset or blank', () => {
    expect(resolveLogLevel({})).toBe('info');
    expect(resolveLogLevel({ LOG_LEVEL: '' })).toBe('info');
    expect(resolveLogLevel({ LOG_LEVEL: 'debug' })).toBe('debug');
  });

  test('exposes the custom levels including debug and trace', () => {
    expect(logger.levels).toEqual({ error: 0, warn: 1, info: 2, debug: 3, trace: 4 });
  });

  test('suppresses debug at info level and enables error', () => {
    logger.level = 'info';
    expect(logger.isLevelEnabled('debug')).toBe(false);
    expect(logger.isLevelEnabled('error')).toBe(true);
  });
});

describe('formatConsoleLine', () => {
  test('a plain message is one line', () => {
    expect(formatConsoleLine({ timestamp: '12:00:00', level: 'info', message: 'hello' })).toBe(
      '12:00:00 [info]: hello'
    );
  });

  test('prints metadata except the service name', () => {
    expect(
      formatConsoleLine({
        timestamp: '12:00:00',
        level: 'warn',
        message: 'slow',
        service: 'minecraft-cards-bot',
        shop: 'ebay',
        ms: 1200,
      })
    ).toBe('12:00:00 [warn]: slow {"shop":"ebay","ms":1200}');
  });

  test('prints the stack on the following lines', () => {
    expect(
      formatConsoleLine({
        timestamp: '12:00:00',
        level: 'error',
        message: 'boom',
        stack: 'Error: boom\n    at x (a.ts:1:1)',
      })
    ).toBe('12:00:00 [error]: boom\nError: boom\n    at x (a.ts:1:1)');
  });

  test('an Error passed as the second argument reaches the console with its stack', () => {
    const lines: string[] = [];
    const capture = new winston.transports.Stream({
      stream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(chunk.toString());
          done();
        },
      }),
      format: winston.format.combine(
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(formatConsoleLine)
      ),
    });
    logger.add(capture);
    try {
      logger.error('Unhandled promise rejection:', new Error('kaputt'));
    } finally {
      logger.remove(capture);
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Unhandled promise rejection: kaputt');
    expect(lines[0]).toMatch(/\nError: kaputt\n\s+at /);
  });
});

describe('logError', () => {
  test('a non-Error value becomes part of the message, without a stack', () => {
    const log = spyOn(logger, 'log').mockImplementation(() => logger);
    try {
      logError('step failed', 'plain string');
      expect(log).toHaveBeenCalledWith('error', 'step failed: plain string', {});
    } finally {
      log.mockRestore();
    }
  });

  test('an Error gives its message and its stack as metadata', () => {
    const log = spyOn(logger, 'log').mockImplementation(() => logger);
    try {
      const error = new Error('kaputt');
      logError('step failed', error, 'warn');
      expect(log).toHaveBeenCalledWith('warn', 'step failed: kaputt', { stack: error.stack });
    } finally {
      log.mockRestore();
    }
  });

  test('an Error with a cause also logs the cause: name, message, code and stack', () => {
    const log = spyOn(logger, 'log').mockImplementation(() => logger);
    try {
      const cause = Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
      const error = new Error('page 2 failed: fetch failed', { cause });
      logError('shop failed', error);
      expect(log).toHaveBeenCalledWith('error', 'shop failed: page 2 failed: fetch failed', {
        stack: error.stack,
        cause: {
          name: 'TypeError',
          message: 'fetch failed',
          code: 'ECONNRESET',
          stack: cause.stack,
        },
      });
    } finally {
      log.mockRestore();
    }
  });

  test('a cause that is not an Error is logged as text', () => {
    const log = spyOn(logger, 'log').mockImplementation(() => logger);
    try {
      const error = new Error('wrapped', { cause: 'socket hang up' });
      logError('step failed', error);
      expect(log).toHaveBeenCalledWith('error', 'step failed: wrapped', {
        stack: error.stack,
        cause: { message: 'socket hang up' },
      });
    } finally {
      log.mockRestore();
    }
  });
});

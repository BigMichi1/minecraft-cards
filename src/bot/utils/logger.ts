import winston from 'winston';
import path from 'path';
import fs from 'fs';

// Ensure logs directory exists (recursive: true is a no-op when it already does)
const logsDir = path.join(process.cwd(), 'logs');
fs.mkdirSync(logsDir, { recursive: true });

// Define log levels with colors
const customLevels = {
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
    trace: 4,
  },
  colors: {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    debug: 'blue',
    trace: 'gray',
  },
};

/** The level threshold from LOG_LEVEL, `info` when unset; `debug`/`trace` need LOG_LEVEL set to them. */
export function resolveLogLevel(env: Record<string, string | undefined>): string {
  return env.LOG_LEVEL || 'info';
}

/**
 * One console line: time, level, message, then any metadata as JSON and the stack of an
 * error passed as the second argument (`logger.error('failed:', err)`) on the next lines.
 */
export function formatConsoleLine(info: winston.Logform.TransformableInfo): string {
  const { timestamp, level, message, stack, service: _service, ...meta } = info;
  let line = `${String(timestamp)} [${level}]: ${String(message)}`;
  if (Object.keys(meta).length > 0) line += ` ${JSON.stringify(meta)}`;
  if (typeof stack === 'string' && stack) line += `\n${stack}`;
  return line;
}

const logger = winston.createLogger({
  levels: customLevels.levels,
  level: resolveLogLevel(process.env),
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'minecraft-cards-bot' },
  transports: [
    // Error logs - only errors
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 10,
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
          return `${timestamp} [${level.toUpperCase()}]: ${message} ${metaStr}`;
        })
      ),
    }),

    // Combined logs - all levels
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 20,
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
          return `${timestamp} [${level.toUpperCase()}]: ${message} ${metaStr}`;
        })
      ),
    }),

    // Console output
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ colors: customLevels.colors }),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(formatConsoleLine)
      ),
    }),
  ],
});

// Add winston colors to console
winston.addColors(customLevels.colors);

/**
 * Log `<text>: <message>` and, for an Error, its stack on the following lines. Use this
 * instead of `logger.error('text:', value)`, which only works for Error values: winston
 * appends nothing readable for a string or other thrown value.
 */
export function logError(text: string, error: unknown, level: 'error' | 'warn' = 'error'): void {
  const message = error instanceof Error ? error.message : String(error);
  const meta = error instanceof Error && error.stack ? { stack: error.stack } : {};
  logger.log(level, `${text}: ${message}`, meta);
}

export default logger;

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

type LogLevel = keyof typeof LOG_LEVELS;

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function timestamp(): string {
  return new Date().toISOString();
}

function formatMessage(
  level: LogLevel,
  context: string,
  message: string,
  data?: unknown,
): string {
  const base = `[${timestamp()}] [${level.toUpperCase().padEnd(5)}] [${context}] ${message}`;
  if (data !== undefined) {
    return `${base} ${JSON.stringify(data, null, 0)}`;
  }
  return base;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

export function createLogger(context: string) {
  return {
    debug(message: string, data?: unknown): void {
      if (shouldLog('debug'))
        console.debug(formatMessage('debug', context, message, data));
    },
    info(message: string, data?: unknown): void {
      if (shouldLog('info'))
        console.info(formatMessage('info', context, message, data));
    },
    warn(message: string, data?: unknown): void {
      if (shouldLog('warn'))
        console.warn(formatMessage('warn', context, message, data));
    },
    error(message: string, data?: unknown): void {
      if (shouldLog('error'))
        console.error(formatMessage('error', context, message, data));
    },
  };
}

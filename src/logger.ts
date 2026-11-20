const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

function currentLevel(): Level {
  const raw = (process.env.CODE2API_LOG_LEVEL ?? 'info').toLowerCase();
  return raw in LEVELS ? (raw as Level) : 'info';
}

function emit(level: Level, message: string, extra?: unknown): void {
  if (LEVELS[level] < LEVELS[currentLevel()]) return;
  const time = new Date().toISOString();
  const prefix = `${time} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (extra === undefined) {
    console.log(prefix);
  } else {
    console.log(prefix, extra);
  }
}

export const log = {
  debug: (message: string, extra?: unknown) => emit('debug', message, extra),
  info: (message: string, extra?: unknown) => emit('info', message, extra),
  warn: (message: string, extra?: unknown) => emit('warn', message, extra),
  error: (message: string, extra?: unknown) => emit('error', message, extra),
};

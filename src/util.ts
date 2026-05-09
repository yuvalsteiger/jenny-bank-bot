export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(`Missing required environment variable: ${name}`);
    console.error('Set it in your .env file. See .env.example for the list.');
    process.exit(1);
  }
  return value;
}

export function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

// Colons and dots aren't safe on all filesystems — flatten them.
export function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

const israelDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// "YYYY-MM-DD" in Asia/Jerusalem — used to bucket transactions by their local debit date.
// Compare these as plain strings; ISO date keys are lexicographically chronological,
// which sidesteps any DST/offset arithmetic.
export function israelDateKey(iso: string | Date): string {
  return israelDateFormatter.format(typeof iso === 'string' ? new Date(iso) : iso);
}

export function todayInIsrael(): string {
  return israelDateFormatter.format(new Date());
}

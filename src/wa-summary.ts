import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Transaction } from 'israeli-bank-scrapers/lib/transactions.js';
import { TransactionStatuses } from 'israeli-bank-scrapers/lib/transactions.js';
import { israelDateKey, requireEnv, todayInIsrael } from './util.js';
import { broadcastTemplate, type Recipient, type TemplateSpec } from './whatsapp.js';

const ILS = (n: number): string =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS' }).format(n);

interface OwnedTransaction extends Transaction {
  owner: string;
  cardAccountNumber: string;
}

interface CalMerged {
  scrapedAt: string;
  owners: string[];
  transactions: OwnedTransaction[];
}

interface HapoalimAccount {
  accountNumber: string;
  balance?: number;
}

interface HapoalimSnapshot {
  success?: boolean;
  accounts?: HapoalimAccount[];
}

async function readJsonOrExit<T>(filePath: string, what: string, scrapeCmd: string): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Could not read ${what} (${filePath}): ${message}`);
    console.error(`Run \`${scrapeCmd}\` first to produce it.`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`${what} at ${filePath} is not valid JSON: ${message}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const outputDir = path.resolve('output');

  const hapoalim = await readJsonOrExit<HapoalimSnapshot>(
    path.join(outputDir, 'latest.json'),
    'Hapoalim snapshot',
    'npm start',
  );
  const cal = await readJsonOrExit<CalMerged>(
    path.join(outputDir, 'cal-merged-latest.json'),
    'merged Cal snapshot',
    'npm run next-debit',
  );

  const balance = (hapoalim.accounts ?? []).reduce(
    (sum, a) => sum + (typeof a.balance === 'number' ? a.balance : 0),
    0,
  );

  const today = todayInIsrael();
  const allTxns = cal.transactions ?? [];

  const futureCompleted = allTxns.filter(
    (t) => t.status === TransactionStatuses.Completed && israelDateKey(t.processedDate) >= today,
  );
  const futureDates = [...new Set(futureCompleted.map((t) => israelDateKey(t.processedDate)))].sort();
  const nextDebitDate: string | undefined = futureDates[0];

  const nextDebitTxns = nextDebitDate
    ? futureCompleted.filter((t) => israelDateKey(t.processedDate) === nextDebitDate)
    : [];
  const pendingTxns = allTxns.filter((t) => t.status === TransactionStatuses.Pending);

  // chargedAmount: negative for debits → magnitude is -chargedAmount.
  // Mirrors debitMagnitude at src/next-debit.ts:15.
  const sumMagnitudes = (txns: Transaction[]): number =>
    txns.reduce((sum, t) => sum + -t.chargedAmount, 0);

  const nextDebitTotal = sumMagnitudes(nextDebitTxns);
  const pendingTotal = sumMagnitudes(pendingTxns);
  const upcomingCal = nextDebitTotal + pendingTotal;
  const remaining = balance - upcomingCal;

  const positiveTemplate = requireEnv('WA_TEMPLATE_POSITIVE');
  const negativeTemplate = requireEnv('WA_TEMPLATE_NEGATIVE');
  const language = requireEnv('WA_TEMPLATE_LANG');

  const isPositive = remaining >= 0;
  const templateName = isPositive ? positiveTemplate : negativeTemplate;
  const magnitude = ILS(Math.abs(remaining));

  // The template body lives in Kapso, not here — log the inputs we'll send so
  // the run is debuggable from stdout.
  console.log(`Template: ${isPositive ? 'positive' : 'negative'} (${templateName})`);
  console.log(`Balance: ${ILS(balance)}`);
  console.log(
    `Upcoming Cal: ${ILS(upcomingCal)} (next debit ${nextDebitDate ?? 'n/a'}: ${ILS(nextDebitTotal)} + pending: ${ILS(pendingTotal)})`,
  );
  console.log(`Remaining: ${ILS(remaining)}`);
  console.log('');

  const result = await broadcastTemplate((recipient: Recipient): TemplateSpec | null => {
    const ownerTxns = allTxns
      .filter((t) => t.owner === recipient.ownerKey)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    const lastTxn = ownerTxns[0];
    if (!lastTxn) {
      console.warn(
        `  [skip] ${recipient.ownerKey}: no Cal transactions in cal-merged-latest.json (scrape may have failed)`,
      );
      return null;
    }
    const lastAmount = ILS(Math.abs(lastTxn.chargedAmount));
    const lastPlace = lastTxn.description?.trim() || '—';
    return {
      name: templateName,
      language,
      body: [
        { type: 'text', text: recipient.displayName },
        { type: 'text', text: lastAmount },
        { type: 'text', text: lastPlace },
        { type: 'text', text: magnitude },
      ],
    };
  });

  console.log('');
  console.log(`Result: ${result.succeeded}/${result.total} delivered, ${result.failed} failed.`);
  if (result.total === 0 || result.succeeded === 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});

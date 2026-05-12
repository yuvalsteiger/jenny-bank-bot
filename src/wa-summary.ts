import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Transaction } from 'israeli-bank-scrapers/lib/transactions.js';
import { TransactionStatuses } from 'israeli-bank-scrapers/lib/transactions.js';
import { israelDateKey, requireEnv, todayInIsrael } from './util.js';
import { broadcastTemplate, getRecipients, type Recipient, type TemplateSpec } from './whatsapp.js';

const ILS = (n: number): string =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS' }).format(n);

// Template body params: `₪` is hardcoded in the Kapso template (e.g. `₪{{2}}`),
// so the runtime value must be a bare number string. Using `ILS()` here would
// double up the shekel sign.
const ILS_NUMBER = (n: number): string =>
  new Intl.NumberFormat('he-IL', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);

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

  // chargedAmount: negative for debits → magnitude is -chargedAmount.
  // Mirrors debitMagnitude at src/next-debit.ts:15.
  const sumMagnitudes = (txns: Transaction[]): number =>
    txns.reduce((sum, t) => sum + -t.chargedAmount, 0);

  const nextDebitTotal = sumMagnitudes(nextDebitTxns);
  const upcomingCal = nextDebitTotal;
  const remaining = balance - upcomingCal;

  const positiveTemplate = requireEnv('WA_TEMPLATE_POSITIVE');
  const negativeTemplate = requireEnv('WA_TEMPLATE_NEGATIVE');
  const language = requireEnv('WA_TEMPLATE_LANG');

  const isPositive = remaining >= 0;
  const templateName = isPositive ? positiveTemplate : negativeTemplate;
  const magnitude = ILS_NUMBER(Math.abs(remaining));

  // Shared pending list: every recipient sees the same combined view, labeled
  // by cardholder displayName so it's clear whose charge is whose.
  const ownerToDisplay = new Map(getRecipients().map((r) => [r.ownerKey, r.displayName]));
  const fmtDay = (iso: string): string => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jerusalem',
      day: '2-digit',
      month: '2-digit',
    }).formatToParts(new Date(iso));
    const day = parts.find((p) => p.type === 'day')?.value ?? '';
    const month = parts.find((p) => p.type === 'month')?.value ?? '';
    return `${day}/${month}`;
  };
  const allPending = allTxns
    .filter((t) => t.status === TransactionStatuses.Pending)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const pendingText =
    allPending.length === 0
      ? 'אין כרגע עסקאות ממתינות 🙌'
      : 'יש גם עסקאות ממתינות שעדיין לא חושבו: ' +
        allPending
          .map((t) => {
            const place = (t.description ?? '').trim() || '—';
            const display = ownerToDisplay.get(t.owner) ?? t.owner;
            return `${place} מ-${fmtDay(t.date)} (${display})`;
          })
          .join(', ');

  // Shared last-txn: newest past completed purchase across all cardholders,
  // labeled with the owner's displayName so each recipient knows whose it was.
  const allPastCompleted = allTxns
    .filter((t) => t.status === TransactionStatuses.Completed)
    .filter((t) => israelDateKey(t.date) <= today)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const sharedLastTxn = allPastCompleted[0];
  if (!sharedLastTxn) {
    console.error('No past completed Cal transactions across all cardholders; cannot send summary.');
    process.exit(1);
  }
  const sharedLastAmount = ILS_NUMBER(Math.abs(sharedLastTxn.chargedAmount));
  const sharedLastOwner = ownerToDisplay.get(sharedLastTxn.owner) ?? sharedLastTxn.owner;
  const sharedLastPlace = `${(sharedLastTxn.description ?? '').trim() || '—'} (${sharedLastOwner})`;

  // Local debug — print the inputs that drove this summary so the user can
  // sanity-check the message. No account numbers in this block.
  console.log('--- summary debug ---');
  console.log(`Hapoalim balance:  ${ILS(balance)}`);
  console.log(`Today (Asia/Jerusalem): ${today}`);
  console.log(`Next debit date:   ${nextDebitDate ?? 'none'}`);
  console.log(`Future debit dates: [${futureDates.join(', ')}]`);
  console.log(`Next-debit txns:   ${nextDebitTxns.length}, total ${ILS(nextDebitTotal)}`);
  console.log(`Upcoming Cal:      ${ILS(upcomingCal)}`);
  console.log(`Remaining:         ${ILS(remaining)}  (balance - upcoming)`);
  console.log(`Template:          ${isPositive ? 'positive' : 'negative'} (${templateName})`);
  console.log(`Last txn (shared): date=${israelDateKey(sharedLastTxn.date)} amount=${sharedLastAmount} place="${sharedLastPlace}"`);
  console.log(`Top 5 past completed by date desc (across all owners):`);
  allPastCompleted.slice(0, 5).forEach((t, j) => {
    const desc = (t.description ?? '').trim() || '—';
    const owner = ownerToDisplay.get(t.owner) ?? t.owner;
    console.log(
      `  ${j + 1}. date=${israelDateKey(t.date)} processed=${israelDateKey(t.processedDate)} amount=${ILS(t.chargedAmount)} owner=${owner} desc="${desc}"`,
    );
  });
  console.log('---------------------');

  const result = await broadcastTemplate((recipient: Recipient, index: number): TemplateSpec | null => {
    const ownerTxns = allTxns
      .filter((t) => t.owner === recipient.ownerKey)
      .filter((t) => t.status === TransactionStatuses.Completed)
      .filter((t) => israelDateKey(t.date) <= today)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const ownerNextDebit = allTxns.filter(
      (t) =>
        t.owner === recipient.ownerKey &&
        t.status === TransactionStatuses.Completed &&
        israelDateKey(t.processedDate) >= today,
    );
    const ownerUpcoming = ownerNextDebit.reduce((s, t) => s + -t.chargedAmount, 0);

    console.log(`recipient #${index + 1}: ${recipient.displayName} (${recipient.ownerKey})`);
    console.log(
      `  past completed txns: ${ownerTxns.length}, upcoming ${ILS(ownerUpcoming)}`,
    );
    console.log(`  top 3 past completed by date desc:`);
    ownerTxns.slice(0, 3).forEach((t, j) => {
      const desc = (t.description ?? '').trim() || '—';
      console.log(
        `    ${j + 1}. date=${israelDateKey(t.date)} processed=${israelDateKey(t.processedDate)} status=${t.status} amount=${ILS(t.chargedAmount)} desc="${desc}"`,
      );
    });

    console.log(`  pending: ${pendingText.replace(/\n/g, ' | ')}`);

    return {
      name: templateName,
      language,
      body: [
        { type: 'text', text: recipient.displayName },
        { type: 'text', text: sharedLastAmount },
        { type: 'text', text: sharedLastPlace },
        { type: 'text', text: magnitude },
        { type: 'text', text: pendingText },
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

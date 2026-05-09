import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CompanyTypes, createScraper } from 'israeli-bank-scrapers';
import type { ScraperScrapingResult } from 'israeli-bank-scrapers/lib/scrapers/interface.js';
import type { Transaction } from 'israeli-bank-scrapers/lib/transactions.js';
import { TransactionStatuses } from 'israeli-bank-scrapers/lib/transactions.js';
import { daysAgo, israelDateKey, todayInIsrael } from './util.js';

const ILS = (n: number): string =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS' }).format(n);

// chargedAmount: negative = debit, positive = refund. Sum signed values; flip
// sign at print time so refunds correctly *reduce* the bucket total.
const debitMagnitude = (t: Transaction): number => -t.chargedAmount;

interface CalAccount {
  owner: string;
  username: string;
  password: string;
}

interface OwnedTransaction extends Transaction {
  owner: string;
  cardAccountNumber: string;
}

function loadCalAccounts(): CalAccount[] {
  const accounts: CalAccount[] = [];
  for (let i = 1; ; i++) {
    const owner = process.env[`CAL_${i}_OWNER`];
    const username = process.env[`CAL_${i}_USERNAME`];
    const password = process.env[`CAL_${i}_PASSWORD`];
    if (!owner && !username && !password) break;
    if (!owner || !username || !password) {
      console.error(`Cal account #${i} is partially configured. Need CAL_${i}_OWNER, CAL_${i}_USERNAME, CAL_${i}_PASSWORD.`);
      process.exit(1);
    }
    accounts.push({ owner: owner.trim(), username, password });
  }
  if (accounts.length === 0) {
    console.error('No Cal accounts configured. Set CAL_1_OWNER, CAL_1_USERNAME, CAL_1_PASSWORD in .env (and CAL_2_* etc. for additional cardholders).');
    process.exit(1);
  }
  return accounts;
}

async function scrapeOne(account: CalAccount, startDate: Date, outputDir: string): Promise<ScraperScrapingResult> {
  const scraper = createScraper({
    companyId: CompanyTypes.visaCal,
    startDate,
    combineInstallments: false,
    showBrowser: true,
    verbose: true,
    timeout: 120_000,
    defaultTimeout: 120_000,
    storeFailureScreenShotPath: path.join(outputDir, `cal-failure-${ownerSlug(account.owner)}.png`),
  });
  console.log(`\n[${account.owner}] Starting Cal scrape (startDate=${startDate.toISOString().slice(0, 10)})...`);
  return scraper.scrape({ username: account.username, password: account.password });
}

function ownerSlug(owner: string): string {
  return owner.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'owner';
}

async function main(): Promise<void> {
  const accounts = loadCalAccounts();
  const startDate = daysAgo(30);
  const outputDir = path.resolve('output');
  await mkdir(outputDir, { recursive: true });

  // Run scrapes sequentially so the user can handle 2FA one window at a time.
  // A single owner's failure shouldn't block the others — collect successes and
  // failures, report at the end.
  const scrapeResults: Array<{ account: CalAccount; result: ScraperScrapingResult }> = [];
  const failures: Array<{ owner: string; errorType?: string; errorMessage?: string }> = [];
  for (const account of accounts) {
    let result: ScraperScrapingResult;
    try {
      result = await scrapeOne(account, startDate, outputDir);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[${account.owner}] Cal scrape threw: ${message}`);
      failures.push({ owner: account.owner, errorType: 'THROWN', errorMessage: message });
      continue;
    }
    if (!result.success) {
      console.error(`[${account.owner}] Cal scrape failed.`);
      console.error(`  errorType:    ${result.errorType ?? '(none)'}`);
      console.error(`  errorMessage: ${result.errorMessage ?? '(none)'}`);
      failures.push({ owner: account.owner, errorType: result.errorType, errorMessage: result.errorMessage });
      continue;
    }
    scrapeResults.push({ account, result });
  }

  if (scrapeResults.length === 0) {
    console.error('\nAll Cal scrapes failed. Nothing to report.');
    process.exit(1);
  }

  // Tag every transaction with its owner + originating card account number.
  const allTxns: OwnedTransaction[] = [];
  for (const { account, result } of scrapeResults) {
    for (const acc of result.accounts ?? []) {
      for (const t of acc.txns ?? []) {
        allTxns.push({ ...t, owner: account.owner, cardAccountNumber: acc.accountNumber });
      }
    }
  }

  const merged = {
    scrapedAt: new Date().toISOString(),
    owners: accounts.map((a) => a.owner),
    transactions: allTxns,
  };
  const mergedJson = JSON.stringify(merged, null, 2);
  await writeFile(path.join(outputDir, 'cal-merged-latest.json'), mergedJson, 'utf8');

  // Reporting
  const today = todayInIsrael();
  const futureConfirmed = allTxns.filter(
    (t) => t.status === TransactionStatuses.Completed && israelDateKey(t.processedDate) >= today,
  );
  const pending = allTxns.filter((t) => t.status === TransactionStatuses.Pending);

  console.log('');
  console.log(`Cal scrape successful. Cardholders: ${accounts.map((a) => a.owner).join(', ')}`);
  console.log(`Transactions seen: ${allTxns.length}`);

  console.log('');
  if (futureConfirmed.length === 0) {
    console.log('No confirmed future-dated debits in the Cal scrape.');
  } else {
    const groups = new Map<string, OwnedTransaction[]>();
    for (const t of futureConfirmed) {
      const key = israelDateKey(t.processedDate);
      const bucket = groups.get(key);
      if (bucket) bucket.push(t);
      else groups.set(key, [t]);
    }
    const sortedDates = [...groups.keys()].sort();
    sortedDates.forEach((date, i) => {
      const txns = groups.get(date) ?? [];
      const total = txns.reduce((sum, t) => sum + debitMagnitude(t), 0);
      const label = i === 0 ? 'Next debit' : 'Then';
      console.log(`${label} on ${date}: ${ILS(total)} across ${txns.length} transactions`);
      const byOwner = new Map<string, { sum: number; count: number }>();
      for (const t of txns) {
        const cur = byOwner.get(t.owner) ?? { sum: 0, count: 0 };
        cur.sum += debitMagnitude(t);
        cur.count += 1;
        byOwner.set(t.owner, cur);
      }
      for (const owner of accounts.map((a) => a.owner)) {
        const stat = byOwner.get(owner) ?? { sum: 0, count: 0 };
        console.log(`    ${owner.padEnd(10)} ${ILS(stat.sum)} (${stat.count} tx)`);
      }
    });
  }

  if (pending.length > 0) {
    const pendingTotal = pending.reduce((sum, t) => sum + debitMagnitude(t), 0);
    console.log('');
    console.log(`Pending charges not yet assigned to a debit date: ${ILS(pendingTotal)} across ${pending.length} transactions`);
    console.log("  (these will be added to the next billing cycle's total)");
    const byOwner = new Map<string, { sum: number; count: number }>();
    for (const t of pending) {
      const cur = byOwner.get(t.owner) ?? { sum: 0, count: 0 };
      cur.sum += debitMagnitude(t);
      cur.count += 1;
      byOwner.set(t.owner, cur);
    }
    for (const owner of accounts.map((a) => a.owner)) {
      const stat = byOwner.get(owner) ?? { sum: 0, count: 0 };
      console.log(`    ${owner.padEnd(10)} ${ILS(stat.sum)} (${stat.count} tx)`);
    }
  }

  console.log('');
  console.log(`Merged data: output/cal-merged-latest.json`);

  if (failures.length > 0) {
    console.log('');
    console.log(`Note: ${failures.length} of ${accounts.length} Cal scrape(s) failed — totals above EXCLUDE them:`);
    for (const f of failures) {
      console.log(`  ${f.owner}: ${f.errorType ?? '(no type)'} — ${f.errorMessage ?? '(no message)'}`);
    }
    console.log(`Failure screenshots (if any): output/cal-failure-<owner>.png`);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});

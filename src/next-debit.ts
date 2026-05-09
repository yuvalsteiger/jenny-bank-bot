import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CompanyTypes, createScraper } from 'israeli-bank-scrapers';
import type { ScraperScrapingResult } from 'israeli-bank-scrapers/lib/scrapers/interface.js';
import type { Transaction } from 'israeli-bank-scrapers/lib/transactions.js';
import { daysAgo } from './util.js';

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

async function scrapeOne(account: CalAccount, startDate: Date): Promise<ScraperScrapingResult> {
  // No storeFailureScreenShotPath — failure screenshots can capture bank UI
  // (balances, recent transactions, names) and would land in publicly-readable
  // GH Actions logs/artifacts. Debug locally with showBrowser=true if needed.
  const scraper = createScraper({
    companyId: CompanyTypes.visaCal,
    startDate,
    combineInstallments: false,
    showBrowser: false,
    verbose: false,
    timeout: 120_000,
    defaultTimeout: 120_000,
  });
  return scraper.scrape({ username: account.username, password: account.password });
}

async function main(): Promise<void> {
  const accounts = loadCalAccounts();
  const startDate = daysAgo(30);
  const outputDir = path.resolve('output');
  await mkdir(outputDir, { recursive: true });

  // Run scrapes sequentially so the user can handle 2FA one window at a time.
  // A single cardholder's failure shouldn't block the others.
  const scrapeResults: Array<{ account: CalAccount; result: ScraperScrapingResult }> = [];
  let failureCount = 0;
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i]!;
    console.log(`[#${i + 1}/${accounts.length}] Starting Cal scrape...`);
    let result: ScraperScrapingResult;
    try {
      result = await scrapeOne(account, startDate);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[#${i + 1}] Cal scrape threw: ${message}`);
      failureCount++;
      continue;
    }
    if (!result.success) {
      console.error(`[#${i + 1}] Cal scrape failed (errorType=${result.errorType ?? 'none'})`);
      failureCount++;
      continue;
    }
    scrapeResults.push({ account, result });
  }

  if (scrapeResults.length === 0) {
    console.error('All Cal scrapes failed.');
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

  // Public-repo safe: counts only. No cardholder names, dates, amounts, or
  // descriptions in stdout.
  console.log(
    `Cal scrape complete: ${scrapeResults.length}/${accounts.length} cardholder(s) succeeded, ${allTxns.length} transaction(s) merged.`,
  );
  if (failureCount > 0) {
    console.log(`(${failureCount} cardholder scrape(s) failed; their txns are excluded.)`);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});

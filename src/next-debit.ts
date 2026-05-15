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
    showBrowser: process.env.SHOW_BROWSER !== 'false',
    verbose: false,
    timeout: 120_000,
    defaultTimeout: 120_000,
    // Required on Ubuntu 24.04 GH Actions runners — see src/index.ts for context.
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  return scraper.scrape({ username: account.username, password: account.password });
}

const RETRY_ATTEMPTS = 3;
const RETRY_SLEEP_MS = 60_000;

async function scrapeWithRetry(
  account: CalAccount,
  startDate: Date,
): Promise<ScraperScrapingResult> {
  let lastReason = '';
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const result = await scrapeOne(account, startDate);
      if (result.success) {
        if (attempt > 1) {
          console.log(`Cal scrape for ${account.owner} succeeded on attempt ${attempt}/${RETRY_ATTEMPTS}.`);
        }
        return result;
      }
      lastReason = `errorType=${result.errorType ?? 'none'}`;
    } catch (e) {
      lastReason = `threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    console.error(
      `Cal scrape for ${account.owner} attempt ${attempt}/${RETRY_ATTEMPTS} failed (${lastReason}).`,
    );
    if (attempt < RETRY_ATTEMPTS) {
      console.error(`Retrying in ${RETRY_SLEEP_MS / 1000}s...`);
      await new Promise((r) => setTimeout(r, RETRY_SLEEP_MS));
    }
  }
  throw new Error(
    `Cal scrape for ${account.owner} failed after ${RETRY_ATTEMPTS} attempts (last: ${lastReason}).`,
  );
}

async function main(): Promise<void> {
  const accounts = loadCalAccounts();
  const startDate = daysAgo(30);
  const outputDir = path.resolve('output');
  await mkdir(outputDir, { recursive: true });

  const ils = (n: number): string =>
    new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS' }).format(n);

  // Run scrapes sequentially so the user can handle 2FA one window at a time.
  const scrapeResults: Array<{ account: CalAccount; result: ScraperScrapingResult }> = [];
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i]!;
    console.log(`[#${i + 1}/${accounts.length}] Starting Cal scrape for ${account.owner}...`);
    const result = await scrapeWithRetry(account, startDate);
    const ownerTxns = (result.accounts ?? []).flatMap((acc) => acc.txns ?? []);
    const ownerTotal = ownerTxns.reduce((sum, t) => sum + -t.chargedAmount, 0);
    console.log(
      `[#${i + 1}] ${account.owner}: ${ownerTxns.length} txns, total charges ${ils(ownerTotal)}`,
    );
    scrapeResults.push({ account, result });
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

  // Local debug logs — amounts/owner names OK, but never log card account numbers.
  const totalAll = allTxns.reduce((sum, t) => sum + -t.chargedAmount, 0);
  console.log(
    `Cal scrape complete: ${scrapeResults.length}/${accounts.length} cardholder(s) succeeded, ${allTxns.length} transaction(s) merged, total charges ${ils(totalAll)}.`,
  );
  for (const owner of accounts.map((a) => a.owner)) {
    const ownerTxns = allTxns.filter((t) => t.owner === owner);
    const ownerTotal = ownerTxns.reduce((sum, t) => sum + -t.chargedAmount, 0);
    console.log(`  ${owner}: ${ownerTxns.length} txns, total ${ils(ownerTotal)}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('Unexpected error:', err instanceof Error ? err.message : err);
    process.exit(1);
  },
);

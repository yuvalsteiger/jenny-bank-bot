import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CompanyTypes, createScraper } from 'israeli-bank-scrapers';
import { daysAgo, requireEnv, safeTimestamp } from './util.js';

function formatDateRange(transactions: Array<{ date?: string }> | undefined): string {
  if (!transactions || transactions.length === 0) return 'no transactions';
  const dates = transactions
    .map((t) => t.date)
    .filter((d): d is string => typeof d === 'string')
    .sort();
  if (dates.length === 0) return 'no dated transactions';
  return `${dates[0]} → ${dates[dates.length - 1]}`;
}

async function main(): Promise<void> {
  const credentials = {
    userCode: requireEnv('HAPOALIM_USER_CODE'),
    password: requireEnv('HAPOALIM_PASSWORD'),
  };

  const startDate = daysAgo(90);

  const scraper = createScraper({
    companyId: CompanyTypes.hapoalim,
    startDate,
    combineInstallments: false,
    showBrowser: true,
    verbose: true,
  });

  console.log(`Starting Hapoalim scrape (startDate=${startDate.toISOString().slice(0, 10)})...`);
  const result = await scraper.scrape(credentials);

  if (!result.success) {
    console.error('Scrape failed.');
    console.error(`  errorType:    ${result.errorType ?? '(none)'}`);
    console.error(`  errorMessage: ${result.errorMessage ?? '(none)'}`);
    process.exit(1);
  }

  const outputDir = path.resolve('output');
  await mkdir(outputDir, { recursive: true });

  const timestampedPath = path.join(outputDir, `scrape-${safeTimestamp(new Date())}.json`);
  const latestPath = path.join(outputDir, 'latest.json');
  const json = JSON.stringify(result, null, 2);

  await writeFile(timestampedPath, json, 'utf8');
  await writeFile(latestPath, json, 'utf8');

  // Summary only — never log credentials or full transaction bodies.
  console.log('\nScrape successful.');
  const accounts = result.accounts ?? [];
  if (accounts.length === 0) {
    console.log('  No accounts returned.');
  } else {
    for (const account of accounts) {
      const balance =
        typeof account.balance === 'number' ? account.balance : 'balance not provided';
      const txnCount = account.txns?.length ?? 0;
      console.log(`  Account ${account.accountNumber}:`);
      console.log(`    balance:      ${balance}`);
      console.log(`    transactions: ${txnCount}`);
      console.log(`    date range:   ${formatDateRange(account.txns)}`);
    }
  }
  console.log(`\nFull data saved to: ${timestampedPath}`);
  console.log(`Latest pointer:     ${latestPath}`);
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});

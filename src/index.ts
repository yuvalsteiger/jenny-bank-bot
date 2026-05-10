import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CompanyTypes, createScraper } from 'israeli-bank-scrapers';
import { daysAgo, requireEnv, safeTimestamp } from './util.js';

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
    showBrowser: false,
    verbose: false,
    // Library default (~30s) is too tight for cold-start Chromium on shared CI
    // runners reaching an Israeli bank from a US Azure datacenter.
    timeout: 120_000,
    defaultTimeout: 120_000,
    // Required on Ubuntu 24.04 GH Actions runners: AppArmor blocks unprivileged
    // user namespaces, which Chromium's sandbox needs. Safe here — the runner
    // is ephemeral and only ever navigates to the bank login flow.
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  console.log('Starting Hapoalim scrape...');
  const result = await scraper.scrape(credentials);

  if (!result.success) {
    console.error(`Scrape failed (errorType=${result.errorType ?? 'none'})`);
    process.exit(1);
  }

  const outputDir = path.resolve('output');
  await mkdir(outputDir, { recursive: true });

  const timestampedPath = path.join(outputDir, `scrape-${safeTimestamp(new Date())}.json`);
  const latestPath = path.join(outputDir, 'latest.json');
  const json = JSON.stringify(result, null, 2);

  await writeFile(timestampedPath, json, 'utf8');
  await writeFile(latestPath, json, 'utf8');

  // Public-repo safe: counts only. No account numbers, balances, amounts, or
  // descriptions in stdout — workflow logs are publicly readable.
  const accounts = result.accounts ?? [];
  const totalTxns = accounts.reduce((sum, a) => sum + (a.txns?.length ?? 0), 0);
  console.log(`Scrape successful. ${accounts.length} account(s), ${totalTxns} transaction(s).`);
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const HAPOALIM_PATH = "output/latest.json";
const CAL_PATH = "output/cal-merged-latest.json";
const NOTIFIED_PATH = "state/notified-fingerprint.json";
const CANDIDATE_PATH = "state/current-fingerprint.json";

const EXIT_NEW = 0;
const EXIT_SKIP = 78;
const EXIT_ERR = 1;

type Json = any;

interface Fingerprint {
  savedAt: string;
  keys: string[];
}

function loadJson(path: string): Json {
  if (!existsSync(path)) {
    console.error(`required file missing: ${path}`);
    process.exit(EXIT_ERR);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function hapoalimKeys(json: Json): string[] {
  const accounts: Json[] = json?.accounts ?? [];
  return accounts.flatMap((acc) => {
    const txns: Json[] = acc?.txns ?? [];
    return txns.map((t) => `hapoalim:${acc.accountNumber}:${t.identifier}`);
  });
}

function calKeys(json: Json): string[] {
  const txns: Json[] = json?.transactions ?? [];
  return txns.map(
    (t) =>
      `cal:${t.owner}:${t.cardAccountNumber}:${t.date}:${t.chargedAmount}:${t.description}`,
  );
}

function writeFingerprint(path: string, keys: Iterable<string>): void {
  mkdirSync(dirname(path), { recursive: true });
  const fp: Fingerprint = {
    savedAt: new Date().toISOString(),
    keys: [...keys].sort(),
  };
  writeFileSync(path, JSON.stringify(fp, null, 2));
}

const current = new Set<string>([
  ...hapoalimKeys(loadJson(HAPOALIM_PATH)),
  ...calKeys(loadJson(CAL_PATH)),
]);

if (!existsSync(NOTIFIED_PATH)) {
  writeFingerprint(NOTIFIED_PATH, current);
  console.log(`bootstrap: saved ${current.size} keys; not sending`);
  process.exit(EXIT_SKIP);
}

const prior: Fingerprint = JSON.parse(readFileSync(NOTIFIED_PATH, "utf8"));
const priorKeys = new Set<string>(prior.keys);
const newKeys = [...current].filter((k) => !priorKeys.has(k));

if (newKeys.length === 0) {
  console.log(`no new transactions (${current.size} known)`);
  process.exit(EXIT_SKIP);
}

writeFingerprint(CANDIDATE_PATH, current);
console.log(`${newKeys.length} new transactions:`);
for (const k of newKeys.slice(0, 10)) console.log(`  + ${k}`);
if (newKeys.length > 10) console.log(`  ... and ${newKeys.length - 10} more`);
process.exit(EXIT_NEW);

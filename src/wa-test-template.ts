import 'dotenv/config';
import { requireEnv } from './util.js';
import { broadcastTemplate, type Recipient, type TemplateSpec } from './whatsapp.js';

const DUMMY_LAST_AMOUNT = '₪50.00';
const DUMMY_LAST_PLACE = 'סופר־פארם';
const DUMMY_REMAINING = '₪500.00';

function parseVariant(arg: string | undefined): 'positive' | 'negative' {
  if (arg === undefined || arg === 'positive') return 'positive';
  if (arg === 'negative') return 'negative';
  console.error(`Unknown variant "${arg}". Usage: npm run wa:test-template [positive|negative]`);
  process.exit(1);
}

async function main(): Promise<void> {
  const variant = parseVariant(process.argv[2]);

  const positiveTemplate = requireEnv('WA_TEMPLATE_POSITIVE');
  const negativeTemplate = requireEnv('WA_TEMPLATE_NEGATIVE');
  const language = requireEnv('WA_TEMPLATE_LANG');

  const templateName = variant === 'positive' ? positiveTemplate : negativeTemplate;

  console.log(`Template: ${variant} (${templateName})`);

  const result = await broadcastTemplate((recipient: Recipient): TemplateSpec | null => ({
    name: templateName,
    language,
    body: [
      { type: 'text', text: recipient.displayName },
      { type: 'text', text: DUMMY_LAST_AMOUNT },
      { type: 'text', text: DUMMY_LAST_PLACE },
      { type: 'text', text: DUMMY_REMAINING },
    ],
  }));

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

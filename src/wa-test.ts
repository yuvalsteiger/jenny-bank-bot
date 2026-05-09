import 'dotenv/config';
import { broadcast } from './whatsapp.js';

async function main(): Promise<void> {
  const arg = process.argv.slice(2).join(' ').trim();
  const body = arg.length > 0 ? arg : `bank_bot WhatsApp setup test - ${new Date().toISOString()}`;

  console.log(`Sending test message (length=${body.length})...`);
  const result = await broadcast(body);

  console.log('');
  console.log(`Result: ${result.succeeded}/${result.total} delivered, ${result.failed} failed.`);

  if (result.total === 0) {
    console.error('No recipients configured. Set WHATSAPP_RECIPIENTS in .env.');
    process.exit(1);
  }
  if (result.succeeded === 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});

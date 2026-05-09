import { WhatsAppClient, buildTemplateSendPayload } from '@kapso/whatsapp-cloud-api';
import { requireEnv } from './util.js';

const KAPSO_BASE_URL = 'https://app.kapso.ai/api/meta/';

export interface BroadcastResult {
  total: number;
  succeeded: number;
  failed: number;
}

export interface Recipient {
  // English; matches CAL_n_OWNER for per-owner lookups in cal-merged-latest.json.
  ownerKey: string;
  // Goes into the message — usually Hebrew for our templates.
  displayName: string;
  // E.164 without '+'.
  number: string;
}

export interface TemplateSpec {
  name: string;
  language: string;
  body: { type: 'text'; text: string }[];
}

// Public-repo safe: identify recipients only by 1-based index in logs. Phone
// numbers, owner keys, and display names are all considered sensitive and must
// never reach stdout.

function parseRecipients(raw: string): Recipient[] {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) {
    console.error('WHATSAPP_RECIPIENTS is set but contains no usable entries.');
    process.exit(1);
  }
  return entries.map((entry) => {
    const parts = entry.split(':').map((p) => p.trim());
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
      console.error(
        `WHATSAPP_RECIPIENTS entry "${entry}" has wrong shape. Expected ownerKey:displayName:number, e.g. Yuval:יובל:972544599580`,
      );
      process.exit(1);
    }
    const [ownerKey, displayName, number] = parts as [string, string, string];
    return { ownerKey, displayName, number };
  });
}

export function getRecipients(): Recipient[] {
  return parseRecipients(requireEnv('WHATSAPP_RECIPIENTS'));
}

function getClient(): WhatsAppClient {
  return new WhatsAppClient({
    baseUrl: KAPSO_BASE_URL,
    kapsoApiKey: requireEnv('KAPSO_API_KEY'),
  });
}

export async function broadcast(body: string): Promise<BroadcastResult> {
  const phoneNumberId = requireEnv('KAPSO_PHONE_NUMBER_ID');
  const recipients = getRecipients();
  const client = getClient();

  let succeeded = 0;
  let failed = 0;

  // Sequential — small recipient counts and we want predictable log ordering.
  // A single recipient's failure shouldn't block the others, mirroring the
  // per-cardholder fail-isolation pattern in next-debit.ts.
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i]!;
    try {
      await client.messages.sendText({ phoneNumberId, to: r.number, body });
      console.log(`  [ok]   recipient #${i + 1}`);
      succeeded++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`  [fail] recipient #${i + 1}: ${message}`);
      failed++;
    }
  }

  return { total: recipients.length, succeeded, failed };
}

// `build(recipient, index)` returns a TemplateSpec, or `null` to skip that
// recipient (e.g. no source data for them in this run). Skipped recipients are
// not counted in succeeded/failed; total reflects how many were actually
// attempted. The 0-based index is passed so callers can produce safe log lines
// without referencing the recipient's owner key or phone number.
export async function broadcastTemplate(
  build: (recipient: Recipient, index: number) => TemplateSpec | null,
): Promise<BroadcastResult> {
  const phoneNumberId = requireEnv('KAPSO_PHONE_NUMBER_ID');
  const recipients = getRecipients();
  const client = getClient();

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i]!;
    const spec = build(r, i);
    if (!spec) continue;
    attempted++;
    try {
      const template = buildTemplateSendPayload({
        name: spec.name,
        language: spec.language,
        body: spec.body,
      });
      await client.messages.sendTemplate({ phoneNumberId, to: r.number, template });
      console.log(`  [ok]   recipient #${i + 1}`);
      succeeded++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`  [fail] recipient #${i + 1}: ${message}`);
      failed++;
    }
  }

  return { total: attempted, succeeded, failed };
}

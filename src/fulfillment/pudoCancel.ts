import https from 'https';
import { getDb } from '../db/connection';
import { decrypt } from '../crypto';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'fulfillment:pudo-cancel' });

const PUDO_BASE_URL = 'https://api-pudo.co.za/api/v1/shipments';

/**
 * Map our internal `service_level_code` strings (which we store on the order
 * at submit time) to PUDO's numeric `service_level_id` field expected by the
 * cancel endpoint.
 *
 * Falls back to 3 (locker-to-door ECO) which is the most common. Submit pages
 * use the same defaults — see `pipeline/stages/payloadCreated.ts`.
 */
const SERVICE_LEVEL_ID_BY_CODE: Record<string, number> = {
  'L2DXS - ECO': 3, // locker-to-door (ECO XS)
  'L2LXS - ECO': 1, // locker-to-locker (ECO XS)
  'D2LXS - ECO': 2, // door-to-locker
  'D2DXS - ECO': 4, // door-to-door
};

export interface PudoCancelResult {
  ok: boolean;
  status: number;
  body: any;
}

/**
 * Cancel an active PUDO shipment.
 *
 * Requires:
 *  - shipmentId  : numeric, returned by PUDO at submit time and saved in
 *                  fulfillment_stage_results.output_data.shipment_id
 *  - serviceLevelCode : "L2DXS - ECO" etc, stored on orders.service_level_code
 *  - reason      : free-text shown to PUDO/courier (e.g. "Customer requested")
 */
export async function cancelPudoShipment(args: {
  tenantId: string;
  shipmentId: number;
  serviceLevelCode: string | null | undefined;
  reason: string;
}): Promise<PudoCancelResult> {
  const db = getDb();

  const pudoSettings = await db('tenant_pudo_settings').where({ tenant_id: args.tenantId }).first();
  if (!pudoSettings) {
    throw new Error('PUDO settings not configured for this tenant');
  }

  let apiKey: string;
  try {
    apiKey = decrypt(pudoSettings.encrypted_pudo_api_key);
  } catch (err: any) {
    throw new Error(
      `PUDO API key could not be decrypted (likely encrypted with a different ENCRYPTION_KEY). Re-save PUDO credentials in Settings. Underlying: ${err.message}`,
    );
  }

  const serviceLevelId = SERVICE_LEVEL_ID_BY_CODE[(args.serviceLevelCode || '').toUpperCase()] || 3;

  const body = {
    status: 'cancelled',
    metaData: {
      tracking_info: {
        message: args.reason || 'Cancelled via dashboard',
      },
    },
    service_level_id: serviceLevelId,
  };

  const url = new URL(`${PUDO_BASE_URL}/${encodeURIComponent(String(args.shipmentId))}`);

  return new Promise<PudoCancelResult>((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 20000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed: any = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          const ok = (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300;
          if (ok) {
            log.info({ shipmentId: args.shipmentId, status: res.statusCode }, 'PUDO shipment cancelled');
          } else {
            log.warn({ shipmentId: args.shipmentId, status: res.statusCode, body: parsed }, 'PUDO cancel returned non-2xx');
          }
          resolve({ ok, status: res.statusCode || 0, body: parsed });
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('PUDO cancel request timed out'));
    });

    req.write(payload);
    req.end();
  });
}

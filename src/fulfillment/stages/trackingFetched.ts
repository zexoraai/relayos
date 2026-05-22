import https from 'https';
import { getDb } from '../../db/connection';
import { createChildLogger } from '../../observability/logger';
import { FulfillmentStage, TrackingResponse } from '../types';

const log = createChildLogger({ module: 'fulfillment:tracking-fetched' });

const TRACKING_BASE_URL = 'https://api-pudo.co.za/api/v1/tracking/shipments/public';

/**
 * Stage: TRACKING_FETCHED
 * Calls PUDO public tracking endpoint to fetch the latest tracking events.
 */
export async function executeTrackingFetched(
  jobId: string,
  waybill: string
): Promise<TrackingResponse> {
  const db = getDb();

  const response = await fetchTracking(waybill);

  await db('fulfillment_stage_results').insert({
    fulfillment_job_id: jobId,
    stage: FulfillmentStage.TRACKING_FETCHED,
    status: 'completed',
    output_data: JSON.stringify({
      shipment_id: response.shipment_id,
      status: response.status,
      events_count: response.tracking_events?.length || 0,
    }),
  });

  await db('fulfillment_jobs').where({ id: jobId }).update({
    current_stage: FulfillmentStage.TRACKING_FETCHED,
    last_polled_at: new Date(),
    updated_at: new Date(),
  });

  log.info({ jobId, waybill, status: response.status, events: response.tracking_events?.length || 0 }, 'Tracking fetched');

  return response;
}

function fetchTracking(waybill: string): Promise<TrackingResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(TRACKING_BASE_URL);
    url.searchParams.set('waybill', waybill);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Tracking API returned ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e: any) {
          reject(new Error(`Failed to parse tracking response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Tracking request timed out')); });
    req.end();
  });
}

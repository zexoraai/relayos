import https from 'https';
import { getDb } from '../../db/connection';
import { createChildLogger } from '../../observability/logger';
import { PipelineStage, PipelineStatus } from '../types';
import { ExtractedOrderData } from '../types';

const log = createChildLogger({ module: 'pipeline:location-resolved' });

export interface DeliveryAddress {
  lat: number | null;
  lng: number | null;
  street_address: string;
  local_area: string;
  suburb: string;
  city: string;
  code: string;
  zone: string;
  country: string;
  entered_address: string;
}

export interface ResolvedLocation {
  delivery_address: DeliveryAddress;
}

/**
 * Stage: LOCATION_RESOLVED
 * Geocodes the shipping address using Google Maps to get coordinates
 * and structured address components. The user's entered_address is
 * always preserved (Google can never remove user intent).
 */
export async function executeLocationResolved(
  jobId: string,
  extracted: ExtractedOrderData
): Promise<ResolvedLocation> {
  const db = getDb();

  const enteredAddress = (extracted.shipping_address || '').toString().trim();
  const googleApiKey = process.env.GOOGLE_MAPS_API_KEY;

  let geocoded: any = null;
  if (googleApiKey && enteredAddress) {
    try {
      geocoded = await geocodeAddress(enteredAddress, googleApiKey);
    } catch (error: any) {
      log.warn({ jobId, error: error.message }, 'Google geocoding failed');
    }
  } else if (!googleApiKey) {
    log.debug({ jobId }, 'GOOGLE_MAPS_API_KEY not configured');
  }

  const deliveryAddress = buildDeliveryAddress(enteredAddress, geocoded);
  const result: ResolvedLocation = { delivery_address: deliveryAddress };

  await db('pipeline_stage_results').insert({
    pipeline_job_id: jobId,
    stage: PipelineStage.LOCATION_RESOLVED,
    status: PipelineStatus.COMPLETED,
    input_data: JSON.stringify({ entered_address: enteredAddress }),
    output_data: JSON.stringify(result),
  });

  await db('pipeline_jobs').where({ id: jobId }).update({
    current_stage: PipelineStage.LOCATION_RESOLVED,
    updated_at: new Date(),
  });

  log.info({ jobId, lat: deliveryAddress.lat, lng: deliveryAddress.lng }, 'Location resolved');

  return result;
}

function buildDeliveryAddress(enteredAddress: string, geocoded: any): DeliveryAddress {
  const result = (geocoded?.results && geocoded.results[0]) || {};
  const components = result.address_components || [];
  const geometry = result.geometry || {};
  const location = geometry.location || {};

  function getComponent(type: string): any {
    return components.find((c: any) => (c.types || []).includes(type));
  }

  function getLongName(type: string): string {
    const comp = getComponent(type);
    return comp ? comp.long_name : '';
  }

  const streetNumber = getLongName('street_number');
  const route = getLongName('route');
  const sublocality = getLongName('sublocality_level_1') || getLongName('sublocality');
  const locality = getLongName('locality');
  const adminArea2 = getLongName('administrative_area_level_2');
  const adminArea1 = getLongName('administrative_area_level_1');
  const postalCode = getLongName('postal_code');
  const country = getLongName('country');

  const street_address = [streetNumber, route].filter(Boolean).join(' ');
  const local_area = sublocality || locality || '';
  const suburb = locality || sublocality || '';
  const city = adminArea2 || locality || adminArea1 || '';
  const code = postalCode || '';
  const zone = adminArea1 || adminArea2 || '';
  const countryName = country || '';

  return {
    lat: location.lat ?? null,
    lng: location.lng ?? null,
    street_address,
    local_area,
    suburb,
    city,
    code,
    zone,
    country: countryName,
    // User intent is preserved, Google can NEVER remove data
    entered_address: enteredAddress,
  };
}

function geocodeAddress(address: string, apiKey: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const encodedAddress = encodeURIComponent(address);
    const path = `/maps/api/geocode/json?address=${encodedAddress}&key=${apiKey}`;

    const options = {
      hostname: 'maps.googleapis.com',
      path,
      method: 'GET',
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.status !== 'OK' && parsed.status !== 'ZERO_RESULTS') {
            return reject(new Error(`Geocoding API error: ${parsed.status}`));
          }
          resolve(parsed);
        } catch (e: any) {
          reject(new Error(`Failed to parse geocoding response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Geocoding request timed out')); });
    req.end();
  });
}

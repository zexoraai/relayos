import https from 'https';
import { getDb } from '../../db/connection';
import { decrypt } from '../../crypto';
import { createChildLogger } from '../../observability/logger';
import { PipelineStage, PipelineStatus } from '../types';
import { ResolvedLocation } from './locationResolved';

const log = createChildLogger({ module: 'pipeline:lockers-resolved' });

const PUDO_LOCKERS_URL = 'https://api-pudo.co.za/api/v1/lockers-data';
const THRESHOLD_KM = 20;

export interface LockersResolvedResult {
  terminal_id: string;
  nearest_locker_name: string;
  distance_km: string;
  eligibility: boolean;
  customer_lat: number | null;
  customer_lng: number | null;
}

/**
 * Stage: LOCKERS_RESOLVED
 * Fetches the PUDO lockers list and finds the nearest eligible locker
 * to the customer's coordinates using the Haversine formula.
 *
 * Eligibility: TCG provider + Locker type + supports V4-XS box.
 * Falls back to closest overall locker if no eligible one is within 20km.
 */
export async function executeLockersResolved(
  jobId: string,
  tenantId: string,
  location: ResolvedLocation
): Promise<LockersResolvedResult> {
  const db = getDb();

  const custLat = parseFloat(String(location.delivery_address.lat ?? ''));
  const custLng = parseFloat(String(location.delivery_address.lng ?? ''));

  if (isNaN(custLat) || isNaN(custLng)) {
    log.warn({ jobId, lat: location.delivery_address.lat, lng: location.delivery_address.lng }, 'Invalid customer coordinates');

    const result: LockersResolvedResult = {
      terminal_id: 'NO_LOCKER_FOUND',
      nearest_locker_name: 'N/A',
      distance_km: 'Infinity',
      eligibility: false,
      customer_lat: null,
      customer_lng: null,
    };

    await db('pipeline_stage_results').insert({
      pipeline_job_id: jobId,
      stage: PipelineStage.LOCKERS_RESOLVED,
      status: PipelineStatus.SKIPPED,
      input_data: JSON.stringify({ reason: 'Invalid customer coordinates' }),
      output_data: JSON.stringify(result),
    });

    await db('pipeline_jobs').where({ id: jobId }).update({
      current_stage: PipelineStage.LOCKERS_RESOLVED,
      updated_at: new Date(),
    });

    return result;
  }

  // Fetch PUDO lockers list (uses tenant's PUDO API key for authentication)
  const pudoSettings = await db('tenant_pudo_settings').where({ tenant_id: tenantId }).first();
  if (!pudoSettings) {
    throw new Error('PUDO settings not configured for tenant');
  }
  const apiKey = decrypt(pudoSettings.encrypted_pudo_api_key);

  const lockersResponse = await fetchLockers(apiKey);
  const lockerList = extractLockerList(lockersResponse);

  log.info({ jobId, count: lockerList.length, custLat, custLng }, 'Fetched lockers, computing nearest');

  // Find nearest overall + nearest eligible
  let closestAny: any = null;
  let minDistAny = Infinity;
  let closestEligible: any = null;
  let minDistEligible = Infinity;

  for (const locker of lockerList) {
    const coords = parseLockerCoords(locker);
    if (!coords) continue;

    const dist = getDistance(custLat, custLng, coords.lLat, coords.lLng);

    // Closest overall (no eligibility filter)
    if (dist < minDistAny) {
      minDistAny = dist;
      closestAny = locker;
    }

    // Eligibility: TCG provider + Locker type + supports V4-XS box
    const isTCG = locker.provider === 'TCG';
    const isLockerType = locker.type && locker.type.name === 'Locker';
    const supportsXS = Array.isArray(locker.lstTypesBoxes) &&
      locker.lstTypesBoxes.some((box: any) => box.name === 'V4-XS' || box.type === '10');
    const isEligible = isTCG && isLockerType && supportsXS;

    if (isEligible && dist < minDistEligible) {
      minDistEligible = dist;
      closestEligible = locker;
    }
  }

  // 20km rule: prefer eligible if within threshold, otherwise fall back to closest
  let chosenLocker: any = null;
  let chosenDistance = Infinity;
  let eligibilityUsed = false;

  if (closestEligible && minDistEligible <= THRESHOLD_KM) {
    chosenLocker = closestEligible;
    chosenDistance = minDistEligible;
    eligibilityUsed = true;
  } else if (closestAny) {
    chosenLocker = closestAny;
    chosenDistance = minDistAny;
    eligibilityUsed = false;
  }

  let result: LockersResolvedResult;

  if (chosenLocker) {
    result = {
      terminal_id: chosenLocker.code,
      nearest_locker_name: chosenLocker.name,
      distance_km: chosenDistance.toFixed(2),
      eligibility: eligibilityUsed,
      customer_lat: custLat,
      customer_lng: custLng,
    };
    log.info({
      jobId,
      terminal_id: result.terminal_id,
      name: result.nearest_locker_name,
      distance_km: result.distance_km,
      eligibility: result.eligibility,
    }, 'Locker resolved');
  } else {
    result = {
      terminal_id: 'NO_LOCKER_FOUND',
      nearest_locker_name: 'N/A',
      distance_km: 'Infinity',
      eligibility: false,
      customer_lat: custLat,
      customer_lng: custLng,
    };
    log.warn({ jobId }, 'No locker found with valid coordinates');
  }

  await db('pipeline_stage_results').insert({
    pipeline_job_id: jobId,
    stage: PipelineStage.LOCKERS_RESOLVED,
    status: PipelineStatus.COMPLETED,
    input_data: JSON.stringify({ customer_lat: custLat, customer_lng: custLng, lockers_count: lockerList.length }),
    output_data: JSON.stringify(result),
  });

  await db('pipeline_jobs').where({ id: jobId }).update({
    current_stage: PipelineStage.LOCKERS_RESOLVED,
    updated_at: new Date(),
  });

  return result;
}

function extractLockerList(response: any): any[] {
  if (Array.isArray(response)) return response;
  if (response?.data && Array.isArray(response.data)) return response.data;
  if (response?.lockers && Array.isArray(response.lockers)) return response.lockers;
  return [];
}

function parseLockerCoords(locker: any): { lLat: number; lLng: number } | null {
  if (!locker || locker.latitude == null || locker.longitude == null) return null;
  const lLat = parseFloat(locker.latitude);
  const lLng = parseFloat(locker.longitude);
  if (isNaN(lLat) || isNaN(lLng)) return null;
  return { lLat, lLng };
}

/**
 * Haversine formula — distance between two coordinates in km.
 */
function getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) *
    Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function fetchLockers(apiKey: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(PUDO_LOCKERS_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      timeout: 20000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`PUDO lockers API returned ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e: any) {
          reject(new Error(`Failed to parse PUDO lockers response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('PUDO lockers request timed out')); });
    req.end();
  });
}

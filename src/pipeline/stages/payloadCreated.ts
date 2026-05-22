import { getDb } from '../../db/connection';
import { createChildLogger } from '../../observability/logger';
import { PipelineStage, PipelineStatus } from '../types';
import { CustomerData } from './customerData';
import { LockersResolvedResult } from './lockersResolved';
import { DeliveryAddress } from './locationResolved';

const log = createChildLogger({ module: 'pipeline:payload-created' });

// SA provinces for extraction
const SA_PROVINCES = [
  'Gauteng', 'Western Cape', 'Eastern Cape', 'Northern Cape',
  'Free State', 'KwaZulu-Natal', 'Limpopo', 'Mpumalanga', 'North West'
];

export interface PudoPayload {
  collection_address: { terminal_id: string };
  special_instructions_collection: string;
  collection_contact: { name: string; email: string; mobile_number: string };
  delivery_address: any;
  delivery_contact: { name: string; email: string; mobile_number: string };
  opt_in_rates?: any[];
  opt_in_time_based_rates?: any[];
  service_level_code: string;
}

/**
 * Stage: PAYLOAD_CREATED
 * Builds the final PUDO shipment payload.
 * Forks based on delivery method:
 *   - locker-to-door: collection from tenant's locker, delivery to customer address
 *   - locker-to-locker: collection from tenant's locker, delivery to nearest locker
 */
export async function executePayloadCreated(
  jobId: string,
  tenantId: string,
  customerData: CustomerData,
  locker: LockersResolvedResult
): Promise<PudoPayload> {
  const db = getDb();

  // Get collection contact from tenant settings
  const collectionSettings = await db('tenant_collection_settings')
    .where({ tenant_id: tenantId })
    .first();

  if (!collectionSettings) {
    throw new Error('Collection contact not configured. Go to Settings to add it.');
  }

  let payload: PudoPayload;

  if (customerData.deliverMethod === 'locker-to-door') {
    payload = buildLockerToDoorPayload(customerData, locker, collectionSettings);
  } else if (customerData.deliverMethod === 'locker-to-locker') {
    payload = buildLockerToLockerPayload(customerData, locker, collectionSettings);
  } else {
    // Unsupported delivery method — store what we have
    payload = buildLockerToDoorPayload(customerData, locker, collectionSettings);
    log.warn({ jobId, deliverMethod: customerData.deliverMethod }, 'Unsupported delivery method, defaulting to locker-to-door payload');
  }

  await db('pipeline_stage_results').insert({
    pipeline_job_id: jobId,
    stage: PipelineStage.PAYLOAD_CREATED,
    status: PipelineStatus.COMPLETED,
    input_data: JSON.stringify({
      delivery_method: customerData.deliverMethod,
      terminal_id: locker.terminal_id,
      collection_terminal_id: collectionSettings.collection_terminal_id,
    }),
    output_data: JSON.stringify(payload),
  });

  await db('pipeline_jobs').where({ id: jobId }).update({
    current_stage: PipelineStage.PAYLOAD_CREATED,
    status: PipelineStatus.COMPLETED,
    updated_at: new Date(),
  });

  log.info({
    jobId,
    orderNumber: customerData.OrderNumber,
    deliverMethod: customerData.deliverMethod,
    service_level_code: payload.service_level_code,
  }, 'PUDO payload created');

  return payload;
}

/**
 * FORK: Locker-to-Door
 * Collection: tenant's locker (terminal_id from settings)
 * Delivery: customer's physical address (geocoded)
 */
function buildLockerToDoorPayload(
  customerData: CustomerData,
  locker: LockersResolvedResult,
  settings: any
): PudoPayload {
  const deliveryAddr = customerData.delivery_address;
  const enteredRaw = (deliveryAddr.entered_address || '').trim();
  const streetAddress = buildStreetAddress(enteredRaw, deliveryAddr);
  const code = extractPostalCode(enteredRaw) || deliveryAddr.code || '';
  const zone = extractProvince(enteredRaw) || deliveryAddr.zone || '';
  const country = extractCountry(enteredRaw) || deliveryAddr.country || 'South Africa';

  return {
    collection_address: {
      terminal_id: settings.collection_terminal_id || locker.terminal_id,
    },
    special_instructions_collection: settings.special_instructions || 'None',
    collection_contact: {
      name: settings.contact_name,
      email: settings.contact_email,
      mobile_number: settings.contact_phone,
    },
    delivery_address: {
      lat: deliveryAddr.lat,
      lng: deliveryAddr.lng,
      street_address: streetAddress,
      local_area: deliveryAddr.local_area || '',
      suburb: deliveryAddr.suburb || '',
      city: deliveryAddr.city || '',
      code,
      zone,
      country,
      type: 'residential',
    },
    delivery_contact: {
      name: customerData.customerName,
      email: settings.contact_email,
      mobile_number: normalizePhone(customerData.customerPhone),
    },
    opt_in_rates: [],
    opt_in_time_based_rates: [],
    service_level_code: 'L2DXS - ECO',
  };
}

/**
 * FORK: Locker-to-Locker
 * Collection: tenant's locker (terminal_id from settings)
 * Delivery: nearest locker to customer (terminal_id from LOCKERS_RESOLVED)
 */
function buildLockerToLockerPayload(
  customerData: CustomerData,
  locker: LockersResolvedResult,
  settings: any
): PudoPayload {
  return {
    collection_address: {
      terminal_id: settings.collection_terminal_id || '',
    },
    special_instructions_collection: settings.special_instructions || 'None',
    collection_contact: {
      name: settings.contact_name,
      email: settings.contact_email,
      mobile_number: settings.contact_phone,
    },
    delivery_address: {
      terminal_id: locker.terminal_id,
    },
    delivery_contact: {
      name: customerData.customerName,
      email: settings.contact_email,
      mobile_number: normalizePhone(customerData.customerPhone),
    },
    service_level_code: 'L2LXS - ECO',
  };
}

// --- Utility functions ---

function buildStreetAddress(enteredRaw: string, deliveryAddr: DeliveryAddress): string {
  if (!enteredRaw) return deliveryAddr.street_address || '';
  let parts = enteredRaw.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length && /^south\s+africa$/i.test(parts[parts.length - 1])) parts.pop();
  if (parts.length && /^\d{10,}$/.test(parts[parts.length - 1].replace(/\D/g, ''))) parts.pop();
  if (parts.length && /^\d{4}$/.test(parts[parts.length - 1])) {
    parts.pop();
  } else if (parts.length) {
    parts[parts.length - 1] = parts[parts.length - 1].replace(/\b\d{4}\b/g, '').trim();
    if (!parts[parts.length - 1]) parts.pop();
  }
  const zone = extractProvince(enteredRaw);
  if (parts.length && zone) {
    if (new RegExp(`^${escapeRegExp(zone)}$`, 'i').test(parts[parts.length - 1])) parts.pop();
  }
  if (parts.length && zone) {
    parts[parts.length - 1] = parts[parts.length - 1].replace(new RegExp(`\\b${escapeRegExp(zone)}\\b`, 'i'), '').replace(/\s{2,}/g, ' ').trim();
    if (!parts[parts.length - 1]) parts.pop();
  }
  return parts.join(', ').replace(/,\s*$/, '').replace(/\s+/g, ' ').trim();
}

function extractPostalCode(address: string): string {
  const matches = address.match(/\b\d{4}\b/g);
  return matches ? matches[matches.length - 1] : '';
}

function extractProvince(address: string): string {
  return SA_PROVINCES.find(p => new RegExp(`\\b${escapeRegExp(p)}\\b`, 'i').test(address)) || '';
}

function extractCountry(address: string): string {
  return /\bsouth\s+africa\b/i.test(address) ? 'South Africa' : '';
}

function normalizePhone(phone: string): string {
  return String(phone || '').replace(/\D/g, '').replace(/^27/, '0');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

/**
 * PUDO supports four service codes. The code MUST match the actual address
 * types in the payload — collection (locker terminal_id vs door street) and
 * delivery (locker terminal_id vs door street). Sending door addresses with
 * an L2D/L2L code (or vice versa) returns:
 *   422 Address types did not matched selected service.
 *
 * Map kept in sync with `pudoCancel.ts` SERVICE_LEVEL_ID_BY_CODE.
 */
const SERVICE_LEVEL_BY_METHOD: Record<string, string> = {
  'locker-to-locker': 'L2LXS - ECO',
  'locker-to-door':   'L2DXS - ECO',
  'door-to-locker':   'D2LXS - ECO',
  'door-to-door':     'D2DXS - ECO',
};

export interface PudoPayload {
  collection_address: any;            // { terminal_id } for L2*; door fields for D2*
  special_instructions_collection: string;
  collection_contact: { name: string; email: string; mobile_number: string };
  delivery_address: any;              // { terminal_id } for *2L; door fields for *2D
  delivery_contact: { name: string; email: string; mobile_number: string };
  opt_in_rates?: any[];
  opt_in_time_based_rates?: any[];
  service_level_code: string;
}

/**
 * Stage: PAYLOAD_CREATED
 *
 * Builds the final PUDO shipment payload, choosing the service code from the
 * actual delivery method. Forks four ways:
 *   - locker-to-locker: collect from tenant locker, deliver to nearest locker
 *   - locker-to-door:   collect from tenant locker, deliver to customer address
 *   - door-to-locker:   collect from tenant address, deliver to nearest locker
 *   - door-to-door:     collect from tenant address, deliver to customer address
 *
 * Door collections require the tenant's collection address to be configured
 * in `tenant_collection_settings.collection_address` (a JSON column the
 * onboarding/settings UI fills out the same shape as a delivery address).
 * If a door collection is requested but no collection address is configured,
 * we fail loudly so caretaker catches it instead of silently swapping
 * service codes (which is what produced the 422 you saw).
 */
export async function executePayloadCreated(
  jobId: string,
  tenantId: string,
  customerData: CustomerData,
  locker: LockersResolvedResult
): Promise<PudoPayload> {
  const db = getDb();

  const collectionSettings = await db('tenant_collection_settings')
    .where({ tenant_id: tenantId })
    .first();

  if (!collectionSettings) {
    throw new Error('Collection contact not configured. Go to Settings to add it.');
  }

  const method = (customerData.deliverMethod || '').toLowerCase().trim();
  const serviceCode = SERVICE_LEVEL_BY_METHOD[method];

  if (!serviceCode) {
    // Caretaker / dataValidated should have caught this, but defend in depth
    // rather than silently swap to L2D and break the courier handoff.
    throw new Error(
      `Unsupported delivery method "${customerData.deliverMethod}". ` +
      `Allowed: ${Object.keys(SERVICE_LEVEL_BY_METHOD).join(', ')}.`,
    );
  }

  // Validate that the addresses we're about to send actually match the service.
  const collectionIsLocker = method.startsWith('locker-');
  const deliveryIsLocker = method.endsWith('-locker');

  if (collectionIsLocker) {
    const lockerId = collectionSettings.collection_terminal_id;
    if (!lockerId) {
      throw new Error(
        `Delivery method "${method}" needs a collection locker, but no ` +
        `collection_terminal_id is set. Go to Settings → Collection Contact ` +
        `and pick a PUDO terminal.`,
      );
    }
  } else {
    // Door collection requires a collection address.
    if (!collectionSettings.collection_address) {
      throw new Error(
        `Delivery method "${method}" needs a door collection address, but no ` +
        `collection_address is set on tenant_collection_settings. Add one in ` +
        `Settings → Collection Contact (street_address, suburb, city, code, zone).`,
      );
    }
  }

  if (deliveryIsLocker) {
    if (!locker?.terminal_id || locker.terminal_id === 'NO_LOCKER_FOUND') {
      throw new Error(
        `Delivery method "${method}" needs a destination locker, but ` +
        `LOCKERS_RESOLVED returned no eligible locker for the customer.`,
      );
    }
  }

  let payload: PudoPayload;
  switch (method) {
    case 'locker-to-locker':
      payload = buildL2LPayload(customerData, locker, collectionSettings);
      break;
    case 'locker-to-door':
      payload = buildL2DPayload(customerData, locker, collectionSettings);
      break;
    case 'door-to-locker':
      payload = buildD2LPayload(customerData, locker, collectionSettings);
      break;
    case 'door-to-door':
      payload = buildD2DPayload(customerData, locker, collectionSettings);
      break;
    default:
      // unreachable — guarded above
      throw new Error(`Unsupported delivery method "${method}"`);
  }

  // The service code from the map is authoritative — a builder that returns
  // a different one is a bug. Pin it explicitly so the row matches the address shape.
  payload.service_level_code = serviceCode;

  await db('pipeline_stage_results').insert({
    pipeline_job_id: jobId,
    stage: PipelineStage.PAYLOAD_CREATED,
    status: PipelineStatus.COMPLETED,
    input_data: JSON.stringify({
      delivery_method: method,
      destination_terminal_id: locker.terminal_id,
      collection_terminal_id: collectionSettings.collection_terminal_id,
      collection_address_present: !!collectionSettings.collection_address,
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
    deliverMethod: method,
    service_level_code: payload.service_level_code,
    collection: collectionIsLocker ? 'locker' : 'door',
    delivery: deliveryIsLocker ? 'locker' : 'door',
  }, 'PUDO payload created');

  return payload;
}

// --- Builders ---------------------------------------------------------------

/** Locker-to-Locker: collection terminal + delivery terminal */
function buildL2LPayload(
  customerData: CustomerData,
  locker: LockersResolvedResult,
  settings: any,
): PudoPayload {
  return {
    collection_address: { terminal_id: settings.collection_terminal_id },
    special_instructions_collection: settings.special_instructions || 'None',
    collection_contact: contactFromSettings(settings),
    delivery_address: { terminal_id: locker.terminal_id },
    delivery_contact: deliveryContact(customerData, settings),
    opt_in_rates: [],
    opt_in_time_based_rates: [],
    service_level_code: SERVICE_LEVEL_BY_METHOD['locker-to-locker'],
  };
}

/** Locker-to-Door: collection terminal + delivery street address */
function buildL2DPayload(
  customerData: CustomerData,
  locker: LockersResolvedResult,
  settings: any,
): PudoPayload {
  return {
    collection_address: {
      terminal_id: settings.collection_terminal_id || locker.terminal_id,
    },
    special_instructions_collection: settings.special_instructions || 'None',
    collection_contact: contactFromSettings(settings),
    delivery_address: deliveryDoorAddress(customerData),
    delivery_contact: deliveryContact(customerData, settings),
    opt_in_rates: [],
    opt_in_time_based_rates: [],
    service_level_code: SERVICE_LEVEL_BY_METHOD['locker-to-door'],
  };
}

/** Door-to-Locker: collection street address + delivery terminal */
function buildD2LPayload(
  customerData: CustomerData,
  locker: LockersResolvedResult,
  settings: any,
): PudoPayload {
  return {
    collection_address: collectionDoorAddress(settings),
    special_instructions_collection: settings.special_instructions || 'None',
    collection_contact: contactFromSettings(settings),
    delivery_address: { terminal_id: locker.terminal_id },
    delivery_contact: deliveryContact(customerData, settings),
    opt_in_rates: [],
    opt_in_time_based_rates: [],
    service_level_code: SERVICE_LEVEL_BY_METHOD['door-to-locker'],
  };
}

/** Door-to-Door: collection street address + delivery street address */
function buildD2DPayload(
  customerData: CustomerData,
  locker: LockersResolvedResult,
  settings: any,
): PudoPayload {
  return {
    collection_address: collectionDoorAddress(settings),
    special_instructions_collection: settings.special_instructions || 'None',
    collection_contact: contactFromSettings(settings),
    delivery_address: deliveryDoorAddress(customerData),
    delivery_contact: deliveryContact(customerData, settings),
    opt_in_rates: [],
    opt_in_time_based_rates: [],
    service_level_code: SERVICE_LEVEL_BY_METHOD['door-to-door'],
  };
}

// --- Address / contact helpers ---------------------------------------------

function contactFromSettings(settings: any) {
  return {
    name: settings.contact_name,
    email: settings.contact_email,
    mobile_number: settings.contact_phone,
  };
}

function deliveryContact(customerData: CustomerData, settings: any) {
  return {
    name: customerData.customerName,
    email: settings.contact_email,
    mobile_number: normalizePhone(customerData.customerPhone),
  };
}

/**
 * Build a customer-side door delivery address from the resolved location.
 * Identical shape to PUDO's `delivery_address` for door services.
 */
function deliveryDoorAddress(customerData: CustomerData) {
  const deliveryAddr = customerData.delivery_address;
  const enteredRaw = (deliveryAddr.entered_address || '').trim();
  const streetAddress = buildStreetAddress(enteredRaw, deliveryAddr);
  const code = extractPostalCode(enteredRaw) || deliveryAddr.code || '';
  const zone = extractProvince(enteredRaw) || deliveryAddr.zone || '';
  const country = extractCountry(enteredRaw) || deliveryAddr.country || 'South Africa';

  return {
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
  };
}

/**
 * Build a tenant-side door collection address from `tenant_collection_settings`.
 * Reads `collection_address` (jsonb) which the Settings UI fills with the
 * same shape as a PUDO delivery address (street_address, suburb, city, code, zone, country).
 */
function collectionDoorAddress(settings: any) {
  let raw: any = settings.collection_address;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = {}; }
  }
  if (!raw || typeof raw !== 'object') raw = {};

  return {
    lat: raw.lat ?? null,
    lng: raw.lng ?? null,
    street_address: raw.street_address || '',
    local_area: raw.local_area || '',
    suburb: raw.suburb || '',
    city: raw.city || '',
    code: raw.code || '',
    zone: raw.zone || '',
    country: raw.country || 'South Africa',
    type: raw.type || 'business',
  };
}

// --- Address-parsing utilities (kept verbatim from previous implementation) -

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

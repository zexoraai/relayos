import https from 'https';
import { z } from 'zod';
import { getDb } from '../../db/connection';
import { createChildLogger } from '../../observability/logger';
import { PipelineStage, PipelineStatus } from '../types';
import { DeliveryAddress, ResolvedLocation } from './locationResolved';
import { chatCompletionValidated } from '../../ai/validatedCompletion';

const log = createChildLogger({ module: 'pipeline:location-reconciled' });

/**
 * Vital fields the South-African PUDO API expects on a courier payload.
 * If any of these are missing after the Google geocode pass, we run
 * reconciliation to try to recover them from the entered address (and a
 * deterministic re-geocode), only invoking the LLM when those fail.
 */
const VITAL_FIELDS = ['suburb', 'city', 'code'] as const;
type VitalField = typeof VITAL_FIELDS[number];

export type ReconciliationDecision =
  | 'skipped'           // address was already complete; nothing to do
  | 'auto_merged_high'  // re-geocode or AI suggestion verified by Google with high confidence
  | 'auto_merged_low'   // AI suggestion accepted but confidence was medium — caretaker should still glance
  | 'flagged';          // tried everything, still uncertain — caretaker must intervene

export interface ReconciliationResult {
  decision: ReconciliationDecision;
  delivery_address: DeliveryAddress;
  missing_before: VitalField[];
  missing_after: VitalField[];
  confidence: number;          // 0..1
  ai_used: boolean;
  ai_suggestion: Partial<DeliveryAddress> | null;
  ai_reasoning: string | null;
  source: 'unchanged' | 'normalized_regeocode' | 'ai_validated' | 'ai_unverified';
}

/**
 * Stage: LOCATION_RECONCILED
 *
 * Runs immediately after LOCATION_RESOLVED. If the geocoded result has
 * suburb / city / postal_code missing, attempt to recover those fields
 * without bothering a human. Strategy in increasing order of cost:
 *
 *   1. Skip entirely if nothing is missing.
 *   2. Try a normalized re-geocode (fix common typos like "Capetown",
 *      "JHB", "Stellenbsh"). If Google returns a complete result, accept.
 *   3. Ask the LLM to reconcile the entered address against the partial
 *      geocode. Output is a structured DeliveryAddress with confidence.
 *   4. Validate the LLM's suggestion by re-geocoding it. If Google now
 *      agrees on the same locality / postal_code, mark high confidence.
 *
 * Decision rules feed into the caretaker:
 *   - auto_merged_high: pipeline continues silently
 *   - auto_merged_low : caretaker still gets it as 'review' with a banner
 *   - flagged         : caretaker must edit by hand
 *
 * Audit: every reconciliation writes a row in
 * `ai_address_reconciliations` so we can later tune thresholds against
 * real-world data.
 *
 * Defensive: any thrown error short-circuits to source='unchanged' so the
 * pipeline always makes forward progress.
 *
 * Optional `llmConcern` argument: when the rules-based check passes but
 * the caretaker LLM still flagged an address concern (postal mismatch,
 * province / suburb inconsistency, etc.), we run reconciliation anyway
 * with the LLM's reasoning passed through to the agent. This catches
 * Google parses that *look* complete but contradict the entered text.
 */
export async function executeLocationReconciled(
  jobId: string,
  tenantId: string,
  location: ResolvedLocation,
  llmConcern?: { reasons: string[]; flags: string[] },
): Promise<ReconciliationResult> {
  const db = getDb();
  const original = location.delivery_address;
  const missingBefore = computeMissing(original);

  // Cheap exit: nothing to reconcile AND no LLM concern means we have
  // nothing useful to do here. When the LLM flagged a concern though,
  // we keep going — its observation may indicate Google parsed the
  // address into the wrong locality / postal even though no fields
  // are technically empty.
  if (missingBefore.length === 0 && !llmConcern) {
    const result: ReconciliationResult = {
      decision: 'skipped',
      delivery_address: original,
      missing_before: [],
      missing_after: [],
      confidence: 1,
      ai_used: false,
      ai_suggestion: null,
      ai_reasoning: null,
      source: 'unchanged',
    };
    await recordStageResult(db, jobId, 'completed', result);
    log.debug({ jobId }, 'Address already complete; reconciliation skipped');
    return result;
  }

  // Pass 1: deterministic re-geocode after normalising common typos.
  let working: DeliveryAddress = { ...original };
  let source: ReconciliationResult['source'] = 'unchanged';
  let aiSuggestion: Partial<DeliveryAddress> | null = null;
  let aiReasoning: string | null = null;
  let aiUsed = false;
  let confidence = 0;
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  try {
    const normalized = normalizeAddress(original.entered_address);
    if (normalized && normalized !== original.entered_address && apiKey) {
      const regeocoded = await geocodeOnce(normalized, apiKey);
      const fromRegeocode = applyGoogleResultIntoAddress(regeocoded, working);
      const stillMissing = computeMissing(fromRegeocode);
      if (stillMissing.length < missingBefore.length) {
        working = fromRegeocode;
        source = 'normalized_regeocode';
        confidence = stillMissing.length === 0 ? 0.92 : 0.7;
        log.info(
          { jobId, before: missingBefore, after: stillMissing, normalized },
          'Reconciliation recovered missing fields via normalised re-geocode',
        );
      }
    }
  } catch (error: any) {
    log.warn({ jobId, error: error.message }, 'Normalised re-geocode pass failed (non-fatal)');
  }

  // Pass 2: AI reconciliation (only if still missing fields OR llmConcern
  // raised an issue with what we already have).
  let stillMissing = computeMissing(working);
  const shouldRunAi = stillMissing.length > 0 || !!llmConcern;
  if (shouldRunAi) {
    try {
      const ai = await aiReconcile({
        tenantId,
        enteredAddress: original.entered_address,
        partial: working,
        missing: stillMissing,
        llmConcern,
      });
      aiUsed = true;
      aiReasoning = ai.reasoning;
      aiSuggestion = ai.suggestion;
      confidence = ai.confidence;

      // Validate by re-geocoding the AI's reconstructed address.
      let validated = false;
      if (apiKey) {
        const reconstructed = [
          ai.suggestion.street_address,
          ai.suggestion.suburb,
          ai.suggestion.city,
          ai.suggestion.zone,
          ai.suggestion.code,
          ai.suggestion.country || 'South Africa',
        ]
          .filter(Boolean)
          .join(', ');

        if (reconstructed) {
          try {
            const reGeo = await geocodeOnce(reconstructed, apiKey);
            const reGeoAddress = applyGoogleResultIntoAddress(reGeo, working);
            const reGeoMissing = computeMissing(reGeoAddress);
            if (reGeoMissing.length === 0) {
              validated = true;
              working = reGeoAddress;
              confidence = Math.max(confidence, 0.88);
              source = 'ai_validated';
            }
          } catch (e: any) {
            log.debug({ jobId, error: e.message }, 'AI suggestion failed to re-geocode');
          }
        }
      }

      // If the AI suggestion didn't validate, still merge any non-empty
      // fields it provided so caretaker sees the best guesses pre-filled.
      if (!validated) {
        working = mergeAddress(working, ai.suggestion);
        source = 'ai_unverified';
      }

      stillMissing = computeMissing(working);
    } catch (error: any) {
      log.warn({ jobId, error: error.message }, 'AI reconciliation failed (non-fatal); falling through');
    }
  }

  // Decision rule.
  let decision: ReconciliationDecision;
  if (stillMissing.length === 0 && confidence >= 0.85) {
    decision = 'auto_merged_high';
  } else if (stillMissing.length === 0 && confidence >= 0.6) {
    decision = 'auto_merged_low';
  } else if (stillMissing.length === 0 && !aiUsed) {
    // Re-geocode fully recovered without AI — treat as high.
    decision = 'auto_merged_high';
    confidence = Math.max(confidence, 0.9);
  } else {
    decision = 'flagged';
    confidence = Math.max(0, Math.min(confidence, 0.55));
  }

  const result: ReconciliationResult = {
    decision,
    delivery_address: working,
    missing_before: missingBefore,
    missing_after: stillMissing,
    confidence,
    ai_used: aiUsed,
    ai_suggestion: aiSuggestion,
    ai_reasoning: aiReasoning,
    source,
  };

  // Persist the audit row.
  try {
    await db('ai_address_reconciliations').insert({
      tenant_id: tenantId,
      pipeline_job_id: jobId,
      entered_address: original.entered_address,
      geocoded: JSON.stringify(original),
      ai_suggestion: aiSuggestion ? JSON.stringify(aiSuggestion) : null,
      ai_reasoning: aiReasoning,
      reconciled: JSON.stringify(working),
      decision,
      source,
      confidence,
      missing_before: JSON.stringify(missingBefore),
      missing_after: JSON.stringify(stillMissing),
      ai_used: aiUsed,
    });
  } catch (e: any) {
    log.warn({ jobId, error: e.message }, 'Failed to persist ai_address_reconciliations row (non-fatal)');
  }

  await recordStageResult(db, jobId, 'completed', result);

  log.info(
    { jobId, decision, confidence, ai_used: aiUsed, source, missing_before: missingBefore, missing_after: stillMissing },
    'Reconciliation complete',
  );

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeMissing(addr: DeliveryAddress): VitalField[] {
  const missing: VitalField[] = [];
  if (!addr.suburb || !addr.suburb.trim()) missing.push('suburb');
  if (!addr.city || !addr.city.trim()) missing.push('city');
  if (!addr.code || !addr.code.trim()) missing.push('code');
  return missing;
}

/**
 * Normalize the most common South-African address typos that the Google
 * geocoder mishandles. Cheap deterministic step before paying for an AI
 * call.
 */
function normalizeAddress(s: string): string {
  if (!s) return s;
  let out = s.trim();
  const subs: [RegExp, string][] = [
    [/\bcapetown\b/gi, 'Cape Town'],
    [/\bjhb\b/gi, 'Johannesburg'],
    [/\bjozi\b/gi, 'Johannesburg'],
    [/\bp\.?e\.?\b/gi, 'Port Elizabeth'],
    [/\bstellenbsh\b/gi, 'Stellenbosch'],
    [/\bkznn?\b/gi, 'KwaZulu-Natal'],
    [/\bgp\b/gi, 'Gauteng'],
    [/\bsa\b\s*$/gi, 'South Africa'],
    [/\s{2,}/g, ' '],
    [/,\s*,/g, ','],
  ];
  for (const [re, rep] of subs) out = out.replace(re, rep);
  return out;
}

function applyGoogleResultIntoAddress(geocoded: any, base: DeliveryAddress): DeliveryAddress {
  const result = (geocoded?.results && geocoded.results[0]) || null;
  if (!result) return base;
  const components = result.address_components || [];
  const geometry = result.geometry || {};
  const location = geometry.location || {};

  const find = (type: string): string => {
    const c = components.find((cc: any) => (cc.types || []).includes(type));
    return c ? c.long_name : '';
  };

  const streetNumber = find('street_number');
  const route = find('route');
  const sublocality = find('sublocality_level_1') || find('sublocality');
  const locality = find('locality');
  const adminArea2 = find('administrative_area_level_2');
  const adminArea1 = find('administrative_area_level_1');
  const postalCode = find('postal_code');
  const country = find('country');

  return {
    ...base,
    lat: location.lat ?? base.lat,
    lng: location.lng ?? base.lng,
    street_address: [streetNumber, route].filter(Boolean).join(' ') || base.street_address,
    local_area: sublocality || locality || base.local_area,
    suburb: locality || sublocality || base.suburb,
    city: adminArea2 || locality || adminArea1 || base.city,
    code: postalCode || base.code,
    zone: adminArea1 || adminArea2 || base.zone,
    country: country || base.country,
  };
}

function mergeAddress(a: DeliveryAddress, b: Partial<DeliveryAddress>): DeliveryAddress {
  const out: DeliveryAddress = { ...a };
  for (const key of Object.keys(b) as (keyof DeliveryAddress)[]) {
    const v = b[key];
    if (v !== null && v !== undefined && String(v).trim() !== '' && !out[key]) {
      (out as any)[key] = v;
    }
  }
  return out;
}

const aiSuggestionSchema = z.object({
  street_address: z.string().optional().default(''),
  suburb: z.string().optional().default(''),
  city: z.string().optional().default(''),
  zone: z.string().optional().default(''),
  code: z.string().optional().default(''),
  country: z.string().optional().default('South Africa'),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().optional().default(''),
});

async function aiReconcile(args: {
  tenantId: string;
  enteredAddress: string;
  partial: DeliveryAddress;
  missing: VitalField[];
  llmConcern?: { reasons: string[]; flags: string[] };
}): Promise<{ suggestion: Partial<DeliveryAddress>; reasoning: string; confidence: number }> {
  const baseSys =
    'You are a South African address reconciliation agent. The user supplied a free-text shipping ' +
    'address. A geocoder returned a partial structured result with missing or possibly mismatched ' +
    'fields. Your job is to reconstruct the address fields the geocoder dropped or got wrong, using ' +
    'ONLY the user-entered address, the partial geocode, and your knowledge of South African ' +
    'localities and postal codes. Never invent a postal code if you are not sure. If the entered ' +
    'address is too ambiguous to recover a field, leave it blank and lower your confidence. Respond ' +
    'strictly as JSON matching this shape: { "street_address": "", "suburb": "", "city": "", ' +
    '"zone": "", "code": "", "country": "", "confidence": 0.0, "reasoning": "" }. Confidence is 0..1.';

  const concernSys = args.llmConcern
    ? '\n\nA secondary AI evaluator already flagged the following concerns about this address. ' +
      'Use these to focus your correction — the geocoder may have parsed the wrong locality even ' +
      "if its result looks 'complete'.\n" +
      `Concerns: ${args.llmConcern.reasons.join(' | ')}\n` +
      `Flags: ${args.llmConcern.flags.join(', ')}`
    : '';

  const sys = baseSys + concernSys;

  const user =
    `Entered address: "${args.enteredAddress}"\n` +
    `Partial geocode result: ${JSON.stringify({
      street_address: args.partial.street_address,
      suburb: args.partial.suburb,
      city: args.partial.city,
      zone: args.partial.zone,
      code: args.partial.code,
      country: args.partial.country,
      lat: args.partial.lat,
      lng: args.partial.lng,
    })}\n` +
    (args.missing.length
      ? `Missing fields the geocoder dropped: ${args.missing.join(', ')}\n`
      : `No fields are blank, but the LLM evaluator flagged inconsistencies — recheck every field for accuracy.\n`) +
    `Reconstruct the address fields. Country is South Africa unless the entered address says otherwise.`;

  const { data } = await chatCompletionValidated({
    schema: aiSuggestionSchema,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    max_tokens: 400,
    agent: 'address_reconciler',
    tenantId: args.tenantId,
    context: { module: 'address_reconciler' },
  });

  const suggestion: Partial<DeliveryAddress> = {};
  if (data.street_address) suggestion.street_address = data.street_address;
  if (data.suburb)         suggestion.suburb = data.suburb;
  if (data.city)           suggestion.city = data.city;
  if (data.zone)           suggestion.zone = data.zone;
  if (data.code)           suggestion.code = data.code;
  if (data.country)        suggestion.country = data.country;

  return { suggestion, reasoning: data.reasoning || '', confidence: data.confidence };
}

function geocodeOnce(address: string, apiKey: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const path = `/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
    const req = https.request(
      { hostname: 'maps.googleapis.com', path, method: 'GET', timeout: 10000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
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
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Geocoding request timed out')); });
    req.end();
  });
}

async function recordStageResult(db: any, jobId: string, status: string, output: ReconciliationResult): Promise<void> {
  await db('pipeline_stage_results').insert({
    pipeline_job_id: jobId,
    stage: PipelineStage.LOCATION_RECONCILED,
    status: status === 'completed' ? PipelineStatus.COMPLETED : PipelineStatus.FAILED,
    input_data: JSON.stringify({}),
    output_data: JSON.stringify(output),
  });
  await db('pipeline_jobs').where({ id: jobId }).update({
    current_stage: PipelineStage.LOCATION_RECONCILED,
    updated_at: new Date(),
  });
}

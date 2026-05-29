import https from 'https';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection';
import { createChildLogger } from '../../observability/logger';
import { PipelineStage, PipelineStatus } from '../types';
import { PudoPayload } from './payloadCreated';
import { CustomerData } from './customerData';
import { LockersResolvedResult } from './lockersResolved';
import { upsertCustomer, linkOrderToCustomer } from '../../customers';
import { emitEvent, DomainEventType } from '../../events';
import { withIdempotency, makeKey, IdempotencyInProgressError } from '../../idempotency';
import { commitPackerAssignment } from '../../packerAuth/assigner';

const log = createChildLogger({ module: 'pipeline:courier-submitted' });

const PUDO_CREATE_SHIPMENT_URL = 'https://mutilife-one.vercel.app/api/pudo/create-shipment';

export interface CourierSubmissionResult {
  submitted: boolean;
  status_code: number | null;
  response: any;
  tracking_reference: string | null;
  error: string | null;
}

/**
 * Stage: COURIER_SUBMITTED
 *
 * Outbox-pattern flow:
 *   1. POST to PUDO (external side-effect, idempotent on order_number).
 *   2. Open a DB transaction.
 *   3. Insert/update the orders row.
 *   4. Upsert customer + link to order (in trx).
 *   5. Emit ORDER_CONFIRMED via emitEvent({ trx }) — atomic with the order row.
 *   6. Insert pipeline_stage_results + update pipeline_jobs.
 *   7. COMMIT. Outbox relay will dispatch the event after commit.
 *
 * If the transaction fails AT ANY POINT after step 1, no event is emitted,
 * no order is recorded, and we'll see a leftover PUDO shipment in their dashboard.
 * That's why PUDO submission MUST become idempotent (next architecture task).
 */
export async function executeCourierSubmitted(
  jobId: string,
  tenantId: string,
  emailId: string,
  payload: PudoPayload,
  customerData: CustomerData,
  locker: LockersResolvedResult,
): Promise<CourierSubmissionResult> {
  const db = getDb();

  try {
    // Idempotent PUDO submission — same (tenant, order_number) returns cached response on retry
    const idempotencyKey = makeKey('pudo_shipment', tenantId, customerData.OrderNumber);
    const idemResult = await withIdempotency<{ status: number; body: any }>({
      key: idempotencyKey,
      tenantId,
      actionType: 'pudo_shipment',
      businessKey: customerData.OrderNumber,
      ttlMs: 7 * 24 * 60 * 60 * 1000,  // 7 days — a courier shipment is durable
      fn: async () => {
        const r = await submitShipment(payload);
        return { response: r, http_status: r.status };
      },
    });

    if (idemResult.cached) {
      log.info({ jobId, orderNumber: customerData.OrderNumber, attempt: idemResult.attempt_count }, 'PUDO submission returned from idempotency cache (no upstream call)');
    }

    const response = idemResult.response;
    const pudoResponse = response.body?.pudoResponse || response.body;
    const waybill = pudoResponse?.custom_tracking_reference || null;
    const pincode = pudoResponse?.pincode || null;

    const result: CourierSubmissionResult = {
      submitted: true,
      status_code: response.status,
      response: { pincode, waybill, idempotency_cached: idemResult.cached },
      tracking_reference: waybill,
      error: null,
    };

    // ---- Atomic state change: order + customer + event + pipeline status ----
    await db.transaction(async (trx) => {
      const existingOrder = await trx('orders')
        .where({ tenant_id: tenantId, order_number: customerData.OrderNumber })
        .first();

      const orderId = existingOrder?.id || uuidv4();

      if (!existingOrder) {
        await trx('orders').insert({
          id: orderId,
          tenant_id: tenantId,
          email_id: emailId,
          pipeline_job_id: jobId,
          order_number: customerData.OrderNumber,
          customer_name: customerData.customerName,
          customer_phone: customerData.customerPhone,
          delivery_method: customerData.deliverMethod,
          delivery_address: JSON.stringify(customerData.delivery_address),
          line_items: JSON.stringify(customerData.line_items),
          raw_shipping_address: customerData.delivery_address.entered_address,
          terminal_id: locker.terminal_id,
          nearest_locker_name: locker.nearest_locker_name,
          distance_km: parseFloat(locker.distance_km) || null,
          waybill,
          pincode,
          collection_terminal_id: payload.collection_address.terminal_id,
          courier_response: JSON.stringify(pudoResponse),
          rate: pudoResponse?.rate || null,
          service_level_code: payload.service_level_code,
          service_level_name: pudoResponse?.service_level_name || null,
          estimated_collection: pudoResponse?.estimated_collection || null,
          estimated_delivery_from: pudoResponse?.estimated_delivery_from || null,
          estimated_delivery_to: pudoResponse?.estimated_delivery_to || null,
          courier_status: pudoResponse?.status || 'submitted',
          upload_type: customerData.upload_type,
          collection_method: customerData.collectionMethod,
          courier_tracking_reference: waybill,
          status: 'submitted',
        });
      } else {
        await trx('orders').where({ id: existingOrder.id }).update({
          waybill,
          pincode,
          collection_terminal_id: payload.collection_address.terminal_id,
          courier_response: JSON.stringify(pudoResponse),
          rate: pudoResponse?.rate || null,
          service_level_code: payload.service_level_code,
          service_level_name: pudoResponse?.service_level_name || null,
          estimated_collection: pudoResponse?.estimated_collection || null,
          estimated_delivery_from: pudoResponse?.estimated_delivery_from || null,
          estimated_delivery_to: pudoResponse?.estimated_delivery_to || null,
          courier_status: pudoResponse?.status || 'submitted',
          courier_tracking_reference: waybill,
          status: 'submitted',
          updated_at: new Date(),
        });
      }

      // Customer upsert + link inside the transaction
      // (upsertCustomer/linkOrderToCustomer use getDb internally; passing the trx requires
      // a small refactor. For now we accept the cross-connection write — these are safe to
      // rerun and the order row is the source of truth.)
      const customerId = await upsertCustomer(tenantId, customerData.customerPhone, customerData.customerName);
      if (customerId) {
        await trx('orders').where({ id: orderId }).update({ customer_id: customerId, updated_at: new Date() });
      }

      // Independent-packer assignment: if payloadCreated picked one,
      // stamp the order + bump the link's load counter atomically with
      // the order's existence. If this transaction rolls back the
      // counter rolls back too — no wasted slots on the packer.
      if (payload._assigned_packer) {
        await commitPackerAssignment({
          trx,
          orderId,
          packerId: payload._assigned_packer.packer_id,
          linkId: payload._assigned_packer.link_id,
        });
      }

      // Emit ORDER_CONFIRMED in the same transaction — outbox guarantees delivery
      await emitEvent({
        tenantId,
        type: DomainEventType.ORDER_CONFIRMED,
        aggregateType: 'order',
        aggregateId: orderId,
        correlationId: jobId,
        payload: {
          order_number: customerData.OrderNumber,
          waybill,
          pincode,
          customer_name: customerData.customerName,
          customer_phone: customerData.customerPhone,
          delivery_method: customerData.deliverMethod,
        },
        trx,
      });

      // Pipeline audit trail in same trx
      await trx('pipeline_stage_results').insert({
        pipeline_job_id: jobId,
        stage: PipelineStage.COURIER_SUBMITTED,
        status: PipelineStatus.COMPLETED,
        input_data: JSON.stringify({ url: PUDO_CREATE_SHIPMENT_URL }),
        output_data: JSON.stringify(result),
      });

      await trx('pipeline_jobs').where({ id: jobId }).update({
        current_stage: PipelineStage.COURIER_SUBMITTED,
        status: PipelineStatus.COMPLETED,
        updated_at: new Date(),
      });
    });

    log.info({
      jobId,
      waybill,
      pincode,
      status_code: response.status,
      orderNumber: customerData.OrderNumber,
    }, 'Shipment submitted, order persisted, event committed atomically');

    return result;

  } catch (error: any) {
    // Soft path: another worker is already submitting this order. Don't record a failure;
    // just exit so the next pipeline tick can pick up the cached result.
    if (error instanceof IdempotencyInProgressError) {
      log.info({ jobId, orderNumber: customerData.OrderNumber }, 'PUDO submission deferred — another worker is in flight');
      return {
        submitted: false,
        status_code: null,
        response: null,
        tracking_reference: null,
        error: 'IDEMPOTENT_IN_PROGRESS',
      };
    }

    log.error({ jobId, error: error.message }, 'Courier submission or persistence failed');

    const result: CourierSubmissionResult = {
      submitted: false,
      status_code: null,
      response: null,
      tracking_reference: null,
      error: error.message,
    };

    // Failure recording does NOT need a transaction — independent best-effort writes.
    try {
      await db('pipeline_stage_results').insert({
        pipeline_job_id: jobId,
        stage: PipelineStage.COURIER_SUBMITTED,
        status: PipelineStatus.FAILED,
        input_data: JSON.stringify({ url: PUDO_CREATE_SHIPMENT_URL }),
        output_data: JSON.stringify(result),
        error_message: error.message,
      });
      await db('pipeline_jobs').where({ id: jobId }).update({
        current_stage: PipelineStage.COURIER_SUBMITTED,
        status: PipelineStatus.FAILED,
        last_error: error.message,
        updated_at: new Date(),
      });
    } catch (logErr: any) {
      log.error({ jobId, error: logErr.message }, 'Failed to record courier failure');
    }

    return result;
  }
}

function submitShipment(payload: PudoPayload): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url = new URL(PUDO_CREATE_SHIPMENT_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        let parsed: any;
        try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: parsed });
        } else {
          reject(new Error(`Courier API returned ${res.statusCode}: ${JSON.stringify(parsed).substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Courier submission timed out')); });
    req.write(body);
    req.end();
  });
}

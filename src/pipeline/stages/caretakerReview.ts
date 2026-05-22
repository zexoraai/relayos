import { getDb } from '../../db/connection';
import { createChildLogger } from '../../observability/logger';
import { PipelineStage, PipelineStatus } from '../types';
import { CustomerData } from './customerData';
import { LockersResolvedResult } from './lockersResolved';
import { PudoPayload } from './payloadCreated';
import { evaluate, CaretakerEvaluation } from '../../caretaker';
import { emitEvent, DomainEventType } from '../../events';

const log = createChildLogger({ module: 'pipeline:caretaker-review' });

/**
 * Stage: CARETAKER_REVIEW
 *
 * Outbox-pattern flow:
 *   1. Run rule + LLM evaluation (no DB writes from us — evaluator handles its own row).
 *   2. Open a transaction.
 *   3. Insert pipeline_stage_results.
 *   4. If verdict !== 'approve', emit ORDER_FLAGGED in the same transaction.
 *   5. COMMIT.
 */
export async function executeCaretakerReview(
  jobId: string,
  tenantId: string,
  customerData: CustomerData,
  locker: LockersResolvedResult,
  payload: PudoPayload,
): Promise<CaretakerEvaluation> {
  const db = getDb();

  const evalResult = await evaluate({
    tenantId,
    pipelineJobId: jobId,
    customerData,
    locker,
    payload,
  });

  await db.transaction(async (trx) => {
    await trx('pipeline_stage_results').insert({
      pipeline_job_id: jobId,
      stage: 'CARETAKER_REVIEW',
      status: evalResult.verdict === 'reject' ? PipelineStatus.FAILED : PipelineStatus.COMPLETED,
      input_data: JSON.stringify({
        orderNumber: customerData.OrderNumber,
        delivery_method: customerData.deliverMethod,
      }),
      output_data: JSON.stringify({
        verdict: evalResult.verdict,
        mode: evalResult.mode,
        flags: evalResult.flags,
        summary: evalResult.summary,
      }),
      error_message: evalResult.verdict === 'reject' ? evalResult.summary : null,
    });

    if (evalResult.verdict !== 'approve') {
      await emitEvent({
        tenantId,
        type: DomainEventType.ORDER_FLAGGED,
        aggregateType: 'pipeline_job',
        aggregateId: jobId,
        correlationId: jobId,
        payload: {
          order_number: customerData.OrderNumber,
          customer_name: customerData.customerName,
          customer_phone: customerData.customerPhone,
          verdict: evalResult.verdict,
          flags: evalResult.flags,
          summary: evalResult.summary,
          evaluation_id: evalResult.id,
        },
        trx,
      });
    }
  });

  log.info({
    jobId,
    verdict: evalResult.verdict,
    mode: evalResult.mode,
    flags: evalResult.flags.length,
    orderNumber: customerData.OrderNumber,
  }, 'Caretaker review committed');

  return evalResult;
}

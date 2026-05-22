import { getDb } from '../../db/connection';
import { createChildLogger } from '../../observability/logger';
import { ExtractedOrderData, ValidationResult, PipelineStage, PipelineStatus } from '../types';

const log = createChildLogger({ module: 'pipeline:data-validated' });

const VALID_DELIVERY_METHODS = [
  'locker-to-locker',
  'locker-to-door',
  'door-to-locker',
  'door-to-door',
];

/**
 * Stage: DATA_VALIDATED
 * Validates the extracted order data to ensure all required fields are present
 * and correctly formatted before proceeding.
 */
export async function executeDataValidated(
  jobId: string,
  extracted: ExtractedOrderData
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required: order_number
  if (!extracted.order_number || extracted.order_number.trim() === '') {
    errors.push('Order number is missing');
  } else if (!/^\d+$/.test(extracted.order_number.trim())) {
    warnings.push(`Order number "${extracted.order_number}" contains non-numeric characters`);
  }

  // Required: shipping_address
  if (!extracted.shipping_address || extracted.shipping_address.trim() === '') {
    errors.push('Shipping address is missing');
  } else if (extracted.shipping_address.length < 10) {
    warnings.push('Shipping address seems too short');
  }

  // Required: delivery_method
  if (!extracted.delivery_method || extracted.delivery_method.trim() === '') {
    errors.push('Delivery method is missing');
  } else if (!VALID_DELIVERY_METHODS.includes(extracted.delivery_method)) {
    errors.push(`Invalid delivery method: "${extracted.delivery_method}". Must be one of: ${VALID_DELIVERY_METHODS.join(', ')}`);
  }

  // Required: phone_number
  if (!extracted.phone_number || extracted.phone_number.trim() === '') {
    errors.push('Phone number is missing');
  } else {
    const cleaned = extracted.phone_number.replace(/[\s\-\(\)]/g, '');
    if (!/^(\+?\d{10,15})$/.test(cleaned)) {
      warnings.push(`Phone number "${extracted.phone_number}" may be invalid`);
    }
  }

  // Optional but useful: customer_name
  if (!extracted.customer_name || extracted.customer_name.trim() === '') {
    warnings.push('Customer name is missing');
  }

  const result: ValidationResult = {
    valid: errors.length === 0,
    errors,
    warnings,
  };

  // Store result (compact - only show what's relevant)
  const db = getDb();
  const status = result.valid ? PipelineStatus.COMPLETED : PipelineStatus.FAILED;
  const compactOutput: Record<string, any> = { valid: result.valid };
  if (errors.length > 0) compactOutput.errors = errors;
  if (warnings.length > 0) compactOutput.warnings = warnings;

  await db('pipeline_stage_results').insert({
    pipeline_job_id: jobId,
    stage: PipelineStage.DATA_VALIDATED,
    status,
    input_data: JSON.stringify({ order_number: extracted.order_number }),
    output_data: JSON.stringify(compactOutput),
  });

  await db('pipeline_jobs').where({ id: jobId }).update({
    current_stage: PipelineStage.DATA_VALIDATED,
    status: result.valid ? PipelineStatus.PROCESSING : PipelineStatus.FAILED,
    last_error: result.valid ? null : errors.join('; '),
    updated_at: new Date(),
  });

  if (result.valid) {
    log.info({ jobId, orderNumber: extracted.order_number, warnings }, 'Data validation passed');
  } else {
    log.warn({ jobId, errors, warnings }, 'Data validation failed');
  }

  return result;
}

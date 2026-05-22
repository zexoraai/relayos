import https from 'https';
import { getDb } from '../../db/connection';
import { createChildLogger } from '../../observability/logger';
import { NormalizedEmail, ExtractedOrderData, PipelineStage, PipelineStatus } from '../types';
import { chatCompletionValidated } from '../../ai/validatedCompletion';
import { extractedOrderDataSchema } from '../../schemas/pipeline';
import { getCurrentPrompt, getCurrentVersion } from '../../ai/promptRegistry';
import { getActiveCorrections, buildCorrectionMessages } from '../../ai/runRecorder';

const log = createChildLogger({ module: 'pipeline:data-extracted' });

const DELIVERY_METHOD_MAP: Record<string, string> = {
  'locker-to-locker': 'locker-to-locker',
  'locker to locker': 'locker-to-locker',
  'l2l': 'locker-to-locker',
  'locker-to-door': 'locker-to-door',
  'locker to door': 'locker-to-door',
  'l2d': 'locker-to-door',
  'door-to-locker': 'door-to-locker',
  'door to locker': 'door-to-locker',
  'd2l': 'door-to-locker',
  'door-to-door': 'door-to-door',
  'door to door': 'door-to-door',
  'd2d': 'door-to-door',
  'the courier guy locker-to-locker': 'locker-to-locker',
  'the courier guy locker-to-door': 'locker-to-door',
  'the courier guy door-to-locker': 'door-to-locker',
  'the courier guy door-to-door': 'door-to-door',
};

function normalizeDeliveryMethod(raw: string): string {
  const lower = raw.toLowerCase().trim();
  return DELIVERY_METHOD_MAP[lower] || lower;
}

/**
 * Stage: DATA_EXTRACTED
 * Uses OpenAI to extract structured order data from the normalized email.
 */
export async function executeDataExtracted(
  jobId: string,
  normalizedEmail: NormalizedEmail
): Promise<ExtractedOrderData> {
  const db = getDb();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required for data extraction');
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  // Use plain text if available, fall back to HTML
  const emailContent = normalizedEmail.text_plain || normalizedEmail.text_html;

  // Load prompt from the versioned registry (prompts/data-extraction/v{n}.md)
  const systemPrompt = getCurrentPrompt('data-extraction');
  const promptVersion = getCurrentVersion('data-extraction');

  // Load active corrections (few-shot examples from past human feedback)
  const corrections = await getActiveCorrections('data-extraction', null, 5);
  const correctionMessages = buildCorrectionMessages(corrections);

  const userPrompt = `Extract order data from this email. Apply ALL extraction rules carefully, especially the locker vs. door delivery reasoning.

Subject: ${normalizedEmail.subject}
From: ${normalizedEmail.from}
Date: ${normalizedEmail.date}

Email content:
${emailContent.substring(0, 6000)}`;

  // Call OpenAI through the validated wrapper. On schema failure, it retries once
  // with a feedback message describing exactly what was wrong.
  const { data: extracted, attempts, raw: rawResponse } = await chatCompletionValidated({
    schema: extractedOrderDataSchema,
    temperature: 0.1,
    max_tokens: 800,
    messages: [
      { role: 'system', content: systemPrompt },
      ...correctionMessages,
      { role: 'user', content: userPrompt },
    ],
    context: { jobId },
    agent: 'data-extraction',
    promptVersion,
  });

  if (attempts > 1) {
    log.warn({ jobId, attempts }, 'Data extraction needed schema-correction retry');
  }

  const result: ExtractedOrderData = {
    order_number: extracted.OrderNumber,
    shipping_address: extracted.shippingAddress || '',
    delivery_method: normalizeDeliveryMethod(extracted.deliverMethod || ''),
    phone_number: extracted.phone_number || '',
    customer_name: extracted.customer_name || '',
    collection_method: extracted.collectionMethod || null,
    upload_type: extracted.upload_type || 'automatic',
    raw_extraction: extracted as any,
  };

  // Store result (without the redundant raw_extraction)
  const { raw_extraction, ...cleanResult } = result;
  await db('pipeline_stage_results').insert({
    pipeline_job_id: jobId,
    stage: PipelineStage.DATA_EXTRACTED,
    status: PipelineStatus.COMPLETED,
    input_data: JSON.stringify({ subject: normalizedEmail.subject, content_length: emailContent.length }),
    output_data: JSON.stringify(cleanResult),
  });

  await db('pipeline_jobs').where({ id: jobId }).update({
    current_stage: PipelineStage.DATA_EXTRACTED,
    updated_at: new Date(),
  });

  log.info({ jobId, orderNumber: result.order_number, deliveryMethod: result.delivery_method, uploadType: result.upload_type, promptVersion }, 'Data extracted via AI');

  return result;
}

function callOpenAI(apiKey: string, model: string, systemPrompt: string, userPrompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 800,
      response_format: { type: 'json_object' },
    });

    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`OpenAI API returned ${res.statusCode}: ${data.substring(0, 200)}`));
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content;
          if (!content) {
            return reject(new Error('OpenAI returned empty content'));
          }
          resolve(content);
        } catch (e: any) {
          reject(new Error(`Failed to parse OpenAI response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenAI request timed out')); });
    req.write(payload);
    req.end();
  });
}

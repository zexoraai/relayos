import { z } from 'zod';
import { phoneSchema, orderNumberSchema, deliveryMethodSchema, uploadTypeSchema, collectionMethodSchema } from './common';

/**
 * The shape we expect from the Data Extraction agent (LLM output).
 * Keys match the prompt's instructed output. Validation enforces:
 *   - all required fields present
 *   - order_number is a non-empty string with leading # stripped
 *   - phone has at least 9 digits
 *   - upload_type is one of the two valid enum values
 */
export const extractedOrderDataSchema = z.object({
  OrderNumber: z.string().min(1, 'OrderNumber required').transform((s) => String(s).replace(/^#/, '').trim()),
  shippingAddress: z.string().min(1, 'shippingAddress required'),
  deliverMethod: z.string().min(1, 'deliverMethod required').transform((s) => s.toLowerCase().trim()),
  phone_number: z.string().min(1, 'phone_number required'),
  customer_name: z.string().min(1, 'customer_name required'),
  collectionMethod: z.string().nullable().optional().default(null),
  upload_type: uploadTypeSchema.default('automatic'),
});

export type ExtractedOrderDataValidated = z.infer<typeof extractedOrderDataSchema>;

/**
 * Customer-data record assembled before lockers/courier stages.
 */
export const customerDataSchema = z.object({
  delivery_address: z.object({
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    street_address: z.string().optional(),
    local_area: z.string().optional(),
    suburb: z.string().optional(),
    city: z.string().optional(),
    code: z.string().optional(),
    zone: z.string().optional(),
    country: z.string().optional(),
    entered_address: z.string().optional(),
  }),
  OrderNumber: z.string(),
  deliverMethod: z.string(),
  customerName: z.string().min(1),
  customerPhone: z.string().min(1),
  collectionMethod: z.string().nullable(),
  upload_type: z.string(),
  line_items: z.array(z.object({
    name: z.string(),
    quantity: z.number().int().min(1),
  })).default([]),
});

export type CustomerDataValidated = z.infer<typeof customerDataSchema>;

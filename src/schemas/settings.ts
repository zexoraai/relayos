import { z } from 'zod';
import { phoneSchema, emailSchema } from './common';

export const shopifyApiBodySchema = z.object({
  shopify_store: z.string().min(1, 'Store URL required').max(256),
  shopify_access_token: z.string().min(10, 'Access token looks too short'),
});

export const collectionContactBodySchema = z.object({
  contact_name: z.string().min(1, 'Contact name required').max(256),
  contact_email: emailSchema,
  contact_phone: phoneSchema,
  special_instructions: z.string().max(1024).optional(),
  collection_terminal_id: z.string().max(50).optional().nullable(),
  // Door collection methods (door-to-locker, door-to-door) require a full
  // street address on the collection side. Same shape as PUDO's delivery
  // address. Only validated when present — locker collection still works
  // with just `collection_terminal_id`.
  collection_address: z.object({
    lat: z.number().nullable().optional(),
    lng: z.number().nullable().optional(),
    street_address: z.string().min(1).max(256),
    local_area: z.string().max(128).optional(),
    suburb: z.string().max(128).optional(),
    city: z.string().min(1).max(128),
    code: z.string().min(4).max(10),
    zone: z.string().min(1).max(64),
    country: z.string().min(2).max(64).optional(),
    type: z.enum(['residential', 'business']).optional(),
  }).optional().nullable(),
});

export const whatsappSettingsBodySchema = z.object({
  phone_number_id: z.string().min(1),
  access_token: z.string().min(10).optional(),
  business_account_id: z.string().optional().nullable(),
  display_phone_number: z.string().optional().nullable(),
  verify_token: z.string().optional().nullable(),
});

export const caretakerRulesBodySchema = z.object({
  enabled: z.boolean().optional(),
  llm_enabled: z.boolean().optional(),
  mode: z.enum(['shadow', 'advisory', 'strict']).optional(),
  max_rate_per_order: z.number().nullable().optional(),
  max_distance_km: z.number().int().nullable().optional(),
  require_phone: z.boolean().optional(),
  require_customer_name: z.boolean().optional(),
  require_line_items: z.boolean().optional(),
  block_duplicate_order_number: z.boolean().optional(),
  block_repeat_phone_within_minutes: z.boolean().optional(),
  repeat_phone_window_minutes: z.number().int().min(1).max(1440).optional(),
});

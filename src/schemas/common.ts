import { z } from 'zod';

/**
 * Reusable primitives shared across schemas.
 * Keep this module small and composable — these are the building blocks.
 */

export const uuidSchema = z.string().uuid('Must be a valid UUID');

export const emailSchema = z.string().email('Invalid email').max(256);

export const passwordSchema = z.string().min(8, 'At least 8 characters').max(128);

/**
 * Phone in any shape we accept (will be normalized to +27XXXXXXXXX downstream).
 * Allow digits, spaces, +, -, parens; require at least 9 digits total.
 */
export const phoneSchema = z.string().refine(
  (s) => s.replace(/\D/g, '').length >= 9,
  { message: 'Phone must contain at least 9 digits' },
);

export const orderNumberSchema = z.string().min(1).max(64).transform((s) => s.replace(/^#/, '').trim());

export const deliveryMethodSchema = z.enum([
  'locker-to-locker',
  'locker-to-door',
  'door-to-locker',
  'door-to-door',
]);

export const uploadTypeSchema = z.enum(['automatic', 'manual']);

export const collectionMethodSchema = z.enum(['collection']).nullable();

/**
 * A coordinate pair. Always nullable because not every address geocodes successfully.
 */
export const coordinatesSchema = z.object({
  lat: z.number().nullable(),
  lng: z.number().nullable(),
});

/**
 * Pagination + ordering query params used by every list route.
 */
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().optional(),
});

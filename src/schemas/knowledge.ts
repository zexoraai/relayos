import { z } from 'zod';

const httpUrlSchema = z.string().url().refine((s) => /^https?:\/\//i.test(s), 'Must be an http(s) URL');

export const ingestUrlBodySchema = z.object({
  url: httpUrlSchema,
  label: z.string().max(256).optional(),
  category: z.string().max(50).optional().nullable(),
});

export const ingestSitemapBodySchema = z.object({
  sitemap_url: httpUrlSchema,
  label: z.string().max(256).optional(),
  max_pages: z.coerce.number().int().min(1).max(500).default(50),
  path_prefix: z.string().optional().nullable(),
});

export const knowledgeDocBodySchema = z.object({
  title: z.string().min(1).max(256),
  category: z.string().max(50).optional().nullable(),
  body: z.string().min(1),
  enabled: z.boolean().default(true).optional(),
});

export const knowledgeDocPatchSchema = z.object({
  title: z.string().min(1).max(256).optional(),
  category: z.string().max(50).nullable().optional(),
  body: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

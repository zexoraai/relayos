import { z } from 'zod';
import { emailSchema, passwordSchema } from './common';

export const registerBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  confirm_password: z.string(),
}).refine((d) => d.password === d.confirm_password, {
  message: 'Passwords do not match',
  path: ['confirm_password'],
});

export const loginBodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password required'),
});

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;

import { Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { AuthenticatedRequest } from './middleware';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'api-validate' });

/**
 * Express middleware factory: validate `req.body` (or `req.query`) against a Zod schema.
 * On success, replaces the field with the parsed/coerced version (so handlers see clean data).
 * On failure, responds 400 with structured field errors.
 *
 * Usage:
 *   router.post('/x', validateBody(mySchema), (req, res) => { ... })
 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return respondWithZodError(res, result.error, 'body');
    req.body = result.data;
    next();
  };
}

export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) return respondWithZodError(res, result.error, 'query');
    // We can't reassign req.query (express types are read-only), so attach to res.locals
    (res.locals as any).query = result.data;
    next();
  };
}

function respondWithZodError(res: Response, error: ZodError, location: string) {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_root';
    if (!fieldErrors[path]) fieldErrors[path] = [];
    fieldErrors[path].push(issue.message);
  }
  log.debug({ location, fieldErrors }, 'Validation failed');
  res.status(400).json({
    success: false,
    error: {
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed',
      location,
      fields: fieldErrors,
    },
  });
}

import { Router, Request, Response } from 'express';
import { registerTenant, loginTenant, getTenantById, AuthError } from '../auth';
import { AuthenticatedRequest, authMiddleware } from './middleware';
import { validateBody } from './validate';
import { registerBodySchema, loginBodySchema } from '../schemas/auth';

const router = Router();

// POST /auth/register
router.post('/register', validateBody(registerBodySchema), async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const tenant = await registerTenant(email, password);
    return res.status(201).json({ success: true, data: { tenant } });
  } catch (error: any) {
    if (error instanceof AuthError) {
      return res.status(409).json({ success: false, error: { code: error.code, message: error.message } });
    }
    throw error;
  }
});

// POST /auth/login
router.post('/login', validateBody(loginBodySchema), async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'email and password are required' },
      });
    }

    const result = await loginTenant(email, password);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    if (error instanceof AuthError) {
      return res.status(401).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
    }
    throw error;
  }
});

// POST /auth/logout
router.post('/logout', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  // Stateless JWT — logout is client-side (discard token)
  return res.status(200).json({ success: true, data: { message: 'Logged out' } });
});

// GET /auth/me
router.get('/me', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const tenant = await getTenantById(req.tenant!.tenantId);
  if (!tenant) {
    return res.status(404).json({
      success: false,
      error: { code: 'TENANT_NOT_FOUND', message: 'Tenant not found' },
    });
  }
  return res.status(200).json({
    success: true,
    data: {
      tenant,
      user: {
        id: req.tenant!.userId,
        email: req.tenant!.email,
        permissions: req.tenant!.permissions || ['*'],
      },
    },
  });
});

export default router;

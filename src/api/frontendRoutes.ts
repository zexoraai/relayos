import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';

const router = Router();

/**
 * Frontend routing strategy:
 *   - /legacy.html → old vanilla JS dashboard (kept for fallback)
 *   - All other non-API GET requests → new Vite/Preact SPA at public/dist/index.html
 *   - The SPA handles client-side routing via wouter
 */

const distIndex = path.join(__dirname, '../../public/dist/index.html');
const legacyIndex = path.join(__dirname, '../../public/legacy.html');

// Legacy fallback
router.get('/legacy.html', (_req: Request, res: Response) => {
  res.sendFile(legacyIndex);
});

// SPA catch-all: any route that doesn't match an API or static file → serve the SPA shell
router.get('/{*path}', (req: Request, res: Response) => {
  // Don't intercept API-like paths or static assets
  if (req.path.startsWith('/auth') || req.path.startsWith('/api') || req.path.includes('.')) {
    return res.status(404).end();
  }
  // Serve the legacy dashboard at root for now (new SPA available at /new/)
  res.sendFile(legacyIndex);
});

export default router;

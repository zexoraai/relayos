import { Router, Request, Response } from 'express';

const router = Router();

// GET /reference/ecommerce-platforms
router.get('/ecommerce-platforms', (_req: Request, res: Response) => {
  return res.status(200).json({
    success: true,
    data: {
      platforms: [
        { id: 'shopify', name: 'Shopify', status: 'active' },
        { id: 'woocommerce', name: 'WooCommerce', status: 'coming_soon' },
      ],
    },
  });
});

// GET /reference/shopify-plans
router.get('/shopify-plans', (_req: Request, res: Response) => {
  return res.status(200).json({
    success: true,
    data: {
      plans: [
        { id: 'basic', name: 'Basic', integration_method: 'imap', status: 'active' },
        { id: 'grow', name: 'Grow', integration_method: 'api', status: 'active' },
        { id: 'advanced', name: 'Advanced', integration_method: 'api', status: 'active' },
        { id: 'plus', name: 'Plus', integration_method: 'api', status: 'active' },
      ],
    },
  });
});

// GET /reference/couriers
router.get('/couriers', (_req: Request, res: Response) => {
  return res.status(200).json({
    success: true,
    data: {
      couriers: [
        { id: 'pudo', name: 'PUDO', status: 'active' },
        { id: 'the_courier_guy', name: 'The Courier Guy', status: 'coming_soon' },
        { id: 'dhl', name: 'DHL', status: 'coming_soon' },
        { id: 'aramex', name: 'Aramex', status: 'coming_soon' },
      ],
    },
  });
});

export default router;

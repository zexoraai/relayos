# Email Ingestion Service

A production-ready email ingestion service that connects to IMAP mailboxes and processes bulk incoming emails with deduplication, retries, error handling, and observability.

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌────────────────────┐
│  IMAP Mailbox   │────▶│  Ingestion   │────▶│   Redis Queue      │
│  (IMAPS)        │     │  Worker      │     │   (BullMQ)         │
└─────────────────┘     └──────────────┘     └────────┬───────────┘
                              │                        │
                              ▼                        ▼
                        ┌──────────────┐     ┌────────────────────┐
                        │  PostgreSQL  │◀────│  Processing        │
                        │  Database    │     │  Worker            │
                        └──────────────┘     └────────┬───────────┘
                                                      │
                                                      ▼
                                             ┌────────────────────┐
                                             │  Attachment        │
                                             │  Storage           │
                                             └────────────────────┘
```

### Flow

1. **Ingestion Worker** polls IMAP mailbox by UID in configurable batches
2. Emails are parsed for metadata and checked for duplicates
3. New emails are inserted into the database with `fetched` status
4. Jobs are enqueued to Redis (BullMQ) for async processing
5. **Processing Worker** picks up jobs, performs full parsing, stores attachments
6. Failed jobs are retried with exponential backoff
7. Permanently failed jobs are moved to a dead-letter table

## Features

- **UID-based fetching** — no emails lost on restart
- **Deduplication** — Message-ID + content hash + DB unique constraint
- **Batch processing** — configurable batch size with backpressure
- **Parallel workers** — concurrent processing with idempotency
- **Attachment handling** — size limits, MIME filtering, virus scan hook, checksums
- **Retry with exponential backoff** — configurable max retries
- **Dead-letter queue** — permanently failed emails preserved for investigation
- **Graceful shutdown** — finish current batch, close connections cleanly
- **Observability** — structured logging (pino), Prometheus metrics, correlation IDs
- **Security** — filename sanitization, path traversal prevention, credential redaction

## Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Redis 6+

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy environment file:
   ```bash
   cp .env.example .env
   ```

4. Configure your `.env` with IMAP credentials, database, and Redis settings.

5. Run database migrations:
   ```bash
   npm run migrate
   ```

6. Start the service:
   ```bash
   npm run build
   npm start
   ```

   Or for development:
   ```bash
   npm run dev
   ```

## Configuration

All settings are configured via environment variables. See `.env.example` for the full list.

| Variable | Description | Default |
|----------|-------------|---------|
| `IMAP_HOST` | IMAP server hostname | (required) |
| `IMAP_PORT` | IMAP server port | `993` |
| `IMAP_USERNAME` | IMAP username | (required) |
| `IMAP_PASSWORD` | IMAP password/app password | (required) |
| `IMAP_MAILBOX` | Mailbox folder to poll | `INBOX` |
| `IMAP_POLLING_INTERVAL_MS` | Polling interval in ms | `30000` |
| `BATCH_SIZE` | Emails per batch | `50` |
| `MAX_RETRY_COUNT` | Max retry attempts | `5` |
| `RETRY_BACKOFF_BASE_MS` | Base backoff delay | `1000` |
| `RETRY_BACKOFF_MAX_MS` | Max backoff delay | `60000` |
| `MAX_ATTACHMENT_SIZE_BYTES` | Max attachment size | `26214400` (25MB) |
| `ALLOWED_MIME_TYPES` | Comma-separated MIME types | See `.env.example` |
| `MARK_AS_READ_ON` | When to mark as read: `queued`, `processed`, `never` | `processed` |
| `DELETE_FROM_MAILBOX` | Delete emails after processing | `false` |

## Database Schema

- **mailboxes** — IMAP mailbox configurations
- **email_ingestion_offsets** — UID tracking per mailbox
- **ingested_emails** — Core email records with dedup keys and status
- **email_attachments** — Attachment metadata and storage references
- **processing_errors** — Error log per processing attempt
- **dead_letter_jobs** — Permanently failed jobs

## Email Processing States

```
fetched → queued → processing → processed
                             ↘ failed → (retry) → dead_lettered
                  ↘ duplicate
```

## Observability

### Metrics (Prometheus)

Available at `http://localhost:9090/metrics`:

- `email_ingestion_fetched_total` — Emails fetched from IMAP
- `email_ingestion_queued_total` — Emails enqueued
- `email_ingestion_processed_total` — Emails successfully processed
- `email_ingestion_failed_total` — Processing failures
- `email_ingestion_duplicates_total` — Duplicates detected
- `email_ingestion_dead_lettered_total` — Dead-lettered emails
- `email_ingestion_imap_connection_failures_total` — IMAP connection failures
- `email_ingestion_retry_attempts_total` — Retry attempts
- `email_ingestion_processing_duration_seconds` — Processing latency histogram

### Health Check

`GET http://localhost:9090/health`

### Structured Logging

JSON-formatted logs with correlation IDs via pino. Sensitive fields (passwords) are automatically redacted.

## Testing

```bash
npm test
```

Tests cover:
- Email parsing (headers, body, attachments)
- Deduplication key generation
- Security (filename sanitization, path traversal)
- Error types and retry logic
- Configuration loading
- Integration scenarios (duplicate detection, restart safety)

## Project Structure

```
src/
├── config/           # Environment-based configuration
├── db/
│   ├── migrations/   # PostgreSQL schema migrations
│   └── connection.ts # Database connection pool
├── dedup/            # Deduplication logic
├── errors/           # Structured error types
├── imap/             # IMAP client with reconnect logic
├── observability/    # Logging, metrics, metrics server
├── parser/           # Email parsing and normalization
├── queue/            # BullMQ producer/consumer setup
├── security/         # Filename sanitization, virus scan hook
├── storage/          # Attachment storage abstraction
├── workers/
│   ├── ingestionWorker.ts   # IMAP polling and enqueue
│   └── processingWorker.ts  # Full processing pipeline
└── index.ts          # Entry point with graceful shutdown
```

## Production Considerations

- Use app-specific passwords for IMAP (not account passwords)
- Configure proper Redis persistence for queue durability
- Set up PostgreSQL connection pooling (PgBouncer) for high concurrency
- Integrate a real virus scanner (ClamAV) via the `scanForVirus` hook
- Monitor dead-letter table and set up alerts
- Use a process manager (PM2, systemd) for automatic restarts
- Consider S3/GCS for attachment storage in production (swap the storage module)

## Multi-Tenant Auth & Onboarding

### Overview

The platform supports multi-tenant onboarding for an Order Fulfillment system. Tenants register, configure their ecommerce integration (Shopify), and courier (PUDO), then become active.

### Onboarding Flow

```
Register → Select Platform → Configure Integration → Select Courier → Configure Courier → Complete
```

### Auth Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/register` | Register with email + password |
| POST | `/auth/login` | Login, returns JWT token |
| POST | `/auth/logout` | Logout (discard token) |
| GET | `/auth/me` | Get authenticated tenant profile |

### Onboarding Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/onboarding/status` | Full onboarding status |
| POST | `/onboarding/ecommerce-platform` | Select shopify or woocommerce |
| POST | `/onboarding/shopify-plan` | Select basic/grow/advanced/plus |
| POST | `/onboarding/shopify-basic/imap-settings` | Configure IMAP for Shopify Basic |
| POST | `/onboarding/shopify-api/settings` | Configure API for Shopify Grow+ |
| POST | `/onboarding/courier` | Select courier (pudo active) |
| POST | `/onboarding/courier/pudo-settings` | Configure PUDO credentials |
| POST | `/onboarding/complete` | Complete onboarding |

### Reference Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/reference/ecommerce-platforms` | List platforms with status |
| GET | `/reference/shopify-plans` | List Shopify plans |
| GET | `/reference/couriers` | List couriers with status |

### Email Ingestion Integration

For Shopify Basic tenants, IMAP settings are stored encrypted and exposed via:

```typescript
import { getActiveImapIngestionConfigs } from './src/tenants';

// Returns only active tenants with configured Shopify Basic IMAP
const configs = await getActiveImapIngestionConfigs();
```

This filters out:
- Incomplete tenants (pending_onboarding)
- Suspended tenants
- WooCommerce tenants
- Shopify API tenants (grow/advanced/plus)
- Unconfigured tenants

### New Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `API_PORT` | HTTP API port | No (default: 3000) |
| `JWT_SECRET` | Secret for signing JWT tokens | Yes |
| `JWT_EXPIRES_IN` | Token expiry (e.g., "24h") | No (default: 24h) |
| `ENCRYPTION_KEY` | Key for encrypting credentials at rest | Yes |

### Security

- Passwords hashed with bcrypt (12 rounds)
- Sensitive credentials (IMAP password, Shopify token, PUDO keys) encrypted with AES-256-GCM at rest
- JWT tokens for stateless auth
- Rate limiting on auth endpoints (20 req/15min)
- Tenant isolation enforced on all onboarding endpoints
- Secrets never logged (pino redaction)

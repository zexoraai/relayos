import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { sanitizeFilename, validateStoragePath } from '../security';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'storage' });

export interface StorageResult {
  storageKey: string;
  fullPath: string;
  sizeBytes: number;
}

/**
 * Store an attachment to the configured storage backend.
 * Currently uses local filesystem; can be swapped to S3/GCS.
 */
export async function storeAttachment(
  emailId: string,
  filename: string | null,
  content: Buffer
): Promise<StorageResult> {
  const sanitizedName = sanitizeFilename(filename);
  const datePrefix = new Date().toISOString().split('T')[0].replace(/-/g, '/');
  const relativePath = path.join(datePrefix, emailId, sanitizedName);

  const fullPath = validateStoragePath(config.attachment.storagePath, relativePath);
  const dir = path.dirname(fullPath);

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(fullPath, content);

  log.debug({ storageKey: relativePath, sizeBytes: content.length }, 'Attachment stored');

  return {
    storageKey: relativePath,
    fullPath,
    sizeBytes: content.length,
  };
}

/**
 * Delete an attachment from storage.
 */
export async function deleteAttachment(storageKey: string): Promise<void> {
  const fullPath = validateStoragePath(config.attachment.storagePath, storageKey);
  try {
    await fs.unlink(fullPath);
    log.debug({ storageKey }, 'Attachment deleted');
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Ensure the storage directory exists.
 */
export async function initStorage(): Promise<void> {
  await fs.mkdir(config.attachment.storagePath, { recursive: true });
  log.info({ path: config.attachment.storagePath }, 'Storage directory initialized');
}

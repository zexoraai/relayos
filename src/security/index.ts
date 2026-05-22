import sanitize from 'sanitize-filename';
import path from 'path';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'security' });

/**
 * Sanitize a filename to prevent path traversal and invalid characters.
 */
export function sanitizeFilename(filename: string | null): string {
  if (!filename) return 'unnamed_attachment';

  // Remove path components
  const basename = path.basename(filename);

  // Get the original extension before sanitization
  const originalExt = path.extname(basename);

  // Sanitize using library (this may truncate to 255 chars)
  const sanitized = sanitize(basename, { replacement: '_' });

  if (!sanitized || sanitized.length === 0) {
    return 'unnamed_attachment';
  }

  // If sanitization truncated and lost the extension, re-add it
  if (originalExt && !sanitized.endsWith(originalExt) && sanitized.length >= 255) {
    const maxNameLen = 255 - originalExt.length;
    return sanitized.substring(0, maxNameLen) + originalExt;
  }

  // If still over 255 (shouldn't happen with sanitize-filename, but safety)
  if (sanitized.length > 255) {
    const ext = path.extname(sanitized) || originalExt;
    const maxNameLen = 255 - ext.length;
    return sanitized.substring(0, maxNameLen) + ext;
  }

  return sanitized;
}

/**
 * Validate that a storage path does not escape the base directory.
 */
export function validateStoragePath(basePath: string, relativePath: string): string {
  const resolved = path.resolve(basePath, relativePath);
  const normalizedBase = path.resolve(basePath);

  if (!resolved.startsWith(normalizedBase)) {
    log.warn({ basePath, relativePath, resolved }, 'Path traversal attempt detected');
    throw new Error('Path traversal detected');
  }

  return resolved;
}

/**
 * Virus scanning hook - stub implementation.
 * Replace with actual virus scanning integration (e.g., ClamAV).
 */
export async function scanForVirus(
  _content: Buffer,
  _filename: string
): Promise<{ clean: boolean; threat?: string }> {
  // Stub: always returns clean
  // In production, integrate with ClamAV or similar:
  // const result = await clamav.scanBuffer(content);
  log.debug('Virus scan stub called - returning clean');
  return { clean: true };
}

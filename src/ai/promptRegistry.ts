import fs from 'fs';
import path from 'path';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'prompt-registry' });

const PROMPTS_DIR = path.join(__dirname, '../../prompts');

/**
 * Prompt Registry
 *
 * Loads versioned prompts from the filesystem at `prompts/{agent}/v{n}.md`.
 * Each agent has a "current" version (highest numbered file).
 *
 * Benefits:
 *   - Prompts are version-controlled in git (diff-friendly)
 *   - Changing a prompt doesn't require a code deploy — just add a new version file
 *   - Every LLM call can record which prompt version it used
 *   - Eval harness can test multiple versions side-by-side
 */

export interface PromptVersion {
  agent: string;
  version: number;
  content: string;
  filePath: string;
}

const cache = new Map<string, PromptVersion[]>();

/**
 * List all versions for an agent, sorted ascending.
 */
export function listVersions(agent: string): PromptVersion[] {
  if (cache.has(agent)) return cache.get(agent)!;

  const dir = path.join(PROMPTS_DIR, agent);
  if (!fs.existsSync(dir)) {
    log.warn({ agent }, 'Prompt directory not found');
    return [];
  }

  const files = fs.readdirSync(dir).filter((f) => /^v\d+\.md$/i.test(f)).sort();
  const versions: PromptVersion[] = files.map((f) => {
    const version = parseInt(f.replace(/^v/i, '').replace(/\.md$/i, ''), 10);
    const filePath = path.join(dir, f);
    const content = fs.readFileSync(filePath, 'utf8').trim();
    return { agent, version, content, filePath };
  });

  cache.set(agent, versions);
  return versions;
}

/**
 * Get the current (latest) prompt for an agent.
 * Optionally specify a version number to pin to a specific version.
 */
export function getPrompt(agent: string, version?: number): PromptVersion {
  const versions = listVersions(agent);
  if (versions.length === 0) {
    throw new Error(`No prompts found for agent: ${agent}`);
  }

  if (version !== undefined) {
    const found = versions.find((v) => v.version === version);
    if (!found) throw new Error(`Prompt version ${version} not found for agent: ${agent}`);
    return found;
  }

  // Return the highest version (current)
  return versions[versions.length - 1];
}

/**
 * Get just the content string for the current prompt.
 * This is the most common usage in agent code.
 */
export function getCurrentPrompt(agent: string): string {
  return getPrompt(agent).content;
}

/**
 * Get the current version number for an agent.
 */
export function getCurrentVersion(agent: string): number {
  return getPrompt(agent).version;
}

/**
 * Clear the cache (useful after adding a new version file at runtime).
 */
export function clearPromptCache(): void {
  cache.clear();
}

/**
 * List all registered agents (directories under prompts/).
 */
export function listAgents(): string[] {
  if (!fs.existsSync(PROMPTS_DIR)) return [];
  return fs.readdirSync(PROMPTS_DIR).filter((f) => {
    return fs.statSync(path.join(PROMPTS_DIR, f)).isDirectory();
  });
}

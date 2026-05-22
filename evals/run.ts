/**
 * Eval harness for AI agents.
 *
 * Usage:
 *   npx ts-node evals/run.ts [agent-name] [--version N]
 *
 * Runs each fixture through the agent's prompt, validates the output against
 * the expected.json, and reports pass/fail per field.
 *
 * Example:
 *   npx ts-node evals/run.ts data-extraction
 *   npx ts-node evals/run.ts data-extraction --version 1
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '../.env') });

import { chatCompletionValidated } from '../src/ai/validatedCompletion';
import { getPrompt, listAgents } from '../src/ai/promptRegistry';
import { extractedOrderDataSchema } from '../src/schemas/pipeline';

const EVALS_DIR = path.join(__dirname);

interface TestCase {
  fixture: string;
  expected: Record<string, any>;
}

interface EvalResult {
  fixture: string;
  passed: boolean;
  fields: Record<string, { expected: any; actual: any; match: boolean }>;
  error?: string;
}

async function runDataExtractionEval(promptVersion?: number): Promise<EvalResult[]> {
  const agent = 'data-extraction';
  const prompt = getPrompt(agent, promptVersion);
  console.log(`\n🧪 Running eval: ${agent} v${prompt.version}\n`);

  const expectedPath = path.join(EVALS_DIR, agent, 'expected.json');
  const testCases: TestCase[] = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const results: EvalResult[] = [];

  for (const tc of testCases) {
    const fixturePath = path.join(EVALS_DIR, agent, 'fixtures', tc.fixture);
    if (!fs.existsSync(fixturePath)) {
      results.push({ fixture: tc.fixture, passed: false, fields: {}, error: 'Fixture file not found' });
      continue;
    }

    const emailContent = fs.readFileSync(fixturePath, 'utf8');
    const userPrompt = `Extract order data from this email. Apply ALL extraction rules carefully.\n\n${emailContent}`;

    try {
      const { data } = await chatCompletionValidated({
        schema: extractedOrderDataSchema,
        messages: [
          { role: 'system', content: prompt.content },
          { role: 'user', content: userPrompt },
        ],
        context: { eval: true, fixture: tc.fixture },
      });

      // Compare fields
      const fields: Record<string, { expected: any; actual: any; match: boolean }> = {};
      let allMatch = true;
      for (const [key, expectedVal] of Object.entries(tc.expected)) {
        const actualVal = (data as any)[key];
        // Flexible matching: case-insensitive for strings, null == undefined
        const match = flexMatch(expectedVal, actualVal);
        fields[key] = { expected: expectedVal, actual: actualVal, match };
        if (!match) allMatch = false;
      }

      results.push({ fixture: tc.fixture, passed: allMatch, fields });
    } catch (err: any) {
      results.push({ fixture: tc.fixture, passed: false, fields: {}, error: err.message });
    }
  }

  return results;
}

function flexMatch(expected: any, actual: any): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  if (typeof expected === 'string' && typeof actual === 'string') {
    // Normalize whitespace and case for comparison
    const e = expected.toLowerCase().replace(/\s+/g, ' ').trim();
    const a = actual.toLowerCase().replace(/\s+/g, ' ').trim();
    return e === a;
  }
  return expected === actual;
}

function printResults(results: EvalResult[]): void {
  let passed = 0;
  let failed = 0;

  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    console.log(`${icon} ${r.fixture}`);
    if (r.error) {
      console.log(`   ERROR: ${r.error}`);
      failed++;
      continue;
    }
    for (const [field, { expected, actual, match }] of Object.entries(r.fields)) {
      if (!match) {
        console.log(`   ❌ ${field}: expected "${expected}" got "${actual}"`);
      }
    }
    if (r.passed) passed++;
    else failed++;
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${results.length} total\n`);
  if (failed > 0) process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const agent = args[0] || 'data-extraction';
  const versionIdx = args.indexOf('--version');
  const version = versionIdx >= 0 ? parseInt(args[versionIdx + 1]) : undefined;

  if (agent === 'data-extraction') {
    const results = await runDataExtractionEval(version);
    printResults(results);
  } else {
    console.log(`Available agents: ${listAgents().join(', ')}`);
    console.log(`Eval fixtures only exist for: data-extraction`);
  }
}

main().catch((err) => {
  console.error('Eval failed:', err.message);
  process.exit(1);
});

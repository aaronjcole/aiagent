/**
 * Temporal worker-wiring test (ARCH-H2). A full `TestWorkflowEnvironment` is too
 * heavy for this suite, so per the audit's minimum bar this asserts the
 * registration wiring the worker depends on:
 *  - the three workflows (+ the human-approved send path) are exported as
 *    functions the worker registers by `workflowsPath`,
 *  - the `workflowActivities` map the worker passes to `Worker.create` contains
 *    exactly the activity names the workflows proxy (no missing/renamed
 *    activity that would fail at first invocation),
 *  - the workflow source is deterministic-safe: it imports no db / provider /
 *    agent / node side-effecting module at workflow scope (only
 *    `@temporalio/workflow` at runtime; everything else is `import type`).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  TASK_QUEUE,
  workflowsPath,
  workflowActivities,
  researchProspectWorkflow,
  outboundSequenceWorkflow,
  inboundEmailWorkflow,
  sendApprovedDraftWorkflow,
} from '@app/workflows';

describe('worker registration wiring', () => {
  it('exports the three workflows (+ human-approved send) as functions', () => {
    expect(typeof researchProspectWorkflow).toBe('function');
    expect(typeof outboundSequenceWorkflow).toBe('function');
    expect(typeof inboundEmailWorkflow).toBe('function');
    expect(typeof sendApprovedDraftWorkflow).toBe('function');
  });

  it('binds to the aiagent task queue and resolves a workflowsPath', () => {
    expect(TASK_QUEUE).toBe('aiagent');
    expect(workflowsPath).toMatch(/workflows\.js$/);
  });

  it('registers every activity the workflows proxy', () => {
    // The names the workflow definitions proxy via proxyActivities<Activities>.
    const proxied = [
      'researchProspectActivity',
      'outboundSequenceActivity',
      'inboundEmailActivity',
      'sendApprovedDraftActivity',
      'recordTerminalFailureActivity',
    ];
    for (const name of proxied) {
      expect(workflowActivities).toHaveProperty(name);
      expect(typeof (workflowActivities as Record<string, unknown>)[name]).toBe('function');
    }
  });
});

describe('workflow determinism safety', () => {
  it('workflow source imports no non-deterministic module at workflow scope', () => {
    // Read the workflow source from the monorepo layout. This test file lives at
    // apps/worker/src/wiring.test.ts; the workflow source is at
    // packages/workflows/src/workflows.ts (../../../packages/... from here).
    const here = fileURLToPath(new URL('.', import.meta.url)); // apps/worker/src/
    const src = readFileSync(
      `${here}../../../packages/workflows/src/workflows.ts`,
      'utf8',
    );

    // Collect runtime (non-type-only) imports.
    const importRe = /^\s*import\s+(?!type\b)([^;]+?)\s+from\s+['"]([^'"]+)['"]/gm;
    const runtimeSpecifiers: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src)) !== null) {
      const clause = m[1] ?? '';
      const specifier = m[2] ?? '';
      // `import type { ... }` is filtered by the negative lookahead above, but an
      // inline `import { type X }` (all-type) still emits no runtime binding —
      // skip clauses whose every named binding is `type`-prefixed.
      const named = clause.match(/\{([^}]*)\}/)?.[1];
      if (named) {
        const bindings = named.split(',').map((s) => s.trim()).filter(Boolean);
        const allType = bindings.length > 0 && bindings.every((b) => b.startsWith('type '));
        if (allType) continue;
      }
      runtimeSpecifiers.push(specifier);
    }

    // The ONLY permitted runtime import in workflow scope is @temporalio/workflow.
    expect(runtimeSpecifiers).toEqual(['@temporalio/workflow']);

    // Guard against direct pulls of side-effecting / non-deterministic modules.
    const forbidden = [
      '@app/db',
      '@app/email',
      '@app/calendar',
      '@app/llm',
      '@app/agents',
      '@prisma/client',
      'node:crypto',
      'node:fs',
    ];
    for (const bad of forbidden) {
      expect(runtimeSpecifiers).not.toContain(bad);
    }
  });
});

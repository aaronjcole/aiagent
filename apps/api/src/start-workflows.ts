/**
 * Thin helpers that START the Temporal workflows from the API, keyed by the
 * deterministic workflow ids from `@app/workflows`. Each returns the
 * `{ workflowId, runId }` so the route can hand the client a handle to poll.
 *
 * These only START the workflow (fire-and-forget from the HTTP request's view);
 * the worker process executes the orchestration. The actual domain logic lives
 * in the workflow/service layer, never here.
 */

import type { Client } from '@temporalio/client';
import {
  TASK_QUEUE,
  inboundEmailWorkflow,
  outboundSequenceWorkflow,
  researchProspectWorkflow,
  workflowIds,
} from '@app/workflows';

export interface StartedWorkflow {
  workflowId: string;
  runId: string;
}

/** Start `researchProspectWorkflow` for a prospect. */
export async function startResearch(client: Client, prospectId: string): Promise<StartedWorkflow> {
  const handle = await client.workflow.start(researchProspectWorkflow, {
    taskQueue: TASK_QUEUE,
    workflowId: workflowIds.research(prospectId),
    args: [{ prospectId }],
  });
  return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
}

/** Start `outboundSequenceWorkflow` for a prospect + sequence. */
export async function startOutbound(
  client: Client,
  prospectId: string,
  sequenceId: string,
): Promise<StartedWorkflow> {
  const handle = await client.workflow.start(outboundSequenceWorkflow, {
    taskQueue: TASK_QUEUE,
    workflowId: workflowIds.outbound(prospectId, sequenceId),
    args: [{ prospectId, sequenceId }],
  });
  return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
}

/** Start `inboundEmailWorkflow` for a (provider) message + thread. */
export async function startInbound(
  client: Client,
  args: { providerMessageId?: string; threadId?: string },
): Promise<StartedWorkflow> {
  const key = args.providerMessageId ?? args.threadId ?? 'unknown';
  const handle = await client.workflow.start(inboundEmailWorkflow, {
    taskQueue: TASK_QUEUE,
    workflowId: workflowIds.inbound(key),
    args: [args],
  });
  return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
}

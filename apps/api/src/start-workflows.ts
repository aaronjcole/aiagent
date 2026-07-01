/**
 * Thin helpers that START the Temporal workflows from the API, keyed by the
 * deterministic workflow ids from `@app/workflows`. Each returns the
 * `{ workflowId, runId }` so the route can hand the client a handle to poll.
 *
 * These only START the workflow (fire-and-forget from the HTTP request's view);
 * the worker process executes the orchestration. The actual domain logic lives
 * in the workflow/service layer, never here.
 */

import { Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import {
  TASK_QUEUE,
  inboundEmailWorkflow,
  outboundSequenceWorkflow,
  researchProspectWorkflow,
  sendApprovedDraftWorkflow,
  workflowIds,
} from '@app/workflows';

/** Identifiers for a started Temporal workflow execution. */
export interface StartedWorkflow {
  workflowId: string;
  runId: string;
}

/**
 * Resolve the `{ workflowId, runId }` for a workflow that is already running
 * under a fixed id. Triggering the same id while a run is open throws
 * `WorkflowExecutionAlreadyStartedError`; we treat that as success and return a
 * handle to the existing execution instead of bubbling a 500.
 */
async function existingWorkflow(client: Client, workflowId: string): Promise<StartedWorkflow> {
  const handle = client.workflow.getHandle(workflowId);
  const desc = await handle.describe();
  return { workflowId: handle.workflowId, runId: desc.runId };
}

/** Start `researchProspectWorkflow` for a prospect. */
export async function startResearch(client: Client, prospectId: string): Promise<StartedWorkflow> {
  const workflowId = workflowIds.research(prospectId);
  try {
    const handle = await client.workflow.start(researchProspectWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [{ prospectId }],
    });
    return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      return existingWorkflow(client, workflowId);
    }
    throw err;
  }
}

/** Start `outboundSequenceWorkflow` for a prospect + sequence. */
export async function startOutbound(
  client: Client,
  prospectId: string,
  sequenceId: string,
): Promise<StartedWorkflow> {
  const workflowId = workflowIds.outbound(prospectId, sequenceId);
  try {
    const handle = await client.workflow.start(outboundSequenceWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [{ prospectId, sequenceId }],
    });
    return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      return existingWorkflow(client, workflowId);
    }
    throw err;
  }
}

/**
 * Start `sendApprovedDraftWorkflow` for a human-APPROVED draft. The send itself
 * is still gated on SENDING_ENABLED + the human approval inside the service;
 * this only kicks off the durable, idempotent SEND path. Workflow id:
 * `send-draft-<draftId>`.
 */
export async function startSendApprovedDraft(
  client: Client,
  draftId: string,
): Promise<StartedWorkflow> {
  const workflowId = workflowIds.sendDraft(draftId);
  try {
    const handle = await client.workflow.start(sendApprovedDraftWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [{ draftId }],
    });
    return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      return existingWorkflow(client, workflowId);
    }
    throw err;
  }
}

/** Start `inboundEmailWorkflow` for a (provider) message + thread. */
export async function startInbound(
  client: Client,
  args: { providerMessageId?: string; threadId?: string },
): Promise<StartedWorkflow> {
  const key = args.providerMessageId ?? args.threadId ?? 'unknown';
  const workflowId = workflowIds.inbound(key);
  try {
    const handle = await client.workflow.start(inboundEmailWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [args],
    });
    return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      return existingWorkflow(client, workflowId);
    }
    throw err;
  }
}

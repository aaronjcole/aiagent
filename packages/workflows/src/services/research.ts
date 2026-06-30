/**
 * Research service — the durable logic behind `researchProspectWorkflow`.
 *
 * Loads the prospect, gathers raw research context via the {@link
 * ResearchProvider}, runs the research agent (RECOMMENDS), persists an
 * `AgentRun`, maps the agent verdict onto a `ResearchResult` + the prospect
 * lifecycle status, and audits the decision. On an agent {@link EscalationError}
 * the prospect is flagged `needs_review`, an `ApprovalItem` (ESCALATION) is
 * created, and the run returns without crashing the workflow.
 */

import {
  AgentRunStatus,
  AgentType,
  ApprovalStatus,
  ApprovalType,
  ProspectStatus,
  ResearchStatus,
  ActorType,
  EscalationError,
  NotFoundError,
  type ResearchOutput,
} from '@app/shared';
import { researchProspect, type ResearchInput } from '@app/agents';
import type { Deps } from '../deps.js';
import {
  persistAgentRun,
  prospectStatusFromResearch,
  toJson,
  writeAudit,
} from './shared.js';

export interface ResearchProspectInput {
  prospectId: string;
}

export interface ResearchProspectResult {
  status: 'researched' | 'escalated';
  prospectId: string;
  researchStatus?: ResearchOutput['status'];
  researchResultId?: string;
  agentRunId?: string;
  summary?: string;
}

const ENTITY = 'prospect';

/** Run the full research flow for a prospect. */
export async function researchProspectService(
  deps: Deps,
  input: ResearchProspectInput,
): Promise<ResearchProspectResult> {
  const { prospectId } = input;

  const prospect = await deps.prisma.prospect.findUnique({
    where: { id: prospectId },
    include: { company: true },
  });

  if (!prospect) {
    await writeAudit(deps, {
      action: 'research.prospect_not_found',
      entityType: ENTITY,
      entityId: prospectId,
      allowed: false,
      reason: 'prospect not found',
    });
    throw new NotFoundError(`prospect not found: ${prospectId}`, { prospectId });
  }

  // Mark as researching while we work.
  await deps.prisma.prospect.update({
    where: { id: prospectId },
    data: { status: ProspectStatus.RESEARCHING },
  });

  // --- Gather context + run the research agent inside one guard ---
  // `gatherResearchContext` does provider I/O (enrichment / web search) which can
  // also fail; keeping it inside the try means a provider/Prisma failure flips the
  // prospect to NEEDS_REVIEW (with a `research.failed` audit) instead of pinning
  // it in RESEARCHING with no record.
  let researchInput: ResearchInput | undefined;
  try {
    researchInput = await gatherResearchContext(deps, prospect);
    const { output, meta } = await researchProspect(researchInput, deps.llmClient);

    const agentRun = await persistAgentRun(deps, {
      agentType: AgentType.RESEARCH,
      status: AgentRunStatus.SUCCEEDED,
      meta,
      prospectId,
      inputPayload: researchInput,
      parsedOutput: output,
    });

    const nextProspectStatus = prospectStatusFromResearch(output.status);

    const researchResult = await deps.prisma.researchResult.create({
      data: {
        prospectId,
        status: output.status,
        summary: output.summary,
        output: toJson(output) as object,
        confidence: output.confidence,
        riskFlags: output.riskFlags,
        provider: meta.provider,
        agentRunId: agentRun.id,
      },
      select: { id: true },
    });

    await deps.prisma.prospect.update({
      where: { id: prospectId },
      data: { status: nextProspectStatus },
    });

    // If the agent itself flags needs_review, also raise an approval item.
    if (output.status === ResearchStatus.NEEDS_REVIEW || output.status === ResearchStatus.INSUFFICIENT) {
      await deps.prisma.approvalItem.create({
        data: {
          type: ApprovalType.ESCALATION,
          status: ApprovalStatus.PENDING,
          prospectId,
          payload: toJson({
            kind: 'research_review',
            researchStatus: output.status,
            summary: output.summary,
            riskFlags: output.riskFlags,
            dataGaps: output.dataGaps,
          }) as object,
          reason: `research status ${output.status}`,
        },
      });
    }

    await writeAudit(deps, {
      action: 'research.completed',
      actorType: ActorType.AGENT,
      entityType: ENTITY,
      entityId: prospectId,
      decision: output.status,
      allowed: true,
      reason: `research ${output.status} (confidence ${output.confidence})`,
      metadata: {
        agentRunId: agentRun.id,
        researchResultId: researchResult.id,
        prospectStatus: nextProspectStatus,
        riskFlags: output.riskFlags,
      },
    });

    return {
      status: 'researched',
      prospectId,
      researchStatus: output.status,
      researchResultId: researchResult.id,
      agentRunId: agentRun.id,
      summary: output.summary,
    };
  } catch (err) {
    if (err instanceof EscalationError) {
      return handleResearchEscalation(deps, prospectId, researchInput ?? { prospect: { email: prospect.email } }, err);
    }
    // Non-escalation terminal failure (provider/Prisma error): don't leave the
    // prospect stuck in RESEARCHING. Flag NEEDS_REVIEW + audit, then rethrow so
    // the failure is visible (and dead-lettered at the workflow layer).
    await deps.prisma.prospect.update({
      where: { id: prospectId },
      data: { status: ProspectStatus.NEEDS_REVIEW },
    });
    await writeAudit(deps, {
      action: 'research.failed',
      actorType: ActorType.SYSTEM,
      entityType: ENTITY,
      entityId: prospectId,
      decision: 'failed',
      allowed: false,
      reason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Gather enrichment + search snippets the research agent will summarize. */
async function gatherResearchContext(
  deps: Deps,
  prospect: {
    email: string;
    firstName: string | null;
    lastName: string | null;
    title: string | null;
    company: { name: string | null; domain: string | null; industry: string | null; description: string | null } | null;
  },
): Promise<ResearchInput> {
  const name = [prospect.firstName, prospect.lastName].filter(Boolean).join(' ').trim() || undefined;
  const domain = prospect.company?.domain ?? prospect.email.split('@')[1];

  // Skip the web search entirely when we have no meaningful query terms (an
  // all-empty query would otherwise hit the provider with a blank string).
  const webQuery = [name, prospect.company?.name ?? domain].filter(Boolean).join(' ').trim();

  const [companyEnrich, personEnrich, webHits] = await Promise.all([
    domain ? deps.research.enrichCompany(domain) : Promise.resolve(null),
    deps.research.enrichPerson({ email: prospect.email, name }),
    webQuery ? deps.research.searchWeb(webQuery) : Promise.resolve([]),
  ]);

  const signals = [
    ...(companyEnrich?.sources ?? []),
    ...personEnrich.sources,
    ...webHits,
  ];

  const researchProspectId: ResearchInput['prospect'] = {
    email: prospect.email,
  };
  if (name) researchProspectId.name = name;
  if (prospect.title) researchProspectId.title = prospect.title;
  const companyName = prospect.company?.name ?? companyEnrich?.name;
  if (companyName) researchProspectId.companyName = companyName;

  const company: ResearchInput['company'] = {};
  if (companyName) company.name = companyName;
  if (domain) company.domain = domain;
  const industry = prospect.company?.industry ?? companyEnrich?.industry;
  if (industry) company.industry = industry;
  const description = prospect.company?.description ?? companyEnrich?.description;
  if (description) company.description = description;

  return {
    prospect: researchProspectId,
    company: Object.keys(company).length > 0 ? company : undefined,
    signals,
  };
}

/** Record an escalated AgentRun + ApprovalItem and flag the prospect. */
async function handleResearchEscalation(
  deps: Deps,
  prospectId: string,
  researchInput: ResearchInput,
  err: EscalationError,
): Promise<ResearchProspectResult> {
  const agentRun = await persistAgentRun(deps, {
    agentType: AgentType.RESEARCH,
    status: AgentRunStatus.ESCALATED,
    prospectId,
    inputPayload: researchInput,
    validationErrors: err.details ?? { message: err.message },
  });

  // Flag the prospect for human review and surface the case via the escalation
  // ApprovalItem.
  await deps.prisma.prospect.update({
    where: { id: prospectId },
    data: { status: ProspectStatus.NEEDS_REVIEW },
  });

  await deps.prisma.approvalItem.create({
    data: {
      type: ApprovalType.ESCALATION,
      status: ApprovalStatus.PENDING,
      prospectId,
      payload: toJson({
        kind: 'research_escalation',
        error: err.message,
        details: err.details,
      }) as object,
      reason: 'research agent escalated (invalid output after repair)',
    },
  });

  await writeAudit(deps, {
    action: 'research.escalated',
    actorType: ActorType.AGENT,
    entityType: ENTITY,
    entityId: prospectId,
    decision: 'needs_review',
    allowed: false,
    reason: err.message,
    metadata: { agentRunId: agentRun.id },
  });

  return { status: 'escalated', prospectId, agentRunId: agentRun.id };
}

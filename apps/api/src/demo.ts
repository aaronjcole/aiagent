/**
 * End-to-end local demo that PROVES the system, printing the resulting DB rows
 * at each step.
 *
 * Modes:
 *  - default (Temporal): drives the real workflows via the Temporal `Client`.
 *    Requires the stack up (`docker compose up`): Temporal + Postgres + a
 *    running `@app/worker`.
 *  - `--no-temporal`: calls the workflow SERVICE functions directly with a
 *    `Deps` from `createDeps()`. Works with only Postgres up.
 *
 * The inbound simulation (step 4) always runs IN-PROCESS via the inbound
 * service, because the mock email provider is in-memory and the preseeded
 * thread must be visible to the code that reads it. The note is printed at the
 * step. Research + outbound respect the selected mode.
 *
 * Steps:
 *  1. Ensure/create a demo prospect.
 *  2. Research workflow → ResearchResult + prospect status + AgentRun.
 *  3. Outbound sequence workflow → DraftEmail + ComplianceReview + ApprovalItem
 *     (auto-send OFF, so NOT sent).
 *  4. Simulate an inbound scheduling reply → classification + scheduling
 *     extraction + availability + scheduling reply DraftEmail + CalendarEvent.
 *  5. Dump the recent AuditLogs (the decision trail).
 */

import 'dotenv/config';
import { Client, Connection } from '@temporalio/client';
import { EmailDirection, loadConfig } from '@app/shared';
import { prisma } from '@app/db';
import {
  TASK_QUEUE,
  createDeps,
  inboundEmailWorkflow,
  inboundEmailService,
  outboundSequenceService,
  outboundSequenceWorkflow,
  researchProspectService,
  researchProspectWorkflow,
  workflowIds,
  type Deps,
} from '@app/workflows';
import { MockEmailProvider } from '@app/email';

const USE_TEMPORAL = !process.argv.includes('--no-temporal');

function section(title: string): void {
  console.log(`\n${'='.repeat(70)}\n${title}\n${'='.repeat(70)}`);
}

function row(label: string, value: unknown): void {
  console.log(`  ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

const DEMO_DOMAIN = 'demo.example.com';
const DEMO_EMAIL = 'casey.demo@demo.example.com';

async function ensureProspect(): Promise<{ id: string; email: string }> {
  section('STEP 1 — Ensure demo prospect');
  const company = await prisma.company.upsert({
    where: { domain: DEMO_DOMAIN },
    create: { name: 'Demo Co', domain: DEMO_DOMAIN, industry: 'Software' },
    update: {},
  });
  const prospect = await prisma.prospect.upsert({
    where: { email: DEMO_EMAIL },
    create: {
      email: DEMO_EMAIL,
      firstName: 'Casey',
      lastName: 'Demo',
      title: 'Head of Growth',
      companyId: company.id,
      source: 'demo',
    },
    update: {},
  });
  row('prospectId', prospect.id);
  row('email', prospect.email);
  row('status', prospect.status);
  return { id: prospect.id, email: prospect.email };
}

async function getSequenceId(prospectId: string): Promise<string> {
  // Prefer the seeded "Default Outbound"; otherwise create a minimal sequence.
  const existing = await prisma.outreachSequence.findFirst({ orderBy: { createdAt: 'asc' } });
  if (existing) return existing.id;
  const created = await prisma.outreachSequence.create({
    data: { name: 'Demo Sequence', prospectId, status: 'active', maxSteps: 3 },
  });
  return created.id;
}

async function runResearch(deps: Deps, client: Client | undefined, prospectId: string): Promise<void> {
  section('STEP 2 — Research workflow');
  if (USE_TEMPORAL && client) {
    const result = await client.workflow.execute(researchProspectWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: workflowIds.research(prospectId),
      args: [{ prospectId }],
    });
    row('workflow result', result);
  } else {
    const result = await researchProspectService(deps, { prospectId });
    row('service result', result);
  }

  const research = await prisma.researchResult.findFirst({
    where: { prospectId },
    orderBy: { createdAt: 'desc' },
  });
  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } });
  const agentRun = await prisma.agentRun.findFirst({
    where: { prospectId, agentType: 'research' },
    orderBy: { createdAt: 'desc' },
  });
  row('ResearchResult.id', research?.id);
  row('ResearchResult.status', research?.status);
  row('ResearchResult.summary', research?.summary);
  row('Prospect.status', prospect?.status);
  row('AgentRun', agentRun ? { id: agentRun.id, status: agentRun.status, model: agentRun.model } : null);
}

async function runOutbound(
  deps: Deps,
  client: Client | undefined,
  prospectId: string,
  sequenceId: string,
): Promise<void> {
  section('STEP 3 — Outbound sequence workflow (auto-send OFF → draft + approval)');
  if (USE_TEMPORAL && client) {
    const result = await client.workflow.execute(outboundSequenceWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: workflowIds.outbound(prospectId, sequenceId),
      args: [{ prospectId, sequenceId }],
    });
    row('workflow result', result);
  } else {
    const result = await outboundSequenceService(deps, { prospectId, sequenceId });
    row('service result', result);
  }

  const draft = await prisma.draftEmail.findFirst({
    where: { prospectId },
    orderBy: { createdAt: 'desc' },
  });
  const approval = await prisma.approvalItem.findFirst({
    where: { prospectId, draftId: draft?.id },
    orderBy: { createdAt: 'desc' },
  });
  row('DraftEmail.id', draft?.id);
  row('DraftEmail.subject', draft?.subject);
  row('DraftEmail.status', draft?.status);
  row('DraftEmail.complianceStatus', draft?.complianceStatus);
  row('ComplianceReview (flags)', draft?.complianceFlags);
  row('ApprovalItem', approval ? { id: approval.id, type: approval.type, status: approval.status } : null);
  row('sent?', draft?.status === 'sent' ? 'YES' : 'NO (expected — auto-send OFF)');
}

async function runInbound(deps: Deps, prospectId: string, prospectEmail: string): Promise<void> {
  section('STEP 4 — Simulate inbound scheduling reply (IN-PROCESS mock provider)');
  console.log('  note: preseeds the in-memory mock email provider, then runs the inbound flow.');

  if (!(deps.email instanceof MockEmailProvider)) {
    console.log('  SKIPPED: EMAIL_PROVIDER is not "mock"; cannot simulate inbound.');
    return;
  }

  const subject = 'Re: Quick intro';
  const [thread] = deps.email.preseed([
    {
      subject,
      messages: [
        {
          from: { email: prospectEmail, name: 'Casey Demo' },
          to: [{ email: deps.config.defaultFromEmail, name: deps.config.defaultFromName }],
          subject,
          body:
            "Yes, I'm interested! Could we find 30 minutes next week? " +
            'I am free Tuesday or Wednesday afternoon (US Eastern / America/New_York). Looking forward to it.',
          direction: EmailDirection.INBOUND,
        },
      ],
    },
  ]);
  if (!thread) throw new Error('failed to preseed inbound thread');
  const providerMessageId = thread.messages[0]?.providerMessageId;
  row('preseeded threadId', thread.providerThreadId);
  row('preseeded providerMessageId', providerMessageId);

  // Always run the inbound service in-process so it reads the preseeded thread.
  // (In Temporal mode the worker has a separate in-memory provider.)
  const result = await inboundEmailService(deps, {
    threadId: thread.providerThreadId,
    ...(providerMessageId ? { providerMessageId } : {}),
  });
  // Reference the Temporal workflow symbol so the relationship is explicit.
  void inboundEmailWorkflow;
  row('inbound result', result);

  const classifier = await prisma.agentRun.findFirst({
    where: { prospectId, agentType: 'inbound_classifier' },
    orderBy: { createdAt: 'desc' },
  });
  const extractor = await prisma.agentRun.findFirst({
    where: { prospectId, agentType: 'scheduling_extractor' },
    orderBy: { createdAt: 'desc' },
  });
  const replyDraft = result.draftId
    ? await prisma.draftEmail.findUnique({ where: { id: result.draftId } })
    : null;
  const event = result.calendarEventId
    ? await prisma.calendarEvent.findUnique({ where: { id: result.calendarEventId } })
    : null;

  row('classification', classifier?.parsedOutput);
  row('scheduling extraction', extractor?.parsedOutput);
  row('scheduling reply DraftEmail', replyDraft ? { id: replyDraft.id, subject: replyDraft.subject, status: replyDraft.status } : null);
  row('CalendarEvent', event ? { id: event.id, status: event.status, timezone: event.timezone } : null);
}

async function dumpAuditLogs(): Promise<void> {
  section('STEP 5 — Recent AuditLogs (decision trail)');
  const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 25 });
  for (const log of logs.reverse()) {
    console.log(
      `  [${log.createdAt.toISOString()}] ${log.action}` +
        ` | ${log.entityType}:${log.entityId}` +
        ` | actor=${log.actorType}` +
        (log.decision ? ` | decision=${log.decision}` : '') +
        (log.allowed === null ? '' : ` | allowed=${log.allowed}`) +
        (log.reason ? ` | ${log.reason}` : ''),
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to run the demo');
  }

  section(`AIAgent demo — mode: ${USE_TEMPORAL ? 'Temporal' : 'direct services (--no-temporal)'}`);
  console.log(`  temporalAddress: ${config.temporalAddress}`);
  console.log(`  emailProvider:   ${config.emailProvider}`);
  console.log(`  autoSendEnabled: ${config.autoSendEnabled} | sendingEnabled: ${config.sendingEnabled}`);

  const deps = await createDeps({ config, prisma });

  let connection: Connection | undefined;
  let client: Client | undefined;
  if (USE_TEMPORAL) {
    try {
      connection = await Connection.connect({ address: config.temporalAddress });
      client = new Client({ connection });
    } catch (err) {
      console.error(
        `\nFailed to connect to Temporal at ${config.temporalAddress}. ` +
          'Start the stack with `docker compose up`, or re-run with `--no-temporal`.\n',
        err,
      );
      await prisma.$disconnect();
      process.exit(1);
    }
  }

  try {
    const prospect = await ensureProspect();
    const sequenceId = await getSequenceId(prospect.id);
    await runResearch(deps, client, prospect.id);
    await runOutbound(deps, client, prospect.id, sequenceId);
    await runInbound(deps, prospect.id, prospect.email);
    await dumpAuditLogs();
    section('Demo complete');
  } finally {
    if (connection) await connection.close();
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('demo failed', err);
  process.exit(1);
});

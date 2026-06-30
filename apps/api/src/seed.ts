/**
 * DB seed — idempotent. Creates a demo Company, a "Default Outbound" sequence
 * with steps, default SystemSettings (auto_send_enabled=false + caps mirrored
 * from env defaults), and a couple of demo prospects. Safe to re-run.
 *
 * Invoke with `pnpm --filter @app/api run seed`. Requires DATABASE_URL.
 *
 * NO real data: all addresses/domains are `example.com` placeholders.
 */

import 'dotenv/config';
import { prisma, type Prisma } from '@app/db';
import { ProspectStatus, loadConfig } from '@app/shared';

const DEMO_DOMAIN = 'acme.example.com';
const SEQUENCE_NAME = 'Default Outbound';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to seed the database');
  }
  const config = loadConfig();

  // --- Company (upsert by unique domain) ---
  const company = await prisma.company.upsert({
    where: { domain: DEMO_DOMAIN },
    create: {
      name: 'Acme Corp',
      domain: DEMO_DOMAIN,
      website: `https://${DEMO_DOMAIN}`,
      industry: 'Software',
      size: '201-500',
      description: 'A demo company used for local development and the demo script.',
    },
    update: {},
  });

  // --- Demo prospects (upsert by unique email) ---
  const prospectSeeds: Prisma.ProspectCreateInput[] = [
    {
      email: 'dana.prospect@acme.example.com',
      firstName: 'Dana',
      lastName: 'Prospect',
      title: 'VP of Engineering',
      status: ProspectStatus.NEW,
      source: 'seed',
      company: { connect: { id: company.id } },
    },
    {
      email: 'sam.lead@acme.example.com',
      firstName: 'Sam',
      lastName: 'Lead',
      title: 'Director of Operations',
      status: ProspectStatus.NEW,
      source: 'seed',
      company: { connect: { id: company.id } },
    },
  ];

  const prospects = [];
  for (const seed of prospectSeeds) {
    const p = await prisma.prospect.upsert({
      where: { email: seed.email },
      create: seed,
      update: {},
    });
    prospects.push(p);
  }

  // --- Default Outbound sequence (find-or-create by name + first prospect) ---
  // OutreachSequence has no business-unique key, so we key the demo sequence on
  // (name, prospectId) to keep the seed idempotent.
  const seqOwner = prospects[0];
  if (!seqOwner) throw new Error('expected at least one seeded prospect');

  let sequence = await prisma.outreachSequence.findFirst({
    where: { name: SEQUENCE_NAME, prospectId: seqOwner.id },
  });
  if (!sequence) {
    sequence = await prisma.outreachSequence.create({
      data: {
        name: SEQUENCE_NAME,
        prospectId: seqOwner.id,
        status: 'active',
        currentStep: 0,
        maxSteps: config.sequenceMaxSteps,
      },
    });
  }

  // --- Sequence steps (upsert by unique [sequenceId, stepNumber]) ---
  const steps: { stepNumber: number; delayHours: number; template: string }[] = [
    { stepNumber: 1, delayHours: 0, template: 'intro' },
    { stepNumber: 2, delayHours: 72, template: 'follow_up_1' },
    { stepNumber: 3, delayHours: 168, template: 'follow_up_2' },
  ];
  for (const step of steps) {
    await prisma.sequenceStep.upsert({
      where: { sequenceId_stepNumber: { sequenceId: sequence.id, stepNumber: step.stepNumber } },
      create: {
        sequenceId: sequence.id,
        stepNumber: step.stepNumber,
        delayHours: step.delayHours,
        channel: 'email',
        template: step.template,
      },
      update: {},
    });
  }

  // --- Default SystemSettings (upsert by key) ---
  const settings: { key: string; value: Prisma.InputJsonValue }[] = [
    { key: 'auto_send_enabled', value: false },
    { key: 'sending_enabled', value: false },
    { key: 'daily_send_cap', value: config.dailySendCap },
    { key: 'per_inbox_daily_cap', value: config.perInboxDailyCap },
    { key: 'per_domain_daily_cap', value: config.perDomainDailyCap },
    { key: 'sequence_max_steps', value: config.sequenceMaxSteps },
  ];
  for (const setting of settings) {
    await prisma.systemSetting.upsert({
      where: { key: setting.key },
      create: { key: setting.key, value: setting.value },
      update: {},
    });
  }

  // --- Summary ---
  console.log('\n=== Seed complete ===');
  console.log(`Company:    ${company.name} (${company.id}) domain=${company.domain}`);
  console.log(`Sequence:   ${sequence.name} (${sequence.id}) steps=${steps.length}`);
  console.log('Prospects:');
  for (const p of prospects) {
    console.log(`  - ${p.email} (${p.id}) status=${p.status}`);
  }
  console.log('Settings:');
  for (const s of settings) {
    console.log(`  - ${s.key} = ${JSON.stringify(s.value)}`);
  }
  console.log('======================\n');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err: unknown) => {
    console.error('seed failed', err);
    await prisma.$disconnect();
    process.exit(1);
  });

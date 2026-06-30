/**
 * Local, structural types for the entities the admin UI renders.
 *
 * The admin is a thin HTTP client for `@app/api`; it does NOT import `@app/db`.
 * These types mirror the relevant fields of the Prisma models as exposed by the
 * API JSON responses. Enum string-literal unions are imported from `@app/shared`
 * (no runtime/db dependency) where helpful, but everything here stays optional
 * and tolerant of extra/missing fields so the UI degrades gracefully.
 */
import type {
  ProspectStatus,
  ResearchStatus,
  DraftStatus,
  ApprovalType,
  ApprovalStatus,
  SuppressionReason,
  EmailDirection,
} from '@app/shared';

/** Any JSON value returned by the API. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface Prospect {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  title?: string | null;
  companyId?: string | null;
  companyName?: string | null;
  companyDomain?: string | null;
  status: ProspectStatus | string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ResearchSource {
  title?: string;
  url?: string;
  snippet?: string;
}

export interface ResearchOutput {
  status?: ResearchStatus | string;
  summary?: string;
  companyInsights?: string;
  personalizationPoints?: Array<{ point: string; evidence?: string; sourceUrl?: string | null }>;
  sources?: ResearchSource[];
  dataGaps?: string[];
  confidence?: number;
  riskFlags?: string[];
}

export interface ResearchResult {
  id: string;
  prospectId: string;
  status: ResearchStatus | string;
  confidence?: number | null;
  summary?: string | null;
  output?: ResearchOutput | null;
  createdAt?: string;
}

export interface DraftEmail {
  id: string;
  prospectId?: string | null;
  threadId?: string | null;
  status: DraftStatus | string;
  subject?: string | null;
  bodyText?: string | null;
  body?: string | null;
  toEmail?: string | null;
  fromEmail?: string | null;
  complianceFlags?: Json;
  createdAt?: string;
}

export interface ApprovalItem {
  id: string;
  type: ApprovalType | string;
  status: ApprovalStatus | string;
  prospectId?: string | null;
  draftId?: string | null;
  draft?: DraftEmail | null;
  reason?: string | null;
  payload?: Json;
  createdAt?: string;
}

export interface EmailMessage {
  id: string;
  threadId?: string | null;
  direction: EmailDirection | string;
  fromEmail?: string | null;
  toEmail?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  providerMessageId?: string | null;
  createdAt?: string;
  receivedAt?: string | null;
}

export interface EmailThread {
  id: string;
  subject?: string | null;
  prospectId?: string | null;
  providerThreadId?: string | null;
  classification?: string | null;
  requiresHuman?: boolean | null;
  messages?: EmailMessage[];
  createdAt?: string;
}

export interface SuppressionEntry {
  id: string;
  email?: string | null;
  domain?: string | null;
  reason?: SuppressionReason | string | null;
  notes?: string | null;
  createdAt?: string;
}

export interface AuditLog {
  id: string;
  entityType?: string | null;
  entityId?: string | null;
  action?: string | null;
  actorType?: string | null;
  actor?: string | null;
  allowed?: boolean | null;
  reason?: string | null;
  metadata?: Json;
  createdAt?: string;
}

export interface SystemSetting {
  key: string;
  value: Json;
  description?: string | null;
  updatedAt?: string;
}

export interface OutreachSequence {
  id: string;
  name?: string | null;
  maxSteps?: number | null;
}

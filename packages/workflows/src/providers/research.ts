/**
 * Research provider — co-located here (rather than a new workspace package) to
 * gather raw enrichment + web snippets a prospect's research agent then
 * summarizes. The default {@link MockResearchProvider} is fully deterministic
 * (no network, no clock/random) so workflows and tests are reproducible. The
 * `live` adapter is a stub that throws {@link ProviderError} until wired up.
 */

import { ProviderError, type Config, type Logger } from '@app/shared';

/** A raw source/snippet gathered for a prospect or company. */
export interface ResearchSource {
  title: string;
  url: string;
  snippet: string;
}

/** Structured enrichment for a company. */
export interface CompanyEnrichment {
  name?: string;
  domain?: string;
  industry?: string;
  description?: string;
  sources: ResearchSource[];
}

/** Structured enrichment for a person. */
export interface PersonEnrichment {
  name?: string;
  title?: string;
  email?: string;
  sources: ResearchSource[];
}

/** A query for a person lookup (email and/or name). */
export interface PersonQuery {
  email?: string;
  name?: string;
}

/**
 * The research port. Implementations gather raw enrichment + sources; the
 * research AGENT (in `@app/agents`) is what synthesizes a `ResearchOutput`.
 */
export interface ResearchProvider {
  readonly name: 'mock' | 'live';
  /** Free-text web search returning candidate sources. */
  searchWeb(query: string): Promise<ResearchSource[]>;
  /** Enrich a company by domain. */
  enrichCompany(domain: string): Promise<CompanyEnrichment>;
  /** Enrich a person by email and/or name. */
  enrichPerson(query: PersonQuery): Promise<PersonEnrichment>;
}

/** Deterministic title-case of a domain's second-level label, for plausible names. */
function companyNameFromDomain(domain: string): string {
  const label = domain.split('.')[0] ?? domain;
  return label.length > 0 ? label.charAt(0).toUpperCase() + label.slice(1) : domain;
}

/**
 * A deterministic, offline research provider. Given the same inputs it always
 * returns the same plausible enrichment + sources. Makes no network calls and
 * reads no clock/random state.
 */
export class MockResearchProvider implements ResearchProvider {
  readonly name = 'mock' as const;

  /** Return a single deterministic search source derived from the query. */
  searchWeb(query: string): Promise<ResearchSource[]> {
    const slug = encodeURIComponent(query.trim().toLowerCase().replace(/\s+/g, '-')) || 'query';
    return Promise.resolve([
      {
        title: `Search result for "${query}"`,
        url: `https://example.com/search/${slug}`,
        snippet: `Reference material related to ${query}.`,
      },
    ]);
  }

  /** Return deterministic, plausible enrichment + sources for a company domain. */
  enrichCompany(domain: string): Promise<CompanyEnrichment> {
    const d = domain.trim().toLowerCase();
    const name = companyNameFromDomain(d);
    return Promise.resolve({
      name,
      domain: d,
      industry: 'Software',
      description: `${name} is a mid-market company showing recent growth signals.`,
      sources: [
        {
          title: `${name} careers page`,
          url: `https://${d}/careers`,
          snippet: 'We are hiring across platform and infrastructure teams.',
        },
        {
          title: `${name} product launch announcement`,
          url: `https://${d}/blog/launch`,
          snippet: 'Introducing our newest product line to better serve customers.',
        },
      ],
    });
  }

  /** Return deterministic enrichment + a public-profile source for a person. */
  enrichPerson(query: PersonQuery): Promise<PersonEnrichment> {
    const email = query.email?.trim().toLowerCase();
    const name = query.name?.trim() ?? (email ? email.split('@')[0] : undefined);
    const sources: ResearchSource[] = email
      ? [
          {
            title: `Public profile for ${name ?? email}`,
            url: `https://example.com/people/${encodeURIComponent(email)}`,
            snippet: `Professional background for ${name ?? email}.`,
          },
        ]
      : [];
    const result: PersonEnrichment = { sources };
    if (name !== undefined) result.name = name;
    return Promise.resolve(result);
  }
}

/**
 * A stub `live` research provider. Throws {@link ProviderError} until a real
 * web/enrichment backend is configured.
 */
export class LiveResearchProvider implements ResearchProvider {
  readonly name = 'live' as const;

  /** Not yet wired up: rejects with {@link ProviderError}. */
  searchWeb(): Promise<ResearchSource[]> {
    return Promise.reject(
      new ProviderError('live research provider not configured', { provider: 'live' }),
    );
  }
  /** Not yet wired up: rejects with {@link ProviderError}. */
  enrichCompany(): Promise<CompanyEnrichment> {
    return Promise.reject(
      new ProviderError('live research provider not configured', { provider: 'live' }),
    );
  }
  /** Not yet wired up: rejects with {@link ProviderError}. */
  enrichPerson(): Promise<PersonEnrichment> {
    return Promise.reject(
      new ProviderError('live research provider not configured', { provider: 'live' }),
    );
  }
}

/**
 * Build a {@link ResearchProvider} from config. Defaults to the deterministic
 * mock; `researchProvider === 'live'` selects the (stub) live adapter.
 */
export function createResearchProvider(
  config: Pick<Config, 'researchProvider'>,
  logger?: Logger,
): ResearchProvider {
  switch (config.researchProvider) {
    case 'live':
      logger?.info({ provider: 'live' }, 'creating research provider');
      return new LiveResearchProvider();
    case 'mock':
    default:
      logger?.info({ provider: 'mock' }, 'creating research provider');
      return new MockResearchProvider();
  }
}

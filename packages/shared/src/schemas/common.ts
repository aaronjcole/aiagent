import { z } from 'zod';

/** Confidence is always a probability in [0, 1]. */
export const ConfidenceSchema = z.number().min(0).max(1);

/** Free-form, machine-actionable risk flags surfaced by an agent. */
export const RiskFlagsSchema = z.array(z.string());

/** ISO-8601 datetime string (e.g. `2026-06-30T15:00:00.000Z`). */
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

/** A proposed time window for a meeting. */
export const TimeSlotSchema = z
  .object({
    startIso: IsoDateTimeSchema,
    endIso: IsoDateTimeSchema,
  })
  .strict();
export type TimeSlot = z.infer<typeof TimeSlotSchema>;

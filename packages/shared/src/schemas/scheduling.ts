import { z } from 'zod';
import { ConfidenceSchema, TimeSlotSchema } from './common.js';

/** Validates extracted scheduling intent from an inbound reply (times, timezone, duration). */
export const SchedulingExtractionSchema = z
  .object({
    hasSchedulingIntent: z.boolean(),
    proposedTimes: z.array(TimeSlotSchema),
    timezone: z.string().nullable(),
    timezoneAmbiguous: z.boolean(),
    durationMinutes: z.number().int().positive().nullable(),
    selectedSlotIndex: z.number().int().nonnegative().nullable(),
    needsClarification: z.boolean(),
    clarificationQuestion: z.string().nullable(),
    confidence: ConfidenceSchema,
  })
  .strict();
/** Scheduling details extracted from a prospect's reply. */
export type SchedulingExtraction = z.infer<typeof SchedulingExtractionSchema>;

/** The action a scheduling reply should take. */
export const SchedulingActionEnum = z.enum(['propose', 'confirm', 'clarify', 'escalate']);
/** Inferred type of {@link SchedulingActionEnum}. */
export type SchedulingActionEnum = z.infer<typeof SchedulingActionEnum>;

/** Validates a drafted scheduling reply (action, body, proposed slots, confidence). */
export const SchedulingReplyDraftSchema = z
  .object({
    action: SchedulingActionEnum,
    body: z.string(),
    proposedSlots: z.array(TimeSlotSchema),
    confidence: ConfidenceSchema,
  })
  .strict();
/** A drafted reply that proposes, confirms, or clarifies meeting times. */
export type SchedulingReplyDraft = z.infer<typeof SchedulingReplyDraftSchema>;

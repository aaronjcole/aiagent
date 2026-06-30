import { z } from 'zod';
import { ConfidenceSchema, TimeSlotSchema } from './common.js';

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
export type SchedulingExtraction = z.infer<typeof SchedulingExtractionSchema>;

export const SchedulingActionEnum = z.enum(['propose', 'confirm', 'clarify', 'escalate']);
export type SchedulingActionEnum = z.infer<typeof SchedulingActionEnum>;

export const SchedulingReplyDraftSchema = z
  .object({
    action: SchedulingActionEnum,
    body: z.string(),
    proposedSlots: z.array(TimeSlotSchema),
    confidence: ConfidenceSchema,
  })
  .strict();
export type SchedulingReplyDraft = z.infer<typeof SchedulingReplyDraftSchema>;

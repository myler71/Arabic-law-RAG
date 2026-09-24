import { z } from 'zod';

/**
 * Feedback target span enum: which part of the AI output this feedback targets.
 */
export const FeedbackTargetSpanEnum = z.enum([
  'final_answer',
  'citation',
  'summary',
  'procedure',
]);
export type FeedbackTargetSpan = z.infer<typeof FeedbackTargetSpanEnum>;

/**
 * Feedback kind: accepted (positive/approved), corrected (modified/edited), rejected (bad/wrong).
 */
export const FeedbackKindEnum = z.enum(['accepted', 'corrected', 'rejected']);
export type FeedbackKind = z.infer<typeof FeedbackKindEnum>;

/**
 * FeedbackWriteSchema per LLMOps spec L5.3
 */
export const feedbackWriteSchema = z
  .object({
    trace_id: z.string().min(1, 'trace_id is required'),
    run_id: z.string().min(1, 'run_id is required'),
    session_id: z.string().nullable().optional(),
    user_id: z.string().nullable().optional(),
    lawyer_id: z.string().nullable().optional(),
    case_id: z.string().nullable().optional(),
    persona: z.enum(['client', 'lawyer']).optional(),
    mode: z.enum(['chat_fast', 'case_deep']).optional(),
    kind: FeedbackKindEnum,
    rating: z.number().int().min(1).max(5).nullable().optional(),
    correction_text: z.string().nullable().optional(),
    target_span: FeedbackTargetSpanEnum.nullable().optional(),
    ai_output_hash: z.string().nullable().optional(),
    ai_output_redacted_snippet: z.string().nullable().optional(),
    citations_user_flagged: z.array(z.string()).default([]),
    citations_user_flagged_bad: z.array(z.string()).optional(),
    tags: z.array(z.string()).default([]),
    locale: z.string().default('ar'),
    client_meta: z.record(z.unknown()).default({}),
  })
  .transform((val) => {
    const flagged =
      val.citations_user_flagged && val.citations_user_flagged.length > 0
        ? val.citations_user_flagged
        : val.citations_user_flagged_bad || [];
    return {
      ...val,
      citations_user_flagged: flagged,
    };
  });

export type FeedbackWriteInput = z.input<typeof feedbackWriteSchema>;
export type FeedbackWrite = z.output<typeof feedbackWriteSchema>;

export interface FeedbackRecord extends Omit<FeedbackWrite, 'citations_user_flagged_bad'> {
  id: string;
  created_at: string;
}

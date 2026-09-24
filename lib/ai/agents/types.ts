import type { LegalChunk, LegalCitation } from '../legalRag';
import type { PreGuardResult, PostGuardResult } from '../safety/legalGuard';

export interface StepTiming {
  step: string;
  duration_ms: number;
  ts: number;
}

export interface RoutePlan {
  domain: string;
  specialists: string[];
  rationale?: string;
  mapped_concepts?: string[];
  applicable_laws?: string[];
}

export interface SpecialistFinding {
  article_number?: string;
  law_name?: string;
  court?: string;
  chunk_ids: string[];
  finding: string;
  confidence?: number;
  source_title?: string;
}

export interface SpecialistOutput {
  specialist_name: string;
  domain?: string;
  findings: SpecialistFinding[];
  summary: string;
  chunk_ids: string[];
}

export interface StructuredSummary {
  case_characterization?: string;
  key_findings?: string[];
  legal_basis?: string[];
  procedural_recommendations?: string[];
  litigation_risks?: string[];
  [key: string]: unknown;
}

export interface HITLState {
  status: 'pending' | 'awaiting_review' | 'approved' | 'modified' | 'rejected';
  checkpoint_id?: string;
  reviewer_id?: string;
  notes?: string;
  reviewed_at?: string;
  modified_draft?: string;
  decision?: 'approve' | 'modify' | 'reject';
}

export interface EpisodicMemoryEntry {
  action: 'approve' | 'modify' | 'reject';
  decision: 'approve' | 'modify' | 'reject';
  reviewer_id?: string;
  notes?: string;
  reviewed_at: string;
  query: string;
  domain?: string;
  evidence_score?: number;
  verified_citations_count?: number;
  [key: string]: unknown;
}

/**
 * Complete state representation for the Case-Deep multi-agent workflow.
 */
export interface LegalGraphState {
  trace_id: string;
  run_id: string;
  session_id?: string;
  user_id?: string;
  case_id?: string;
  raw_query: string;
  normalized_query: string;
  guard_pre: PreGuardResult | null;
  route_plan: RoutePlan | null;
  retrieved_chunks: LegalChunk[];
  specialist_outputs: Record<string, SpecialistOutput>;
  draft_answer?: string;
  structured_summary?: StructuredSummary | null;
  citations: LegalCitation[];
  guard_post?: PostGuardResult | null;
  hitl: HITLState;
  timings: StepTiming[];
  errors?: string[];
  final_response?: string;
  episodic_memory?: EpisodicMemoryEntry | null;
}

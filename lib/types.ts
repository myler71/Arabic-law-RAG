export type UserRole = 'client' | 'lawyer';

export interface User {
  id: string;
  name: string;
  email: string;
  phone?: string;
  role: UserRole;
  avatar?: string;
  location?: string;
  specialty?: string;
  barNumber?: string;
  experienceYears?: number;
  bio?: string;
  hourlyRate?: number;
  rating?: number;
  reviewCount?: number;
  winRate?: number;
  casesCount?: number;
}

export interface LegalCitation {
  id: string;
  title: string;
  lawName: string;
  court: string;
  articleNumber?: string;
  year?: string;
  summary: string;
  fullText?: string;
  category: LegalCategory;
  relevanceScore?: number;
  sourceUrl?: string;
}

export type LegalCategory = 
  | 'criminal' 
  | 'civil' 
  | 'labor' 
  | 'corporate' 
  | 'family' 
  | 'real_estate' 
  | 'commercial' 
  | 'administrative' 
  | 'intellectual_property' 
  | 'constitutional'
  | 'military'
  | 'tax';

export interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: string;
  citations?: LegalCitation[];
  caseBriefReady?: boolean;
  generatedSummary?: Partial<CaseIntake>;
}

export type CaseUrgency = 'low' | 'medium' | 'high' | 'urgent';

export type CaseStatus = 
  | 'new_intake' 
  | 'under_review' 
  | 'accepted' 
  | 'in_court' 
  | 'resolved' 
  | 'closed';

export interface CaseTimelineEvent {
  date: string;
  event: string;
  importance?: 'normal' | 'critical';
}

export interface CaseIntake {
  id: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  clientLocation: string;
  lawyerId?: string;
  lawyerName?: string;
  title: string;
  category: LegalCategory;
  urgency: CaseUrgency;
  status: CaseStatus;
  executiveSummary: string;
  legalClaims: string[];
  relevantStatutes: LegalCitation[];
  clientTimeline: CaseTimelineEvent[];
  aiStrategicRecommendation: string;
  feeEstimate?: string;
  createdAt: string;
  updatedAt: string;
  lawyerNotes?: string;
  courtDate?: string;
  sourceChatMessagesCount?: number;
}

export interface LawyerReview {
  id: string;
  clientName: string;
  rating: number;
  date: string;
  comment: string;
  caseCategory: string;
}

export interface LawyerProfile {
  id: string;
  name: string;
  title: string;
  email: string;
  phone: string;
  avatar: string;
  location: string;
  address: string;
  barNumber: string;
  experienceYears: number;
  specialties: LegalCategory[];
  bio: string;
  rating: number;
  reviewCount: number;
  winRate: number;
  activeCasesCount: number;
  totalResolvedCases: number;
  consultationFee: number;
  languages: string[];
  education: string[];
  featuredCases: {
    title: string;
    category: LegalCategory;
    outcome: string;
    year: string;
  }[];
  reviews: LawyerReview[];
}

export interface LegalArticleSearchItem {
  id: string;
  title: string;
  code: string;
  articleNumber: string;
  category: LegalCategory;
  courtName: string;
  rulingDate: string;
  text: string;
  keyTakeaway: string;
  tags: string[];
  citedCount: number;
}

export interface LawyerMatchResult {
  lawyer: LawyerProfile;
  matchScore: number;
  matchReasons: string[];
  estimatedCostRange: string;
}

import type { ZodType } from 'zod';

export type ProviderId = 'openai' | 'anthropic';

export interface ModelInfo {
  id: string;
  displayName: string;
  createdAt: string | null;
  deprecated: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenerateJSONRequest<T> {
  model: string;
  system: string;
  user: string;
  schema: ZodType<T>;
  schemaName: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface GenerateJSONResult<T> {
  data: T;
  usage: Usage;
  model: string;
}

export interface StreamChatRequest {
  model: string;
  system: string;
  messages: ChatTurn[];
  maxTokens?: number;
  onText: (delta: string) => void;
  signal?: AbortSignal;
}

export interface StreamChatResult {
  text: string;
  usage: Usage;
  model: string;
}

/**
 * Provider adapter contract. New providers implement this interface and are
 * registered in `createProvider`; nothing else in the app is vendor-specific.
 */
export interface AIProvider {
  readonly id: ProviderId;
  listModels(): Promise<ModelInfo[]>;
  generateJSON<T>(req: GenerateJSONRequest<T>): Promise<GenerateJSONResult<T>>;
  streamChat(req: StreamChatRequest): Promise<StreamChatResult>;
}

export type AIErrorCode =
  | 'not_configured'
  | 'invalid_key'
  | 'permission_denied'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'model_not_found'
  | 'bad_request'
  | 'refused'
  | 'invalid_output'
  | 'unavailable'
  | 'timeout';

export class AIError extends Error {
  constructor(
    public readonly code: AIErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'AIError';
  }
}

/** User-facing explanations — never include provider response bodies (could echo keys). */
export const AI_ERROR_MESSAGES: Record<AIErrorCode, string> = {
  not_configured: 'No AI provider is connected. Add one in Settings → AI.',
  invalid_key: 'The AI provider rejected the API key. Check or replace it in Settings → AI.',
  permission_denied: 'Your API key does not have access to this model or feature.',
  rate_limited: 'The AI provider is rate-limiting requests. Try again in a minute.',
  budget_exceeded: 'Your monthly AI spending limit has been reached. Adjust it in Settings → AI.',
  model_not_found: 'The selected model is not available to your account. Choose another model in Settings → AI.',
  bad_request: 'The AI provider rejected the request.',
  refused: 'The AI provider declined to answer this request.',
  invalid_output: 'The AI response could not be validated, so it was discarded.',
  unavailable: 'The AI provider is temporarily unavailable.',
  timeout: 'The AI provider took too long to respond.',
};

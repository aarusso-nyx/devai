// ADR-MDL-0001: the model bridge's shared reply extractor. It is implemented once in
// @devai-nyx/schemas beside getValidator, because the judge sensor and the triage
// tie-breaker sit below this package and must read replies through the same code.
export {
  extractStructuredReply,
  providerReplySchema,
  REPLY_EXCERPT_MAX_CHARS,
  REPLY_PROJECTION_VERSION,
  replyProjectionIdentity,
  replySha256,
} from '@devai-nyx/schemas';
export type {
  ReplyErrorCode,
  ReplyExtraction,
  ReplyExtractionError,
  ReplyFinishReason,
  ReplySchemaName,
  StructuredReply,
} from '@devai-nyx/schemas';

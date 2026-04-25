export type MemoryType =
  | "project-config"
  | "architecture"
  | "error-solution"
  | "preference"
  | "learned-pattern"
  | "conversation";

export type ConversationRole = "user" | "assistant" | "system" | "tool";

export type ConversationContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; imageUrl: { url: string } };

export interface ConversationMessage {
  role: ConversationRole;
  content: string | ConversationContentPart[];
  name?: string;
}

export interface ConversationIngestResponse {
  id: string;
  conversationId: string;
  status: string;
}

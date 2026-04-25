export function stripPrivateContent(content: string): string {
  return content.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]");
}

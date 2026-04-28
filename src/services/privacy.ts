export function stripPrivateContent(content: string): string {
  return content.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]");
}

export function cleanContent(content: string): string {
  return content
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<supermemory-context>[\s\S]*?<\/supermemory-context>/gi, "")
    .trim();
}

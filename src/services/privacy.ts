export function stripPrivateContent(content: string): string {
  return content.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]");
}

// Codex injects the sandbox/cwd context and AGENTS.md as user-role messages; they are not the user's words.
export function cleanContent(content: string): string {
  return content
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<supermemory-context>[\s\S]*?<\/supermemory-context>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/gi, "")
    .replace(/# AGENTS\.md instructions for [^\n]*\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, "")
    .trim();
}

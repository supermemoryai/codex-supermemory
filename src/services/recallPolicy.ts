export const MIN_RECALL_QUERY_CHARS = 12;
export const MAX_RECALL_QUERY_CHARS = 500;

export function shouldRecallPrompt(prompt: string): boolean {
  const query = prompt.trim();
  if (query.length < MIN_RECALL_QUERY_CHARS) return false;
  return !["/", "!", "#"].some((prefix) => query.startsWith(prefix));
}

export function prepareRecallQuery(prompt: string): string {
  return prompt.trim().slice(0, MAX_RECALL_QUERY_CHARS);
}

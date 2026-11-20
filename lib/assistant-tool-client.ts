import {
  assistantResourceId, exactAssistantObject, parseAssistantToolInput, parseAssistantToolResult,
  type AssistantToolCall, type AssistantToolError, type AssistantToolReply,
} from '@/lib/assistant-tools';

export type AssistantLookup = AssistantToolReply | { error: AssistantToolError };

export function assistantToolEndpoint(base: string | undefined): string | null {
  if (!base) return null;
  try {
    const url = new URL(base);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return `${url.origin}/v1/lookup`;
  } catch { return null; }
}

export async function requestAssistantTool(
  base: string, clinicId: string, token: string, call: AssistantToolCall, signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<AssistantLookup> {
  const endpoint = assistantToolEndpoint(base);
  if (!endpoint) return { error: 'unavailable' };
  if (!assistantResourceId.test(clinicId) || !parseAssistantToolInput(call.tool, call.input)) return { error: 'invalid-request' };
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  try {
    const response = await fetcher(endpoint, {
      method: 'POST', signal: deadline, redirect: 'error', credentials: 'omit', cache: 'no-store',
      referrerPolicy: 'no-referrer', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clinicId, tool: call.tool, input: call.input }),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) return { error: 'access-denied' };
      if (response.status === 400) return { error: 'invalid-request' };
      if (response.status === 504) return { error: 'timeout' };
      return { error: 'unavailable' };
    }
    const body: unknown = await response.json();
    if (deadline.aborted) return { error: 'timeout' };
    if (!exactAssistantObject(body, ['tool', 'result']) || body.tool !== call.tool) return { error: 'unavailable' };
    if (call.tool === 'find_person_by_name') {
      const result = parseAssistantToolResult(call.tool, body.result);
      return result && result.matches.every(match => match.name === call.input.name)
        ? { tool: call.tool, result } : { error: 'unavailable' };
    }
    const result = parseAssistantToolResult(call.tool, body.result);
    return result && result.from === call.input.from && result.through === call.input.through
      ? { tool: call.tool, result } : { error: 'unavailable' };
  } catch {
    return { error: deadline.aborted ? 'timeout' : 'unavailable' };
  }
}

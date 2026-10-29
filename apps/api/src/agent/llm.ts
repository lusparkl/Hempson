/** Provider-neutral chat + tool-calling types. The agent only knows this interface; OpenAI is one implementation. */
export type ToolCall = { id: string; name: string; arguments: string };
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
export type LlmResult = { content: string | null; toolCalls: ToolCall[]; model: string; inputTokens: number; outputTokens: number };

export interface LlmClient {
  readonly model: string;
  complete(req: { messages: ChatMessage[]; tools: ToolSpec[] }): Promise<LlmResult>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export type OpenAiOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Total attempts for one request (429 / 5xx / network). */
  attempts?: number;
  maxOutputTokens?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

type WireMessage = Record<string, unknown>;
const toWire = (m: ChatMessage): WireMessage => {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant')
    return {
      role: 'assistant',
      content: m.content,
      ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}),
    };
  return { role: m.role, content: m.content };
};

/** OpenAI Chat Completions with function calling over plain `fetch` (no SDK dependency). The key is only ever sent in the Authorization header. */
export class OpenAiClient implements LlmClient {
  readonly model: string;
  private o: Required<Omit<OpenAiOptions, 'model'>>;
  constructor(opts: OpenAiOptions) {
    this.model = opts.model;
    this.o = {
      apiKey: opts.apiKey,
      baseUrl: (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
      timeoutMs: opts.timeoutMs ?? 30_000,
      attempts: opts.attempts ?? 3,
      maxOutputTokens: opts.maxOutputTokens ?? 800,
      fetch: opts.fetch ?? fetch,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  async complete(req: { messages: ChatMessage[]; tools: ToolSpec[] }): Promise<LlmResult> {
    const body = JSON.stringify({
      model: this.model,
      messages: req.messages.map(toWire),
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: 'auto' } : {}),
      max_completion_tokens: this.o.maxOutputTokens,
    });
    let last: LlmError | undefined;
    for (let attempt = 1; attempt <= this.o.attempts; attempt++) {
      try {
        return await this.once(body);
      } catch (e) {
        last = e instanceof LlmError ? e : new LlmError(e instanceof Error ? e.message : 'network error', true);
        if (!last.retryable || attempt === this.o.attempts) break;
        await this.o.sleep(500 * 2 ** (attempt - 1));
      }
    }
    throw last!;
  }

  private async once(body: string): Promise<LlmResult> {
    let res: Response;
    try {
      res = await this.o.fetch(`${this.o.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}` },
        body,
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch (e) {
      throw new LlmError(e instanceof Error ? e.name : 'network error', true);
    }
    if (!res.ok) {
      // The response body is deliberately not copied into the error: it can echo prompt content.
      throw new LlmError(`OpenAI HTTP ${res.status}`, res.status === 429 || res.status >= 500, res.status);
    }
    const j = (await res.json().catch(() => null)) as {
      model?: string;
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;
    const msg = j?.choices?.[0]?.message;
    if (!msg) throw new LlmError('OpenAI response had no message', false);
    return {
      content: msg.content?.trim() || null,
      toolCalls: (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
      model: j?.model ?? this.model,
      inputTokens: j?.usage?.prompt_tokens ?? 0,
      outputTokens: j?.usage?.completion_tokens ?? 0,
    };
  }
}

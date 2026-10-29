import type { ChatMessage, LlmClient, LlmResult, ToolSpec } from '../../apps/api/src/agent/llm';

export type LlmStep = Partial<Pick<LlmResult, 'content' | 'toolCalls' | 'inputTokens' | 'outputTokens'>>;
type Req = { messages: ChatMessage[]; tools: ToolSpec[] };
type Entry = LlmStep | Error | ((req: Req) => LlmStep | Error | Promise<LlmStep | Error>);

/** Test double for the model: plays back a script, records every request. No network, no key. */
export class ScriptedLlm implements LlmClient {
  readonly model = 'scripted-1';
  calls: Req[] = [];
  constructor(private script: Entry[]) {}
  push(...e: Entry[]) {
    this.script.push(...e);
  }
  async complete(req: Req): Promise<LlmResult> {
    this.calls.push({ messages: [...req.messages], tools: req.tools });
    const e = this.script.shift();
    if (e === undefined) throw new Error('ScriptedLlm: script exhausted');
    const r = typeof e === 'function' ? await e(req) : e;
    if (r instanceof Error) throw r;
    return { content: null, toolCalls: [], model: this.model, inputTokens: 10, outputTokens: 5, ...r };
  }
}

export const say = (content: string): LlmStep => ({ content });
export const useTool = (name: string, args: unknown, id = `call_${name}`): LlmStep => ({ toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
/** The JSON the agent gave back to the model for the last tool call. */
export const lastToolResult = (req: Req) => JSON.parse((req.messages.filter((m) => m.role === 'tool').at(-1) as { content: string }).content);

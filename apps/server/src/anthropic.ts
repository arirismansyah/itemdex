// Claude speaks its own Messages API. These two pure functions translate the OpenAI-shaped
// request the rest of the client builds, so every feature works with Claude unchanged.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const textOf = (c: unknown) =>
  typeof c === 'string' ? c : (Array.isArray(c) ? c : []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');

function block(part: Json): Json {
  if (part.type === 'text') return { type: 'text', text: part.text };
  const url: string = part.image_url?.url ?? '';
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(url);
  return { type: 'image', source: m ? { type: 'base64', media_type: m[1], data: m[2] } : { type: 'url', url } };
}

export function toAnthropicRequest(model: string, body: Json): Json {
  const msgs: Json[] = body.messages ?? [];
  const system = msgs.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
  const schema = body.response_format?.json_schema;
  return {
    model,
    max_tokens: body.max_tokens ?? 1500,
    ...(system ? { system } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    messages: msgs.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : (m.content as Json[]).map(block),
    })),
    // Forcing a tool call makes Claude return JSON that matches the schema.
    ...(schema ? {
      tools: [{ name: schema.name, description: 'Return the result', input_schema: schema.schema }],
      tool_choice: { type: 'tool', name: schema.name },
    } : {}),
  };
}

export function fromAnthropicResponse(data: Json): string {
  const blocks: Json[] = data.content ?? [];
  const tool = blocks.find((b) => b.type === 'tool_use');
  return tool ? JSON.stringify(tool.input) : blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

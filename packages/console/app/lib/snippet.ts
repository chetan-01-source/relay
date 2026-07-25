/**
 * cURL / SDK snippet builder (Day 13 DX rule) — PURE. Every entity page can show a ready-to-run
 * snippet so a user never has to hand-write a request. The gateway is OpenAI-compatible, so the
 * snippets are the official OpenAI shapes pointed at the Relay base URL with the caller's key.
 */
export interface SnippetInputs {
  baseUrl: string; // e.g. http://localhost:3000
  apiKey: string; // the virtual key (shown once) or a placeholder like rk_live_…
  model: string; // e.g. gpt-4o
}

export type SnippetLang = 'curl' | 'python' | 'node';

export function buildSnippet(lang: SnippetLang, input: SnippetInputs): string {
  const base = input.baseUrl.replace(/\/$/, '');
  const { apiKey, model } = input;
  if (lang === 'curl') {
    return [
      `curl ${base}/v1/chat/completions \\`,
      `  -H "authorization: Bearer ${apiKey}" \\`,
      `  -H "content-type: application/json" \\`,
      `  -d '{"model":"${model}","messages":[{"role":"user","content":"hello"}]}'`,
    ].join('\n');
  }
  if (lang === 'python') {
    return [
      `from openai import OpenAI`,
      ``,
      `client = OpenAI(base_url="${base}/v1", api_key="${apiKey}")`,
      `resp = client.chat.completions.create(`,
      `    model="${model}",`,
      `    messages=[{"role": "user", "content": "hello"}],`,
      `)`,
      `print(resp.choices[0].message.content)`,
    ].join('\n');
  }
  return [
    `import OpenAI from "openai";`,
    ``,
    `const client = new OpenAI({ baseURL: "${base}/v1", apiKey: "${apiKey}" });`,
    `const resp = await client.chat.completions.create({`,
    `  model: "${model}",`,
    `  messages: [{ role: "user", content: "hello" }],`,
    `});`,
    `console.log(resp.choices[0].message.content);`,
  ].join('\n');
}

export const SNIPPET_LANGS: SnippetLang[] = ['curl', 'python', 'node'];

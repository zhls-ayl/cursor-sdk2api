import { afterEach, expect, test, vi } from "vitest";
import { postMessages } from "./lib/client.js";

afterEach(() => vi.unstubAllGlobals());

test("live client preserves streamed tool arguments for continuation assertions", async () => {
  const frames = [
    { type: "message_start", message: { type: "message", role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_1", name: "live_alpha", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"token":' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"CHECK"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 1, output_tokens: 2 } },
    { type: "message_stop" },
  ];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    frames.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  )));
  const res = await postMessages({ baseUrl: "http://localhost", apiKey: "synthetic", body: {}, timeoutMs: 1000 });
  expect(res.raw).toMatchObject({ content: [{ type: "tool_use", input: { token: "CHECK" } }], stop_reason: "tool_use" });
});

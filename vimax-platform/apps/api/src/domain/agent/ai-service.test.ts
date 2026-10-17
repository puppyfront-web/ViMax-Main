import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiStreamAccumulator } from "./ai-service.js";

// ── text + thinking passthrough ────────────────────────────────────

test("feedChoice yields text deltas immediately", () => {
  const acc = new OpenAiStreamAccumulator();
  const out = acc.feedChoice({ delta: { content: "hello" } });
  assert.deepEqual(out, [{ type: "text-delta", text: "hello" }]);
});

test("feedChoice emits thinking-start once, then thinking-deltas", () => {
  const acc = new OpenAiStreamAccumulator();
  const a = acc.feedChoice({ delta: { reasoning_content: "hm" } });
  assert.equal(a[0]!.type, "thinking-start");
  assert.equal(a[1]!.type, "thinking-delta");
  const b = acc.feedChoice({ delta: { reasoning_content: " more" } });
  // no second thinking-start
  assert.equal(b[0]!.type, "thinking-delta");
});

// ── tool-call fragmentation (the bug this fixes) ───────────────────

test("flush assembles a tool call whose args were streamed in fragments", () => {
  const acc = new OpenAiStreamAccumulator();
  // First chunk: name + start of args (incomplete JSON).
  acc.feedChoice({
    delta: {
      tool_calls: [{
        index: 0,
        id: "call_1",
        function: { name: "generate_script", arguments: '{"prompt":"做一' },
      }],
    },
  });
  // Second chunk: continuation — no name, more args.
  acc.feedChoice({
    delta: {
      tool_calls: [{
        index: 0,
        function: { arguments: '个电商广告短视频"' },
      }],
    },
  });
  // Third chunk: closing brace.
  acc.feedChoice({
    delta: {
      tool_calls: [{ index: 0, function: { arguments: "}" } }],
    },
  });

  const flushed = acc.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]!.type, "tool-call");
  assert.equal(flushed[0]!.toolName, "generate_script");
  assert.deepEqual(flushed[0]!.toolArgs, { prompt: "做一个电商广告短视频" });
});

test("flush assembles multiple concurrent tool calls by index", () => {
  const acc = new OpenAiStreamAccumulator();
  acc.feedChoice({ delta: { tool_calls: [{ index: 0, function: { name: "run_node", arguments: '{"nodeId":"a"' } }] } });
  acc.feedChoice({ delta: { tool_calls: [{ index: 1, function: { name: "run_node", arguments: '{"nodeId":"b"' } }] } });
  acc.feedChoice({ delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] } });
  acc.feedChoice({ delta: { tool_calls: [{ index: 1, function: { arguments: "}" } }] } });

  const flushed = acc.flush();
  assert.equal(flushed.length, 2);
  assert.equal(flushed[0]!.toolArgs!.nodeId, "a");
  assert.equal(flushed[1]!.toolArgs!.nodeId, "b");
});

test("flush yields nothing when no tool call name was ever received", () => {
  const acc = new OpenAiStreamAccumulator();
  acc.feedChoice({ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } });
  assert.equal(acc.flush().length, 0);
});

test("flush carries the provider tool-call id for the loop to echo back", () => {
  const acc = new OpenAiStreamAccumulator();
  acc.feedChoice({
    delta: {
      tool_calls: [{ index: 0, id: "call_abc", function: { name: "generate_image", arguments: "{}" } }],
    },
  });
  assert.equal(acc.flush()[0]!.toolCallId, "call_abc");
});

test("flush omits toolCallId when the provider never sent one", () => {
  const acc = new OpenAiStreamAccumulator();
  acc.feedChoice({
    delta: { tool_calls: [{ index: 0, function: { name: "f", arguments: "{}" } }] },
  });
  assert.equal(acc.flush()[0]!.toolCallId, undefined);
});

test("flush is idempotent (clears pending)", () => {
  const acc = new OpenAiStreamAccumulator();
  acc.feedChoice({ delta: { tool_calls: [{ index: 0, function: { name: "f", arguments: "{}" } }] } });
  assert.equal(acc.flush().length, 1);
  assert.equal(acc.flush().length, 0);
});

test("finish_reason ends an open thinking span", () => {
  const acc = new OpenAiStreamAccumulator();
  acc.feedChoice({ delta: { reasoning_content: "x" } });
  const out = acc.feedChoice({ finish_reason: "stop" });
  assert.ok(out.some((c) => c.type === "thinking-end"));
});

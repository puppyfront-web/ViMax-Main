import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNodeData } from "./decision-layer.js";

test("normalizeNodeData keeps valid object payloads untouched", () => {
  const data = { prompt: "a dog", size: "1024x1024" };
  assert.deepEqual(normalizeNodeData("image", data), data);
});

test("normalizeNodeData maps a string payload into the node type's text field", () => {
  assert.deepEqual(normalizeNodeData("image", "一只金毛犬"), {
    prompt: "一只金毛犬",
    status: "idle",
  });
  assert.deepEqual(normalizeNodeData("shot", "镜头2：草地奔跑"), {
    ffDesc: "镜头2：草地奔跑",
    status: "idle",
  });
  assert.deepEqual(normalizeNodeData("script", "剧本正文"), {
    content: "剧本正文",
    status: "idle",
  });
  assert.deepEqual(normalizeNodeData("storyboard_cell", "远景，跟拍"), {
    shotBrief: "远景，跟拍",
    status: "idle",
  });
  assert.deepEqual(normalizeNodeData("character", "金毛犬豆包"), {
    description: "金毛犬豆包",
    status: "idle",
  });
});

test("normalizeNodeData falls back to an empty object for missing/unknown payloads", () => {
  assert.deepEqual(normalizeNodeData("video", undefined), {});
  assert.deepEqual(normalizeNodeData("video", "  "), {});
  assert.deepEqual(normalizeNodeData("video", ["镜头1"]), {});
  assert.deepEqual(normalizeNodeData("concat", null), {});
});

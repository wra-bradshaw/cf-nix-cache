import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJsonc } from "./jsonc.mts";

test("strips line and block comments", () => {
  const source = `{
    // a line comment
    "a": 1, /* a block
    comment */ "b": 2
  }`;
  assert.deepEqual(parseJsonc(source), { a: 1, b: 2 });
});

test("removes trailing commas in objects and arrays", () => {
  const source = `{
    "list": [1, 2, 3,],
    "nested": { "x": [ { "y": true, }, ], },
  }`;
  assert.deepEqual(parseJsonc(source), {
    list: [1, 2, 3],
    nested: { x: [{ y: true }] },
  });
});

test("removes a trailing comma followed by a comment", () => {
  assert.deepEqual(parseJsonc(`[1, // last\n]`), [1]);
});

test("leaves string contents untouched", () => {
  const source = `{
    "comma": "a, }",
    "bracket": "b ,]",
    "line": "https://example.com",
    "block": "/* not a comment */",
  }`;
  assert.deepEqual(parseJsonc(source), {
    comma: "a, }",
    bracket: "b ,]",
    line: "https://example.com",
    block: "/* not a comment */",
  });
});

test("handles escaped quotes and backslashes inside strings", () => {
  const source = String.raw`{
    "quote": "say \"hi, }\" // still a string",
    "slash": "ends with a backslash \\",
    "after": "x",
  }`;
  assert.deepEqual(parseJsonc(source), {
    quote: 'say "hi, }" // still a string',
    slash: "ends with a backslash \\",
    after: "x",
  });
});

/**
 * Calls rescued from LiteRT-LM.js's "Failed to parse tool calls" -- no deck, no browser.
 *
 * The replay provider drives the prompted path only, so a fixture cannot reach this one.
 * The first error below is the runtime's message VERBATIM, pasted from the chat: the
 * runtime's wording is the input under test, and a tidied copy would test a format it
 * never produced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { salvageCalls } from "../chat/agent/act/salvage.js";

const TOOLS = [{ name: "edit_text" }, { name: "go_to_slide" }];

// "Change the heading of this slide to "Bye!"" -- Gemma 4 E2B, native tools, slide 24.
const ASCII_QUOTES = new Error(
  'Failed to parse tool calls from code block: call:edit_text{find: "Thanks!", slide: 24, text: "Bye!"} full response: <|tool_call>call:edit_text{find: "Thanks!", slide: 24, text: "Bye!"}<tool_call|> error: Failed to parse FC tool calls: FallThrough(ParseCancelledError(NoAltError(NoViableAltError { base: BaseRecognitionError { message: "", offending_token: GenericToken { token_type: 13, channel: 0, start: 22, stop: 27, token_index: 6, line: 1, column: 22, text: "Thanks", read_only: false }, offending_state: 44, states_stack: [36, 22, 18, 12] }, start_token: GenericToken { token_type: 13, channel: 0, start: 22, stop: 27, token_index: 6, line: 1, column: 22, text: "Thanks", read_only: false } })))',
);

const failed = (reply) =>
  new Error(
    `Failed to parse tool calls from code block: x full response: ${reply} error: Failed to parse FC tool calls: ...`,
  );

test("the recorded ASCII-quoted call is read and kept whole", () => {
  const calls = salvageCalls(ASCII_QUOTES, TOOLS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, TOOLS[0]);
  assert.deepEqual(calls[0].args, { find: "Thanks!", slide: 24, text: "Bye!" });
});

test("token quotes, quoted keys, escapes and several calls in order", () => {
  const calls = salvageCalls(
    failed(
      '<|tool_call>call:go_to_slide{"move": "last"}<tool_call|>' +
        '<|tool_call>call:edit_text{find:<|"|>A, B<|"|>,text:"line \\"one\\"\\ntwo"}<tool_call|>',
    ),
    TOOLS,
  );
  assert.deepEqual(
    calls.map(({ tool, args }) => [tool.name, args]),
    [
      ["go_to_slide", { move: "last" }],
      ["edit_text", { find: "A, B", text: 'line "one"\ntwo' }],
    ],
  );
});

test("anything not read with certainty leaves the error standing", () => {
  // Some other failure.
  assert.equal(salvageCalls(new Error("Conversation cancelled"), TOOLS), null);
  // A tool the turn never declared.
  assert.equal(
    salvageCalls(
      failed("<|tool_call>call:delete_deck{all: true}<tool_call|>"),
      TOOLS,
    ),
    null,
  );
  // An unterminated string, and a nested value no deck tool takes.
  for (const body of ['find: "Thanks', "find: {a: 1}", "find: Thanks"]) {
    assert.equal(
      salvageCalls(
        failed(`<|tool_call>call:edit_text{${body}}<tool_call|>`),
        TOOLS,
      ),
      null,
      body,
    );
  }
  // One readable call does not license running a turn whose other call was unreadable.
  assert.equal(
    salvageCalls(
      failed(
        '<|tool_call>call:go_to_slide{move: "last"}<tool_call|><|tool_call>call:edit_text{find: oops}<tool_call|>',
      ),
      TOOLS,
    ),
    null,
  );
});

/**
 * The WebMCP dispatcher, against a fake host -- no deck, no browser.
 *
 * The fake answers the way Chrome did when checked against this deck: `getTools()` lists
 * tools with `name`, `origin` and `window`, and `executeTool()` resolves to a JSON string.
 * Whether real Chrome still does is a check in the browser, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDispatch, fromHost, VIA } from "../chat/mcp/host.js";

const ours = {};
const theirs = {};

const OK = { content: [{ type: "text", text: "slide 1 of 26" }] };

/** A registry entry, as `mcp/index.js` builds it. Counts direct calls. */
const tool = (name = "get_slide") => {
  const entry = {
    name,
    direct: 0,
    call: async () => {
      entry.direct += 1;
      return OK;
    },
  };
  return entry;
};

/** A host that lists `listed` and runs each call through `run`. */
const host = ({ listed = [{ name: "get_slide", window: ours }], run } = {}) => {
  const fake = {
    listings: 0,
    executed: [],
    listeners: {},
    registerTool: () => {},
    getTools: async () => {
      fake.listings += 1;
      return listed;
    },
    executeTool: async (found, args) => {
      fake.executed.push({ found, args });
      return run ? run(found, args) : JSON.stringify(OK);
    },
    addEventListener: (type, fn) => (fake.listeners[type] = fn),
  };
  return fake;
};

const dispatchFor = (mc, enabled) =>
  createDispatch({ getModelContext: () => mc, win: ours, enabled });

test("no host: calls the registry directly", async () => {
  const t = tool();
  const { result, via } = await dispatchFor(undefined)(t, { slide: 1 });
  assert.equal(via, VIA.direct);
  assert.equal(t.direct, 1);
  assert.deepEqual(result, OK);
});

test("a host without executeTool, like an injected polyfill: direct", async () => {
  const t = tool();
  const { via } = await dispatchFor({ registerTool: () => {} })(t, {});
  assert.equal(via, VIA.direct);
  assert.equal(t.direct, 1);
});

test("host: goes through executeTool and parses the string it returns", async () => {
  const t = tool();
  const mc = host();
  const { result, via } = await dispatchFor(mc)(t, { slide: 1 });
  assert.equal(via, VIA.webmcp);
  assert.equal(t.direct, 0);
  assert.deepEqual(mc.executed[0].args, { slide: 1 });
  assert.deepEqual(result, OK);
});

test("host: an object result is passed through as it is", async () => {
  const mc = host({ run: () => OK });
  const { result } = await dispatchFor(mc)(tool(), {});
  assert.deepEqual(result, OK);
});

test("host: a refusal keeps the deck's wording and its isError", async () => {
  const refusal = {
    isError: true,
    content: [{ type: "text", text: '"abc" is not a slide number.' }],
  };
  const mc = host({ run: () => JSON.stringify(refusal) });
  const { result } = await dispatchFor(mc)(tool(), { slide: "abc" });
  assert.deepEqual(result, refusal);
});

test("host: a rejection becomes an isError result, not a throw", async () => {
  const mc = host({
    run: () => {
      throw new Error("tool is busy");
    },
  });
  const { result, via } = await dispatchFor(mc)(tool(), {});
  assert.equal(via, VIA.webmcp);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /tool is busy/);
});

test("host: only this window's tool is called, not a same-named one", async () => {
  const mc = host({
    listed: [
      { name: "get_slide", window: theirs },
      { name: "get_slide", window: ours },
    ],
  });
  await dispatchFor(mc)(tool(), {});
  assert.equal(mc.executed[0].found.window, ours);
});

test("host lists the name only for another window: direct", async () => {
  const t = tool();
  const mc = host({ listed: [{ name: "get_slide", window: theirs }] });
  const { via } = await dispatchFor(mc)(t, {});
  assert.equal(via, VIA.direct);
  assert.equal(t.direct, 1);
  assert.equal(mc.executed.length, 0);
});

test("the host's list is cached until toolchange", async () => {
  const mc = host();
  const dispatch = dispatchFor(mc);
  await dispatch(tool(), {});
  await dispatch(tool(), {});
  assert.equal(mc.listings, 1);
  mc.listeners.toolchange();
  await dispatch(tool(), {});
  assert.equal(mc.listings, 2);
});

test("getTools() rejecting falls back to direct, and asks again next time", async () => {
  const t = tool();
  const mc = host();
  let fail = true;
  const list = mc.getTools;
  mc.getTools = async () => {
    if (fail) throw new Error("host gone");
    return list();
  };
  const dispatch = dispatchFor(mc);
  const first = await dispatch(t, {});
  assert.equal(first.via, VIA.direct);
  assert.equal(t.direct, 1);
  fail = false;
  const second = await dispatch(t, {});
  assert.equal(second.via, VIA.webmcp);
});

test("a toolchange while getTools() is pending does not cache the old list", async () => {
  const mc = host();
  let release;
  const list = mc.getTools;
  mc.getTools = () =>
    new Promise((resolve) => (release = () => resolve(list())));
  const dispatch = dispatchFor(mc);
  const call = dispatch(tool(), {});
  mc.listeners.toolchange();
  release();
  await call;
  mc.getTools = list;
  await dispatch(tool(), {});
  assert.equal(mc.listings, 2);
});

test("a tool missing from the list is looked up again on the next call", async () => {
  const listed = [];
  const mc = host();
  // A fresh array per call, as a real host returns: a shared one would let a stale
  // cache see the push below and pass for the wrong reason.
  mc.getTools = async () => [...listed];
  const dispatch = dispatchFor(mc);
  assert.equal((await dispatch(tool(), {})).via, VIA.direct);
  listed.push({ name: "get_slide", window: ours });
  assert.equal((await dispatch(tool(), {})).via, VIA.webmcp);
});

test("?direct (enabled false) skips the host even when there is one", async () => {
  const t = tool();
  const mc = host();
  const dispatch = dispatchFor(mc, () => false);
  const { via } = await dispatch(t, {});
  assert.equal(via, VIA.direct);
  assert.equal(dispatch.via(), VIA.direct);
  assert.equal(mc.executed.length, 0);
});

/** A Chrome 154 host: arguments must be a JSON string, an object is refused unrun. */
const chrome154 = () => {
  const mc = host();
  const run = mc.executeTool;
  mc.ran = [];
  mc.executeTool = async (found, args) => {
    if (typeof args !== "string") {
      mc.executed.push({ found, args, refused: true });
      throw new Error("Failed to parse input arguments");
    }
    mc.ran.push(args);
    return run(found, args);
  };
  return mc;
};

test("Chrome 154: an object is refused, so the JSON string is sent", async () => {
  const mc = chrome154();
  const { result, via } = await dispatchFor(mc)(tool(), { move: "last" });
  assert.equal(via, VIA.webmcp);
  assert.deepEqual(mc.ran, ['{"move":"last"}']);
  assert.deepEqual(result, OK);
});

test("Chrome 154: once found out, later calls go straight to the string", async () => {
  const mc = chrome154();
  const dispatch = dispatchFor(mc);
  await dispatch(tool(), { slide: 1 });
  await dispatch(tool(), { slide: 2 });
  assert.equal(mc.executed.filter((call) => call.refused).length, 1);
  assert.deepEqual(mc.ran, ['{"slide":1}', '{"slide":2}']);
});

test("a different rejection is not retried as a string", async () => {
  let calls = 0;
  const mc = host({
    run: () => {
      calls += 1;
      throw new Error("tool is busy");
    },
  });
  const { result } = await dispatchFor(mc)(tool(), {});
  assert.equal(calls, 1);
  assert.equal(result.isError, true);
});

test("fromHost: null is the navigation case; non-JSON text is kept", () => {
  assert.match(fromHost(null).content[0].text, /navigated/);
  assert.deepEqual(fromHost("plain words"), {
    content: [{ type: "text", text: "plain words" }],
  });
});

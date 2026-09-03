/**
 * Every fixture, replayed against a real deck in a real browser.
 *
 * ARRANGE A CHROME AND A DEV SERVER; THE HARNESS DOES THE REST. `cdp.js` reuses a deck tab
 * if one is open and opens its own if not, so the setup is:
 *
 *   npm run dev
 *   npm run cdp
 *
 * SKIPPED RATHER THAN FAILED when either is missing, because that is the ordinary state of
 * a checkout: `npm test` on a laptop with nothing running should be green and fast. The
 * skip carries the specific reason -- no CDP, or nothing being served -- because "skipped"
 * with no cause is the state people stop noticing.
 *
 * ONE ASSERTION PER FIXTURE, on `report.ok`, with `report.failures` as the message. The
 * runner already knows how to describe a mismatch -- which turn, which call, which slide --
 * and re-deriving that here would be a second opinion on the same data, worded worse. What
 * this file owns is the browser, not the judgement.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { connect, disconnect, runFixture } from "./cdp.js";

const DIR = new URL("./fixtures/", import.meta.url);
const names = (await readdir(DIR)).filter((name) => name.endsWith(".json"));

let deck = null;

before(async () => {
  deck = await connect();
});

// A tab this suite opened is closed again; one it found is left as it was.
after(() => disconnect(deck));

for (const name of names) {
  test(`${name}: replays against the live deck`, async (t) => {
    if (!deck?.session) return t.skip(deck?.reason ?? "no deck");

    const fixture = JSON.parse(await readFile(new URL(name, DIR), "utf8"));
    const report = await runFixture(deck.session, fixture);

    // Printed before the assertion, so a failure shows the whole run rather than only the
    // first thing that went wrong. A replay is a sequence, and the turn before the failing
    // one is usually where the cause is.
    if (!report.ok) console.error(JSON.stringify(report, null, 2));

    assert.ok(report.ok, `${name}\n  ${report.failures.join("\n  ")}`);
  });
}

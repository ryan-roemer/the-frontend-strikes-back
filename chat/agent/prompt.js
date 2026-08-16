/**
 * The system prompt: who the assistant is, and everything about the deck that
 * does not change while it is running.
 *
 * A FUNCTION, not a constant, and that is now load-bearing rather than merely
 * tidy. `outlineText()` reads a live harvest of the fiber tree, so this cannot be
 * a string evaluated at import time -- at import time there is no deck yet.
 * `chat/index.js` hands it over via `setSystemPrompt`, and `model-state.js` calls
 * it at the moment a session is actually created.
 *
 * WHAT GOES HERE AND WHAT DOES NOT IS DECIDED BY VOLATILITY, not by importance.
 * The system prompt is fixed when the session is created, so anything that
 * changes while the deck is running cannot live here -- rebuilding the session on
 * every navigation would be a full `create()` on Chrome. The slide on screen is
 * therefore NOT here; see `deck-context.js`.
 *
 * THE BUDGET. Both providers have a real input window around 8-9k tokens, and
 * LiteRT re-prefills the whole preface on every turn (`providers/litert.js`), so
 * a token here is a token paid again on every answer at ~1,600 tok/s. This block
 * costs ~680 and buys ~0.4s per turn:
 *
 *   identity + capabilities   ~60 tok
 *   <deck-facts>             ~350 tok   the argument, from the data modules
 *   <deck-outline>           ~270 tok   35 titles
 *
 * The alternative was the whole deck as Markdown -- 16,100 characters, ~4,000
 * tokens, 49% of the window and +2.5s on every turn, taking a ~1s answer to
 * ~3.5s. It also carries the speaker notes, which are full of presenter timings,
 * TODOs and "first cut if we're running long". Those must not reach a model that
 * is answering out loud, in a room, with the notes' author standing in it.
 *
 * `deck-context-handoff.md` §4 dropped the outline from the per-turn default
 * because navigation commands never read it. That was right for the WebMCP
 * command router and is wrong here: "which slide covers WebMCP" and "what's the
 * argument" are most of what a Q&A chat is asked, and the outline answers the
 * first for 270 tokens with no retrieval at all.
 */
import { chapters } from "../../deck/chapters.js";
import { AUDIENCES, takeaways, VERDICTS } from "../../deck/takeaways.js";
import { outline, outlineText } from "../harvest/views.js";

/** Matches the tag-delimiting in `harvest/views.js`, and for the same reason. */
const tagged = (tag, lines) => [`<${tag}>`, ...lines, `</${tag}>`].join("\n");

/**
 * The talk's argument, from the modules that define it.
 *
 * READ FROM THE DATA, NOT FROM A HARVEST. `deck/takeaways.js` and
 * `deck/chapters.js` exist precisely because each of these appears several times
 * across the deck and hand-copies drift; harvesting them back out of the rendered
 * slides would reassemble from three lossy copies something we can read from the
 * source of truth in one line each.
 *
 * The `detail` line is included and `provenance`-style metadata is not: a detail
 * is the caveat that makes a claim honest ("good for narrow jobs, not your
 * product's core... yet"), which is exactly the nuance a small model drops if you
 * give it only the headline.
 */
const factsText = () =>
  tagged("deck-facts", [
    "This is a conference talk. Its five chapters:",
    ...chapters.map(({ n, title }) => `  ${n}. ${title}`),
    "",
    "The six takeaways the talk exists to land:",
    ...takeaways.map(({ n, text, detail, verdict }) => {
      const mark = verdict ? ` [${VERDICTS[verdict]?.title ?? verdict}]` : "";
      return `  ${n}. ${text}${mark}${detail ? ` -- ${detail}` : ""}`;
    }),
    "",
    "Who it is for, and what each half of the room should leave doing:",
    ...AUDIENCES.map(
      ({ who, claim, action }) => `  ${who}: ${claim} ${action}`,
    ),
  ]);

const IDENTITY = [
  "You are a small AI model running entirely on the user's own machine, inside a slide deck about on-device AI in the browser.",
  "No network request leaves this page when you answer.",
  "",
  "Be brief and direct. Two or three sentences unless asked for more.",
  "If you don't know something, say so plainly rather than guessing.",
];

/**
 * What the assistant can and cannot see.
 *
 * WORTH GETTING EXACTLY RIGHT, because both ways of being wrong fail on stage.
 * Overstate it and the model answers confidently about slide 22, whose text it
 * has never been given. Understate it -- the old line was a flat "you have no
 * access to the slides" -- and it refuses to discuss the slide it is currently
 * being shown, in front of an audience watching that slide.
 *
 * So it is stated as three specifics rather than as a posture: the outline of
 * all of them, the full text of the ones asked about, nothing else.
 */
const CAPABILITIES = [
  "",
  "You can see the deck's outline and argument below, and the full text of any slide you have been shown in this conversation.",
  "A slide's text is given in full, including any part that animates in later, so answer about all of it rather than guessing at what is on screen right now.",
  "When a slide holds a code sample, its complete source is given in a fenced block and is the real file from this project, so quote and explain it directly.",
  "You cannot see the full text of other slides, the speaker notes, the web, or any tools.",
  "If a question needs a slide you have not been shown, say which slide number to go to rather than guessing at its contents.",
];

export const systemPrompt = () =>
  [
    ...IDENTITY,
    ...CAPABILITIES,
    "",
    factsText(),
    "",
    outlineText(outline()),
  ].join("\n");

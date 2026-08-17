/**
 * The system prompt: who the assistant is, and everything about the deck that
 * does not change while it is running.
 *
 * A FUNCTION, not a constant: `outlineText()` reads a live harvest of the fiber
 * tree, and at import time there is no deck yet. `chat/index.js` hands it over via
 * `setSystemPrompt`, and it is called when a session is created.
 *
 * VOLATILITY DECIDES WHAT GOES HERE, not importance. The system prompt is fixed
 * when the session is created, so anything that changes while the deck runs cannot
 * live here -- rebuilding on every navigation is a full `create()` on Chrome. The
 * slide on screen is therefore in `deck-context.js` instead.
 *
 * THE BUDGET. LiteRT re-prefills the whole preface every turn, so a token here is
 * paid again on every answer at ~1,600 tok/s. This block costs ~680 and ~0.4s:
 *
 *   identity + capabilities   ~60 tok
 *   <deck-facts>             ~350 tok   the argument, from the data modules
 *   <deck-outline>           ~270 tok   35 titles
 *
 * The whole deck as Markdown would be ~4,000 tokens -- 49% of the window and
 * +2.5s per turn -- and would carry the speaker notes, which hold presenter
 * timings and TODOs that must not reach a model answering out loud in a room.
 *
 * The outline earns its 270 tokens here even though the WebMCP command router
 * drops it: "which slide covers X" and "what's the argument" are most of what a
 * Q&A chat is asked, and it answers the first with no retrieval at all.
 */
import { chapters } from "../../deck/chapters.js";
import { AUDIENCES, takeaways, VERDICTS } from "../../deck/takeaways.js";
import { outline, outlineText } from "../harvest/views.js";

/** Matches the tag-delimiting in `harvest/views.js`, and for the same reason. */
const tagged = (tag, lines) => [`<${tag}>`, ...lines, `</${tag}>`].join("\n");

/**
 * The talk's argument, from the modules that define it.
 *
 * READ FROM THE DATA, NOT FROM A HARVEST. Each of these appears several times across the
 * deck, which is why `deck/takeaways.js` and `deck/chapters.js` exist -- harvesting them
 * back out of rendered slides reassembles from lossy copies what the source states once.
 *
 * `detail` is included because it is the caveat that makes a claim honest ("good for
 * narrow jobs, not your product's core... yet") -- exactly the nuance a small model drops
 * when given only the headline.
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
 * BOTH WAYS OF BEING WRONG FAIL ON STAGE. Overstate it and the model answers confidently
 * about slide 22, whose text it has never been given; understate it and it refuses to
 * discuss the slide it is being shown, in front of an audience watching that slide.
 *
 * Hence three specifics rather than a posture: the outline of all of them, the full text
 * of the ones asked about, nothing else.
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

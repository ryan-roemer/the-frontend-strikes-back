---
name: talk-transcript
description: Turn a pasted run-through transcript of this talk into a per-slide outline in docs/transcripts.md, update the speaker notes on every slide to match what was said, call out each "note to Ryan / note to self", and finish with an action item list. Use when the user pastes a talk transcript, says "here's another run-through", or asks to format a transcript into sections or update notes from one.
---

# Talk transcript → outline, notes, action items

The transcript is a speech-to-text dump of one run-through, one long paragraph. Ryan
says "note to Ryan" or "note to self" mid-talk to leave himself a fix. The job:

1. A formatted outline in `docs/transcripts.md`, one section per slide
2. Updated speaker notes on every slide in `index.html`
3. Every "note to Ryan / self" called out, plus an action item list

The previous run's section in `docs/transcripts.md` is the format to match. Read it first.

## 1. Put the raw transcript in the file

New runs go at the top, under `# Notes`, newest first: `# YYYY-MM-DD - NNN`. If the user
already pasted it into the file, work from there. Keep the raw text verbatim at the bottom
of the section under `Raw:`. Never edit the raw text.

Speech-to-text repeats phrases and garbles names ("LIDAR TLM" for LiteRT-LM, "Arama" for
Orama, "W-Llama" for wllama). Fix these in the outline, not in the raw text.

## 2. Map the transcript to the slides

Read the deck in `index.html` from top to bottom (`docs/slide-types.md` explains each
component). Split the transcript at each slide change. These phrases usually mark one:
"let's go to the next slide", "so let's talk about", "all right", or the next slide's
title said out loud.

Watch for content that moved to a different slide than in the last run (for example a
demo walkthrough said over a code slide). Follow what was said, and flag the move as an
action item so Ryan can confirm it was on purpose.

Leave out anything not said to the audience, such as asides to people in the room or
interruptions. It goes in neither the outline nor the notes.

## 3. Write the outline section

Use the same shape as the previous run:

- Header: `**Run-through:** date · #NNN · **Time:** mm:ss` and the change from last run
- `## ✅ Action Items` first (see step 5)
- Parts and numbered subsections that follow the deck's chapters: `## 0. Opening`,
  `## Part 1: …`, `### 1.1 …`, ending with `## Wrap-Up`
- Short bullets in Ryan's words. Quote the lines worth keeping
- Each note to Ryan / self goes in a callout right where it was said:

  ```md
  > [!WARNING]
  > **📝 Note to Ryan:** "exact words." What it's about, in one line.
  ```

- Then `---` and `Raw:` with the transcript

## 4. Update the speaker notes on every slide

Update every slide, including ones with no notes yet. If the recording is cut off, update
only the slides it covers. Mark the rest "Not recorded" in the outline and ❓ in the
carry-over table. Notes are what Ryan reads at a
glance **while presenting**, so every bullet is something he says or does live: short
bullets, his phrasing, the demo steps in order, and the line that makes the point out
loud. Not a script.

- Merge with the existing notes, don't replace them. Keep facts and credits he didn't
  say this time (the Alex Nahas credit, "if asked" answers). Update numbers and the order
  of points to match what he said. Drop lines that no longer apply
- **No history and no prep in the notes.** Nothing about past runs: no dates, no run
  numbers, no "stuck here last time", no record of what went wrong or what he misspoke.
  No pre-talk checklist items ("preload the model before going on stage"). Those go in
  the action items in `docs/transcripts.md`, and prep goes to `docs/offline.md` or the
  offline-prep skill. A fix lands in the notes as the better line to say (a typo'd demo
  input becomes the input, spelled right; a stumble becomes the one-line close)
- Write each bullet as words he can say to the room. The only instructions are his
  all-caps stage cues for a demo step (QUERY, TOOL, PAGE, VIDEO, OPEN THE TIMINGS) in
  that form. No delivery advice to himself: not "close in one line", "one line per
  card", "in one breath", "read it off the panel"
- Resolve a `**TODO:**` in the notes if this run settled it. If it didn't, keep it, and
  put what each run said in the outline, not the notes
- A note to Ryan becomes the better talking point on that slide (the line itself,
  rewritten), never an instruction about how to say it, and never what happened

Where notes live, by slide type:

| Slide                                                                                                      | Notes go in                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MdSlide`, `JsSlide`, `DemoSlide`, `TakeawaySlide`, `MatrixSlide`, `TilesSlide`, `RowsSlide`, `TopicSlide` | the `notes=${`…`}` prop (full markdown, nested lists OK)                                                                                          |
| Hand-built `DeckSlide`                                                                                     | a `<${Notes}><${Markdown} className="notes">` child, as on the title slide                                                                        |
| `MarkdownSlideSet`                                                                                         | **Skip.** Its `Notes:` line is one plain-text line and loses everything after the first markup. List what should change as an action item instead |

Escape backticks inside notes as `` \` ``, like the existing notes do.

Speaker notes reach the deck chat only when `get_slide` is called with `notes: true`,
so they don't add to the base prompt budget. If a change makes a statement about notes
in `chat/mcp/tools.js` wrong (for example which slides have them), don't edit the tool
text: that changes the measured prompt budget. Add it as an action item that points
to the tool-call-triage skill, step 5.

## 5. Action items

At the top of the run's section:

1. **From "Notes to Ryan/Self"**: every one, as a checkbox, named by its slide
2. **Seen in the run**: things he didn't call out: misspoken names, skipped slides,
   content that moved, two different tellings of the same thing, numbers that don't
   match the slide, a `MarkdownSlideSet` note that needs an edit
3. **Carried over from the previous run**: a table of the last run's items, each marked
   ✅ / 🟡 / ❌ / ❓ against this transcript and the current code. Use ❓ when the repo
   can't show it (for example a setting on an external demo app)

## 6. Finish

- `npm run format`, then check that `git diff` only touches the notes, the outline, and
  any component that needed a `notes` prop
- The deck isn't checked in a browser here. Ask Ryan to open it and step through the
  presenter view (one step, the expected result, he pastes back what he sees)
- Don't commit. Tell Ryan what's unstaged
- In the reply: the action item list, which slides got new notes, and any slide skipped
  and why

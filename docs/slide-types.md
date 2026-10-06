# Slide types

The slide layouts this deck has, for rebuilding the middle of the talk. Each one is
a component in `deck/components.js` (or Spectacle's `MarkdownSlideSet`). The full
deck before the cut, with every type in use, is at commit `3bb7ecd`:

```sh
git show 3bb7ecd:index.html
```

| Type                     | Use it for                                                         | In the deck now                            | Example at `3bb7ecd`                           |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------- |
| `TopicSlide`             | Chapter divider: big numeral, pillar eyebrow, title, photo         | All three chapters                         | Same                                           |
| `MarkdownSlideSet`       | Plain heading and bullets, several slides in one block             | WebMCP, analogy, Available right now, etc. | "How agents use your app today"                |
| `DemoSlide`              | A live demo: label, app name, URL, steps, backup plan              | All four demos                             | Same                                           |
| `TakeawaySlide`          | Numbered cards: one centered card, or a list of them               | Chapter takeaways, Implementation, close   | "Verdict" slides, built from `byChapter(n)`    |
| `MatrixSlide`            | Comparison table with yes / no / manual marks and notes            | The five runtimes                          | Same                                           |
| `JsSlide`                | Code pane with a filename bar, from a real file in `examples/`     | Not used                                   | "Register a tool", "What you get for free"     |
| `RowsSlide`              | Rows of icon + label groups (for example agents / tools / runs on) | Not used                                   | "Many small agents, each with a small context" |
| `SeamSlide`              | Points on the left, agent → tools → implementations diagram        | Not used                                   | "Tools are the seam"                           |
| `AudienceCards`          | The two audience cards, inside a `DeckSlide`                       | Slide 4 and "So, what now?"                | Same                                           |
| `DeckSlide` (hand-built) | Anything else: title, "Hi", "Our question" slides                  | Intro slides                               | Same                                           |

## Notes on each

**`TopicSlide`**: takes `chapter={chapter(n)}`. Title, pillar, accent and background
all come from `deck/chapters.js`.

**`MarkdownSlideSet`**: spread `mdSlideProps({ chapter: n })` onto it to get the
chapter accent and slide chrome. Separate slides with `---`. The `Notes:` line has two
rules (one logical line with `\` continuations, plain text only); see the comment on
`mdSlideProps` in `deck/components.js`. `--- { "layout": "columns" }` with `::section`
gives two columns (the Links and Thanks slides use it).

**`DemoSlide`**: `demo="<id>"` turns on the backup-video button, and the id must be in
`deck/demos.js`. Leave it off for a demo with no recording. `label` defaults to
"Live demo"; the vector search slide uses "Quick demo". `points` can carry inline
markup such as `<code>`.

**`TakeawaySlide`**: `items` is a list of `{ n, text, detail, verdict? }`. One item
gets the large centered treatment; set `compact` for three or more cards so they fit.
`verdict` (a key in `VERDICTS` in `deck/takeaways.js`) adds the icon on the right. The
old chapter verdicts passed `items={byChapter(n)}`; the new slides pass items inline.

**`MatrixSlide`**: `columns` is the header row; each row is `{ icon, name, cells }`,
and each cell is `{ mark?, text, note?, value? }`. `mark` is `yes`, `no` or `manual`.
The chat's replay fixtures check this slide's cell wording.

**`JsSlide`**: to bring code slides back, restore the two lines removed from
`index.html`:

```js
import { getExamples } from "./deck/examples.js";
const examples = await getExamples();
```

then pass `filename`, `code` and `language` from `examples.<name>`. The snippet files
are still in `examples/` and listed in `deck/examples.js`.

**`RowsSlide`**: `sections` is a list of `{ title, items: [{ text, icon }] }`; `dense`
tightens the spacing.

**`SeamSlide`**: takes `points`, `agent`, `agentNote`, `boundary`, `tools`, `caption`
and `impls`. It renders the diagram from those props.

Icons are Phosphor names (`icon("name")` in markdown strings, `<Icon name="..." />` in
components).

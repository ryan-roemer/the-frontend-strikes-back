import { slides } from "./knowledge.js";

/**
 * Which slides a question is about.
 *
 * Term overlap, scored with an IDF weight. Not embeddings, and not because
 * embeddings would be hard -- joyce runs Orama plus a transformers model and it
 * works well -- but because that machinery is sized for thousands of blog chunks.
 * The corpus here is 35 short slides. Term overlap over 35 documents is instant,
 * needs no index, no model and no dependency, and at this scale it is not
 * measurably worse.
 *
 * The IDF weight is what makes it usable rather than a toy: "the deck" and "slide"
 * appear everywhere, so an unweighted count ranks by slide length. Weighting by
 * rarity means the words that actually discriminate -- "vector", "gemma",
 * "webmcp" -- decide the result.
 */

/** Words carrying no signal, including the ones specific to asking about a deck. */
const STOPWORDS = new Set([
  "a",
  "about",
  "all",
  "also",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "deck",
  "did",
  "do",
  "does",
  "for",
  "from",
  "get",
  "give",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "me",
  "much",
  "my",
  "of",
  "on",
  "one",
  "or",
  "our",
  "out",
  "presentation",
  "said",
  "say",
  "show",
  "slide",
  "slides",
  "so",
  "some",
  "talk",
  "tell",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "up",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "you",
  "your",
]);

const MIN_TERM = 3;

const terms = (text) =>
  (text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? []).filter(
    (word) => word.length >= MIN_TERM && !STOPWORDS.has(word),
  );

/**
 * Rank slides against a question.
 *
 * The ACTIVE slide is always included regardless of score, because "what does this
 * say?" and "make this shorter" are the most common things anyone asks and neither
 * shares a single word with the slide it means.
 */
export const rank = (question, { activeNumber = null, limit = 3 } = {}) => {
  const corpus = slides();
  if (!corpus.length) return [];

  const queryTerms = [...new Set(terms(question))];
  const documents = corpus.map((slide) => ({
    slide,
    bag: new Set(terms(`${slide.title} ${slide.text}`)),
  }));

  const scored = documents
    .map(({ slide, bag }) => {
      let score = 0;
      for (const term of queryTerms) {
        if (!bag.has(term)) continue;
        // How many slides contain this term at all -> how much a hit is worth.
        const spread = documents.filter((doc) => doc.bag.has(term)).length;
        score += Math.log(1 + corpus.length / spread);
        // A title hit is a stronger signal than a body hit: slide titles are
        // written to name the subject.
        if (slide.title.toLowerCase().includes(term)) score += 0.5;
      }
      return { slide, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  const picked = [];
  const seen = new Set();

  const active = corpus.find((slide) => slide.number === activeNumber);
  if (active) {
    picked.push(active);
    seen.add(active.number);
  }

  for (const { slide } of scored) {
    if (picked.length >= limit) break;
    if (seen.has(slide.number)) continue;
    picked.push(slide);
    seen.add(slide.number);
  }

  return picked.sort((a, b) => a.number - b.number);
};

/** The retrieved slides, formatted for the prompt. */
export const context = (question, options) => {
  const picked = rank(question, options);
  if (!picked.length) return "";
  return picked
    .map(
      ({ number, chapter, title, text }) =>
        `--- SLIDE ${number}${chapter ? ` (chapter ${chapter})` : ""}: ${title}\n${text}`,
    )
    .join("\n");
};

import {
  CSS_VARS,
  HEADING_TREATMENTS,
  STYLE_PROPS,
  TOGGLE_CLASSES,
} from "../deck-adapter.js";

/**
 * The shapes the model is allowed to produce.
 *
 * Two passes, ROUTE then FILL, rather than one `anyOf` union. The union is the
 * natural schema and the wrong one here: a weak model that picks the wrong branch
 * emits a perfectly VALID object that does the wrong thing to a live deck. Routing
 * first turns the hard decision into one word from a list of nine, and the fill
 * pass then sees a shape with two or three required fields.
 *
 * The live enums are still the reliability lever. Element refs, property names,
 * class names and var names are spliced in per turn, and they do two jobs: they are
 * the allowlist `planner.js` validates against, and -- because they are rendered
 * into the prompt verbatim -- they are most of what tells the model what exists on
 * this slide at all.
 *
 * What they no longer do is make a bad value IMPOSSIBLE. Under the Prompt API these
 * schemas were `responseConstraint`s, so a hallucinated ref was undecodable rather
 * than merely wrong. LiteRT-LM has no constrained decoding, so the same enums are
 * now enforced after generation -- see the header of `planner.js` for what that
 * costs and how it is contained. This file did not have to change for the swap,
 * which is the point of it being data.
 */

export const ROUTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["op"],
  properties: {
    op: {
      enum: [
        "answer",
        "set_text",
        "set_style",
        "set_var",
        "toggle_class",
        "goto",
        "deck_action",
        "undo",
        "reset",
      ],
    },
  },
};

/**
 * Per-op schemas, built against the current inventory.
 *
 * `answer` is absent on purpose: routing to it short-circuits the second pass
 * entirely, because prose belongs in a streamed turn on the durable conversation.
 * Asking for an answer as a schema-shaped field would neither stream nor survive
 * its own `maxLength`.
 */
export const opSchema = ({
  refs = [],
  slideCount = 35,
  hasChapter = true,
}) => ({
  set_text: {
    type: "object",
    additionalProperties: false,
    required: ["ref", "text"],
    properties: {
      ref: { enum: refs },
      // A layout guard as much as a model guard: the canvas is a fixed 1366x768
      // and long text overflows a slide silently.
      text: { type: "string", maxLength: 140 },
    },
  },

  set_style: {
    type: "object",
    additionalProperties: false,
    required: ["ref", "prop", "value"],
    properties: {
      ref: { enum: refs },
      prop: { enum: STYLE_PROPS },
      value: { type: "string", maxLength: 48 },
    },
  },

  set_var: {
    type: "object",
    additionalProperties: false,
    required: ["name", "value", "scope"],
    properties: {
      name: { enum: CSS_VARS },
      value: { type: "string", maxLength: 48 },
      // An enum, not a selector. The model must never author a selector.
      //
      // "chapter" is offered only when the current slide is IN one. The title slide is
      // not, and a chapter-scoped change there can only ever be refused -- so
      // "Make the whole deck accent orange" was landing on `scope: "chapter"` and
      // getting an error about chapters, on a slide where the option was meaningless.
      // Same reasoning as the live ref enum: a choice that cannot work should not be
      // on the list. `apply.js` defaults a missing scope to "deck", so dropping an
      // invalid one lands on the right answer rather than nothing.
      scope: {
        enum: hasChapter ? ["deck", "chapter", "element"] : ["deck", "element"],
      },
      ref: { enum: refs },
    },
  },

  toggle_class: {
    type: "object",
    additionalProperties: false,
    required: ["ref", "class", "on"],
    properties: {
      ref: { enum: refs },
      class: { enum: TOGGLE_CLASSES },
      // Explicit rather than inferred, so "make the cards dense" and "undo the
      // dense cards" are the same op with different booleans.
      on: { type: "boolean" },
    },
  },

  goto: {
    type: "object",
    additionalProperties: false,
    required: ["where"],
    properties: {
      where: {
        enum: [
          "next",
          "prev",
          "nextSlide",
          "prevSlide",
          "first",
          "last",
          "slide",
          "chapter",
        ],
      },
      slideIndex: { type: "integer", minimum: 1, maximum: slideCount },
      chapter: { type: "integer", minimum: 1, maximum: 5 },
    },
  },

  deck_action: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { enum: ["fullscreen", "heading_style"] },
      value: { enum: HEADING_TREATMENTS },
    },
  },

  undo: { type: "object", additionalProperties: false, properties: {} },
  reset: { type: "object", additionalProperties: false, properties: {} },
});

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
 * natural schema and the wrong one here: on-device constrained decoding handles
 * `anyOf` unevenly, and a weak model that picks the wrong branch emits a
 * perfectly VALID object that does the wrong thing to a live deck. Routing first
 * turns the hard decision into a single token from an enum of nine, and the fill
 * pass then sees a schema with two or three required fields.
 *
 * The live-enum trick is the real reliability lever. Element refs, property names,
 * class names and var names are spliced in per turn, so a hallucinated reference is
 * not merely rejected after the fact -- it is undecodable. That is worth more on a
 * 3B model than any amount of prompt wording.
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
 * entirely, because prose belongs in a streamed, unconstrained turn. A
 * `responseConstraint` on an answer would neither stream nor survive its own
 * `maxLength`.
 */
export const opSchema = ({ refs = [], slideCount = 35 }) => ({
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
      scope: { enum: ["deck", "chapter", "element"] },
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

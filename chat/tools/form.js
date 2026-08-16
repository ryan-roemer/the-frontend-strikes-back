import { createElement } from "react";
import htm from "htm";

const html = htm.bind(createElement);

/**
 * A tool's `inputSchema`, as a form.
 *
 * The schema is already the documentation an agent gets -- names, types,
 * required-ness, enums, prose. Generating the human form from the same object
 * rather than hand-writing fourteen forms is not just less code: it means the
 * form CANNOT drift from what the agent sees. If a field appears here that an
 * agent would not be told about, that is a bug in the schema, and this makes it
 * visible instead of hiding it.
 */

/**
 * The first sentence, plus a trailing parenthetical if there is one.
 *
 * Descriptions in `tools.js` are written for a model and run long -- `find_node`
 * opens with three sentences of guidance. The full text still shows in the
 * schema table above the form; this is for the placeholder inside the field,
 * where anything past a line is noise.
 */
export const summarize = (text) => {
  if (!text) return "";
  const parenthetical = text.match(/\s+(\([^)]+\))\s*$/);
  const body = parenthetical ? text.slice(0, parenthetical.index) : text;

  // A full stop only ENDS A SENTENCE when a new one starts after it. Splitting
  // on the first `.` instead turns "A node id like '9.3'" into "A node id like
  // '9." and "The value, e.g. 'red'" into "The value, e." -- both of which are
  // in this deck's schemas, and both of which read as a truncation bug rather
  // than as a summary. Requiring whitespace and then a capital or a bracket
  // costs one lookahead and gets decimals, ids and `e.g.` right.
  const first = body.match(/^.*?[.!?](?=\s+[A-Z(]|\s*$)/s);
  const head = (first ? first[0] : body).trim();
  return parenthetical ? `${head} ${parenthetical[1]}` : head;
};

/**
 * Schema properties, flattened into what a widget needs.
 *
 * `kind` collapses JSON Schema's type vocabulary onto the four controls that
 * exist. `enum` is checked BEFORE `type`, because a string with an enum is a
 * dropdown and a string without one is a text box, and that distinction matters
 * more here than the type does -- five of this deck's parameters are enums drawn
 * straight from `chat/edit/apply.js`, and typing `background-color` by hand at a
 * podium is how you find out you typed `background_color`.
 */
export const fieldsOf = (schema) => {
  const properties = schema?.properties ?? {};
  const required = schema?.required ?? [];

  return Object.entries(properties).map(([name, prop]) => ({
    name,
    required: required.includes(name),
    description: prop.description ?? "",
    type: prop.type ?? "any",
    options: prop.enum ?? null,
    kind: prop.enum
      ? "enum"
      : prop.type === "boolean"
        ? "boolean"
        : prop.type === "number" || prop.type === "integer"
          ? "number"
          : "text",
  }));
};

/**
 * Empty, except booleans.
 *
 * A checkbox has no empty state -- unchecked IS `false`, not "unset" -- so
 * booleans start as the value they visibly represent. Everything else starts as
 * `""` and is dropped from the payload if left that way, which is how an
 * optional parameter gets to mean "use the default" rather than "use empty".
 */
export const initialArgs = (fields) =>
  Object.fromEntries(
    fields.map((field) => [field.name, field.kind === "boolean" ? false : ""]),
  );

/** Whether a required field has been left empty. Checkboxes cannot be. */
export const missing = (fields, args) =>
  fields.some(
    (field) =>
      field.required &&
      field.kind !== "boolean" &&
      (args[field.name] === "" || args[field.name] == null),
  );

/**
 * The form's values, as the arguments a tool actually receives.
 *
 * Empty is OMITTED, not sent. `execute` destructures with defaults and the read
 * tools treat a missing `slide` as "the slide on screen"; sending `slide: ""`
 * instead would turn that default into a `Number("")` of zero. The one exception
 * is booleans, where `false` is a real answer.
 */
export const toArgs = (fields, args) => {
  const payload = {};

  for (const field of fields) {
    const value = args[field.name];
    if (field.kind === "boolean") {
      payload[field.name] = !!value;
      continue;
    }
    if (value === "" || value == null) continue;
    payload[field.name] = field.kind === "number" ? Number(value) : value;
  }

  return payload;
};

const Label = ({ field }) => html`
  <span className="chat-tools__label">
    ${field.name}
    ${field.required &&
    html`<span className="chat-tools__required" aria-label="required">*</span>`}
  </span>
`;

/** One widget, chosen by `kind`. */
const Field = ({ field, value, onChange }) => {
  const placeholder = summarize(field.description) || field.name;

  if (field.kind === "boolean") {
    return html`
      <label className="chat-tools__field chat-tools__field--check">
        <input
          type="checkbox"
          checked=${!!value}
          onChange=${(event) => onChange(field.name, event.target.checked)}
        />
        <${Label} field=${field} />
      </label>
    `;
  }

  if (field.kind === "enum") {
    return html`
      <label className="chat-tools__field">
        <${Label} field=${field} />
        <select
          className="chat-tools__input"
          value=${value ?? ""}
          onChange=${(event) => onChange(field.name, event.target.value)}
        >
          ${!field.required && html`<option value="">(unset)</option>`}
          ${field.required &&
          value === "" &&
          html`<option value="" disabled>Choose one…</option>`}
          ${field.options.map(
            (option) =>
              html`<option key=${option} value=${option}>${option}</option>`,
          )}
        </select>
      </label>
    `;
  }

  return html`
    <label className="chat-tools__field">
      <${Label} field=${field} />
      <input
        className="chat-tools__input"
        type=${field.kind === "number" ? "number" : "text"}
        value=${value ?? ""}
        placeholder=${placeholder}
        onChange=${(event) => onChange(field.name, event.target.value)}
      />
    </label>
  `;
};

/**
 * The whole form, or nothing at all.
 *
 * Four of the fourteen tools take no arguments. Rendering an empty `<div>` with
 * padding for those leaves a gap above the button that reads as a missing
 * control rather than as a tool that needs nothing.
 */
export const Fields = ({ fields, args, onChange }) => {
  if (fields.length === 0) return null;

  return html`
    <div className="chat-tools__fields">
      ${fields.map(
        (field) => html`
          <${Field}
            key=${field.name}
            field=${field}
            value=${args[field.name]}
            onChange=${onChange}
          />
        `,
      )}
    </div>
  `;
};

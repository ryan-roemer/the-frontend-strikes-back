import { createElement } from "react";
import htm from "htm";
import { summarize } from "../mcp/schema.js";

const html = htm.bind(createElement);

/**
 * A tool's `inputSchema`, as a form.
 *
 * The schema is already the documentation an agent gets -- names, types,
 * required-ness, enums, prose. Generating the human form from the same object
 * rather than hand-writing one per tool is not just less code: it means the
 * form CANNOT drift from what the agent sees. If a field appears here that an
 * agent would not be told about, that is a bug in the schema, and this makes it
 * visible instead of hiding it.
 */

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
 * `get_deck_outline` takes no arguments. Rendering an empty `<div>` with padding
 * for it leaves a gap above the button that reads as a missing control rather
 * than as a tool that needs nothing.
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

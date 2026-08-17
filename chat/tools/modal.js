import {
  createElement,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import htm from "htm";
import { editingEnabled, getModelContext, getTools } from "../mcp/index.js";
import { setOpen, initialTool } from "./state.js";
import { useCopy } from "../ui/use-copy.js";
import { useDismissKeys } from "../ui/use-dismiss-keys.js";
import {
  Fields,
  fieldsOf,
  initialArgs,
  missing,
  summarize,
  toArgs,
} from "./form.js";

const html = htm.bind(createElement);

/**
 * The deck's WebMCP tools, as something you can point at.
 *
 * `window.deckMcp` has been able to do all of this since the tools existed, and
 * that is exactly the problem: a devtools console is not a demo. Slide 9 says
 * the page registers tools and an agent discovers and calls them; this is the
 * discovering and the calling, on screen, driven by a person instead of a model.
 *
 * IT CALLS THE REGISTERED TOOLS. `getTools()` hands back the same `guard()`ed
 * functions that went to `registerTool`, so what happens when this Execute
 * button is pressed is what happens when an agent calls the tool -- not a
 * parallel implementation that agrees with it today.
 *
 * Lazily loaded; see `gate.js`. Default export because `lazy()` requires one.
 */

/** Sidebar order and headings. `edit` is absent entirely without `?mcp`. */
const GROUPS = [
  { group: "read", label: "Read" },
  { group: "navigate", label: "Navigate" },
  { group: "edit", label: "Edit" },
];

const close = () => setOpen(false);

/**
 * One tool: its schema, its form, and what it returned.
 *
 * Keyed on the tool name by the caller, so selecting another tool REMOUNTS this
 * and every piece of state below resets. That is the whole reason it is a
 * separate component -- the alternative is an effect that clears args and result
 * whenever the selection changes, which is the same thing said less reliably.
 */
const ToolDetail = ({ tool }) => {
  const fields = useMemo(() => fieldsOf(tool.inputSchema), [tool]);
  const [args, setArgs] = useState(() => initialArgs(fields));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const output = useRef(null);

  const change = useCallback(
    (name, value) => setArgs((prev) => ({ ...prev, [name]: value })),
    [],
  );

  const incomplete = missing(fields, args);

  const execute = useCallback(
    async (event) => {
      event?.preventDefault();
      if (busy || incomplete) return;

      setBusy(true);
      setResult(null);
      // NO CATCH, BUT A `finally`. `guard()` in `chat/mcp/index.js` already turns a
      // throwing tool into an `isError` result, and catching here would quietly cover
      // for a tool that broke that contract -- so a rejection still reaches the console,
      // which is the point. What must not also happen is Execute staying disabled
      // forever: without this, one tool that broke the contract left the sheet with no
      // way back except closing it.
      try {
        const value = await tool.call(toArgs(fields, args));
        setResult(value);
      } finally {
        setBusy(false);
      }
    },
    [args, busy, fields, incomplete, tool],
  );

  /** The result, as the JSON somebody would paste into an issue. */
  const asText = useCallback(
    () => (result == null ? null : JSON.stringify(result, null, 2)),
    [result],
  );

  const { copied, copy } = useCopy(asText, output);

  const failed = !!result?.isError;

  return html`
    <${Fragment}>
      ${
        "" /* Two columns, not two rows. A tool result is JSON several levels deep
              and mostly long lines; given the bottom third of the card it wraps
              into an unreadable ribbon, and it is the thing the room is actually
              looking at. The docs and the form are narrow by nature -- a label and
              a field -- so they are what gives up the width. */
      }
      <div className="chat-tools__pane">
        <div className="chat-tools__doc">
          <h3 className="chat-tools__name">${tool.name}</h3>
          <p className="chat-tools__desc">${tool.description}</p>
          ${fields.length > 0 &&
          html`
            <table className="chat-tools__schema">
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th>Type</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                ${fields.map(
                  (field) => html`
                    <tr key=${field.name}>
                      <td>
                        <code>${field.name}</code>
                        ${field.required &&
                        html`<span className="chat-tools__required">*</span>`}
                      </td>
                      <td>${field.options ? "enum" : field.type}</td>
                      <td>${summarize(field.description)}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
          ${fields.length === 0 &&
          html`<p className="chat-tools__none">Takes no arguments.</p>`}
        </div>

        <form className="chat-tools__form" onSubmit=${execute}>
          <${Fields} fields=${fields} args=${args} onChange=${change} />
          <div className="chat-tools__run">
            <button
              type="submit"
              className="chat-tools__execute"
              disabled=${busy || incomplete}
            >
              ${busy ? "Executing…" : "Execute"}
            </button>
            ${incomplete &&
            html`<span className="chat-tools__hint"
              >Fill the required fields.</span
            >`}
          </div>
        </form>
      </div>

      <div className="chat-tools__output">
        <div className="chat-tools__output-head">
          <span
            >Result${failed &&
            html` <span className="chat-tools__error-chip"
              >isError</span
            >`}</span
          >
          ${result != null &&
          html`
            <button
              type="button"
              className="chat-icon-button"
              onClick=${copy}
              title=${copied ? "Copied" : "Copy result"}
              aria-label=${copied ? "Copied" : "Copy result"}
            >
              <i
                className=${`ph ph-${copied ? "check" : "copy"}`}
                aria-hidden="true"
              ></i>
            </button>
          `}
        </div>
        ${
          "" /* The RAW MCP result, not a friendlier rendering of it. `content`
                blocks and `structuredContent` next to each other is exactly what
                arrives at the other end of the protocol, and the gap between the
                two -- prose for the model, data for the program -- is the part
                of the shape worth showing on a projector. */
        }
        <pre
          ref=${output}
          className=${`chat-tools__result${failed ? " chat-tools__result--error" : ""}`}
        >
${result == null
            ? busy
              ? "Running…"
              : "Nothing yet. Execute the tool to see what an agent gets back."
            : JSON.stringify(result, null, 2)}</pre
        >
      </div>
    <//>
  `;
};

const ToolInspector = () => {
  const tools = useMemo(() => getTools(), []);
  const overlay = useRef(null);

  const [selected, setSelected] = useState(() => {
    const wanted = initialTool();
    return (
      tools.find((tool) => tool.name === wanted)?.name ?? tools[0]?.name ?? null
    );
  });

  const tool = tools.find((entry) => entry.name === selected) ?? null;

  // Focus the overlay so Escape reaches the handler below even before anything
  // inside has been clicked. Without this the key lands on whatever the deck
  // left focused, which is usually nothing.
  //
  // The `tabindex` that makes the div focusable is lowercase because prettier
  // formats these html`` templates as HTML and rewrites `tabIndex` back on every
  // format run. React sets the attribute either way, and the deck loads React's
  // production build, which has no casing warning to trip.
  useEffect(() => overlay.current?.focus(), []);

  /** Escape closes, arrows stay off the deck -- see `use-dismiss-keys.js`. */
  const onKeyDown = useDismissKeys(close);

  return html`
    <div
      ref=${overlay}
      className="chat-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="WebMCP tools"
      tabindex=${-1}
      onKeyDown=${onKeyDown}
      onMouseDown=${(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="chat-sheet__card">
        <header className="chat-sheet__bar">
          <span className="chat-sheet__title">
            <i className="ph-fill ph-plugs-connected" aria-hidden="true"></i>
            WebMCP tools
          </span>
          ${
            "" /* A select rather than a rail down the side. Fourteen names cost a
                  fifth of the card's width to list permanently, and they are read
                  once -- to choose -- while the arguments beside them are read
                  every time. `optgroup` keeps the read / navigate / edit split
                  that the rail was carrying, and the native listbox scrolls on its
                  own however many tools a page registers. */
          }
          <select
            className="chat-tools__select"
            value=${selected ?? ""}
            onChange=${(event) => setSelected(event.target.value)}
            aria-label="Tool"
          >
            ${GROUPS.map(({ group, label }) => {
              const inGroup = tools.filter((entry) => entry.group === group);
              if (inGroup.length === 0) return null;

              return html`
                <optgroup key=${group} label=${label}>
                  ${inGroup.map(
                    (entry) =>
                      html`<option key=${entry.name} value=${entry.name}>
                        ${entry.name}
                      </option>`,
                  )}
                </optgroup>
              `;
            })}
          </select>
          <span className="chat-sheet__badges">
            <span>${tools.length} registered</span>
            ${
              "" /* Whether a host is attached is the question every failure here
                    turns out to be. Answering it in the header costs a word and
                    saves the "why is nothing happening" detour -- the tools work
                    from this modal either way, which is itself the point. */
            }
            <span
              className=${`chat-sheet__badge${getModelContext() ? " chat-sheet__badge--on" : ""}`}
              >${getModelContext() ? "host connected" : "no host"}</span
            >
            ${editingEnabled() &&
            html`<span className="chat-sheet__badge chat-sheet__badge--on"
              >editing</span
            >`}
          </span>
          <button
            type="button"
            className="chat-icon-button"
            onClick=${close}
            title="Close"
            aria-label="Close WebMCP tools"
          >
            <i className="ph ph-x" aria-hidden="true"></i>
          </button>
        </header>

        <div className="chat-tools__body">
          ${
            "" /* Empty only when the chat mounted but installTools did not, which
                  in practice means paged mode -- worth a sentence rather than a
                  blank pane. */
          }
          ${tool
            ? html`<${ToolDetail} key=${tool.name} tool=${tool} />`
            : html`<div className="chat-tools__pane">
                <div className="chat-tools__doc">
                  <p className="chat-tools__none">No tools are registered.</p>
                </div>
              </div>`}
        </div>
      </div>
    </div>
  `;
};

export default ToolInspector;

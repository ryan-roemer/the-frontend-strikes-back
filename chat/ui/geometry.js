import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Where the panel is and how big it is -- including across reloads and across
 * projectors.
 *
 * Size and position are computed in JS rather than left to CSS `clamp()`, even
 * though the default is expressible in CSS. Dragging has to write pixels, and a
 * panel whose default comes from CSS but whose dragged position comes from JS has
 * two sources of truth that disagree the first time you move it.
 *
 * The restore is CLAMPED, and that is the point of persisting at all. Geometry
 * saved on a 16" laptop would put the panel entirely offscreen on a 1024x768
 * projector -- which is exactly the machine you discover it on. Same clamp runs
 * on window resize, so switching displays mid-talk pulls the panel back into view
 * instead of losing it.
 */

const KEY = "chat:geometry";

const MARGIN = 24;
const MIN_W = 300;
const MIN_H = 260;

/** Intelligent default: a comfortable reading column, never more than a quarter
 *  of the canvas, never taller than the viewport can hold. */
const defaults = () => {
  const width = Math.min(
    420,
    Math.max(MIN_W, Math.round(window.innerWidth * 0.26)),
  );
  const height = Math.min(
    640,
    Math.max(MIN_H, Math.round(window.innerHeight * 0.6)),
  );
  return {
    width,
    height,
    left: window.innerWidth - width - MARGIN,
    top: window.innerHeight - height - MARGIN,
  };
};

/**
 * Force any geometry to fit the current viewport.
 *
 * Size is clamped before position so the position clamp has a real width to work
 * against; otherwise a too-wide panel gets pinned to the left edge and then
 * shrunk, which looks like it jumped.
 */
const clamp = (geo) => {
  const maxW = Math.max(MIN_W, window.innerWidth - MARGIN * 2);
  const maxH = Math.max(MIN_H, window.innerHeight - MARGIN * 2);
  const width = Math.min(Math.max(geo.width, MIN_W), maxW);
  const height = Math.min(Math.max(geo.height, MIN_H), maxH);
  return {
    width,
    height,
    left: Math.min(
      Math.max(geo.left, 0),
      Math.max(0, window.innerWidth - width),
    ),
    top: Math.min(
      Math.max(geo.top, 0),
      Math.max(0, window.innerHeight - height),
    ),
  };
};

const load = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (
      !raw ||
      ["width", "height", "left", "top"].some((k) => !Number.isFinite(raw[k]))
    ) {
      return defaults();
    }
    return clamp(raw);
  } catch {
    return defaults();
  }
};

const save = (geo) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(geo));
  } catch {
    // Best effort, same as the enabled flag.
  }
};

/**
 * Drag and resize, committed to React state only once per gesture.
 *
 * The moves themselves write `style.left`/`style.top` straight onto the node.
 * Re-rendering on every pointermove would re-render the transcript sixty times a
 * second to move a box, and a long transcript makes that visible. State updates
 * on pointerup, which is also when the geometry is persisted.
 */
export const usePanelGeometry = (nodeRef) => {
  const [geometry, setGeometry] = useState(load);
  const gesture = useRef(null);

  // Keep the live node in sync when state changes for reasons other than a
  // gesture (initial mount, viewport clamp).
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    node.style.left = `${geometry.left}px`;
    node.style.top = `${geometry.top}px`;
    node.style.width = `${geometry.width}px`;
    node.style.height = `${geometry.height}px`;
  }, [geometry, nodeRef]);

  useEffect(() => {
    const onResize = () => setGeometry((current) => clamp(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const begin = useCallback(
    (mode) => (event) => {
      const node = nodeRef.current;
      if (!node || event.button !== 0) return;
      // Let buttons in the header keep their clicks.
      if (mode === "move" && event.target.closest("button")) return;

      event.preventDefault();
      const rect = node.getBoundingClientRect();
      gesture.current = {
        mode,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        from: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [nodeRef],
  );

  const move = useCallback(
    (event) => {
      const g = gesture.current;
      const node = nodeRef.current;
      if (!g || !node || event.pointerId !== g.pointerId) return;

      const dx = event.clientX - g.startX;
      const dy = event.clientY - g.startY;
      const next =
        g.mode === "move"
          ? { ...g.from, left: g.from.left + dx, top: g.from.top + dy }
          : { ...g.from, width: g.from.width + dx, height: g.from.height + dy };

      const fitted = clamp(next);
      node.style.left = `${fitted.left}px`;
      node.style.top = `${fitted.top}px`;
      node.style.width = `${fitted.width}px`;
      node.style.height = `${fitted.height}px`;
    },
    [nodeRef],
  );

  const end = useCallback(
    (event) => {
      const g = gesture.current;
      const node = nodeRef.current;
      if (!g || !node) return;
      gesture.current = null;
      if (event.currentTarget.hasPointerCapture?.(g.pointerId)) {
        event.currentTarget.releasePointerCapture(g.pointerId);
      }
      const rect = node.getBoundingClientRect();
      const committed = clamp({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      });
      setGeometry(committed);
      save(committed);
    },
    [nodeRef],
  );

  const reset = useCallback(() => {
    const fresh = defaults();
    setGeometry(fresh);
    save(fresh);
  }, []);

  return {
    geometry,
    reset,
    dragHandlers: {
      onPointerDown: begin("move"),
      onPointerMove: move,
      onPointerUp: end,
      onPointerCancel: end,
    },
    resizeHandlers: {
      onPointerDown: begin("resize"),
      onPointerMove: move,
      onPointerUp: end,
      onPointerCancel: end,
    },
  };
};

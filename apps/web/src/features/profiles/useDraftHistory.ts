import { useCallback, useEffect, useRef, useState } from "react";
export function useDraftHistory<T extends object>(initial: T) {
  const [draft, setDraft] = useState(initial),
    [revision, setRevision] = useState(0);
  const current = useRef(initial),
    past = useRef<T[]>([]),
    future = useRef<T[]>([]),
    group = useRef("");
  const update = useCallback((next: T, field = "") => {
    if (JSON.stringify(next) === JSON.stringify(current.current)) return;
    if (!field || group.current !== field) past.current.push(current.current);
    past.current = past.current.slice(-50);
    future.current = [];
    group.current = field;
    current.current = next;
    setDraft(next);
    setRevision((n) => n + 1);
  }, []);
  const reset = useCallback((next: T) => {
    current.current = next;
    past.current = [];
    future.current = [];
    group.current = "";
    setDraft(next);
    setRevision((n) => n + 1);
  }, []);
  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (!previous) return;
    future.current.push(current.current);
    current.current = previous;
    group.current = "";
    setDraft(previous);
    setRevision((n) => n + 1);
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(current.current);
    current.current = next;
    group.current = "";
    setDraft(next);
    setRevision((n) => n + 1);
  }, []);
  useEffect(() => {
    function keyboard(e: KeyboardEvent) {
      if (
        !(e.ctrlKey || e.metaKey) ||
        e.key.toLowerCase() !== "z" ||
        (e.target as HTMLElement)?.closest("input,textarea,[contenteditable]")
      )
        return;
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [undo, redo]);
  return {
    draft,
    update,
    reset,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    revision,
    endGroup: () => {
      group.current = "";
    },
  };
}

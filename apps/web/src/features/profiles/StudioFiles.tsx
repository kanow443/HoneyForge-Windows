import { useEffect, useMemo, useRef, useState } from "react";
import { Collapse, useContentMotion } from "../../shared/ui/motion";
import {
  ChevronRight,
  FileText,
  Folder,
  Plus,
  Search,
  Maximize2,
  Minimize2,
  Trash2,
} from "lucide-react";
import CodeMirror, {
  EditorView,
  EditorState,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { openSearchPanel, search } from "@codemirror/search";
import { historyField } from "@codemirror/commands";
import type { Config } from "../../shared/api/models";
import { Field } from "../../shared/ui";
const editorTheme = EditorView.theme({
  "&": { fontSize: "13px", backgroundColor: "#fff", height: "100%" },
  ".cm-scroller": {
    fontFamily: '"SFMono-Regular", Consolas, monospace',
    lineHeight: "1.9",
    overflow: "auto",
  },
  ".cm-content": { padding: "18px 0" },
  ".cm-line": { padding: "0 16px" },
  ".cm-gutters": {
    backgroundColor: "#fff",
    color: "#a4aab2",
    border: "none",
    padding: "0 6px 0 8px",
  },
  ".cm-activeLineGutter": { backgroundColor: "#f5f6f8", color: "#5c6470" },
  ".cm-activeLine": { backgroundColor: "#f8f9fb" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "#dce6f3",
  },
  ".cm-panels": { backgroundColor: "#f7f8fa", borderColor: "#e5e7eb" },
  ".cm-search": { fontFamily: "Inter, sans-serif", padding: "12px" },
  ".cm-textfield": {
    fontSize: "13px",
    border: "1px solid #d9dde3",
    borderRadius: "4px",
    backgroundColor: "#fff",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "#fff",
    border: "1px solid #d9dde3",
    borderRadius: "4px",
    fontSize: "12px",
  },
});
const attributes = EditorView.contentAttributes.of({
  "aria-label": "Содержимое файла",
});
const searchSetup = search({ top: true });
const historyFields = { history: historyField };
const basicSetup = {
  foldGutter: false,
  highlightActiveLine: true,
  autocompletion: false,
};
const directory = (path: string) =>
  path.slice(0, Math.max(0, path.lastIndexOf("/"))) || "/";
const phrases = EditorState.phrases.of({
  Find: "Поиск",
  Replace: "Заменить на",
  next: "Далее",
  previous: "Назад",
  all: "Все",
  replace: "Заменить",
  "replace all": "Заменить все",
  close: "Закрыть",
  "match case": "Регистр",
  regexp: "Регулярное выражение",
  "by word": "Слово целиком",
});
export function StudioFiles({
  config,
  patch,
  errors,
  endGroup,
  onSelect,
  focusEditor,
  onToggleFocus,
}: {
  config: Config;
  patch: (p: Partial<Config>, group?: string) => void;
  errors: Record<string, string>;
  endGroup: () => void;
  onSelect?: (path: string) => void;
  focusEditor?: boolean;
  onToggleFocus?: () => void;
}) {
  const files = config.decoy_files ?? [],
    [selected, setSelected] = useState(0),
    [collapsed, setCollapsed] = useState<string[]>([]),
    editor = useRef<ReactCodeMirrorRef>(null),
    documents = useRef(
      new Map<
        number,
        {
          path: string;
          content: string;
          json: ReturnType<EditorState["toJSON"]>;
          scrollTop: number;
        }
      >(),
    ),
    file = files[selected];
  const cached = documents.current.get(selected),
    restored =
      cached?.path === file?.path && cached?.content === file?.content
        ? cached
        : undefined;
  const documentMotion = useContentMotion<HTMLDivElement>(selected);
  const extensions = useMemo(
    () => [
      editorTheme,
      attributes,
      phrases,
      searchSetup,
      EditorView.lineWrapping,
      ...(file?.path.endsWith(".json") ? [json()] : []),
    ],
    [file?.path],
  );
  useEffect(() => {
    onSelect?.(file?.path ?? "");
  }, [file?.path, onSelect]);
  useEffect(() => {
    if (selected >= files.length) setSelected(Math.max(0, files.length - 1));
  }, [selected, files.length]);
  useEffect(() => {
    const bad = Object.keys(errors).find((k) =>
      /^(path|content|decoy_files)\.\d+/.test(k),
    );
    if (bad) setSelected(Number(bad.split(".")[1]));
  }, [errors]);
  const groups = Array.from(new Set(files.map((f) => directory(f.path))));
  function rememberDocument() {
    const view = editor.current?.view;
    if (view && file)
      documents.current.set(selected, {
        path: file.path,
        content: view.state.doc.toString(),
        json: view.state.toJSON(historyFields),
        scrollTop: view.scrollDOM.scrollTop,
      });
  }
  function add() {
    rememberDocument();
    let n = files.length + 1;
    while (files.some((f) => f.path === `/opt/decoy/file-${n}.txt`)) n++;
    patch({
      decoy_files: [
        ...files,
        { path: `/opt/decoy/file-${n}.txt`, content: "" },
      ],
    });
    setSelected(files.length);
    setCollapsed([]);
  }
  return (
    <div className="studio-files-workspace">
      <div className="studio-files-heading">
        <span>{files.length} из 12 файлов</span>
        <button
          type="button"
          className="icon-button"
          aria-label={focusEditor ? "Свернуть редактор" : "Развернуть редактор"}
          title={focusEditor ? "Свернуть редактор" : "Развернуть редактор"}
          onClick={onToggleFocus}
        >
          {focusEditor ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button
          type="button"
          className="button small"
          disabled={files.length >= 12}
          onClick={add}
        >
          <Plus size={14} />
          Добавить файл
        </button>
      </div>
      <div className="studio-file-editor">
        <nav className="studio-file-tree" aria-label="Файлы легенды">
          {groups.map((dir) => (
            <div className="studio-tree-folder" key={dir}>
              <button
                type="button"
                className="studio-folder-toggle"
                aria-expanded={!collapsed.includes(dir)}
                title={dir}
                onClick={() =>
                  setCollapsed((c) =>
                    c.includes(dir) ? c.filter((d) => d !== dir) : [...c, dir],
                  )
                }
              >
                <ChevronRight size={12} />
                <Folder size={14} />
                <span>{dir.split("/").at(-1) || "Файлы"}</span>
              </button>
              <Collapse open={!collapsed.includes(dir)}>
                {files.map((f, i) =>
                  directory(f.path) === dir ? (
                    <button
                      type="button"
                      key={i}
                      aria-current={i === selected ? "true" : undefined}
                      className={i === selected ? "selected" : ""}
                      title={f.path}
                      onClick={() => {
                        rememberDocument();
                        setSelected(i);
                        endGroup();
                      }}
                    >
                      <FileText size={14} />
                      <span>{f.path.split("/").at(-1) || "Без имени"}</span>
                      {(errors[`path.${i}`] || errors[`content.${i}`]) && (
                        <span className="bad">!</span>
                      )}
                    </button>
                  ) : null,
                )}
              </Collapse>
            </div>
          ))}
        </nav>
        <div ref={documentMotion} className="studio-file-document">
          {file ? (
            <>
              <div className="studio-file-document-bar">
                <Field
                  label="Путь файла"
                  error={
                    errors[`path.${selected}`] ??
                    errors[`decoy_files.${selected}.path`]
                  }
                >
                  <input
                    className="mono"
                    value={file.path}
                    maxLength={160}
                    onBlur={endGroup}
                    onChange={(e) =>
                      patch(
                        {
                          decoy_files: files.map((f, i) =>
                            i === selected ? { ...f, path: e.target.value } : f,
                          ),
                        },
                        `path-${selected}`,
                      )
                    }
                  />
                </Field>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Поиск в файле"
                  title="Поиск и замена"
                  onClick={() => {
                    if (editor.current?.view)
                      openSearchPanel(editor.current.view);
                  }}
                >
                  <Search size={15} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Удалить ${file.path.split("/").at(-1)}`}
                  title="Удалить файл"
                  onClick={() => {
                    documents.current.clear();
                    patch({
                      decoy_files: files.filter((_, i) => i !== selected),
                    });
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <CodeMirror
                key={selected}
                ref={editor}
                className="studio-code-editor"
                value={file.content}
                initialState={
                  restored
                    ? { json: restored.json, fields: historyFields }
                    : undefined
                }
                onUpdate={(update) => {
                  documents.current.set(selected, {
                    path: file.path,
                    content: update.state.doc.toString(),
                    json: update.state.toJSON(historyFields),
                    scrollTop: update.view.scrollDOM.scrollTop,
                  });
                }}
                onCreateEditor={(view) => {
                  if (restored)
                    requestAnimationFrame(() => {
                      if (editor.current?.view === view)
                        view.scrollDOM.scrollTop = restored.scrollTop;
                    });
                }}
                height="100%"
                extensions={extensions}
                basicSetup={basicSetup}
                indentWithTab={false}
                onBlur={() => {
                  rememberDocument();
                  endGroup();
                }}
                onChange={(content) =>
                  patch(
                    {
                      decoy_files: files.map((f, i) =>
                        i === selected ? { ...f, content } : f,
                      ),
                    },
                    `content-${selected}`,
                  )
                }
                placeholder="Содержимое файла"
              />
              <div className="studio-document-status">
                <span>{file.path.endsWith(".json") ? "JSON" : "Текст"}</span>
                <span className={file.content.length > 8192 ? "bad" : ""}>
                  {file.content.length.toLocaleString("ru-RU")} символов
                </span>
              </div>
              {(errors[`content.${selected}`] ||
                file.content.length > 8192) && (
                <p className="studio-file-error" role="alert">
                  Не более 8192 символов
                </p>
              )}
            </>
          ) : (
            <div className="studio-no-files">
              <p>Пока нет файлов</p>
              <button type="button" className="button" onClick={add}>
                Добавить файл
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Preserve number tokens (e.g. 1.0) from the actual response. JSON.parse/stringify
// alone would change them and cannot verify Python's canonical serialization.
export function canonicalReport(raw: string): string {
  let at = 0;
  const whitespace = () => {
    while (/\s/.test(raw[at] ?? "") && at < raw.length) at++;
  };
  function string() {
    whitespace();
    const start = at;
    if (raw[at++] !== '"') throw new Error("Ожидалась строка JSON");
    while (at < raw.length) {
      if (raw[at] === "\\") {
        at += 2;
        continue;
      }
      if (raw[at++] === '"')
        return JSON.stringify(JSON.parse(raw.slice(start, at)));
    }
    throw new Error("Неполная строка JSON");
  }
  function value(root = false): string {
    whitespace();
    const ch = raw[at];
    if (ch === '"') return string();
    if (ch === "{") {
      at++;
      const entries: [string, string][] = [];
      whitespace();
      if (raw[at] !== "}")
        while (true) {
          const key = JSON.parse(string()) as string;
          whitespace();
          if (raw[at++] !== ":") throw new Error("Неверный объект JSON");
          const item = value();
          if (!(root && key === "sha256")) entries.push([key, item]);
          whitespace();
          if (raw[at] !== ",") break;
          at++;
        }
      if (raw[at++] !== "}") throw new Error("Неполный объект JSON");
      entries.sort(([a], [b]) => {
        const aa = Array.from(a, (c) => c.codePointAt(0)!),
          bb = Array.from(b, (c) => c.codePointAt(0)!);
        for (let i = 0; i < Math.min(aa.length, bb.length); i++)
          if (aa[i] !== bb[i]) return aa[i] - bb[i];
        return aa.length - bb.length;
      });
      return (
        "{" +
        entries
          .map(([key, item]) => JSON.stringify(key) + ":" + item)
          .join(",") +
        "}"
      );
    }
    if (ch === "[") {
      at++;
      const items: string[] = [];
      whitespace();
      if (raw[at] !== "]")
        while (true) {
          items.push(value());
          whitespace();
          if (raw[at] !== ",") break;
          at++;
        }
      if (raw[at++] !== "]") throw new Error("Неполный массив JSON");
      return "[" + items.join(",") + "]";
    }
    const token = raw
      .slice(at)
      .match(
        /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/,
      )?.[0];
    if (!token) throw new Error("Неверное значение JSON");
    at += token.length;
    return token;
  }
  const result = value(true);
  whitespace();
  if (at !== raw.length) throw new Error("Лишние данные JSON");
  return result;
}
export async function verifyReport(raw: string, expected: string) {
  const bytes = new TextEncoder().encode(canonicalReport(raw));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actual = Array.from(new Uint8Array(digest), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
  return { actual, valid: actual === expected };
}

import { describe, expect, it } from "vitest";
import { eventFilters, setFilter } from "./filters";
import { cleanText } from "../../shared/ui";
describe("контекст расследования", () => {
  it("ссылка восстанавливает фильтры, но event ID не уходит в API", () => {
    expect(
      eventFilters(
        new URLSearchParams(
          "event=selected&deployment_id=d&source_ip=10.0.0.1&q=curl&offset=100",
        ),
      ),
    ).toEqual({
      limit: 100,
      offset: 100,
      deployment_id: "d",
      source_ip: "10.0.0.1",
      q: "curl",
    });
  });
  it("выбор события сохраняет offset и фильтры", () => {
    const p = setFilter(
      new URLSearchParams("q=whoami&offset=100"),
      "event",
      "e",
    );
    expect(p.get("q")).toBe("whoami");
    expect(p.get("offset")).toBe("100");
    expect(p.get("event")).toBe("e");
  });
  it("новый фильтр сбрасывает страницу, но сохраняет выбранный объект", () => {
    const p = setFilter(
      new URLSearchParams("event=e&offset=100"),
      "source_ip",
      "10.0.0.1",
    );
    expect(p.get("offset")).toBeNull();
    expect(p.get("event")).toBe("e");
  });
  it("удаляет ANSI, сохраняя HTML как обычный текст", () => {
    expect(cleanText("\x1b[31m<script>alert(1)</script>\x1b[0m")).toBe(
      "<script>alert(1)</script>",
    );
  });
});

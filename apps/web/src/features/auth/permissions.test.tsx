import { afterEach, describe, expect, it } from "vitest";
import { canAccess } from "./permissions";
import type { Permission } from "./permissions";
import { cleanup, render, screen } from "@testing-library/react";
import { RequirePermission } from "./permissions";
afterEach(() => cleanup());
describe("server role matrix reflected by UI", () => {
  it("grants only the declared operation, investigation and administration capabilities", () => {
    const matrix = {
      viewer: [false, false, false],
      analyst: [false, true, false],
      operator: [true, true, false],
      admin: [true, true, true],
    };
    for (const [role, expected] of Object.entries(matrix))
      expect(
        (["operate", "investigate", "admin"] as Permission[]).map((p) =>
          canAccess(role, p),
        ),
      ).toEqual(expected);
    for (const role of [undefined, "unknown"])
      for (const p of ["operate", "investigate", "admin"] as Permission[])
        expect(canAccess(role, p)).toBe(false);
  });
  it("fails closed without authentication when a restricted route is opened directly", () => {
    render(
      <RequirePermission permission="admin">
        <div>Secret user administration</div>
      </RequirePermission>,
    );
    expect(screen.queryByText("Secret user administration")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Действие недоступно" }),
    ).toBeTruthy();
  });
});

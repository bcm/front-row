import { describe, expect, it } from "vitest";
import { esc, page } from "./page";

describe("esc", () => {
  it("escapes HTML metacharacters", () => {
    expect(esc('<a href="x">a&b</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;a&amp;b&lt;/a&gt;"
    );
  });

  it("leaves plain text alone", () => {
    expect(esc("Ghost")).toBe("Ghost");
  });
});

describe("page", () => {
  it("renders a full document with the escaped title and body", () => {
    const html = page("Title <x>", "<h1>Hi</h1>");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Title &lt;x&gt;</title>");
    expect(html).toContain("<h1>Hi</h1>");
  });
});

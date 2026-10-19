import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Markdown from "./markdown";

describe("Markdown", () => {
  it("filters horizontal rules without removing surrounding content", () => {
    const html = renderToStaticMarkup(<Markdown content={"第一段\n\n---\n\n第二段"} animating={false} className="markdown" />);

    expect(html).toContain("第一段");
    expect(html).toContain("第二段");
    expect(html).not.toContain("<hr");
  });
  it("preserves semantic hierarchy for the product typography layer", () => {
    const content = [
      "# 一级标题",
      "",
      "正文包含 **重点** 和 `inline()`。",
      "",
      "## 二级标题",
      "",
      "- 第一项",
      "- 第二项",
      "",
      "> 重要说明",
    ].join("\n");
    const html = renderToStaticMarkup(<Markdown content={content} animating={false} className="markdown" />);

    expect(html).toContain('data-streamdown="heading-1"');
    expect(html).toContain('data-streamdown="heading-2"');
    expect(html).toContain('data-streamdown="unordered-list"');
    expect(html).toContain('data-streamdown="inline-code"');
    expect(html).toContain('data-streamdown="blockquote"');
  });
});

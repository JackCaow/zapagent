import { describe, expect, it } from "bun:test"
import { renderToString } from "ink"
import { createElement } from "react"
import { formatLatexForTerminal } from "../../src/ui/latex"
import { __test, Markdown } from "../../src/ui/markdown"

const { flattenRuns, parseBlocks, parseInline, wrapMathForTerminal } = __test

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "")
}

function renderMarkdown(source: string): string {
  return stripAnsi(renderToString(createElement(Markdown, { source }), { columns: 120 }))
}

describe("terminal LaTeX formatter", () => {
  it("renders the common fraction, function, and script forms from model output", () => {
    expect(formatLatexForTerminal(String.raw`S=\frac{1}{2}bc\sin A`))
      .toBe("S=½bc sin A")
    expect(formatLatexForTerminal(String.raw`\cos A=\frac{b^2+c^2-a^2}{2bc}`))
      .toBe("cos A=(b²+c²−a²)/(2bc)")
    expect(formatLatexForTerminal(String.raw`\sin^2 A=1-\cos^2 A`))
      .toBe("sin² A=1−cos² A")
  })

  it("renders roots, boxes, spacing, symbols, Greek, and subscripts", () => {
    expect(formatLatexForTerminal(
      String.raw`\boxed{S=\sqrt{s(s-a)(s-b)(s-c)}}\qquad\blacksquare`,
    )).toBe("⟦S=√(s(s−a)(s−b)(s−c))⟧    ■")
    expect(formatLatexForTerminal(String.raw`x_i^2+\alpha\leq\infty`))
      .toBe("xᵢ²+α≤∞")
  })

  it("supports TeX shorthand fractions", () => {
    expect(formatLatexForTerminal(String.raw`\frac12 ar+\frac12 br+\frac12 cr=rs`))
      .toBe("½ ar+½ br+½ cr=rs")
  })

  it("keeps numeric denominators compact while grouping implicit products", () => {
    expect(formatLatexForTerminal(String.raw`\frac{1}{16}`)).toBe("1/16")
    expect(formatLatexForTerminal(String.raw`\frac{1}{2bc}`)).toBe("1/(2bc)")
  })

  it("renders accents, binomials, negation, and annotations without losing semantics", () => {
    expect(formatLatexForTerminal(String.raw`\vec{x}+\hat{y}+\overline{AB}`))
      .toBe("x⃗+ŷ+A̅B̅")
    expect(formatLatexForTerminal(String.raw`\binom{n}{k}`)).toBe("C(n, k)")
    expect(formatLatexForTerminal(String.raw`a\not=b,\quad x\not\leq y`))
      .toBe("a≠b,   x≰ y")
    expect(formatLatexForTerminal(String.raw`\overset{!}{=}\underset{x}{y}`))
      .toBe("=^(!)y_(x)")
  })

  it("preserves matrix columns, case conditions, and aligned rows", () => {
    expect(formatLatexForTerminal(
      String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
    )).toBe("(a, b; c, d)")
    expect(formatLatexForTerminal(
      String.raw`f(x)=\begin{cases}x^2&x\ge0\\-x&x<0\end{cases}`,
    )).toBe("f(x)={\n│ x²,  x≥0\n│ −x,  x<0\n}")
    expect(formatLatexForTerminal(
      String.raw`\begin{aligned}a&=b+c\\d&=e\end{aligned}`,
    )).toBe("a=b+c\nd=e")
  })

  it("renders big-operator limits and invisible right delimiters readably", () => {
    expect(formatLatexForTerminal(
      String.raw`\sum_{i=1}^n i+\int_0^\infty f(x)\,dx`,
    )).toBe("∑ᵢ₌₁ⁿ i+∫₀^∞ f(x) dx")
    expect(formatLatexForTerminal(String.raw`\left\{x\right.`)).toBe("{x")
  })

  it("marks unknown macros instead of silently changing their meaning", () => {
    expect(formatLatexForTerminal(String.raw`\mystery{x}`)).toBe("⟨\\mystery⟩x")
  })

  it("keeps named operators separated from adjacent variables", () => {
    expect(formatLatexForTerminal(String.raw`x\operatorname{mod}n`)).toBe("x mod n")
    expect(formatLatexForTerminal(String.raw`\operatorname{rank}(A)`)).toBe("rank(A)")
  })
})

describe("markdown math blocks", () => {
  it("recognises and renders a same-line display formula", () => {
    const source = String.raw`$$S=\frac{1}{2}bc\sin A$$`
    const blocks = parseBlocks(source)

    expect(blocks).toEqual([{ kind: "math", latex: String.raw`S=\frac{1}{2}bc\sin A` }])
    expect(renderMarkdown(source)).toContain("S=½bc sin A")
    expect(renderMarkdown(source)).not.toContain("$$")
    expect(renderMarkdown(source)).not.toContain("\\frac")
  })

  it("collects multiline display math and resumes normal paragraphs", () => {
    const source = [
      "推导：",
      "$$",
      String.raw`\frac{a}{b}+\sqrt{x}`,
      "$$",
      "完成。",
    ].join("\n")
    const blocks = parseBlocks(source)

    expect(blocks.map(block => block.kind)).toEqual(["p", "math", "p"])
    expect(renderMarkdown(source)).toContain("a/b+√x")
  })

  it("renders an unclosed display block as a streaming partial", () => {
    const source = String.raw`$$S=\sqrt{s(s-a)}`

    expect(parseBlocks(source)[0]?.kind).toBe("math")
    expect(renderMarkdown(source)).toContain("S=√(s(s−a))")
  })

  it("recognises bracket display delimiters", () => {
    const source = String.raw`\[x^2+y^2=z^2\]`

    expect(parseBlocks(source)).toEqual([{
      kind: "math",
      latex: "x^2+y^2=z^2",
    }])
    expect(renderMarkdown(source)).toContain("x²+y²=z²")
  })

  it("keeps prose after a same-line or multiline display closer", () => {
    expect(parseBlocks("$$x^2$$ 后续正文")).toEqual([
      { kind: "math", latex: "x^2" },
      { kind: "p", text: "后续正文" },
    ])

    const multiline = ["$$", "x^2", "$$ 后续正文"].join("\n")
    expect(parseBlocks(multiline)).toEqual([
      { kind: "math", latex: "x^2" },
      { kind: "p", text: "后续正文" },
    ])
  })
})

describe("markdown inline math boundaries", () => {
  it("renders inline variables and formulas with math styling", () => {
    const source = "由 $A^2$ 与 $\\cos A$ 可得"
    const atoms = flattenRuns(parseInline(source))

    expect(atoms.map(atom => atom.value).join("")).toBe("由 A² 与 cos A 可得")
    expect(atoms.filter(atom => atom.style.math).map(atom => atom.value))
      .toEqual(["A²", "cos A"])
  })

  it("recognises TeX inline delimiters and compact Unicode formulas", () => {
    const source = "由 \\(x^2\\) 与 $α$、$πr$、$x y$ 可得"
    const atoms = flattenRuns(parseInline(source))

    expect(atoms.map(atom => atom.value).join(""))
      .toBe("由 x² 与 α、πr、x y 可得")
    expect(atoms.filter(atom => atom.style.math).map(atom => atom.value))
      .toEqual(["x²", "α", "πr", "x y"])
  })

  it("recognises paired display delimiters embedded in prose", () => {
    const atoms = flattenRuns(parseInline("所以 $$x^2+y^2$$ 成立"))

    expect(atoms.map(atom => atom.value).join("")).toBe("所以 x²+y² 成立")
    expect(atoms.filter(atom => atom.style.math).map(atom => atom.value))
      .toEqual(["x²+y²"])
  })

  it("does not consume two currency amounts as one formula", () => {
    const source = "价格从 $100 到 $200，预算不变"
    const atoms = flattenRuns(parseInline(source))

    expect(atoms.map(atom => atom.value).join("")).toBe(source)
    expect(atoms.some(atom => atom.style.math)).toBe(false)
  })

  it("keeps unmatched dollars and removes the escape slash for literal dollars", () => {
    expect(flattenRuns(parseInline("预算 $100")).map(atom => atom.value).join(""))
      .toBe("预算 $100")
    expect(flattenRuns(parseInline("预算 \\$100")).map(atom => atom.value).join(""))
      .toBe("预算 $100")
  })

  it("does not parse math delimiters inside inline code or fenced code", () => {
    const inline = flattenRuns(parseInline("代码 `$\\frac{1}{2}$`"))
    expect(inline.map(atom => atom.value).join("")).toBe("代码 $\\frac{1}{2}$")
    expect(inline.some(atom => atom.style.math)).toBe(false)

    const fenced = parseBlocks(["```tex", String.raw`$\frac{1}{2}$`, "```"].join("\n"))
    expect(fenced).toEqual([{
      kind: "fence",
      lang: "tex",
      code: String.raw`$\frac{1}{2}$`,
    }])
  })
})

describe("display math wrapping", () => {
  it("wraps long formulas at operators and preserves every character", () => {
    const formula = "a+b+c+d+e+f+g+h+i+j"
    const lines = wrapMathForTerminal(formula, 8)

    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join("")).toBe(formula)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(8)
  })

  it("preserves explicit matrix and cases rows", () => {
    expect(wrapMathForTerminal("{\n│ x², x≥0\n│ −x, x<0\n}", 40))
      .toEqual(["{", "│ x², x≥0", "│ −x, x<0", "}"])
  })
})

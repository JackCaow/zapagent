/**
 * Small LaTeX-to-Unicode formatter for terminal transcripts.
 *
 * A terminal cannot reproduce TeX's two-dimensional layout without turning
 * every formula into an image. The useful TUI fallback is a compact linear
 * form: preserve the expression, replace structural commands with readable
 * Unicode, and never expose raw delimiter noise for the common math emitted
 * by language models.
 *
 * This is intentionally not a TeX evaluator. It understands presentation
 * primitives only and leaves unknown commands as their readable command name.
 */

const COMMANDS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε",
  varepsilon: "ϵ", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ",
  omicron: "ο", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ",
  sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "φ",
  varphi: "ϕ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ",
  Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",

  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓", ast: "∗",
  circ: "∘", bullet: "•", oplus: "⊕", otimes: "⊗",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠",
  approx: "≈", sim: "∼", simeq: "≃", equiv: "≡", propto: "∝",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", supset: "⊃",
  subseteq: "⊆", supseteq: "⊇", cup: "∪", cap: "∩", setminus: "∖",
  land: "∧", wedge: "∧", lor: "∨", vee: "∨", neg: "¬",
  forall: "∀", exists: "∃", nexists: "∄", therefore: "∴", because: "∵",
  to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔",
  Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔",
  implies: "⇒", iff: "⇔", mapsto: "↦",
  sum: "∑", prod: "∏", int: "∫", iint: "∬", iiint: "∭",
  oint: "∮", partial: "∂", nabla: "∇", infty: "∞",
  angle: "∠", triangle: "△", parallel: "∥", perp: "⊥",
  ell: "ℓ", hbar: "ℏ", Re: "ℜ", Im: "ℑ", aleph: "ℵ",
  emptyset: "∅", varnothing: "∅",
  lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉",
  langle: "⟨", rangle: "⟩", vert: "|", Vert: "‖",
  ldots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱",
  blacksquare: "■", square: "□", checkmark: "✓",

  sin: "sin", cos: "cos", tan: "tan", cot: "cot", sec: "sec", csc: "csc",
  arcsin: "arcsin", arccos: "arccos", arctan: "arctan",
  sinh: "sinh", cosh: "cosh", tanh: "tanh",
  log: "log", ln: "ln", exp: "exp", lim: "lim", max: "max", min: "min",
  det: "det", gcd: "gcd", mod: "mod",
}

const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ",
  h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ",
  o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ",
  w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
}

const SUBSCRIPT: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ",
  m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ",
  u: "ᵤ", v: "ᵥ", x: "ₓ",
}

const VULGAR_FRACTIONS: Record<string, string> = {
  "1/2": "½", "1/3": "⅓", "2/3": "⅔", "1/4": "¼", "3/4": "¾",
  "1/5": "⅕", "2/5": "⅖", "3/5": "⅗", "4/5": "⅘",
  "1/6": "⅙", "5/6": "⅚", "1/8": "⅛", "3/8": "⅜",
  "5/8": "⅝", "7/8": "⅞",
}

const FUNCTION_COMMANDS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc",
  "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
  "log", "ln", "exp", "lim", "max", "min", "det", "gcd", "mod",
])

const DECORATORS: Record<string, { mark: string; each?: boolean }> = {
  vec: { mark: "⃗" },
  overrightarrow: { mark: "⃗" },
  overleftarrow: { mark: "⃖" },
  hat: { mark: "̂" },
  widehat: { mark: "̂", each: true },
  bar: { mark: "̄" },
  overline: { mark: "̅", each: true },
  underline: { mark: "̲", each: true },
  dot: { mark: "̇" },
  ddot: { mark: "̈" },
  tilde: { mark: "̃" },
  widetilde: { mark: "̃", each: true },
  acute: { mark: "́" },
  grave: { mark: "̀" },
}

const NEGATED_SYMBOLS: Record<string, string> = {
  "=": "≠",
  "<": "≮",
  ">": "≯",
  "≤": "≰",
  "≥": "≱",
  "∈": "∉",
  "∋": "∌",
  "⊂": "⊄",
  "⊃": "⊅",
  "⊆": "⊈",
  "⊇": "⊉",
  "≈": "≉",
  "≡": "≢",
}

const MATRIX_DELIMITERS: Record<string, [string, string]> = {
  matrix: ["[", "]"],
  smallmatrix: ["[", "]"],
  array: ["[", "]"],
  bmatrix: ["[", "]"],
  pmatrix: ["(", ")"],
  Bmatrix: ["{", "}"],
  vmatrix: ["|", "|"],
  Vmatrix: ["‖", "‖"],
}

function decorate(value: string, mark: string, each = false): string {
  if (!each) return `${value}${mark}`
  return Array.from(value, ch => /\s/.test(ch) ? ch : `${ch}${mark}`).join("")
}

function splitEnvironmentRows(source: string): string[] {
  const rows: string[] = []
  let start = 0
  let depth = 0
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === "{") depth++
    else if (ch === "}" && depth > 0) depth--
    else if (depth === 0 && ch === "\\" && source[i + 1] === "\\") {
      rows.push(source.slice(start, i))
      i++
      if (source[i + 1] === "[") {
        const close = source.indexOf("]", i + 2)
        if (close >= 0) i = close
      }
      start = i + 1
    }
  }
  rows.push(source.slice(start))
  return rows
}

function splitEnvironmentColumns(source: string): string[] {
  const columns: string[] = []
  let start = 0
  let depth = 0
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === "{") depth++
    else if (ch === "}" && depth > 0) depth--
    else if (depth === 0 && ch === "&" && source[i - 1] !== "\\") {
      columns.push(source.slice(start, i))
      start = i + 1
    }
  }
  columns.push(source.slice(start))
  return columns
}

function stripLeadingRawGroup(source: string): string {
  const start = source.search(/\S/)
  if (start < 0 || source[start] !== "{") return source
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}") {
      depth--
      if (depth === 0) return source.slice(i + 1)
    }
  }
  return source
}

function formatEnvironment(name: string, rawSource: string): string {
  const source = name === "array" ? stripLeadingRawGroup(rawSource) : rawSource
  const rows = splitEnvironmentRows(source).filter(row => row.trim().length > 0)

  if (name === "cases") {
    const formatted = rows.map(row => {
      const [expression = "", ...conditionParts] = splitEnvironmentColumns(row)
      const expressionText = formatLatexForTerminal(expression)
      const conditionText = formatLatexForTerminal(conditionParts.join(" "))
      return `│ ${expressionText}${conditionText ? `,  ${conditionText}` : ""}`
    })
    return ["{", ...formatted, "}"].join("\n")
  }

  const delimiters = MATRIX_DELIMITERS[name]
  if (delimiters) {
    const rowText = rows.map(row => splitEnvironmentColumns(row)
      .map(cell => formatLatexForTerminal(cell))
      .join(", "))
      .join("; ")
    return `${delimiters[0]}${rowText}${delimiters[1]}`
  }

  if (["aligned", "alignedat", "gathered", "split", "equation", "equation*"].includes(name)) {
    return rows.map(row => splitEnvironmentColumns(row)
      .map(cell => formatLatexForTerminal(cell))
      .join(""))
      .join("\n")
  }

  const readable = formatLatexForTerminal(source)
  return `⟦environment ${name}${readable ? `: ${readable}` : ""}⟧`
}

function convertScript(value: string, table: Record<string, string>, fallback: "^" | "_"): string {
  let converted = ""
  for (const ch of value) {
    const mapped = table[ch]
    if (!mapped) {
      if (Array.from(value).length === 1 && /^[\p{L}\p{N}∞∂∇α-ωΑ-Ω]$/u.test(value)) {
        return `${fallback}${value}`
      }
      return `${fallback}(${value})`
    }
    converted += mapped
  }
  return converted
}

function isSimpleMathAtom(value: string): boolean {
  return /^[\p{L}\p{N}⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]+$/u.test(value)
}

function fractionPart(value: string): string {
  const trimmed = value.trim()
  // Multi-digit numeric literals are still a single atom (`1/16`), unlike
  // implicit products such as `2bc`, which must render as `1/(2bc)`.
  if (/^\p{N}+(?:[.,]\p{N}+)?$/u.test(trimmed)) return trimmed
  // One base symbol with optional scripts is an unambiguous linear atom.
  // Products such as `2bc` need parentheses when used as a denominator.
  if (/^[\p{L}\p{N}][⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ]*$/u.test(trimmed)) return trimmed
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) return trimmed
  return `(${trimmed})`
}

class LatexParser {
  private index = 0

  constructor(private readonly source: string) {}

  parse(stopAtBrace = false): string {
    let out = ""
    while (this.index < this.source.length) {
      const ch = this.source[this.index]!
      if (stopAtBrace && ch === "}") {
        this.index++
        break
      }
      if (ch === "{") {
        this.index++
        out += this.parse(true)
        continue
      }
      if (ch === "}") {
        // Unmatched closing braces are presentation noise in a terminal.
        this.index++
        continue
      }
      if (ch === "\\") {
        out += this.readCommand()
        continue
      }
      if (ch === "^" || ch === "_") {
        this.index++
        const value = this.readArgument()
        out += convertScript(value, ch === "^" ? SUPERSCRIPT : SUBSCRIPT, ch)
        continue
      }
      if (ch === "-") out += "−"
      else if (ch === "~") out += " "
      else if (ch === "&") { /* alignment marker */ }
      else if (ch === "\n") out += "\n"
      else out += ch
      this.index++
    }
    return out
  }

  private skipSpaces(): void {
    while (this.index < this.source.length && /[ \t]/.test(this.source[this.index]!)) {
      this.index++
    }
  }

  private readArgument(): string {
    this.skipSpaces()
    if (this.index >= this.source.length) return ""
    if (this.source[this.index] === "{") {
      this.index++
      return this.parse(true)
    }
    if (this.source[this.index] === "\\") return this.readCommand()
    const value = this.source[this.index]!
    this.index++
    return value === "-" ? "−" : value
  }

  private readRawGroup(): string {
    this.skipSpaces()
    if (this.source[this.index] !== "{") return ""
    const start = ++this.index
    let depth = 1
    while (this.index < this.source.length) {
      const ch = this.source[this.index]
      if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          const value = this.source.slice(start, this.index)
          this.index++
          return value
        }
      }
      this.index++
    }
    return this.source.slice(start)
  }

  private readEnvironment(): string {
    const name = this.readRawGroup()
    if (!name) return "⟦environment?⟧"
    const endToken = `\\end{${name}}`
    const end = this.source.indexOf(endToken, this.index)
    const body = end >= 0
      ? this.source.slice(this.index, end)
      : this.source.slice(this.index)
    this.index = end >= 0 ? end + endToken.length : this.source.length
    return formatEnvironment(name, body)
  }

  private readCommand(): string {
    this.index++ // consume backslash
    if (this.index >= this.source.length) return ""

    const first = this.source[this.index]!
    if (!/[A-Za-z]/.test(first)) {
      this.index++
      if (first === "\\") return "\n"
      if (first === "," || first === ";" || first === ":") return " "
      if (first === "!") return ""
      return first
    }

    const start = this.index
    while (this.index < this.source.length && /[A-Za-z]/.test(this.source[this.index]!)) {
      this.index++
    }
    const command = this.source.slice(start, this.index)

    if (command === "begin") return this.readEnvironment()
    if (command === "end") {
      const name = this.readRawGroup()
      return `⟦end ${name || "environment"}⟧`
    }

    if (command === "frac" || command === "dfrac" || command === "tfrac") {
      const numerator = this.readArgument()
      const denominator = this.readArgument()
      const vulgar = VULGAR_FRACTIONS[`${numerator}/${denominator}`]
      return vulgar ?? `${fractionPart(numerator)}/${fractionPart(denominator)}`
    }
    if (command === "sqrt") {
      this.skipSpaces()
      let index = ""
      if (this.source[this.index] === "[") {
        const close = this.source.indexOf("]", this.index + 1)
        if (close >= 0) {
          index = this.source.slice(this.index + 1, close)
          this.index = close + 1
        }
      }
      const body = this.readArgument().trim()
      const radical = index ? `${index}√` : "√"
      if (isSimpleMathAtom(body) || (body.startsWith("(") && body.endsWith(")"))) {
        return `${radical}${body}`
      }
      return `${radical}(${body})`
    }
    if (command === "boxed" || command === "fbox") {
      return `⟦${this.readArgument()}⟧`
    }
    const decorator = DECORATORS[command]
    if (decorator) {
      return decorate(this.readArgument(), decorator.mark, decorator.each)
    }
    if (command === "binom" || command === "dbinom" || command === "tbinom") {
      const top = this.readArgument()
      const bottom = this.readArgument()
      return `C(${top}, ${bottom})`
    }
    if (command === "not") {
      this.skipSpaces()
      let target = ""
      if (this.source[this.index] === "\\") target = this.readCommand()
      else if (this.index < this.source.length) target = this.source[this.index++]!
      return NEGATED_SYMBOLS[target] ?? `¬${target}`
    }
    if (command === "overset" || command === "stackrel") {
      const annotation = this.readArgument()
      const base = this.readArgument()
      return `${base}^(${annotation})`
    }
    if (command === "underset") {
      const annotation = this.readArgument()
      const base = this.readArgument()
      return `${base}_(${annotation})`
    }
    if (
      command === "text" || command === "textrm" || command === "mathrm" ||
      command === "mathbf" || command === "mathit" || command === "mathsf" ||
      command === "mathtt"
    ) {
      return this.readArgument()
    }
    if (command === "operatorname") return `\u0000${this.readArgument()}\u0001`
    if ([
      "displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle",
      "limits", "nolimits",
    ].includes(command)) return ""
    if (command === "color") {
      this.readArgument()
      return ""
    }
    if (command === "textcolor") {
      this.readArgument()
      return this.readArgument()
    }
    if (command === "quad") return "  "
    if (command === "qquad") return "    "
    if (command === "left" || command === "right") {
      this.skipSpaces()
      if (this.source[this.index] === ".") this.index++
      return ""
    }
    if (command === "over") return "/"
    if (command === "atop") return " over "
    if (command === "choose") return " choose "

    const mapped = COMMANDS[command]
    if (mapped !== undefined) {
      // A sentinel lets the final cleanup keep one readable boundary before
      // named functions without collapsing deliberate \quad spacing.
      return FUNCTION_COMMANDS.has(command) ? `\u0000${mapped}` : mapped
    }
    // Unknown macros must be visibly marked. Silently stripping the control
    // slash turns `\vec{x}` into the misleading `vecx`; an explicit marker
    // keeps unsupported input searchable without pretending it was rendered.
    return `⟨\\${command}⟩`
  }
}

export function formatLatexForTerminal(source: string): string {
  return new LatexParser(source)
    .parse()
    .replace(/[ \t]*\u0000[ \t]*/g, (_match, offset: number, input: string) => {
      const previous = input[offset - 1]
      return !previous || /[=+\-−*/(<>,]/.test(previous) ? "" : " "
    })
    .replace(/[ \t]*\u0001[ \t]*/g, (match, offset: number, input: string) => {
      const next = input[offset + match.length]
      return !next || /[=+\-−*/()<>,]/.test(next) ? "" : " "
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

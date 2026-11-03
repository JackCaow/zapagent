/** @jsxImportSource react */
import { Box, Text } from "ink"
import { generatedImageArtifact } from "../../zapsdk/utils/generated-image.js"
import { c } from "./theme.js"

/** Stored pixels are small, validated RGB data; no file reads or provider ANSI. */
export function GeneratedImageResult({ meta }: { meta: unknown }) {
  const image = generatedImageArtifact(meta)
  if (!image) return null
  const thumbnail = image.thumbnail
  const rows: string[] = []
  if (thumbnail && Number.isInteger(thumbnail.width) && Number.isInteger(thumbnail.height)
    && thumbnail.width > 0 && thumbnail.width <= 32 && thumbnail.height > 0 && thumbnail.height <= 32
    && typeof thumbnail.rgb === "string" && thumbnail.rgb.length === thumbnail.width * thumbnail.height * 6
    && /^[a-f0-9]+$/.test(thumbnail.rgb)) {
    const rgb = Buffer.from(thumbnail.rgb, "hex")
    const color = (x: number, y: number) => {
      const offset = (Math.min(y, thumbnail.height - 1) * thumbnail.width + x) * 3
      return `${rgb[offset]};${rgb[offset + 1]};${rgb[offset + 2]}`
    }
    for (let y = 0; y < thumbnail.height; y += 2) {
      let line = ""
      for (let x = 0; x < thumbnail.width; x++) line += `\x1b[38;2;${color(x, y)}m\x1b[48;2;${color(x, y + 1)}m▀`
      rows.push(line + "\x1b[0m")
    }
  }
  return <Box flexDirection="column">
    {rows.map((row, index) => <Text key={index}>{row}</Text>)}
    <Text color={c.text.faint}>{`PNG · ${image.width}×${image.height} · ${(image.bytes / 1024).toFixed(0)} KB`}</Text>
  </Box>
}

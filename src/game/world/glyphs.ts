/**
 * A 3x5 pixel font, for numbers painted on the road.
 *
 * Advisory speeds have to be legible from a chase camera at 300km/h, which rules
 * out a texture atlas — the circuit is deliberately untextured so the whole lap
 * renders from one vertex-coloured material, and adding a font atlas would mean
 * adding a texture, a second material and a download for four glyphs' worth of
 * information.
 *
 * A bitmap font solves it with geometry instead: each lit cell becomes one quad
 * on the road surface. A three-digit number is 33 cells at worst, which is
 * cheaper than the chevron next to it.
 *
 * Rows run top to bottom as the driver reads them, and each row's three bits run
 * left to right from the most significant bit.
 */

export const GLYPH_COLUMNS = 3;
export const GLYPH_ROWS = 5;
/** Columns from one glyph's left edge to the next: 3 lit, 1 blank. */
export const GLYPH_ADVANCE = 4;

/* eslint-disable no-bitwise */
const FONT: Record<string, readonly number[]> = {
  "0": [0b111, 0b101, 0b101, 0b101, 0b111],
  "1": [0b010, 0b110, 0b010, 0b010, 0b111],
  "2": [0b111, 0b001, 0b111, 0b100, 0b111],
  "3": [0b111, 0b001, 0b111, 0b001, 0b111],
  "4": [0b101, 0b101, 0b111, 0b001, 0b001],
  "5": [0b111, 0b100, 0b111, 0b001, 0b111],
  "6": [0b111, 0b100, 0b111, 0b101, 0b111],
  "7": [0b111, 0b001, 0b010, 0b010, 0b010],
  "8": [0b111, 0b101, 0b111, 0b101, 0b111],
  "9": [0b111, 0b101, 0b111, 0b001, 0b001],
};

/** Total columns a string occupies, with no trailing gap. */
export function glyphTextColumns(text: string): number {
  if (text.length === 0) return 0;
  return text.length * GLYPH_ADVANCE - (GLYPH_ADVANCE - GLYPH_COLUMNS);
}

/**
 * Visit every lit cell of `text`.
 *
 * `column` is 0 at the left edge of the string, `row` is 0 at the top. Unknown
 * characters occupy their slot and light nothing, so a stray character shifts the
 * rest of the string rather than silently closing up.
 */
export function forEachGlyphCell(
  text: string,
  visit: (column: number, row: number) => void,
): void {
  for (let index = 0; index < text.length; index += 1) {
    const glyph = FONT[text[index]!];
    if (!glyph) continue;
    const originColumn = index * GLYPH_ADVANCE;
    for (let row = 0; row < GLYPH_ROWS; row += 1) {
      const bits = glyph[row] ?? 0;
      for (let column = 0; column < GLYPH_COLUMNS; column += 1) {
        // Most significant bit first, so the literals above read as pictures.
        if (bits & (1 << (GLYPH_COLUMNS - 1 - column))) {
          visit(originColumn + column, row);
        }
      }
    }
  }
}
/* eslint-enable no-bitwise */

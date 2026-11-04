/**
 * Fills for categorical bar series, readable on a colour e-ink panel: solid colours only (patterns blur on the
 * glass), chosen for the widest spread in lightness, so that stacked series stay apart even where the glass mutes
 * the colours (web/design/eink.md): ink is near black, rust and forest mid, ochre light. Ochre, the lightest,
 * gets an ink outline so it never melts into the paper. Callers keep i stable per entity (lib/cost.ts
 * applianceOrder) and draw a one-pixel paper gap between stacked segments.
 */
interface Style {
  colour: string;
  outline: boolean;
}
const STYLES: Style[] = [
  { colour: '--surface-forest', outline: false },
  { colour: '--surface-rust', outline: false },
  { colour: '--ochre', outline: true },
  { colour: '--ink', outline: false },
  { colour: '--ink-muted', outline: false },
];

const style = (i: number) => STYLES[((i % STYLES.length) + STYLES.length) % STYLES.length]!;

export function seriesFill(i: number): string {
  return `var(${style(i).colour})`;
}

/** The outline for a series' marks: ink for the light ones, none for the rest. */
export function seriesStroke(i: number): string {
  return style(i).outline ? 'var(--ink)' : 'none';
}

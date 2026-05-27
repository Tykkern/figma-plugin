# Claude Design → Figma Plugin: JSON Format Spec

This file tells Claude how to generate UI designs that import directly into Figma
via the **Design from Claude** plugin (`figma-plugin/`).

---

## How it works

1. Claude generates a design as a JSON file matching the schema below.
2. User opens the **Design from Claude** Figma plugin.
3. User loads the JSON → plugin builds fully editable Figma frames (text, shapes, icons).

---

## Output format

When asked to produce a Figma-importable design, output a single JSON object:

```json
{
  "screens": [
    {
      "id": "string — unique name, e.g. \"light-feed\"",
      "theme": "string — e.g. \"light\" | \"dark\" | \"brand\"",
      "screen": "string — e.g. \"feed\" | \"login\" | \"profile\"",
      "width": 402,
      "height": 874,
      "layers": [ ...layer objects, back-to-front paint order... ]
    }
  ]
}
```

Multiple screens = multiple Figma frames. They will be laid out on the canvas
in a grid ordered by theme (rows) and screen (columns).

---

## Layer types

### `rect` — rectangle / background / card / divider

```json
{
  "type": "rect",
  "x": 0,
  "y": 0,
  "width": 402,
  "height": 874,
  "cornerRadius": 0,
  "fill": "#B5E0F0",
  "fillOpacity": 1,
  "stroke": null,
  "strokeWidth": 0,
  "strokeOpacity": 1
}
```

- `fill`: hex color string, or `null` for no fill (stroke-only outlines).
- `fillOpacity`: 0–1.
- `stroke`: hex color string, or `null`.
- `cornerRadius`: pixels, uniform for all corners.

---

### `text` — label, heading, body copy

```json
{
  "type": "text",
  "x": 18,
  "y": 96,
  "width": 300,
  "height": 24,
  "content": "Hi, Alina — fresh looks for you",
  "fontFamily": "Manrope",
  "fontSize": 26,
  "fontWeight": "700",
  "fill": "#0A0A0A",
  "fillOpacity": 1,
  "textAlign": "left",
  "letterSpacing": -0.3
}
```

- `x`, `y`: top-left corner of the text bounding box (not baseline).
- Each **visual line** of multi-line text should be a **separate `text` layer**
  so that positioning is pixel-accurate.
- `fontWeight`: string — `"400"` Regular, `"500"` Medium, `"600"` SemiBold,
  `"700"` Bold, `"800"` ExtraBold.
- `fontFamily`: use fonts available in Figma via Google Fonts
  (e.g. `"Manrope"`, `"Inter"`, `"Roboto"`, `"Caprasimo"`).
- `textAlign`: `"left"` | `"center"` | `"right"`.
- `letterSpacing`: pixels (0 = normal).

---

### `svg` — icon or illustration

```json
{
  "type": "svg",
  "x": 183,
  "y": 420,
  "width": 36,
  "height": 36,
  "opacity": 1,
  "svgContent": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"36\" height=\"36\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#0A0A0A\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z\"/></svg>"
}
```

- `svgContent`: a complete `<svg>` string with explicit `width`, `height`, and `viewBox`.
- Use `stroke="<hex>"` directly — do **not** use `currentColor`.
- Keep paths clean; Figma will parse them as editable vector nodes.

---

## Design rules

| Rule | Detail |
|------|--------|
| Coordinate origin | Top-left corner of the frame is `(0, 0)` |
| Units | All numbers are CSS pixels (dp) |
| Layer order | First layer in the array = bottom of the stack |
| Clipping | The frame clips all content automatically; layers outside bounds are hidden |
| Opacity | Per-layer `opacity` field (0–1); omit or set to 1 if fully opaque |
| No groups | Use flat layer arrays; do not nest `layers` inside layers |
| Screen size | Default mobile frame: `402 × 874` px (iPhone 14 Pro logical size) |

---

## Minimal example — a splash screen

```json
{
  "screens": [
    {
      "id": "brand-splash",
      "theme": "brand",
      "screen": "splash",
      "width": 402,
      "height": 874,
      "layers": [
        { "type": "rect",  "x": 0,   "y": 0,   "width": 402, "height": 874, "cornerRadius": 0,  "fill": "#1A1A2E", "fillOpacity": 1, "stroke": null },
        { "type": "rect",  "x": 151, "y": 357,  "width": 100, "height": 100, "cornerRadius": 50, "fill": "#FFFFFF", "fillOpacity": 0.1, "stroke": null },
        { "type": "svg",   "x": 175, "y": 381, "width": 52,  "height": 52,  "opacity": 1,
          "svgContent": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"52\" height=\"52\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#FFFFFF\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><line x1=\"12\" y1=\"8\" x2=\"12\" y2=\"12\"/><line x1=\"12\" y1=\"16\" x2=\"12.01\" y2=\"16\"/></svg>" },
        { "type": "text",  "x": 0,   "y": 492, "width": 402, "height": 36,  "content": "myapp",      "fontFamily": "Inter", "fontSize": 32, "fontWeight": "700", "fill": "#FFFFFF", "fillOpacity": 1, "textAlign": "center", "letterSpacing": -1 },
        { "type": "text",  "x": 0,   "y": 536, "width": 402, "height": 20,  "content": "tap to begin", "fontFamily": "Inter", "fontSize": 14, "fontWeight": "400", "fill": "#FFFFFF", "fillOpacity": 0.55, "textAlign": "center", "letterSpacing": 0.5 }
      ]
    }
  ]
}
```

---

## How to invoke Claude

Prompt examples that trigger this output:

> "Design a dark-theme onboarding screen for a finance app and export it as
> Figma plugin JSON using the format in CLAUDE.md."

> "Generate 3 screens (splash, login, dashboard) for a travel app — light theme.
> Output as `outfitfly-figma.json` compatible JSON."

Claude should respond with a fenced `json` code block containing the full JSON,
ready to save as `outfitfly-figma.json` and load into the Figma plugin.

---

## Plugin files

| File | Purpose |
|------|---------|
| `manifest.json` | Figma plugin descriptor |
| `code.js` | Main thread — creates Figma nodes from JSON |
| `ui.html` | Plugin UI — file picker + import button |

Install: Figma Desktop → **Plugins → Development → Import plugin from manifest…**
→ select `manifest.json`.

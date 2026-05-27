// Outfitfly Figma Plugin — main thread
// Receives layer JSON from ui.html and builds editable Figma nodes.

figma.showUI(__html__, { width: 380, height: 440, title: 'Outfitfly Import' });

// ── Helpers ────────────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const full  = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean;
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
  };
}

function solidPaint(hex, opacity = 1) {
  return [{ type: 'SOLID', color: hexToRgb(hex), opacity }];
}

// CSS numeric font-weight → Figma style name.
// Falls back gracefully if the exact style isn't available.
const WEIGHT_TO_STYLE = {
  '100': ['Thin',       'ExtraLight', 'Light', 'Regular'],
  '200': ['ExtraLight', 'Thin',       'Light', 'Regular'],
  '300': ['Light',      'Regular'],
  '400': ['Regular',    'Light'],
  '500': ['Medium',     'Regular'],
  '600': ['SemiBold',   'Bold',       'Medium', 'Regular'],
  '700': ['Bold',       'SemiBold'],
  '800': ['ExtraBold',  'Bold'],
  '900': ['Black',      'ExtraBold',  'Bold'],
};

async function loadFont(family, cssWeight) {
  const candidates = WEIGHT_TO_STYLE[cssWeight] || ['Regular'];
  for (const style of candidates) {
    try {
      await figma.loadFontAsync({ family, style });
      return { family, style };
    } catch (_) {}
  }
  // Last-resort fallback
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  return { family: 'Inter', style: 'Regular' };
}

// ── Layer builders ─────────────────────────────────────────────────────────────

function buildRect(layer, parent) {
  const node = figma.createRectangle();
  node.x = layer.x;
  node.y = layer.y;
  node.resize(Math.max(1, layer.width), Math.max(1, layer.height));
  node.cornerRadius = layer.cornerRadius || 0;
  node.name = 'rect';

  if (layer.fill) {
    node.fills = solidPaint(layer.fill, layer.fillOpacity != null ? layer.fillOpacity : 1);
  } else {
    node.fills = [];
  }

  if (layer.stroke) {
    node.strokes     = solidPaint(layer.stroke, layer.strokeOpacity != null ? layer.strokeOpacity : 1);
    node.strokeWeight = layer.strokeWidth || 1;
    node.strokeAlign  = 'INSIDE';
  }

  parent.appendChild(node);
}

async function buildText(layer, parent, fontCache) {
  const cacheKey = `${layer.fontFamily}::${layer.fontWeight}`;
  if (!fontCache.has(cacheKey)) {
    fontCache.set(cacheKey, await loadFont(layer.fontFamily, String(layer.fontWeight)));
  }
  const fontName = fontCache.get(cacheKey);

  const node = figma.createText();
  node.fontName    = fontName;
  node.fontSize    = layer.fontSize || 14;
  node.characters  = layer.content;
  node.fills       = solidPaint(layer.fill, layer.fillOpacity != null ? layer.fillOpacity : 1);

  if (layer.letterSpacing && layer.letterSpacing !== 0) {
    node.letterSpacing = { unit: 'PIXELS', value: layer.letterSpacing };
  }

  const ta = layer.textAlign;
  node.textAlignHorizontal =
    ta === 'center' ? 'CENTER' :
    ta === 'right'  ? 'RIGHT'  : 'LEFT';

  node.textAutoResize = 'HEIGHT';
  node.x = layer.x;
  node.y = layer.y;
  node.resize(Math.max(1, layer.width), Math.max(1, layer.height));
  node.name = layer.content.slice(0, 40);

  parent.appendChild(node);
}

function buildSvg(layer, parent) {
  try {
    const node = figma.createNodeFromSvg(layer.svgContent);
    node.x = layer.x;
    node.y = layer.y;
    node.name = 'icon';
    parent.appendChild(node);
  } catch (e) {
    // If SVG parse fails, drop a placeholder rectangle
    const fallback = figma.createRectangle();
    fallback.x      = layer.x;
    fallback.y      = layer.y;
    fallback.resize(Math.max(1, layer.width), Math.max(1, layer.height));
    fallback.fills  = solidPaint('#cccccc', 0.4);
    fallback.name   = 'icon (parse error)';
    parent.appendChild(fallback);
  }
}

// ── Main import ────────────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg) => {
  if (msg.type !== 'import') return;

  const screens   = msg.screens || [];
  const total     = screens.length;
  const fontCache = new Map();

  // Layout: themes as rows, screens as columns.
  // Each frame is 402×874, gap 40px between frames and 80px between theme rows.
  const FRAME_W  = 402;
  const FRAME_H  = 874;
  const GAP_X    = 40;
  const GAP_Y    = 80;
  const SCREENS_PER_ROW = 9;

  const themeOrder  = ['light', 'dark', 'a11y'];
  const screenOrder = ['splash','login','feed','wardrobe','carousel','wishlist','search','profile','settings'];

  try {
    for (let si = 0; si < screens.length; si++) {
      const screen = screens[si];
      figma.ui.postMessage({ type: 'progress', current: si + 1, total, label: screen.id });

      const themeIdx  = themeOrder.indexOf(screen.theme);
      const screenIdx = screenOrder.indexOf(screen.screen);
      const col = screenIdx >= 0 ? screenIdx : si % SCREENS_PER_ROW;
      const row = themeIdx  >= 0 ? themeIdx  : Math.floor(si / SCREENS_PER_ROW);

      const frame = figma.createFrame();
      frame.name         = screen.id;
      frame.resize(FRAME_W, FRAME_H);
      frame.x = col * (FRAME_W + GAP_X);
      frame.y = row * (FRAME_H + GAP_Y);
      frame.clipsContent = true;
      frame.fills        = [];

      figma.currentPage.appendChild(frame);

      for (const layer of (screen.layers || [])) {
        if (layer.type === 'rect') {
          buildRect(layer, frame);
        } else if (layer.type === 'text') {
          await buildText(layer, frame, fontCache);
        } else if (layer.type === 'svg') {
          buildSvg(layer, frame);
        }
      }
    }

    // Select and zoom to all created frames
    const created = figma.currentPage.children.slice(-screens.length);
    figma.currentPage.selection = created;
    figma.viewport.scrollAndZoomIntoView(created);

    figma.ui.postMessage({ type: 'done', count: screens.length });
  } catch (e) {
    figma.ui.postMessage({ type: 'error', message: e.message });
  }
};

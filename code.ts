/**
 * HTML → Figma — main thread
 *
 * The UI renders the HTML in a real browser and sends a tree of boxes, text
 * runs, paints and SVG markup measured from that render (page coordinates).
 * This side only rebuilds it: nested Frames with parent-relative positions,
 * rich Text, native gradients/images/vectors.
 *
 * Motion: every element that animates, reacts to hover or changes on click
 * arrives as a component description (one tree per state + the steps between
 * them). It becomes a component set whose variants are wired with prototype
 * reactions (Smart Animate), and the page holds an instance where the element
 * was ({type:'ref'}). Anchor links, page links and position: fixed become
 * prototype links / fixed layers; what Figma can't play goes to a spec frame.
 */

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

type PaintSpec =
  | { type: 'SOLID'; color: Rgba }
  | { type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL'; gradientTransform: Transform; gradientStops: ColorStop[] }
  | { type: 'IMAGE'; scaleMode: 'FILL' | 'FIT'; imageRef?: string; url?: string };

interface Run {
  text: string;
  families: string[]; // font-family stack, first = what the browser actually rendered
  weight: number;
  italic: boolean;
  size: number;
  lineHeight: number;
  letterSpacing: number;
  color: Rgba;
  fills?: PaintSpec[]; // background-clip: text
  decoration?: 'UNDERLINE' | 'STRIKETHROUGH';
  textCase?: TextCase;
  href?: string;
}

interface HtmlNode {
  type: 'frame' | 'text' | 'svg' | 'ref';
  name?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity?: number;
  blend?: BlendMode;
  fills?: PaintSpec[];
  stroke?: { color: Rgba; t: number; r: number; b: number; l: number; dash?: number[] };
  radius?: number[] | null; // tl, tr, br, bl
  effects?: Effect[];
  clip?: boolean;
  transform?: { m: number[]; ox: number; oy: number }; // CSS matrix(a,b,c,d,e,f) + transform-origin
  children?: HtmlNode[];
  // text
  runs?: Run[];
  align?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  anchor?: 'LEFT' | 'CENTER' | 'RIGHT'; // edge an auto-width line keeps when Figma's width differs
  autoWidth?: boolean;
  maxLines?: number;
  breaks?: number[]; // character offsets where the browser wrapped
  // svg
  svg?: string;
  // motion
  key?: string; // ref: the component to place here
  tree?: HtmlNode; // ref: its look after a click (text overrides, or drawn as a copy)
  k?: string; // element key: what a click step's trigger points at
  domId?: string; // element id: target of "#id" links
  href?: string; // <a href>
  fixed?: boolean; // position: fixed
}

/** One prototype step between two variants. */
interface Step {
  from: number;
  to: number;
  trigger: 'hover' | 'click' | 'timeout';
  timeout?: number; // ms, as Figma stores "After delay"
  node?: string; // click: key of the element clicked inside the variant
  duration: number; // s, as Figma stores transition durations
  easing: number[] | null; // cubic-bezier; null = instant
}

interface Comp {
  key: string;
  kind: 'hover' | 'click' | 'loop' | 'once' | 'static';
  name: string;
  note?: string;
  depth: number;
  states: { name: string; tree: HtmlNode }[];
  steps: Step[];
}

interface SpecRow {
  type: string;
  name: string;
  detail: string;
  status: string;
}

interface PageSpec {
  name: string;
  file: string;
  tree: HtmlNode;
  comps: Comp[];
  spec: SpecRow[];
}

interface SetInfo {
  main: ComponentNode; // default variant
  tree: HtmlNode; // its tree
  off: { x: number; y: number }; // root box − component origin
}

interface Ctx {
  images: Map<string, string>; // imageRef or url -> Figma image hash
  font: (r: Run) => FontName;
  sets: Map<string, SetInfo>; // this page's component sets by element key
  statics: Map<string, HtmlNode>; // roots with nothing to animate: drawn in place
  byKey: Map<string, SceneNode> | null; // element key -> node (inside one variant)
  anchors: Map<string, SceneNode> | null; // element id -> node (page only)
  links: { node: SceneNode; href: string }[] | null;
  fixed: SceneNode[] | null;
}

type Screen = FrameNode | ComponentNode;

const LINE_BREAK = String.fromCharCode(0x2028); // soft line break inside a Figma text layer
type Reactions = Map<SceneNode, Reaction[]>;

figma.showUI(__html__, { width: 360, height: 660, themeColors: true });

figma.ui.onmessage = async (msg: {
  type: string;
  pages?: PageSpec[];
  tree?: HtmlNode;
  images?: Record<string, string>;
  viewportWidth?: number;
  viewportHeight?: number;
  sourceName?: string;
  asComponent?: boolean;
  settings?: unknown;
}) => {
  if (msg.type === 'load-settings') {
    figma.ui.postMessage({ type: 'settings', settings: await figma.clientStorage.getAsync('settings') });
    return;
  }
  if (msg.type === 'save-settings') {
    await figma.clientStorage.setAsync('settings', msg.settings);
    return;
  }
  if (msg.type !== 'convert') return;
  const pages: PageSpec[] = msg.pages || (msg.tree ? [{ name: msg.sourceName || '', file: '', tree: msg.tree, comps: [], spec: [] }] : []);
  if (!pages.length) return;
  try {
    const everything: HtmlNode = { type: 'frame', x: 0, y: 0, w: 0, h: 0, children: [] };
    for (const p of pages) {
      everything.children!.push(p.tree);
      for (const c of p.comps) for (const s of c.states) everything.children!.push(s.tree);
    }
    progress('Шрифты и изображения…');
    const [images, fonts] = await Promise.all([loadImages(everything, msg.images || {}), loadFonts(everything)]);
    const size = msg.viewportHeight ? `${msg.viewportWidth}×${msg.viewportHeight}px` : `${msg.viewportWidth}px`;
    const suffix = msg.viewportWidth ? ` · ${size}` : '';
    const reactions: Reactions = new Map();
    const center = figma.viewport.center;
    const firstX = Math.round(center.x - (msg.viewportWidth || 1440) / 2);
    const topY = Math.round(center.y - (msg.viewportHeight || 1024) / 2);
    let x = firstX;
    let area: FrameNode | null = null;
    const screens: Screen[] = [];
    const ctxs: Ctx[] = [];
    let comps = 0;

    for (const page of pages) {
      const ctx: Ctx = {
        images, font: fonts.get, sets: new Map(), statics: new Map(),
        byKey: null, anchors: new Map(), links: [], fixed: [],
      };
      if (page.comps.some((c) => c.kind !== 'static')) area = area || createArea();
      progress(`Компоненты: ${page.name || 'страница'}…`);
      comps += buildComponents(page.comps, ctx, area, reactions);
      progress(`Слои: ${page.name || 'страница'}…`);
      let root = build(page.tree, null, ctx) as Screen;
      root.name = (page.name || msg.sourceName || 'HTML Import') + suffix;
      root.x = x;
      root.y = topY;
      x += root.width + 240;
      figma.currentPage.appendChild(root);
      pinFixed(root, ctx.fixed!);
      if (msg.asComponent) root = figma.createComponentFromNode(root);
      screens.push(root);
      ctxs.push(ctx);
    }

    const byFile = new Map<string, Screen>();
    pages.forEach((p, i) => { if (p.file) byFile.set(fileKey(p.file), screens[i]); });
    let links = 0;
    ctxs.forEach((ctx, i) => { links += linkReactions(ctx, screens[i], byFile, reactions); });
    progress('Прототип: переходы и анимации…');
    const failed = await applyReactions(reactions);

    let bottom = topY;
    for (const s of screens) bottom = Math.max(bottom, s.y + s.height);
    let specX = x;
    for (const page of pages) {
      const spec = await buildSpec(page, specX, topY);
      if (spec) specX += spec.width + 120;
    }
    if (area) {
      area.x = firstX;
      area.y = bottom + 400;
    }

    let styles = 0;
    for (const s of screens) styles = Math.max(styles, await linkColorStyles(s));
    if (area) await linkColorStyles(area);
    try {
      const flows = figma.currentPage.flowStartingPoints.filter((f) => f.nodeId !== screens[0].id);
      figma.currentPage.flowStartingPoints = flows.concat([{ nodeId: screens[0].id, name: screens[0].name }]);
    } catch (e) {
      // flows are a convenience; the frames are there either way
    }
    figma.currentPage.selection = screens;
    figma.viewport.scrollAndZoomIntoView(screens);
    let count = 0;
    for (const s of screens) count += countNodes(s);
    if (area) count += countNodes(area);
    figma.ui.postMessage({ type: 'done', count, styles, comps, links, failed, missingFonts: fonts.missing });
  } catch (err) {
    figma.ui.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

function progress(text: string): void {
  figma.ui.postMessage({ type: 'progress', text });
}

// ---------------------------------------------------------------------------
// Node building
// ---------------------------------------------------------------------------

function build(n: HtmlNode, parent: HtmlNode | null, ctx: Ctx): SceneNode | null {
  if (n.type === 'ref') return buildRef(n, parent, ctx);
  const relX = parent ? n.x - parent.x : 0;
  const relY = parent ? n.y - parent.y : 0;
  let node: SceneNode;

  if (n.type === 'text') {
    const t = buildText(n, ctx);
    const slack = t.textAutoResize === 'WIDTH_AND_HEIGHT' ? n.w - t.width : 0; // browser − Figma width
    const anchor = n.anchor || n.align;
    t.x = relX + (anchor === 'CENTER' ? slack / 2 : anchor === 'RIGHT' ? slack : 0);
    t.y = relY;
    node = t;
  } else if (n.type === 'svg') {
    node = buildSvg(n);
    node.x = relX;
    node.y = relY;
  } else {
    const kids = n.children || [];
    const box = kids.length || !parent ? figma.createFrame() : figma.createRectangle();
    if (n.name) box.name = n.name;
    box.resize(Math.max(n.w, 0.01), Math.max(n.h, 0.01));
    box.x = relX;
    box.y = relY;
    box.fills = paints(n.fills, ctx);
    applyStroke(box, n);
    applyRadius(box, n.radius);
    if (box.type === 'FRAME') {
      box.clipsContent = !!n.clip;
      for (const child of kids) {
        const c = build(child, n, ctx);
        if (c) box.appendChild(c);
      }
    }
    node = box;
  }

  if (n.effects && n.effects.length && 'effects' in node) setEffects(node, n.effects);
  if (n.opacity !== undefined && n.opacity < 1) node.opacity = Math.max(0, n.opacity);
  if (n.blend) node.blendMode = n.blend;
  if (n.transform) applyTransform(node, n, relX, relY);
  remember(node, n, ctx);
  return node;
}

/** Bookkeeping for the prototype: click targets, anchors, links, fixed layers. */
function remember(node: SceneNode, n: HtmlNode, ctx: Ctx): void {
  if (n.k && ctx.byKey) ctx.byKey.set(n.k, node);
  if (n.domId && ctx.anchors && !ctx.anchors.has(n.domId)) ctx.anchors.set(n.domId, node);
  if (n.href && ctx.links) ctx.links.push({ node, href: n.href });
  if (n.fixed && ctx.fixed) ctx.fixed.push(node);
}

/** An element captured as a component: its instance, or a drawn copy when no instance fits. */
function buildRef(n: HtmlNode, parent: HtmlNode | null, ctx: Ctx): SceneNode | null {
  const px = parent ? parent.x : 0;
  const py = parent ? parent.y : 0;
  const set = ctx.sets.get(n.key || '');
  if (set && (!n.tree || sameButText(set.tree, n.tree))) {
    const inst = set.main.createInstance();
    inst.x = n.x - px - set.off.x;
    inst.y = n.y - py - set.off.y;
    if (n.tree) overrideTexts(inst, n.tree);
    remember(inst, n, ctx);
    return inst;
  }
  const tree = n.tree || ctx.statics.get(n.key || '');
  if (!tree) return null;
  // Drawn where the ref is, even if the copy was measured a little elsewhere.
  return build(tree, { x: px - (n.x - tree.x), y: py - (n.y - tree.y) } as HtmlNode, ctx);
}

/** Same layers apart from what the text says (and the text widths that follow from it). */
function sameButText(a: HtmlNode, b: HtmlNode): boolean {
  const shape = (t: HtmlNode) =>
    JSON.stringify(t, function (this: Record<string, unknown>, k: string, v: unknown) {
      if (k === 'text' && 'size' in this) return '';
      if ((k === 'w' || k === 'x' || k === 'breaks') && this.type === 'text') return undefined;
      return v;
    });
  return shape(a) === shape(b);
}

/** Text layers in build order, not looking into nested instances (they keep their own text). */
function ownTexts(node: SceneNode, out: TextNode[]): TextNode[] {
  if (node.type === 'TEXT') out.push(node);
  else if ('children' in node && node.type !== 'INSTANCE') for (const c of node.children) ownTexts(c, out);
  return out;
}

function overrideTexts(inst: InstanceNode, tree: HtmlNode): void {
  const want: string[] = [];
  const visit = (n: HtmlNode) => {
    if (n.type === 'text') want.push((n.runs || []).map((r) => r.text).join(''));
    for (const c of n.children || []) visit(c);
  };
  visit(tree);
  const have: TextNode[] = [];
  for (const c of inst.children) ownTexts(c, have);
  if (have.length !== want.length) return;
  have.forEach((t, i) => {
    if (t.characters.split(LINE_BREAK).join(' ') === want[i]) return;
    try {
      t.characters = want[i];
    } catch (e) {
      // font not loaded for this run: keep the default text
    }
  });
}

function buildText(n: HtmlNode, ctx: Ctx): TextNode {
  const t = figma.createText();
  const runs = n.runs || [];
  t.fontName = ctx.font(runs[0]);
  t.characters = runs.map((r) => r.text).join('');
  let i = 0;
  for (const r of runs) {
    const end = i + r.text.length;
    if (end > i) {
      t.setRangeFontName(i, end, ctx.font(r));
      t.setRangeFontSize(i, end, Math.max(r.size, 1));
      t.setRangeLineHeight(i, end, { unit: 'PIXELS', value: Math.max(r.lineHeight, 0) });
      if (r.letterSpacing) t.setRangeLetterSpacing(i, end, { unit: 'PIXELS', value: r.letterSpacing });
      t.setRangeFills(i, end, r.fills ? paints(r.fills, ctx) : [solid(r.color)]);
      if (r.decoration) t.setRangeTextDecoration(i, end, r.decoration);
      if (r.textCase) t.setRangeTextCase(i, end, r.textCase);
      if (r.href) {
        try {
          t.setRangeHyperlink(i, end, { type: 'URL', value: r.href });
        } catch (e) {
          // not a URL Figma accepts; keep the text
        }
      }
    }
    i = end;
  }
  t.textAlignHorizontal = n.align || 'LEFT';
  if (n.autoWidth) {
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
  } else {
    t.resize(Math.max(n.w, 1), Math.max(n.h, 1));
    t.textAutoResize = 'HEIGHT';
    const line = Math.min(...runs.map((r) => r.lineHeight)) || 1;
    if (n.breaks && n.breaks.length && n.align !== 'JUSTIFIED' && Math.abs(t.height - n.h) > line / 2) {
      // Figma's copy of the font wraps differently: keep the browser's lines (soft breaks).
      for (const at of n.breaks.slice().sort((a, b) => b - a)) {
        let pos = Math.min(at, t.characters.length);
        if (t.characters[pos - 1] === ' ') {
          t.deleteCharacters(pos - 1, pos); // the space the browser wrapped at
          pos--;
        }
        t.insertCharacters(pos, LINE_BREAK, pos > 0 ? 'BEFORE' : 'AFTER');
      }
      t.textAutoResize = 'WIDTH_AND_HEIGHT';
    }
  }
  if (n.maxLines) {
    t.textTruncation = 'ENDING';
    t.maxLines = n.maxLines;
  }
  return t;
}

function buildSvg(n: HtmlNode): FrameNode {
  let f: FrameNode;
  try {
    f = figma.createNodeFromSvg(n.svg || '');
  } catch (e) {
    f = figma.createFrame();
    f.fills = [];
    f.name = 'svg (не импортировался)';
  }
  if (n.name) f.name = n.name;
  f.resize(Math.max(n.w, 0.01), Math.max(n.h, 0.01));
  f.clipsContent = !!n.clip;
  return f;
}

/** CSS transform (rotation + uniform scale) around transform-origin. */
function applyTransform(node: SceneNode, n: HtmlNode, relX: number, relY: number): void {
  const [a, b, c, d, e, f] = n.transform!.m;
  const s = Math.hypot(a, b);
  if (Math.abs(s - 1) > 0.001 && 'rescale' in node) node.rescale(s);
  const ra = a / s, rb = b / s, rc = c / s, rd = d / s;
  const { ox, oy } = n.transform!;
  node.relativeTransform = [
    [ra, rc, relX + ox - s * (ra * ox + rc * oy) + e],
    [rb, rd, relY + oy - s * (rb * ox + rd * oy) + f],
  ];
}

// ---------------------------------------------------------------------------
// Components and prototype
// ---------------------------------------------------------------------------

const areaLayout = { x: 80, y: 80, row: 0, right: 0 };

function createArea(): FrameNode {
  const a = figma.createFrame();
  a.name = 'Компоненты · анимации и состояния';
  a.fills = [{ type: 'SOLID', color: { r: 0.95, g: 0.95, b: 0.96 } }];
  a.clipsContent = false;
  figma.currentPage.appendChild(a);
  areaLayout.x = 80;
  areaLayout.y = 80;
  areaLayout.row = 0;
  areaLayout.right = 0;
  return a;
}

function placeInArea(area: FrameNode, node: SceneNode): void {
  if (areaLayout.x > 80 && areaLayout.x + node.width > 6000) {
    areaLayout.x = 80;
    areaLayout.y += areaLayout.row + 120;
    areaLayout.row = 0;
  }
  node.x = areaLayout.x;
  node.y = areaLayout.y;
  areaLayout.x += node.width + 120;
  areaLayout.row = Math.max(areaLayout.row, node.height);
  areaLayout.right = Math.max(areaLayout.right, areaLayout.x);
  area.resizeWithoutConstraints(Math.max(areaLayout.right, 400), areaLayout.y + areaLayout.row + 80);
}

/** Component sets, deepest first so that sets nested in others already exist. */
function buildComponents(comps: Comp[], ctx: Ctx, area: FrameNode | null, reactions: Reactions): number {
  let made = 0;
  for (const c of comps.slice().sort((a, b) => b.depth - a.depth)) {
    if (c.kind === 'static' || c.states.length < 2 || !area) {
      ctx.statics.set(c.key, c.states[0].tree);
      continue;
    }
    const trees = c.states.map((s) => s.tree);
    const u = union(trees);
    const variants: ComponentNode[] = [];
    const maps: Map<string, SceneNode>[] = [];
    for (const s of c.states) {
      const comp = figma.createComponent();
      comp.name = 'Состояние=' + s.name.replace(/[=,]/g, ' ');
      comp.resizeWithoutConstraints(Math.max(u.w, 1), Math.max(u.h, 1));
      comp.fills = [];
      comp.clipsContent = false;
      const sub: Ctx = Object.assign({}, ctx, { byKey: new Map<string, SceneNode>(), anchors: null, links: null, fixed: null });
      const node = build(s.tree, { x: u.x, y: u.y } as HtmlNode, sub);
      if (node) comp.appendChild(node);
      variants.push(comp);
      maps.push(sub.byKey!);
    }
    const set = figma.combineAsVariants(variants, area);
    set.name = c.name;
    if (c.note) set.description = c.note;
    let y = 40, w = 0;
    for (const v of variants) {
      v.x = 40;
      v.y = y;
      y += v.height + 40;
      w = Math.max(w, v.width);
    }
    set.resizeWithoutConstraints(w + 80, y);
    set.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    placeInArea(area, set);
    ctx.sets.set(c.key, { main: variants[0], tree: trees[0], off: { x: trees[0].x - u.x, y: trees[0].y - u.y } });
    for (const s of c.steps) {
      const src = s.trigger === 'click' ? maps[s.from].get(s.node || '') : variants[s.from];
      if (src) queue(reactions, src, { trigger: triggerOf(s), actions: [changeTo(variants[s.to], s)] });
    }
    made++;
  }
  return made;
}

function union(trees: HtmlNode[]): { x: number; y: number; w: number; h: number } {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const n of trees) {
    l = Math.min(l, n.x);
    t = Math.min(t, n.y);
    r = Math.max(r, n.x + n.w);
    b = Math.max(b, n.y + n.h);
  }
  return { x: l, y: t, w: r - l, h: b - t };
}

function queue(reactions: Reactions, node: SceneNode, r: Reaction): void {
  const list = reactions.get(node);
  if (list) list.push(r);
  else reactions.set(node, [r]);
}

function triggerOf(s: Step): Trigger {
  if (s.trigger === 'hover') return { type: 'ON_HOVER' };
  if (s.trigger === 'click') return { type: 'ON_CLICK' };
  return { type: 'AFTER_TIMEOUT', timeout: Math.max(1, Math.round(s.timeout || 1)) }; // ms
}

function changeTo(dest: ComponentNode, s: Step): Action {
  return {
    type: 'NODE',
    destinationId: dest.id,
    navigation: 'CHANGE_TO',
    transition: s.easing && s.duration > 0 ? { type: 'SMART_ANIMATE', easing: easingOf(s.easing), duration: s.duration } : null,
  };
}

function easingOf(b: number[]): Easing {
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 1) return { type: 'LINEAR' };
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: clamp(b[0]), y1: b[1], x2: clamp(b[2]), y2: b[3] } };
}

/** position: fixed layers move to the screen's top level and stay put while it scrolls. */
function pinFixed(root: Screen, fixed: SceneNode[]): void {
  const all = new Set<BaseNode>(fixed);
  const top = fixed.filter((n) => {
    for (let p = n.parent; p && p !== root; p = p.parent) if (all.has(p)) return false; // inside another fixed layer
    return true;
  });
  for (const n of top) {
    const ax = n.absoluteTransform[0][2] - root.absoluteTransform[0][2];
    const ay = n.absoluteTransform[1][2] - root.absoluteTransform[1][2];
    root.appendChild(n);
    n.x = ax;
    n.y = ay;
  }
  if (top.length) root.numberOfFixedChildren = top.length;
}

function fileKey(href: string): string {
  let p = href.split(/[?#]/)[0];
  try {
    p = decodeURIComponent(p);
  } catch (e) {
    // keep it as written
  }
  return (p.split('/').pop() || '').toLowerCase();
}

/** "#id" → scroll to it, "page.html" → that screen, http(s)/mailto/tel → open the URL. */
function linkReactions(ctx: Ctx, root: Screen, screens: Map<string, Screen>, reactions: Reactions): number {
  let made = 0;
  for (const { node, href } of ctx.links || []) {
    const h = href.trim();
    let action: Action | null = null;
    if (h.charAt(0) === '#') {
      let id = h.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch (e) {
        // keep it as written
      }
      const dest = ctx.anchors!.get(id) || (id === '' || id === 'top' ? root.children[0] : undefined);
      if (dest && dest !== node) {
        action = {
          type: 'NODE', destinationId: dest.id, navigation: 'SCROLL_TO',
          transition: { type: 'SCROLL_ANIMATE', easing: { type: 'EASE_IN_AND_OUT' }, duration: 0.6 },
        };
      }
    } else if (/^(https?:|mailto:|tel:)/i.test(h)) {
      action = { type: 'URL', url: h };
    } else {
      const dest = screens.get(fileKey(h));
      if (dest && dest !== root) {
        action = {
          type: 'NODE', destinationId: dest.id, navigation: 'NAVIGATE',
          transition: { type: 'DISSOLVE', easing: { type: 'EASE_OUT' }, duration: 0.3 },
        };
      }
    }
    if (action) {
      queue(reactions, node, { trigger: { type: 'ON_CLICK' }, actions: [action] });
      made++;
    }
  }
  return made;
}

/** Components first; an instance then keeps the hover / loop it inherits and gets its own trigger on top. */
async function applyReactions(reactions: Reactions): Promise<number> {
  let failed = 0;
  const entries = Array.from(reactions.entries()).sort(
    (a, b) => Number(a[0].type === 'INSTANCE') - Number(b[0].type === 'INSTANCE')
  );
  for (const [node, list] of entries) {
    if (!('setReactionsAsync' in node)) continue; // slices have no prototype
    const all = node.type === 'INSTANCE' ? (node.reactions as Reaction[]).concat(list) : list;
    try {
      await node.setReactionsAsync(all);
    } catch (e) {
      try {
        // A transition Figma doesn't take here (e.g. animated scroll): fall back to an instant one.
        await node.setReactionsAsync(all.map(withoutTransition));
      } catch (e2) {
        failed++;
        console.warn('Could not set reactions on', node.name, e2);
      }
    }
  }
  return failed;
}

function withoutTransition(r: Reaction): Reaction {
  return {
    trigger: r.trigger,
    actions: (r.actions || []).map((a) => (a.type === 'NODE' ? Object.assign({}, a, { transition: null }) : a)),
  };
}

/** What the page does, as a readable list: what plays in the prototype and what is only described. */
async function buildSpec(page: PageSpec, x: number, y: number): Promise<FrameNode | null> {
  if (!page.spec || !page.spec.length) return null;
  const BOLD: FontName = { family: 'Inter', style: 'Bold' };
  let bold = BOLD;
  try {
    await figma.loadFontAsync(BOLD);
  } catch (e) {
    bold = INTER;
  }
  const ink = { r: 0.12, g: 0.12, b: 0.14 }, grey = { r: 0.45, g: 0.45, b: 0.5 };
  const green = { r: 0.12, g: 0.5, b: 0.28 }, orange = { r: 0.78, g: 0.42, b: 0.08 };
  const f = figma.createFrame();
  f.name = 'Спецификация анимаций · ' + (page.name || 'страница');
  f.layoutMode = 'VERTICAL';
  f.primaryAxisSizingMode = 'AUTO';
  f.counterAxisSizingMode = 'FIXED';
  f.resize(960, 100);
  f.paddingTop = f.paddingBottom = f.paddingLeft = f.paddingRight = 48;
  f.itemSpacing = 18;
  f.cornerRadius = 24;
  f.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  figma.currentPage.appendChild(f);
  f.x = x;
  f.y = y;
  const add = (chars: string, size: number, font: FontName, color: RGB): TextNode => {
    const t = figma.createText();
    t.fontName = font;
    t.fontSize = size;
    t.characters = chars;
    t.fills = [{ type: 'SOLID', color }];
    f.appendChild(t);
    t.layoutAlign = 'STRETCH';
    t.textAutoResize = 'HEIGHT';
    return t;
  };
  add('Анимации и интерактив', 32, bold, ink);
  add('Что перенесено в прототип Figma (варианты компонентов, Smart Animate, переходы по ссылкам) и что описано только здесь. Время указано в секундах.', 15, INTER, grey);
  const played = (r: SpecRow) => r.status.indexOf('в прототипе') === 0;
  const rows = page.spec.slice().sort((a, b) => Number(played(b)) - Number(played(a)) || a.type.localeCompare(b.type));
  for (const r of rows) {
    const head = r.type + ' · ' + r.name;
    const t = add(head + '\n' + (r.detail ? r.detail + '\n' : '') + r.status, 14, INTER, ink);
    t.setRangeFontName(0, head.length, bold);
    t.setRangeFontSize(0, head.length, 15);
    t.setRangeFills(t.characters.length - r.status.length, t.characters.length, [{ type: 'SOLID', color: played(r) ? green : orange }]);
  }
  return f;
}

// ---------------------------------------------------------------------------
// Paints / strokes / effects
// ---------------------------------------------------------------------------

function solid(c: Rgba): SolidPaint {
  return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
}

function paints(specs: PaintSpec[] | undefined, ctx: Ctx): Paint[] {
  const out: Paint[] = [];
  for (const p of specs || []) {
    if (p.type === 'SOLID') out.push(solid(p.color));
    else if (p.type === 'IMAGE') {
      const hash = ctx.images.get(p.imageRef || p.url || '');
      if (hash) out.push({ type: 'IMAGE', scaleMode: p.scaleMode, imageHash: hash });
    } else out.push(p);
  }
  return out;
}

function applyStroke(node: FrameNode | RectangleNode, n: HtmlNode): void {
  const s = n.stroke;
  if (!s) return;
  node.strokes = [solid(s.color)];
  node.strokeAlign = 'INSIDE';
  if (s.t === s.r && s.r === s.b && s.b === s.l) node.strokeWeight = s.t;
  else {
    node.strokeTopWeight = s.t;
    node.strokeRightWeight = s.r;
    node.strokeBottomWeight = s.b;
    node.strokeLeftWeight = s.l;
  }
  if (s.dash) node.dashPattern = s.dash;
}

function applyRadius(node: FrameNode | RectangleNode, r: number[] | null | undefined): void {
  if (!r) return;
  if (r[0] === r[1] && r[1] === r[2] && r[2] === r[3]) node.cornerRadius = r[0];
  else {
    node.topLeftRadius = r[0];
    node.topRightRadius = r[1];
    node.bottomRightRadius = r[2];
    node.bottomLeftRadius = r[3];
  }
}

function setEffects(node: SceneNode & BlendMixin, effects: Effect[]): void {
  try {
    node.effects = effects;
  } catch (e) {
    // Figma only accepts shadow spread on filled, clipping frames; drop it elsewhere.
    node.effects = effects.map((fx) =>
      fx.type === 'DROP_SHADOW' || fx.type === 'INNER_SHADOW' ? Object.assign({}, fx, { spread: 0 }) : fx
    );
  }
}

// ---------------------------------------------------------------------------
// Images / fonts (resolved once, up front)
// ---------------------------------------------------------------------------

function walk(n: HtmlNode, fn: (n: HtmlNode) => void): void {
  fn(n);
  for (const c of n.children || []) walk(c, fn);
  if (n.tree) walk(n.tree, fn);
}

async function loadImages(tree: HtmlNode, b64: Record<string, string>): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const id of Object.keys(b64)) {
    try {
      hashes.set(id, figma.createImage(figma.base64Decode(b64[id])).hash);
    } catch (e) {
      console.warn('Failed to create image', id, e);
    }
  }
  // Images the UI couldn't read (no CORS): let Figma fetch them itself.
  const urls = new Set<string>();
  walk(tree, (n) => {
    const all = (n.fills || []).concat(...(n.runs || []).map((r) => r.fills || []));
    for (const p of all) if (p.type === 'IMAGE' && p.url) urls.add(p.url);
  });
  await Promise.all(
    Array.from(urls).map((url) =>
      figma
        .createImageAsync(url)
        .then((img) => hashes.set(url, img.hash))
        .catch(() => console.warn('Could not fetch image', url))
    )
  );
  return hashes;
}

const INTER: FontName = { family: 'Inter', style: 'Regular' };
let fontIndex: Map<string, FontName[]> | null = null;

// Generic / system families → what to look for in Figma, in order.
const SYSTEM_SANS = ['SF Pro', 'SF Pro Text', 'Inter'];
const FONT_ALIASES: Record<string, string[]> = {
  'system-ui': SYSTEM_SANS,
  '-apple-system': SYSTEM_SANS,
  blinkmacsystemfont: SYSTEM_SANS,
  'ui-sans-serif': SYSTEM_SANS,
  'sans-serif': ['Helvetica', 'Arial', 'Inter'],
  serif: ['Times New Roman', 'Times', 'Georgia', 'Noto Serif'],
  'ui-serif': ['New York', 'Times New Roman', 'Georgia'],
  monospace: ['Menlo', 'Courier New', 'Roboto Mono'],
  'ui-monospace': ['SF Mono', 'Menlo', 'Roboto Mono'],
  sfmono: ['SF Mono', 'Menlo', 'Roboto Mono'],
  'sfmono-regular': ['SF Mono', 'Menlo', 'Roboto Mono'],
  cursive: ['Comic Sans MS'],
};
const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-\w+|-apple-system|blinkmacsystemfont|emoji|math)$/i;
const EMOJI = /emoji|symbol/i;

async function loadFonts(tree: HtmlNode): Promise<{ get: (r: Run) => FontName; missing: string[] }> {
  if (!fontIndex) {
    fontIndex = new Map();
    for (const f of await figma.listAvailableFontsAsync()) {
      const key = f.fontName.family.toLowerCase();
      const list = fontIndex.get(key);
      if (list) list.push(f.fontName);
      else fontIndex.set(key, [f.fontName]);
    }
  }
  const index = fontIndex;
  const runKey = (r: Run) => r.families.join(',') + '|' + r.weight + '|' + r.italic;
  const chosen = new Map<string, FontName>();
  const missing = new Set<string>();
  walk(tree, (n) => {
    for (const r of n.runs || []) {
      const key = runKey(r);
      if (chosen.has(key)) continue;
      let styles: FontName[] | undefined;
      for (const fam of r.families) {
        if (EMOJI.test(fam)) continue;
        for (const cand of FONT_ALIASES[fam.toLowerCase()] || [fam]) {
          styles = index.get(cand.toLowerCase());
          if (styles) break;
        }
        if (styles) break;
        if (!GENERIC.test(fam)) missing.add(fam);
      }
      chosen.set(key, pickStyle(styles || index.get('inter') || [INTER], r.weight, r.italic));
    }
  });
  const failed = new Set<string>();
  const unique = new Map<string, FontName>();
  chosen.forEach((f) => unique.set(f.family + '::' + f.style, f));
  unique.set('Inter::Regular', INTER);
  await Promise.all(
    Array.from(unique.entries()).map(([k, f]) => figma.loadFontAsync(f).catch(() => failed.add(k)))
  );
  return {
    get: (r) => {
      const f = r && chosen.get(runKey(r));
      return f && !failed.has(f.family + '::' + f.style) ? f : INTER;
    },
    missing: Array.from(missing),
  };
}

function styleWeight(style: string): number {
  const s = style.toLowerCase().replace(/[\s_-]/g, '');
  if (/thin|hairline/.test(s)) return 100;
  if (/(extra|ultra)light/.test(s)) return 200;
  if (/light/.test(s)) return 300;
  if (/medium/.test(s)) return 500;
  if (/(semi|demi)bold/.test(s)) return 600;
  if (/(extra|ultra)bold/.test(s)) return 800;
  if (/black|heavy/.test(s)) return 900;
  if (/bold/.test(s)) return 700;
  return 400;
}

/** Closest weight, matching italic; plain styles beat Condensed/Display/etc. */
function pickStyle(styles: FontName[], weight: number, italic: boolean): FontName {
  let best = styles[0];
  let bestScore = Infinity;
  for (const f of styles) {
    const isItalic = /italic|oblique/i.test(f.style);
    const extra = f.style
      .replace(/italic|oblique|regular|normal|book|roman|thin|hairline|extra|ultra|semi|demi|light|medium|bold|black|heavy/gi, '')
      .trim();
    const score =
      Math.abs(styleWeight(f.style) - weight) + (isItalic !== italic ? 1000 : 0) + (extra ? 50 : 0);
    if (score < bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Local color styles
// ---------------------------------------------------------------------------

interface ColorUse {
  color: RGB;
  opacity: number;
  links: ((styleId: string) => Promise<void>)[];
}

/**
 * Turns the import's most-used solid colors into `HTML/` paint styles and links every
 * layer (fill, stroke or text run) with that color to its style, so editing one style
 * recolors the whole import.
 */
async function linkColorStyles(root: SceneNode): Promise<number> {
  const uses = new Map<string, ColorUse>();
  const note = (p: ReadonlyArray<Paint> | PluginAPI['mixed'], link: ColorUse['links'][number]) => {
    // Gradients, images and stacked paints keep their own fills: a style would replace all of them.
    if (p === figma.mixed || p.length !== 1) return;
    const s = p[0];
    const a = s.opacity === undefined ? 1 : s.opacity;
    if (s.type !== 'SOLID' || s.visible === false || (s.blendMode || 'NORMAL') !== 'NORMAL' || a < 0.05) return;
    const key = colorKey(s.color, a);
    const use = uses.get(key) || { color: s.color, opacity: a, links: [] };
    use.links.push(link);
    uses.set(key, use);
  };
  // Instances get their colours from the component, which is styled where it lives.
  const nodes = 'findAll' in root ? [root, ...root.findAll((n) => n.type !== 'INSTANCE' && !insideInstance(n, root))] : [root];
  for (const n of nodes) {
    if (n.type === 'TEXT') {
      for (const seg of n.getStyledTextSegments(['fills']))
        note(seg.fills, (id) => n.setRangeFillStyleIdAsync(seg.start, seg.end, id));
    } else if ('fills' in n) note(n.fills, (id) => n.setFillStyleIdAsync(id));
    if ('strokes' in n) note(n.strokes, (id) => n.setStrokeStyleIdAsync(id));
  }

  // Reuse an earlier import's style only while it still holds the exact color, so a
  // style the user has since recolored never changes this import.
  const existing = new Map<string, string>();
  for (const s of await figma.getLocalPaintStylesAsync()) {
    const p = s.paints[0];
    if (s.name.startsWith('HTML/') && s.paints.length === 1 && p.type === 'SOLID')
      existing.set(colorKey(p.color, p.opacity === undefined ? 1 : p.opacity), s.id);
  }
  // Most-used first, capped so imports don't flood the file with near-duplicate styles.
  const top = Array.from(uses.entries())
    .sort((x, y) => y[1].links.length - x[1].links.length)
    .slice(0, 40);
  const pending: Promise<void>[] = [];
  for (const [key, use] of top) {
    let id = existing.get(key);
    if (!id) {
      const style = figma.createPaintStyle();
      style.name = 'HTML/' + rgbToHex(use.color) + (use.opacity < 0.999 ? ` @${Math.round(use.opacity * 100)}%` : '');
      style.paints = [{ type: 'SOLID', color: use.color, opacity: use.opacity }];
      id = style.id;
    }
    for (const link of use.links) pending.push(link(id));
  }
  await Promise.all(pending);
  return top.length;
}

function insideInstance(n: BaseNode, root: BaseNode): boolean {
  for (let p = n.parent; p && p !== root; p = p.parent) if (p.type === 'INSTANCE') return true;
  return false;
}

function colorKey(c: RGB, a: number): string {
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), Math.round(a * 100)].join(',');
}

function rgbToHex(c: RGB): string {
  const h = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, '0');
  return ('#' + h(c.r) + h(c.g) + h(c.b)).toUpperCase();
}

function countNodes(node: BaseNode): number {
  let n = 1;
  if ('children' in node) for (const child of node.children) n += countNodes(child);
  return n;
}

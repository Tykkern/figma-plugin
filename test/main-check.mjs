// Runs code.js against a stand-in `figma` API with a real capture (from test/motion-check.html)
// and checks what Figma itself would reject: CHANGE_TO only to a sibling variant, SCROLL_TO inside
// the same screen, delays ≥ 1 ms, Smart Animate steps of 0–10 s. Usage: node test/main-check.mjs capture.json
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const capture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let seq = 0;
const all = new Map();

class Node {
  constructor(type) {
    this.type = type; this.id = String(++seq); this.name = type.toLowerCase(); this.children = [];
    this.parent = null; this.x = 0; this.y = 0; this.width = 100; this.height = 100;
    this.fills = []; this.strokes = []; this.effects = []; this.reactions = []; this.opacity = 1;
    all.set(this.id, this);
  }
  resize(w, h) { this.width = w; this.height = h; }
  resizeWithoutConstraints(w, h) { this.resize(w, h); }
  rescale(s) { this.width *= s; this.height *= s; }
  appendChild(c) { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); c.parent = this; this.children.push(c); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  findAll(fn) { const out = []; const go = (n) => n.children.forEach((c) => { if (!fn || fn(c)) out.push(c); go(c); }); go(this); return out; }
  set relativeTransform(m) { this.x = m[0][2]; this.y = m[1][2]; }
  get absoluteTransform() { let x = 0, y = 0; for (let n = this; n && n.type !== 'PAGE'; n = n.parent) { x += n.x; y += n.y; } return [[1, 0, x], [0, 1, y]]; }
  async setReactionsAsync(list) { validate(this, list); this.reactions = list; }
  async setFillStyleIdAsync() {} async setStrokeStyleIdAsync() {}
  createInstance() {
    if (this.type !== 'COMPONENT') throw new Error('createInstance on ' + this.type);
    const inst = clone(this, 'INSTANCE');
    const main = this;
    inst.mainComponent = main;
    // Like Figma: an instance shows its component's reactions until it gets its own.
    Object.defineProperty(inst, 'reactions', { get() { return this.own || main.reactions; }, set(v) { this.own = v; } });
    return inst;
  }
}
class Text extends Node {
  constructor() { super('TEXT'); this._chars = ''; this.fontName = null; this.textAutoResize = 'NONE'; }
  get characters() { return this._chars; }
  set characters(v) { if (!this.fontName) throw new Error('font not set'); this._chars = v; this.width = v.length * 8; }
  setRangeFontName() {} setRangeFontSize() {} setRangeLineHeight() {} setRangeLetterSpacing() {} setRangeFills() {}
  setRangeTextDecoration() {} setRangeTextCase() {} setRangeHyperlink() {} async setRangeFillStyleIdAsync() {}
  insertCharacters(i, s) { this._chars = this._chars.slice(0, i) + s + this._chars.slice(i); }
  deleteCharacters(a, b) { this._chars = this._chars.slice(0, a) + this._chars.slice(b); }
  getStyledTextSegments() { return [{ start: 0, end: this._chars.length, fills: this.fills }]; }
}
function clone(n, type) {
  const c = n.type === 'TEXT' ? new Text() : new Node(type || n.type);
  Object.assign(c, { name: n.name, x: n.x, y: n.y, width: n.width, height: n.height, fills: n.fills, fontName: n.fontName, _chars: n._chars });
  for (const k of n.children) c.appendChild(clone(k));
  return c;
}
const page = new Node('PAGE');
page.flowStartingPoints = [];
page.selection = [];

const problems = [];
const variantOf = (n) => {
  for (let p = n; p; p = p.parent) {
    if (p.type === 'COMPONENT' && p.parent && p.parent.type === 'COMPONENT_SET') return p;
    if (p.type === 'INSTANCE') return p.mainComponent;
  }
  return null;
};
// Sets a CHANGE_TO may switch: the node's own (an instance's component) and the variant it sits in
// ("a Change to interaction is placed on the nested instance to change the parent component").
const switchable = (n) => {
  const sets = [];
  if (n.type === 'INSTANCE') sets.push(n.mainComponent.parent);
  const v = variantOf(n.type === 'INSTANCE' ? n.parent : n);
  if (v) sets.push(v.parent);
  return sets;
};
const screenOf = (n) => { let p = n; while (p.parent && p.parent.type !== 'PAGE') p = p.parent; return p; };
function validate(node, list) {
  for (const r of list) {
    if (!r.trigger || !r.actions || !r.actions.length) problems.push('reaction without trigger/actions on ' + node.name);
    if (r.trigger.type === 'AFTER_TIMEOUT' && !(r.trigger.timeout >= 1)) problems.push('timeout < 1 ms on ' + node.name);
    for (const a of r.actions) {
      const t = a.transition;
      if (t && t.type === 'SMART_ANIMATE' && !(t.duration > 0 && t.duration <= 10)) problems.push('Smart Animate ' + t.duration + ' s on ' + node.name);
      if (a.type !== 'NODE') continue;
      const dest = all.get(a.destinationId);
      if (!dest) { problems.push('missing destination from ' + node.name); continue; }
      if (a.navigation === 'CHANGE_TO' && (dest.type !== 'COMPONENT' || switchable(node).indexOf(dest.parent) < 0)) {
        problems.push('CHANGE_TO outside its set from ' + node.name);
      }
      if (a.navigation === 'SCROLL_TO' && screenOf(dest) !== screenOf(node)) problems.push('SCROLL_TO to another screen from ' + node.name);
    }
  }
}

const sent = [];
const figma = {
  mixed: Symbol('mixed'),
  showUI() {},
  ui: { postMessage: (m) => sent.push(m), onmessage: null },
  clientStorage: { getAsync: async () => null, setAsync: async () => {} },
  viewport: { center: { x: 0, y: 0 }, scrollAndZoomIntoView() {} },
  currentPage: page,
  createFrame: () => { const n = new Node('FRAME'); page.appendChild(n); return n; },
  createRectangle: () => { const n = new Node('RECTANGLE'); page.appendChild(n); return n; },
  createText: () => { const n = new Text(); page.appendChild(n); return n; },
  createNodeFromSvg: (svg) => { if (!/^<svg/.test(svg)) throw new Error('bad svg'); const n = new Node('FRAME'); page.appendChild(n); return n; },
  createComponent: () => { const n = new Node('COMPONENT'); page.appendChild(n); return n; },
  createComponentFromNode: (n) => {
    const c = new Node('COMPONENT');
    Object.assign(c, { x: n.x, y: n.y, width: n.width, height: n.height, name: n.name });
    n.parent.appendChild(c);
    [...n.children].forEach((k) => c.appendChild(k));
    n.remove();
    return c;
  },
  combineAsVariants: (comps, parent) => {
    const names = comps.map((c) => c.name);
    if (new Set(names).size !== names.length) throw new Error('duplicate variant names: ' + names);
    if (!names.every((s) => /^[^=,]+=[^=,]+$/.test(s))) throw new Error('bad variant name: ' + names);
    const set = new Node('COMPONENT_SET');
    parent.appendChild(set);
    comps.forEach((c) => set.appendChild(c));
    return set;
  },
  createImage: () => ({ hash: 'h' + (++seq) }),
  createImageAsync: async () => ({ hash: 'h' + (++seq) }),
  base64Decode: (s) => Buffer.from(s, 'base64'),
  listAvailableFontsAsync: async () =>
    ['Regular', 'Medium', 'Bold'].flatMap((style) => ['Inter', 'Onest'].map((family) => ({ fontName: { family, style } }))),
  loadFontAsync: async () => {},
  createPaintStyle: () => ({ id: 'S' + (++seq), name: '', paints: [] }),
  getLocalPaintStylesAsync: async () => [],
};

// A second screen, linked from the first one, for page-to-page navigation.
const second = { name: 'about', file: 'site/about.html', tree: JSON.parse(JSON.stringify(capture.pages[0].tree)), comps: [], spec: [] };
capture.pages[0].tree.children.push({ type: 'frame', name: 'a.to-about', x: 0, y: 0, w: 10, h: 10, fills: [], effects: [], children: [], href: 'about.html#team' });

vm.runInNewContext(readFileSync(new URL('../code.js', import.meta.url), 'utf8'), { figma, __html__: '', console, setTimeout, Buffer });
await figma.ui.onmessage({ type: 'convert', pages: capture.pages.concat([second]), images: capture.images, viewportWidth: 1440, viewportHeight: 1024, sourceName: 'motion' });

const results = [];
const check = (name, ok) => results.push((ok ? '✓ ' : '✗ ') + name);
const done = sent.find((m) => m.type === 'done');
const error = sent.find((m) => m.type === 'error');
check('import finished' + (error ? ': ' + error.message : ''), !!done);
const nodes = [...all.values()];
const sets = nodes.filter((n) => n.type === 'COMPONENT_SET' && n.parent);
const expected = capture.pages[0].comps.filter((c) => c.kind !== 'static').length;
check(`component sets: ${sets.length} of ${expected}`, sets.length === expected);
const screen = page.children.find((n) => n.name.indexOf('motion') === 0);
check('screen frame on the page', !!screen && screen.width === 1440);
const live = nodes.filter((n) => { for (let p = n; p; p = p.parent) if (p === page) return true; return false; });
check('instances placed on the screen', !!screen && screen.findAll((n) => n.type === 'INSTANCE').length >= 10);
const has = (fn) => live.some((n) => n.reactions.some(fn));
check('hover variants wired', has((r) => r.trigger.type === 'ON_HOVER' && r.actions[0].transition.type === 'SMART_ANIMATE'));
check('loops wired with After delay', has((r) => r.trigger.type === 'AFTER_TIMEOUT' && r.actions[0].navigation === 'CHANGE_TO'));
check('custom cubic-bezier passed through', has((r) => r.actions[0].transition && r.actions[0].transition.easing.type === 'CUSTOM_CUBIC_BEZIER'));
check('clicks inside variants wired', has((r) => r.trigger.type === 'ON_CLICK' && r.actions[0].navigation === 'CHANGE_TO'));
check('anchor links scroll', has((r) => r.actions[0].navigation === 'SCROLL_TO'));
check('fixed nav pinned', !!screen && screen.numberOfFixedChildren >= 1 &&
  screen.children.slice(-screen.numberOfFixedChildren).some((n) => /nav/.test(n.name)));
const linkButtons = screen ? screen.findAll((n) => n.type === 'INSTANCE' && n.reactions.some((r) => r.trigger.type === 'ON_HOVER') &&
  n.reactions.some((r) => r.actions[0].navigation === 'SCROLL_TO')) : [];
check('link buttons keep hover and scroll', linkButtons.length >= 3);
const yearly = live.filter((n) => n.type === 'TEXT' && /^279/.test(n.characters));
check('yearly price overridden on the plan instance', yearly.length === 1 && variantOf(yearly[0]) !== null);
check('spec frame', page.children.some((n) => /^Спецификация анимаций/.test(n.name) && n.children.length > 10));
check('flow starts at the screen', page.flowStartingPoints.length === 1);
const about = page.children.find((n) => n.name.indexOf('about') === 0);
check('link to another file navigates to its screen', !!about && has((r) => r.actions[0].navigation === 'NAVIGATE' && r.actions[0].destinationId === about.id));
check('no reaction Figma would reject' + (problems.length ? ': ' + [...new Set(problems)].slice(0, 5).join('; ') : ''), problems.length === 0);
console.log(results.join('\n'));
const failed = results.filter((r) => r[0] === '✗').length;
console.log('\n' + (failed ? failed + ' FAILED' : 'ALL PASSED (' + results.length + ')'));
process.exit(failed ? 1 : 0);

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Card #15(a). yc-early.js is the first script in every Office editor page. It reaches into
// classes the editor publishes (sdkjs) and swaps a few methods. Nothing pinned that the swaps
// became what they are meant to be, or that every OTHER editor feature stayed exactly as sdkjs
// made it. It is loaded here, as the page would, against stand-ins for the editor's classes.
const SOURCE = fs.readFileSync(path.join(__dirname, '../../office-addon/editors/yc-early.js'), 'utf8');

interface Opts { settings?: { status: number; body: string } | 'throws'; storage?: Record<string, string>; }

/** A fake editor window the script is run in. */
function load(opts: Opts = {}) {
  const store = new Map<string, string>(Object.entries(opts.storage ?? {}));
  const win: any = {};
  win.window = win;
  win.localStorage = { getItem: (k: string) => (store.has(k) ? store.get(k) : null), setItem: (k: string, v: string) => { store.set(k, v); } };
  win.location = { origin: 'office://tok' };
  win.XMLHttpRequest = class {
    status = 0; responseText = '';
    open() {}
    send() {
      if (opts.settings === 'throws') throw new Error('no host');
      if (opts.settings) { this.status = opts.settings.status; this.responseText = opts.settings.body; }
    }
  };
  // A canvas whose 2d context records what is really painted or cleared.
  win.HTMLCanvasElement = class {
    id = ''; width = 800; height = 600;
    calls: string[] = [];
    ctx: any;
    getContext(kind: string) {
      if (kind !== '2d') return null;
      this.ctx ??= {
        canvas: this, fillStyle: '#000',
        fillRect: (...a: number[]) => this.calls.push(`fill:${a.join(',')}`),
        clearRect: (...a: number[]) => this.calls.push(`clear:${a.join(',')}`),
      };
      return this.ctx;
    }
  };
  vm.createContext(win);
  vm.runInContext(SOURCE, win);
  return { win, store };
}

const canvas = (win: any, id: string) => { const c = new win.HTMLCanvasElement(); c.id = id; return c; };

describe('yc-early.js: peer connections are turned off', () => {
  it('both constructors throw and cannot be put back', () => {
    const { win } = load();
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
      expect(() => new win[name]()).toThrow();
      const d = Object.getOwnPropertyDescriptor(win, name)!;
      expect(d.writable).toBe(false);
      expect(d.configurable).toBe(false);
    }
  });
});

describe("yc-early.js: the person's saved settings are written in before the editor starts", () => {
  it('seeds missing keys, never overwrites one the page already has, skips non-text values', () => {
    const { store } = load({
      storage: { 'de-settings-unit': 'page-value' },
      settings: { status: 200, body: JSON.stringify({ 'de-settings-unit': 'saved', 'de-settings-zoom': '120', 'bad-number': 5, 'bad-null': null }) },
    });
    expect(store.get('de-settings-unit')).toBe('page-value');
    expect(store.get('de-settings-zoom')).toBe('120');
    expect(store.has('bad-number')).toBe(false);
    expect(store.has('bad-null')).toBe(false);
  });

  it.each([
    ['a non-200 answer', { status: 404, body: '{"a":"1"}' }],
    ['unreadable JSON', { status: 200, body: 'not json' }],
    ['a JSON value that is not an object', { status: 200, body: 'null' }],
    ['a host that does not answer', 'throws' as const],
  ])('%s leaves storage untouched and the page still loads', (_n, settings) => {
    const { store, win } = load({ settings });
    expect(store.size).toBe(0);
    expect(typeof win.__ycRedrawScrolls).toBe('function'); // the script ran to its end
  });
});

describe('yc-early.js: the external-links warning and the automatic link refresh do nothing', () => {
  it('Api.onNeedUpdateExternalReferenceOnOpen becomes a no-op, whether the class is published after or before', () => {
    const { win } = load();
    const other = function () { return 'kept'; };
    const Api = function () {} as any;
    Api.prototype.onNeedUpdateExternalReferenceOnOpen = () => { throw new Error('would show the warning'); };
    Api.prototype.save = other;
    win.AscCommon = { baseEditorsApi: Api }; // sdkjs: window.AscCommon = ...; AscCommon.baseEditorsApi = e
    expect(Api.prototype.onNeedUpdateExternalReferenceOnOpen()).toBeUndefined();
    expect(Api.prototype.save).toBe(other);

    // Already published before the script ran
    const Early = function () {} as any;
    Early.prototype.onNeedUpdateExternalReferenceOnOpen = () => { throw new Error('nope'); };
    const w2: any = {}; w2.window = w2;
    w2.AscCommon = { baseEditorsApi: Early };
    w2.XMLHttpRequest = class { status = 0; open() {} send() {} };
    w2.localStorage = { getItem: () => null, setItem() {} }; w2.location = { origin: 'x' };
    vm.createContext(w2); vm.runInContext(SOURCE, w2);
    expect(Early.prototype.onNeedUpdateExternalReferenceOnOpen()).toBeUndefined();
  });

  it('WorkbookView.initExternalReferenceUpdateTimer becomes a no-op; its other methods are untouched', () => {
    const { win } = load();
    const View = function () {} as any;
    const draw = function () {};
    View.prototype.initExternalReferenceUpdateTimer = () => { throw new Error('would refetch'); };
    View.prototype.draw = draw;
    win.AscCommonExcel = { WorkbookView: View };
    expect(View.prototype.initExternalReferenceUpdateTimer()).toBeUndefined();
    expect(View.prototype.draw).toBe(draw);
  });

  it('a class published without a prototype, or a non-class, does not break the page', () => {
    const { win } = load();
    expect(() => { win.AscCommon = { baseEditorsApi: {}, ScrollObject: null }; }).not.toThrow();
    expect(() => { win.AscCommonExcel = { WorkbookView: undefined, WorksheetView: {} }; }).not.toThrow();
  });
});

describe("yc-early.js: a sheet's view counts at least 1000 rows and 52 columns", () => {
  function sheetView(win: any, rowsTo: number, colsTo: number) {
    const View = function (this: any) { this.nRowsCount = 0; this.nColsCount = 0; this.cols = []; } as any;
    const keep = function () {};
    View.prototype._initRowsCount = function (this: any) { const was = this.nRowsCount; this.nRowsCount = rowsTo; return was !== rowsTo; };
    View.prototype._initColsCount = function (this: any) { const was = this.nColsCount; this.nColsCount = colsTo; return was !== colsTo; };
    View.prototype.setColsCount = function (this: any, n: number) { this.nColsCount = n; this.cols.push(n); };
    View.prototype.scrollTo = keep;
    win.AscCommonExcel = { WorksheetView: View };
    return { View, keep };
  }

  it('raises a small sheet to the minimum and reports the change', () => {
    const { win } = load();
    const { View, keep } = sheetView(win, 30, 10);
    const v = new View();
    expect(v._initRowsCount()).toBe(true);
    expect(v.nRowsCount).toBe(1000);
    expect(v._initColsCount()).toBe(true);
    expect(v.nColsCount).toBe(52);
    expect(v.cols).toEqual([52]); // the column count goes through the sheet's own setter
    expect(View.prototype.scrollTo).toBe(keep);
  });

  it('leaves a bigger sheet at its own size', () => {
    const { win } = load();
    const { View } = sheetView(win, 5000, 200);
    const v = new View();
    v._initRowsCount(); v._initColsCount();
    expect([v.nRowsCount, v.nColsCount]).toEqual([5000, 200]);
    expect(v.cols).toEqual([]);
  });

  it('wraps only once, even if the class is published twice', () => {
    const { win } = load();
    const { View } = sheetView(win, 30, 10);
    const first = View.prototype._initRowsCount;
    win.AscCommonExcel = { WorksheetView: View };
    expect(View.prototype._initRowsCount).toBe(first);
  });

  it('a class without the two methods is left alone', () => {
    const { win } = load();
    const View = function () {} as any;
    win.AscCommonExcel = { WorksheetView: View };
    expect(View.prototype.__ycSteady).toBeUndefined();
  });
});

describe('yc-early.js: slim scrollbars', () => {
  it('ScrollSettings: every instance has no arrows; the rest of the class is as sdkjs made it', () => {
    const { win } = load();
    const Orig = function (this: any) { this.showArrows = true; this.scrollerColor = '#112233'; } as any;
    Orig.prototype.helper = function () { return 'h'; };
    Orig.STATIC = 7;
    win.AscCommon = { ScrollSettings: Orig };
    const Slim = win.AscCommon.ScrollSettings;
    const s = new Slim();
    expect(s.showArrows).toBe(false);
    expect(s.scrollerColor).toBe('#112233');
    expect(s.helper()).toBe('h');
    expect(s instanceof Orig).toBe(true);
    expect(Slim.STATIC).toBe(7);
    // Handed to the wrapper again, it is not wrapped twice
    win.AscCommon.ScrollSettings = Slim;
    expect(win.AscCommon.ScrollSettings).toBe(Slim);
  });

  function scrollObject(win: any) {
    const SO = function () {} as any;
    const move = function () {};
    SO.prototype._drawScroll = () => { throw new Error('the square sdkjs thumb'); };
    SO.prototype.moveBy = move;
    win.AscCommon = { ScrollObject: SO };
    const ops: string[] = [];
    const ctx: any = {
      fillStyle: '', clearRect: (...a: number[]) => ops.push(`clear:${a.join(',')}`),
      beginPath: () => ops.push('begin'), moveTo: () => {}, lineTo: () => {}, arcTo: () => {}, closePath: () => {},
      fill() { ops.push(`fill:${this.fillStyle}`); },
    };
    const make = (settings: any, extra: any = {}) => Object.assign(Object.create(SO.prototype), {
      settings, context: ctx, canvasW: 20, canvasH: 400, maxScrollX: 0, maxScrollY: 100,
      scroller: { x: 0, y: 40, w: 20, h: 100 }, canvas: { isConnected: true }, ...extra,
    });
    return { SO, move, ops, ctx, make };
  }

  it('_drawScroll paints a rounded thumb in the theme colour; moveBy and the rest stay sdkjs\'s', () => {
    const { win } = load();
    const { SO, move, ops, make } = scrollObject(win);
    expect(SO.prototype.moveBy).toBe(move);
    const bar = make({ isVerticalScroll: true, scrollerColor: '#336699', scrollerHoverColor: '#336699', scrollerActiveColor: '#336699' });
    bar._drawScroll(0x33, 0x33, 0x33);
    expect(ops).toEqual(['clear:0,0,20,400', 'begin', 'fill:rgb(51,102,153)']);
    expect([bar.scrollColor, bar.targetColor, bar.strokeColor]).toEqual([0x33, 0x33, 0x33]);
  });

  it('a track with nothing to scroll is cleared and nothing is drawn', () => {
    const { win } = load();
    const { ops, make } = scrollObject(win);
    make({ isVerticalScroll: true, scrollerColor: '#336699' }, { maxScrollY: 0 })._drawScroll(0, 0, 0);
    expect(ops).toEqual(['clear:0,0,20,400']);
  });

  it('__ycRedrawScrolls redraws the live scrollbars and forgets ones removed from the page', () => {
    const { win } = load();
    const { ops, make } = scrollObject(win);
    const s = { isVerticalScroll: true, scrollerColor: '#336699', scrollerHoverColor: '#336699', scrollerActiveColor: '#336699' };
    const live = make(s); const gone = make(s);
    live._drawScroll(0x33, 0x33, 0x33); gone._drawScroll(0x33, 0x33, 0x33);
    gone.canvas.isConnected = false;
    ops.length = 0;
    win.__ycRedrawScrolls();
    expect(ops.filter((o) => o.startsWith('fill'))).toHaveLength(1);
    ops.length = 0;
    win.__ycRedrawScrolls(); // the removed one is gone for good
    expect(ops.filter((o) => o.startsWith('fill'))).toHaveLength(1);
  });
});

describe('yc-early.js: canvas painting changes only on the named canvases', () => {
  it('the slide list background is cleared on a glass theme only, and only for the full-canvas fill', () => {
    const { win } = load();
    const thumbs = canvas(win, 'id_thumbnails_background');
    const ctx = thumbs.getContext('2d');
    ctx.fillRect(0, 0, 800, 600);
    expect(thumbs.calls).toEqual(['fill:0,0,800,600']); // not glass: painted as sdkjs wants
    win.__ycGlassFrame = true;
    ctx.fillRect(0, 0, 800, 600);
    ctx.fillRect(10, 10, 50, 50); // an outline-sized fill still paints
    expect(thumbs.calls).toEqual(['fill:0,0,800,600', 'clear:0,0,800,600', 'fill:10,10,50,50']);
    // another canvas with the same shape of fill is never touched
    const other = canvas(win, 'id_something_else');
    other.getContext('2d').fillRect(0, 0, 800, 600);
    expect(other.calls).toEqual(['fill:0,0,800,600']);
  });

  it('a see-through fill on the desk and rulers clears; an opaque one paints; other canvases are untouched', () => {
    const { win } = load();
    for (const id of ['id_viewer', 'id_hor_ruler', 'id_vert_ruler']) {
      const c = canvas(win, id); const ctx = c.getContext('2d');
      ctx.fillStyle = 'transparent'; ctx.fillRect(1, 2, 3, 4);
      ctx.fillStyle = 'rgba(0, 0, 0, 0)'; ctx.fillRect(5, 6, 7, 8);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(9, 9, 9, 9);
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(1, 1, 1, 1);
      expect(c.calls).toEqual(['clear:1,2,3,4', 'clear:5,6,7,8', 'fill:9,9,9,9', 'fill:1,1,1,1']);
    }
    const plain = canvas(win, 'id_other'); const ctx = plain.getContext('2d');
    ctx.fillStyle = 'transparent'; ctx.fillRect(1, 2, 3, 4);
    expect(plain.calls).toEqual(['fill:1,2,3,4']);
  });

  it('getContext still hands back the same context each time and passes non-2d requests through', () => {
    const { win } = load();
    const c = canvas(win, 'id_viewer');
    expect(c.getContext('2d')).toBe(c.getContext('2d'));
    expect(c.getContext('webgl')).toBeNull();
  });
});

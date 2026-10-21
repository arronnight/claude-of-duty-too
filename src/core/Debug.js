/** Dev-only overlay; the critic loop screenshots with this hidden. */
export class DebugSystem {
  async init(ctx) {
    const el = document.createElement('div');
    el.id = 'debug-overlay';
    el.style.cssText = 'position:fixed;top:8px;left:8px;font:11px ui-monospace,monospace;color:#9f9;text-shadow:0 1px 2px #000;white-space:pre;pointer-events:none;';
    document.getElementById('ui-root').appendChild(el);
    this.el = el;
    this.acc = 0;
    ctx.debug = { setVisible: (v) => { el.style.display = v ? 'block' : 'none'; } };
  }
  lateUpdate(dt, ctx) {
    this.acc += dt;
    if (this.acc < 0.25) return;
    this.acc = 0;
    const s = ctx.engine.stats;
    this.el.textContent = `${s.fps.toFixed(0)} fps  ${s.ms.toFixed(1)} ms\ndraws ${s.drawCalls}  tris ${(s.triangles / 1000).toFixed(0)}k\ntier ${ctx.quality.tier}`;
  }
}

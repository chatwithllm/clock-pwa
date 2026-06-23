// nav.js — D-pad spatial focus navigation. Arrows move focus by geometry, Enter
// activates, Escape closes panels. Visible focus ring via .is-focus + native :focus.
// Nothing is reachable by hover only; focus is never trapped or lost.

export class DpadNav {
  constructor({ onEscape, onActivate } = {}){
    this.onEscape = onEscape || (()=>{});
    this.onActivate = onActivate || (()=>{});
    this._scopeEl = document; // limit candidates to a container (e.g. panel) when set
    document.addEventListener('keydown', (e)=>this._onKey(e), true);
  }

  setScope(el){ this._scopeEl = el || document; }

  _candidates(){
    const root = this._scopeEl || document;
    const all = Array.from(root.querySelectorAll('[data-nav]'));
    return all.filter(n => !n.hasAttribute('disabled') && n.offsetParent !== null);
  }

  current(){
    const a = document.activeElement;
    if (a && a.hasAttribute && a.hasAttribute('data-nav')) return a;
    return null;
  }

  focusFirst(){
    const c = this._candidates();
    if (c.length){ this._focus(c[0]); return c[0]; }
    return null;
  }

  _focus(el){
    if (!el) return;
    const prev = document.querySelector('[data-nav].is-focus');
    if (prev && prev !== el) prev.classList.remove('is-focus');
    el.classList.add('is-focus');
    try { el.focus({ preventScroll:true }); } catch(_) { try { el.focus(); } catch(__){} }
  }

  // Geometry-based nearest neighbor in a direction.
  _move(dir){
    const items = this._candidates();
    if (!items.length) return;
    const cur = this.current() || items[0];
    if (!this.current()){ this._focus(items[0]); return; }

    const cr = cur.getBoundingClientRect();
    const cx = cr.left + cr.width/2, cy = cr.top + cr.height/2;

    let best = null, bestScore = Infinity;
    for (const it of items){
      if (it === cur) continue;
      const r = it.getBoundingClientRect();
      const x = r.left + r.width/2, y = r.top + r.height/2;
      const dx = x - cx, dy = y - cy;

      let primary, cross;
      if (dir === 'left'){ if (dx >= -1) continue; primary = -dx; cross = Math.abs(dy); }
      else if (dir === 'right'){ if (dx <= 1) continue; primary = dx; cross = Math.abs(dy); }
      else if (dir === 'up'){ if (dy >= -1) continue; primary = -dy; cross = Math.abs(dx); }
      else { if (dy <= 1) continue; primary = dy; cross = Math.abs(dx); }

      // Weight cross-axis heavily so we stay aligned; primary distance breaks ties.
      const score = primary + cross*2;
      if (score < bestScore){ bestScore = score; best = it; }
    }
    // Wrap-around fallback so focus is never stuck.
    if (!best){
      const sorted = items.filter(i=>i!==cur);
      if (sorted.length) best = sorted[0];
    }
    if (best) this._focus(best);
  }

  _onKey(e){
    const k = e.key;
    if (k === 'Escape'){ this.onEscape(); return; }

    const editing = document.activeElement &&
      (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');

    if (k === 'Enter'){
      const cur = this.current();
      if (cur){
        // Let inputs/buttons behave naturally but also notify app.
        if (!editing){ e.preventDefault(); cur.click(); }
        this.onActivate(cur);
      }
      return;
    }

    // Arrow keys: don't hijack typing inside a text field horizontally.
    let dir = null;
    if (k === 'ArrowLeft') dir = 'left';
    else if (k === 'ArrowRight') dir = 'right';
    else if (k === 'ArrowUp') dir = 'up';
    else if (k === 'ArrowDown') dir = 'down';
    if (!dir) return;
    if (editing && (dir === 'left' || dir === 'right')) return; // caret movement
    e.preventDefault();
    this._move(dir);
  }
}

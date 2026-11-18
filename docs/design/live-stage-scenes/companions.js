/* Live Stage prototype — companions layer.
   Rail DOM (right column), hero connectors (worker PCB route, peer dashed
   arc + capsule, group "Saturn" ring), group member avatars on the ring. */
(() => {
  const LS = window.LS;
  const { W, H, R } = LS;
  const O = LS.O_BASE;
  const COPPER = '255,190,120', GOLD = '255,214,128', AMBER = '255,220,81';
  const CYAN = '96,226,236', CYAN_HI = '190,250,255', OT = '197,169,255';

  const STATUS_RANK = {
    dispatch: 0, return: 0, sending: 0, incoming: 0, posting: 0,
    working: 1, active: 1, verifying: 1,
    awaiting: 2, delivered: 2, waiting: 2,
  };
  const CHIP = {
    worker: {
      dispatch: ['派发中', 'Dispatching'], working: ['执行中', 'Working'],
      return: ['交回', 'Returned'], verifying: ['核验中', 'Verifying'],
    },
    peer: {
      sending: ['发送中', 'Sending'], delivered: ['已送达', 'Delivered'],
      awaiting: ['等回复', 'Awaiting reply'], incoming: ['新消息', 'New message'],
    },
    group: {
      posting: ['发言中', 'Posting'], active: ['进行中', 'In progress'],
      incoming: ['新发言', 'New post'],
    },
  };
  const SECTIONS = { workers: ['本地协作', 'Local'], peers: ['私聊', 'Private'], groups: ['群任务', 'Group'] };

  const GLYPHS = {
    worker: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M1 9h4l2-2h4"/><circle cx="10.5" cy="7" r="1"/></svg>',
    peer: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.6"><path d="M2 10Q6 1 10 6"/></svg>',
    group: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1"><ellipse cx="6" cy="6" rx="5" ry="2.4" transform="rotate(-12 6 6)"/><circle cx="6" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="2" cy="4.4" r=".7" fill="currentColor" stroke="none"/><circle cx="10" cy="5" r=".7" fill="currentColor" stroke="none"/></svg>',
  };

  const M = {
    env: null, rail: null, memberLayer: null,
    spec: { workers: [], peers: [], groups: [] },
    hero: null,
    lang: 'zh',
    items: new Map(),
    memberEls: new Map(),
    memberGrp: null, moreEl: null, ringA: 0, rx: 0,
    t: 0, fadeT: -9,
    pulses: [],
    peerCycle: { t0: -9, dropped: false, leanAt: -9, dropAt: -9 },
    ringSweep: { t0: -9, senderAngle: null, done: false },
    ringSpin: 0,
  };

  function person(id) {
    return (LS.catalog && LS.catalog.people && LS.catalog.people[id]) || { id, name: id, avatar: '' };
  }

  function tr(pair) { return M.lang === 'en' ? pair[1] : pair[0]; }
  /* catalog values are {zh,en} objects (or plain strings) */
  function trv(v) { return v == null ? '' : typeof v === 'string' ? v : (v[M.lang] || v.zh || ''); }

  /* ------------------------------ rail DOM ------------------------------ */
  function buildRail() {
    const rail = M.rail;
    rail.innerHTML = '';
    M.items.clear();
    const order = ['workers', 'peers', 'groups'];
    const total = order.reduce((n, t) => n + (M.spec[t] || []).length, 0);
    const MAX = 5;
    // reserve a row for the "+N" chip so it is never pushed out of the band
    const cap = total > MAX ? MAX - 1 : MAX;
    // pick visible items globally: the hero is always pinned, then active-now → working → waiting
    const rank = (c) => STATUS_RANK[c.status] ?? 1;
    const isHero = (type, c) => Boolean(M.hero && M.hero.type === type && M.hero.id === (type === 'groups' ? c.id : c.who));
    const picked = new Set(order
      .flatMap((type) => (M.spec[type] || []).map((c) => ({ type, c })))
      .sort((a, b) => (isHero(b.type, b.c) - isHero(a.type, a.c)) || (rank(a.c) - rank(b.c)))
      .slice(0, cap)
      .map((entry) => entry.c));
    let shown = 0;
    for (const type of order) {
      const list = M.spec[type] || [];
      const sorted = [...list].sort((a, b) => rank(a) - rank(b));
      const visible = sorted.filter((c) => picked.has(c));
      if (!visible.length) continue; // heading only when ≥1 item shows
      const sec = document.createElement('div');
      sec.className = 'rail-section';
      const head = document.createElement('div');
      head.className = 'rail-heading';
      head.textContent = tr(SECTIONS[type]);
      sec.appendChild(head);
      for (const c of visible) sec.appendChild(buildItem(type, c));
      rail.appendChild(sec);
      shown += visible.length;
    }
    const hidden = total - shown;
    if (hidden > 0) {
      const more = document.createElement('div');
      more.className = 'rail-more';
      more.textContent = M.lang === 'en' ? `+${hidden} threads` : `+${hidden} 个线程`;
      rail.appendChild(more);
    }
    rail.setAttribute('aria-hidden', shown === 0 ? 'true' : 'false');
    // stagger-in
    requestAnimationFrame(() => {
      let i = 0;
      for (const el of rail.querySelectorAll('.rail-item')) {
        el.style.transitionDelay = `${i * 60}ms`;
        el.classList.add('is-in');
        i += 1;
      }
      setTimeout(() => {
        for (const el of rail.querySelectorAll('.rail-item')) el.style.transitionDelay = '';
      }, shown * 60 + 400);
    });
  }

  function buildItem(type, c) {
    const kind = type === 'workers' ? 'worker' : type === 'peers' ? 'peer' : 'group';
    const el = document.createElement('div');
    el.className = 'rail-item';
    el.dataset.status = c.status;
    const isHero = M.hero && M.hero.type === type && M.hero.id === (kind === 'group' ? c.id : c.who);
    if (isHero) el.dataset.hero = kind;
    if (kind === 'group') {
      const stack = document.createElement('div');
      stack.className = 'rail-stack';
      c.members.slice(0, 3).forEach((pid, i) => {
        const img = document.createElement('img');
        img.src = person(pid).avatar;
        img.alt = '';
        stack.appendChild(img);
      });
      if (c.members.length > 3) {
        const n = document.createElement('span');
        n.className = 'rail-more-n';
        n.textContent = `+${c.members.length - 3}`;
        stack.appendChild(n);
      }
      el.appendChild(stack);
    } else {
      const img = document.createElement('img');
      img.className = 'rail-avatar';
      img.src = person(c.who).avatar;
      img.alt = '';
      el.appendChild(img);
    }
    const meta = document.createElement('div');
    meta.className = 'rail-meta';
    const head = document.createElement('div');
    head.className = 'rail-head';
    const name = document.createElement('span');
    name.className = 'rail-name';
    name.textContent = kind === 'group' ? trv(c.title) : person(c.who).name;
    head.appendChild(name);
    const chip = document.createElement('span');
    chip.className = 'rail-chip';
    chip.textContent = tr(CHIP[kind][c.status] || [c.status, c.status]);
    head.appendChild(chip);
    const hasOT = kind === 'group'
      ? c.members.some((m) => person(m).openteam)
      : person(c.who).openteam;
    if (hasOT) {
      const ot = document.createElement('span');
      ot.className = 'rail-ot';
      ot.textContent = 'OpenTeam';
      head.appendChild(ot);
    }
    const sub = document.createElement('span');
    sub.className = 'rail-sub';
    sub.textContent = kind === 'group'
      ? (M.lang === 'en' ? `${c.members.length} members` : `${c.members.length} 位成员`)
      : kind === 'worker'
        ? (trv(person(c.who).task) || (M.lang === 'en' ? 'sub-thread' : '子线程'))
        : (trv(person(c.who).last) || (M.lang === 'en' ? 'private chat' : '私聊'));
    const glyph = document.createElement('span');
    glyph.className = 'rail-glyph';
    glyph.innerHTML = GLYPHS[kind];
    meta.appendChild(head);
    meta.appendChild(sub);
    el.appendChild(meta);
    el.appendChild(glyph);
    M.items.set(`${type}:${kind === 'group' ? c.id : c.who}`, el);
    return el;
  }

  /* logical position helpers (offset* coords are unscaled stage px) */
  function itemRect(el) {
    const stage = M.rail.offsetParent; // .live-stage
    let x = el.offsetLeft, y = el.offsetTop, p = el.offsetParent;
    while (p && p !== stage) { x += p.offsetLeft; y += p.offsetTop; p = p.offsetParent; }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  }

  function heroItem() {
    if (!M.hero) return null;
    const id = M.hero.type === 'groups' ? M.hero.id : M.hero.id;
    return M.items.get(`${M.hero.type}:${id}`) || null;
  }

  function itemAnchor(el) {
    const r = itemRect(el);
    return { x: r.x - 6, y: r.y + r.h / 2 };
  }

  function avatarAnchor(el) {
    const img = el.querySelector('.rail-avatar');
    const r = itemRect(el);
    if (!img) return { x: r.x + 14, y: r.y + r.h / 2 };
    return { x: r.x + img.offsetLeft + img.offsetWidth / 2, y: r.y + img.offsetTop + img.offsetHeight / 2 };
  }

  /* --------------------------- worker connector --------------------------- */
  function workerRoute(to) {
    const o = M.env.O;
    const S2 = 1.18 * R;
    const pts = [];
    pts.push({ x: o.x + S2, y: o.y });
    pts.push({ x: o.x + S2 + 40, y: o.y });
    const dy = to.y - o.y;
    const jog = Math.sign(dy) * Math.min(Math.abs(dy), 60);
    pts.push({ x: o.x + S2 + 40 + Math.abs(jog), y: o.y + jog });
    pts.push({ x: to.x, y: to.y });
    return LS.arcTable(pts);
  }

  function drawWorker(g, item, status, hero, fx, t) {
    const to = itemAnchor(item);
    const route = workerRoute(to);
    const baseA = hero ? 0.38 : 0.12;
    const m = fx.aMul;
    const h = fx.slate ? '148,163,184' : COPPER;
    g.save();
    g.strokeStyle = LS.rgba(h, baseA * m);
    g.lineWidth = 1.2;
    if (status === 'verifying') g.setLineDash([4, 5]);
    g.beginPath();
    route.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.stroke();
    g.setLineDash([]);
    // via ring at the item end
    g.strokeStyle = LS.rgba(h, Math.min(0.5, baseA + 0.1) * m);
    g.beginPath();
    g.arc(to.x, to.y, 2.5, 0, Math.PI * 2);
    g.stroke();
    g.restore();

    // pulses
    const conf = {
      dispatch: { period: 1.4, a: 0.85, dir: 1 },
      working: { period: 2.6, a: 0.3, dir: 1 },
      return: { period: 1.2, a: 0.85, dir: -1 },
      verifying: { period: 2.4, a: 0.5, dir: -1 },
    }[status] || { period: 4, a: 0.22, dir: 1 };
    const period = hero ? conf.period : 4;
    const alpha = hero ? conf.a : 0.22;
    const dir = hero ? conf.dir : 1;
    const local = (t + route.L / 300) % period;
    const speed = 220;
    const s = dir > 0 ? local * speed : route.L - local * speed;
    if (s >= 0 && s <= route.L) {
      const head = route.pointAt(s);
      const tail = route.pointAt(s - dir * 16);
      const hue = status === 'return' ? (fx.slate ? h : AMBER) : (fx.slate ? h : GOLD);
      g.save();
      g.globalCompositeOperation = 'lighter';
      const grad = g.createLinearGradient(tail.x, tail.y, head.x, head.y);
      grad.addColorStop(0, LS.rgba(hue, 0));
      grad.addColorStop(1, LS.rgba(hue, alpha * m));
      g.strokeStyle = grad;
      g.lineWidth = 1.6;
      g.shadowColor = LS.rgba(hue, alpha * m);
      g.shadowBlur = 6;
      g.beginPath();
      g.moveTo(tail.x, tail.y);
      g.lineTo(head.x, head.y);
      g.stroke();
      g.restore();
      if (dir < 0 && s < speed * 0.033 && status === 'return' && !item._inhaled) {
        item._inhaled = true;
        M.env.emit('inhale');
      }
      if (s > speed * 0.033) item._inhaled = false;
    }
  }

  /* ---------------------------- peer connector ---------------------------- */
  function peerArc(to) {
    const o = M.env.O;
    const d = Math.hypot(to.x - o.x, to.y - o.y) || 1;
    const from = { x: o.x + ((to.x - o.x) / d) * R, y: o.y + ((to.y - o.y) / d) * R };
    const ctrl = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - 40 };
    return { from, ctrl, to, table: LS.arcTable(LS.sampleQuadratic(from, ctrl, to, 24)) };
  }

  function drawPeer(g, item, status, hero, fx, t, dt) {
    const to = avatarAnchor(item);
    const arc = peerArc(to);
    const m = fx.aMul;
    const h = fx.slate ? '148,163,184' : CYAN;
    const a = hero ? 0.38 : 0;
    if (hero) {
      g.save();
      g.strokeStyle = LS.rgba(h, a * m);
      g.lineWidth = 1.1;
      g.setLineDash([3, 5]);
      g.beginPath();
      arc.table.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.stroke();
      g.setLineDash([]);
      g.restore();
    } else {
      // non-hero: 12px dashed stub from the rail item
      const r = itemAnchor(item);
      g.save();
      g.strokeStyle = LS.rgba(h, 0.3 * m);
      g.lineWidth = 1;
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(r.x, r.y);
      g.lineTo(r.x - 12, r.y);
      g.stroke();
      g.restore();
      return;
    }

    const hi = fx.slate ? '148,163,184' : CYAN_HI;
    if (status === 'sending' || status === 'incoming') {
      const period = 2.6;
      const local = t % period;
      const dur = 1.3;
      if (local < dur) {
        const raw = local / dur;
        const p = status === 'sending' ? LS.easeInOutCubic(raw) : 1 - LS.easeInOutCubic(raw);
        const pt = arc.table.pointAt(p * arc.table.L);
        const pt2 = arc.table.pointAt((p - 0.03) * arc.table.L);
        // capsule: 16×8 pill along the arc
        const ang = Math.atan2(pt.y - pt2.y, pt.x - pt2.x);
        g.save();
        g.translate(pt.x, pt.y);
        g.rotate(ang);
        g.globalCompositeOperation = 'lighter';
        g.shadowColor = LS.rgba(hi, 0.7 * m);
        g.shadowBlur = 8;
        g.fillStyle = LS.rgba(hi, 0.85 * m);
        LS.roundRect(g, -8, -4, 16, 8, 4);
        g.fill();
        g.shadowBlur = 0;
        g.fillStyle = 'rgba(10,18,32,.9)';
        g.fillRect(-2, -1.5, 4, 3);
        g.restore();
        // at 50%: dotted drop to the nearest chain block
        if (status === 'sending' && raw >= 0.5 && !M.peerCycle.dropped) {
          M.peerCycle.dropped = true;
          const pos = M.env.chainApi && M.env.chainApi.flashNearest(pt.x, pt.y);
          if (pos) M.peerCycle.drop = { from: { x: pt.x, y: pt.y }, to: pos, t0: t };
          M.env.emit('lean', { x: 6, ms: 300 });
        }
        if (status === 'incoming' && p < 0.05 && !M.peerCycle.landed) {
          M.peerCycle.landed = true;
          M.env.emit('inhale');
        }
      } else {
        M.peerCycle.dropped = false;
        M.peerCycle.landed = false;
      }
      // drop line persists ~800ms so the anchor reads in stills too
      if (M.peerCycle.drop && t - M.peerCycle.drop.t0 < 0.8) {
        const d = M.peerCycle.drop;
        const de = (t - d.t0) / 0.8;
        g.save();
        g.setLineDash([2, 4]);
        g.strokeStyle = LS.rgba(hi, 0.2 * (1 - de) * m);
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(d.from.x, d.from.y);
        g.lineTo(d.to.x, d.to.y);
        g.stroke();
        g.restore();
      }
    }
    if (status === 'delivered' || status === 'awaiting') {
      // check at the peer end
      g.save();
      g.strokeStyle = LS.rgba(hi, 0.6 * m);
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(to.x - 14, to.y + 6);
      g.lineTo(to.x - 11, to.y + 9);
      g.lineTo(to.x - 5, to.y + 2);
      g.stroke();
      g.restore();
    }
    if (status === 'awaiting') {
      for (let i = 0; i < 3; i += 1) {
        const ph = (t * 1.6 + i * 0.6) % 1.8;
        const a2 = 0.2 + 0.4 * Math.sin(Math.PI * Math.min(1, ph / 0.6));
        g.fillStyle = LS.rgba(hi, Math.max(0.12, a2) * m);
        g.beginPath();
        g.arc(to.x - 20 - i * 7, to.y + 12, 2, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  /* ------------------------------ group ring ------------------------------ */
  const RING_TILT = (-8 * Math.PI) / 180;
  /* members live only on the right arc: |θ| ≤ 50°, outside the orb disc */
  const RING_ANGLES = [-45, -15, 15, 45].map((d) => (d * Math.PI) / 180);
  const MORE_ANGLE = (60 * Math.PI) / 180;

  /* the ring exists only while a group is the hero thread */
  function heroGroup() {
    if (!M.hero || M.hero.type !== 'groups') return null;
    return (M.spec.groups || []).find((g) => g.id === M.hero.id) || null;
  }

  /* clamp rx so the ring's right extremity stays 24px clear of the rail */
  function ringRx() {
    const o = M.env.O;
    const railLeft = M.rail && M.rail.offsetWidth ? M.rail.offsetLeft : 0.762 * W;
    const limit = (railLeft - 24 - o.x) / Math.cos(RING_TILT);
    return LS.clamp(limit, 1.2 * R, 1.8 * R);
  }

  function ringPt(theta) {
    const o = M.env.O;
    const rx = M.rx || 1.8 * R, ry = 0.58 * R;
    const u = rx * Math.cos(theta), v = ry * Math.sin(theta);
    return {
      x: o.x + u * Math.cos(RING_TILT) - v * Math.sin(RING_TILT),
      y: o.y + u * Math.sin(RING_TILT) + v * Math.cos(RING_TILT),
      back: Math.sin(theta) < 0,
    };
  }

  function drawRingHalf(g, back, alpha, hi, m) {
    const N = 72;
    g.strokeStyle = LS.rgba(hi, alpha * m);
    g.lineWidth = 1;
    g.beginPath();
    let started = false;
    for (let i = 0; i <= N; i += 1) {
      const th = (i / N) * Math.PI * 2;
      const p = ringPt(th);
      const isBack = Math.sin(th) < 0;
      if (isBack === back) {
        if (!started) { g.moveTo(p.x, p.y); started = true; }
        else g.lineTo(p.x, p.y);
      } else started = false;
    }
    g.stroke();
  }

  function drawRingArc(g, thetaFrom, thetaTo, hi, a, m) {
    const N = Math.max(3, Math.ceil(Math.abs(thetaTo - thetaFrom) / 0.08));
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = LS.rgba(hi, a * m);
    g.lineWidth = 1.4;
    g.beginPath();
    for (let i = 0; i <= N; i += 1) {
      const th = thetaFrom + ((thetaTo - thetaFrom) * i) / N;
      const p = ringPt(th);
      if (i === 0) g.moveTo(p.x, p.y);
      else g.lineTo(p.x, p.y);
    }
    g.stroke();
    g.restore();
  }

  function groupMembers(grp) {
    return grp.members.filter((pid) => pid !== 'twin');
  }

  /* sender and chair are always among the ≤4 members placed on the ring */
  function orderedMembers(grp) {
    const list = groupMembers(grp);
    const out = [];
    if (grp.sender && list.includes(grp.sender)) out.push(grp.sender);
    if (grp.chair && list.includes(grp.chair)) out.push(grp.chair);
    for (const pid of list) if (!out.includes(pid)) out.push(pid);
    return out;
  }

  function memberAngles(grp) {
    const map = new Map();
    orderedMembers(grp).slice(0, RING_ANGLES.length)
      .forEach((pid, i) => map.set(pid, RING_ANGLES[i]));
    return map;
  }

  function memberAngle(grp, pid) {
    const a = memberAngles(grp).get(pid);
    return a == null ? 0 : a;
  }

  function buildMemberLayer(grp) {
    const layer = M.memberLayer;
    layer.innerHTML = '';
    M.memberEls.clear();
    M.moreEl = null;
    M.memberGrp = grp || null;
    if (!grp) return;
    const ordered = orderedMembers(grp);
    for (const pid of ordered.slice(0, RING_ANGLES.length)) {
      const el = document.createElement('div');
      el.className = 'group-member';
      const p = person(pid);
      const img = document.createElement('img');
      img.src = p.avatar;
      img.alt = '';
      el.appendChild(img);
      if (grp.chair === pid) {
        const c = document.createElement('span');
        c.className = 'gm-chair';
        el.appendChild(c);
      }
      if (p.openteam) {
        const ring = document.createElement('span');
        ring.className = 'gm-ot';
        const badge = document.createElement('span');
        badge.className = 'gm-ot-badge';
        badge.textContent = 'OT';
        el.appendChild(ring);
        el.appendChild(badge);
      }
      layer.appendChild(el);
      M.memberEls.set(pid, el);
    }
    const extra = ordered.length - RING_ANGLES.length;
    if (extra > 0) {
      const el = document.createElement('div');
      el.className = 'group-member gm-more';
      el.textContent = `+${extra}`;
      layer.appendChild(el);
      M.moreEl = el;
    }
  }

  /* keep the DOM member layer in sync with the hero group */
  function syncMemberLayer() {
    const grp = heroGroup();
    if (grp && M.memberGrp !== grp) {
      buildMemberLayer(grp);
      layoutMembers();
    }
  }

  function clearMemberLayer() {
    M.memberLayer.innerHTML = '';
    M.memberEls.clear();
    M.moreEl = null;
    M.memberGrp = null;
  }

  function layoutMembers() {
    const grp = M.memberGrp;
    if (!grp) return;
    M.rx = ringRx();
    const angles = memberAngles(grp);
    const a = M.ringA;
    for (const [pid, el] of M.memberEls) {
      const th = angles.get(pid);
      if (th == null) { el.style.opacity = '0'; continue; }
      const p = ringPt(th);
      const back = Math.sin(th) < 0;
      const size = back ? 20 : 26;
      el.dataset.side = back ? 'back' : 'front';
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.left = `${p.x - size / 2}px`;
      el.style.top = `${p.y - size / 2}px`;
      let op = (back ? 0.6 : 1) * a;
      // copy-column protection: fade members entering the left 30%
      if (p.x < 0.34 * W) op = Math.max(0, op - 0.5);
      el.style.opacity = String(op);
    }
    if (M.moreEl) {
      const p = ringPt(MORE_ANGLE);
      M.moreEl.dataset.side = 'front';
      M.moreEl.style.left = `${p.x - 9}px`;
      M.moreEl.style.top = `${p.y - 9}px`;
      M.moreEl.style.opacity = String(0.9 * a);
    }
  }

  function drawGroupRing(gBack, gFront, dt, t, fx) {
    const grp = M.memberGrp;
    if (!grp || M.ringA <= 0.001) return;
    const m = fx.aMul * M.ringA;
    M.rx = ringRx();
    const h = fx.slate ? '148,163,184' : CYAN;
    const hi = fx.slate ? '148,163,184' : CYAN_HI;
    M.ringSpin += dt * ((25 * Math.PI) / 180);

    // base ellipse: back half → back canvas, front half → front canvas
    drawRingHalf(gBack, true, 0.16, h, m);
    drawRingHalf(gFront, false, 0.22, h, m);

    // ambient 40° highlight flowing along the front half
    const head = M.ringSpin % (Math.PI * 2);
    drawRingArc(gFront, head, head + (40 * Math.PI) / 180, hi, 0.35, m);

    // chair dot: on orb top edge when twin chairs
    if (grp.chair === 'twin') {
      const o = M.env.O;
      gFront.fillStyle = LS.rgba(AMBER, 0.85 * m);
      gFront.beginPath();
      gFront.arc(o.x, o.y - R - 7, 1.5, 0, Math.PI * 2);
      gFront.fill();
    }

    // posting/incoming sweeps only while this group is the live hero
    const live = heroGroup() === grp;
    const isPosting = live && grp.status === 'posting';
    const isIncoming = live && grp.status === 'incoming';
    if ((isPosting || isIncoming) && M.ringSweep.t0 < 0) {
      M.ringSweep.t0 = t;
      M.ringSweep.senderAngle = isIncoming ? memberAngle(grp, grp.sender) : Math.PI / 2;
      M.ringSweep.done = false;
      if (isPosting) {
        const bp = ringPt(Math.PI / 2);
        const pos = M.env.chainApi && M.env.chainApi.flashNearest(bp.x, bp.y);
        if (pos) M.ringSweep.drop = { from: bp, to: pos, t0: t };
      }
    }
    if (!isPosting && !isIncoming) {
      M.ringSweep.t0 = -9;
      M.ringSweep.drop = null;
    }
    if (M.ringSweep.t0 >= 0) {
      const e = t - M.ringSweep.t0;
      const from = M.ringSweep.senderAngle;
      const sweep = e * ((160 * Math.PI) / 180);
      if (e < 2) {
        drawRingArc(gFront, from, from + sweep, hi, 0.4, m);
        drawRingArc(gFront, from, from - sweep, hi, 0.4, m);
        // member pulses
        for (const pid of groupMembers(grp)) {
          const a = memberAngle(grp, pid);
          let d = Math.abs(a - from);
          d = Math.min(d, Math.PI * 2 - d);
          const el = M.memberEls.get(pid);
          if (el) el.dataset.lit = sweep >= d && e < 1.6 ? '1' : '0';
        }
      } else {
        for (const el of M.memberEls.values()) el.dataset.lit = '0';
      }
      // dotted drop line (posting) to the chain block
      if (M.ringSweep.drop && e < 0.9) {
        const d = M.ringSweep.drop;
        gFront.save();
        gFront.setLineDash([2, 4]);
        gFront.strokeStyle = LS.rgba(hi, 0.25 * (1 - e / 0.9) * m);
        gFront.beginPath();
        gFront.moveTo(d.from.x, d.from.y);
        gFront.lineTo(d.to.x, d.to.y);
        gFront.stroke();
        gFront.restore();
      }
      // incoming: glint from sender to orb
      if (isIncoming && !M.ringSweep.done && e > 0.4) {
        const ge = LS.clamp((e - 0.4) / 0.8, 0, 1);
        const sp = ringPt(from);
        const o = M.env.O;
        const dd = Math.hypot(sp.x - o.x, sp.y - o.y) || 1;
        const edge = { x: o.x + ((sp.x - o.x) / dd) * R, y: o.y + ((sp.y - o.y) / dd) * R };
        const ctrl = { x: (sp.x + edge.x) / 2, y: Math.min(sp.y, edge.y) - 40 };
        const pt = LS.quad(sp, ctrl, edge, LS.easeInOutCubic(ge));
        gFront.save();
        gFront.globalCompositeOperation = 'lighter';
        gFront.shadowColor = LS.rgba(hi, 0.8 * m);
        gFront.shadowBlur = 7;
        gFront.fillStyle = LS.rgba(hi, 0.7 * m);
        gFront.beginPath();
        gFront.arc(pt.x, pt.y, 2.4, 0, Math.PI * 2);
        gFront.fill();
        gFront.restore();
        if (ge >= 1) {
          M.ringSweep.done = true;
          M.env.emit('inhale');
        }
      }
    }
  }

  /* ------------------------------- public ------------------------------- */
  LS.companions = {
    init(env) {
      M.env = env;
      M.rail = document.querySelector('[data-companion-rail]');
      M.memberLayer = document.querySelector('[data-group-members]');
    },
    apply(spec) {
      const prev = { ...M.spec };
      M.spec = spec && Object.keys(spec).length ? spec : { workers: [], peers: [], groups: [] };
      M.hero = M.spec.hero || null;
      M.fadeT = M.t;
      M.peerCycle = { t0: -9, dropped: false, leanAt: -9, dropAt: -9, drop: null };
      M.ringSweep = { t0: -9, senderAngle: null, done: false };
      buildRail();
      syncMemberLayer();
      layoutMembers();
      return prev;
    },
    setLanguage(l) {
      M.lang = l;
      buildRail();
      layoutMembers();
    },
    hero() { return M.hero; },
    relayout() { layoutMembers(); },
    /* verification hook: distance of the hero peer arc's start from the orb edge */
    _peerArcStart() {
      if (!M.hero || M.hero.type !== 'peers') return null;
      const el = M.items.get(`peers:${M.hero.id}`);
      if (!el) return null;
      const arc = peerArc(avatarAnchor(el));
      const o = M.env.O;
      const d = Math.hypot(arc.from.x - o.x, arc.from.y - o.y);
      return { x: arc.from.x, y: arc.from.y, d, edge: d - R };
    },
    /* called by proto once per frame with both companion canvases */
    draw(gBack, gFront, dt, t, fx) {
      M.t = t;
      syncMemberLayer();
      // ring + members fade over 400ms when the hero gains/leaves a group
      if (dt === 0) M.ringA = heroGroup() ? 1 : 0;
      else M.ringA = LS.clamp(M.ringA + (heroGroup() ? dt / 0.4 : -dt / 0.4), 0, 1);
      if (!heroGroup() && M.ringA <= 0 && M.memberGrp) clearMemberLayer();
      drawGroupRing(gBack, gFront, dt, t, fx);
      for (const c of M.spec.workers || []) {
        const el = M.items.get(`workers:${c.who}`);
        if (!el) continue;
        const hero = M.hero && M.hero.type === 'workers' && M.hero.id === c.who;
        drawWorker(gFront, el, c.status, hero, fx, t);
      }
      for (const c of M.spec.peers || []) {
        const el = M.items.get(`peers:${c.who}`);
        if (!el) continue;
        const hero = M.hero && M.hero.type === 'peers' && M.hero.id === c.who;
        drawPeer(gFront, el, c.status, hero, fx, t, dt);
      }
    },
    layoutMembers,
  };
})();

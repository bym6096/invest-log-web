(function () {
  const KEY = 'invest.v1';
  const TYPE_LABEL = { i: '초기', t: '거래', r: '밸런스', w: '출금', d: '시드추가' };
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const EMPTY = { version: 1, coins: [], snapshots: [], flows: [], log: [] };
  let db = load();
  let tab = 'sum';
  let openCoin = null;
  let formOpen = {};
  let editing = null; // { kind, id }
  const isEd = (kind, id) => editing && editing.kind === kind && editing.id === id;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* 저장소 접근 불가 시 기본 데이터 */ }
    return JSON.parse(JSON.stringify(EMPTY));
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ }
  }

  // ---------- 유틸 ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (n, d = 0) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const usd = (n) => '$' + num(n);
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + num(Math.abs(n));
  const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
  const short = (d) => (d ? d.slice(2).replace(/-/g, '/') : '–');
  const today = () => new Date().toISOString().slice(0, 10);
  const nid = () => 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0); // 안정 정렬

  // ---------- 계산 ----------
  const snaps = () => [...db.snapshots].sort(byDate);
  const latestSnap = () => snaps().slice(-1)[0];

  function seedAt(coin, date) {
    let seed = null;
    for (const e of coin.events) if (!e.date || e.date <= date) seed = e.seed;
    return seed;
  }
  const curSeed = (coin) => (coin.events.length ? coin.events[coin.events.length - 1].seed : 0);

  function coinStats(coin) {
    let prev = null, pnl = 0, wd = 0;
    const rows = coin.events.map((e) => {
      let delta = null;
      if (prev !== null && (e.type === 't' || e.type === 'w')) {
        delta = e.seed - prev + (e.type === 'w' ? e.amount || 0 : 0);
        pnl += delta;
      } else if (prev !== null) {
        delta = e.seed - prev;
      }
      if (e.type === 'w') wd += e.amount || 0;
      const row = { ...e, delta, pnlEvent: e.type === 't' || e.type === 'w' };
      prev = e.seed;
      return row;
    });
    return { rows, pnl, wd };
  }

  function summary() {
    const s = snaps();
    const first = s[0], last = s[s.length - 1];
    const coinSum = db.coins.reduce((a, c) => a + curSeed(c), 0);
    const inRange = (f) => f.date > first.date && f.date <= last.date;
    const dep = db.flows.filter((f) => f.type === 'in' && inRange(f)).reduce((a, f) => a + (f.usd || 0), 0);
    const wd = db.flows.filter((f) => f.type === 'out' && inRange(f)).reduce((a, f) => a + (f.usd || 0), 0);
    const profit = last.balance - first.balance - dep + wd;
    const invested = first.balance + dep;
    const diff = coinSum - last.balance;
    const coinWd = db.coins.reduce((a, c) => a + coinStats(c).wd, 0);
    const totalWd = db.flows.filter((f) => f.type === 'out').reduce((a, f) => a + (f.usd || 0), 0);
    const hasEst = db.flows.some((f) => f.est);
    return { first, last, coinSum, dep, wd, profit, invested, diff, coinWd, totalWd, hasEst };
  }

  // 코인 시드 합계가 바뀐 시점별 오차 (코인 이벤트 날짜가 있는 시점부터)
  function diffHistory() {
    const dated = db.coins.flatMap((c) => c.events.filter((e) => e.date).map((e) => e.date));
    if (!dated.length) return [];
    const from = dated.sort()[0];
    return snaps().filter((s) => s.date >= from).map((s) => {
      const sum = db.coins.reduce((a, c) => a + (seedAt(c, s.date) || 0), 0);
      return { date: s.date, balance: s.balance, sum, diff: sum - s.balance };
    });
  }

  function unmatchedWithdrawals() {
    const out = [];
    db.coins.forEach((c) => c.events.filter((e) => e.type === 'w').forEach((e) => {
      const ok = db.flows.some((f) => f.type === 'out' && f.date === e.date && f.usd === e.amount);
      if (!ok) out.push({ coin: c.sym, date: e.date, amount: e.amount });
    }));
    return out;
  }

  // ---------- 차트 ----------
  function lineChart(series) {
    const W = 600, H = 200, pl = 44, pr = 8, pt = 10, pb = 22;
    const pts = series.flatMap((s) => s.pts);
    if (pts.length < 2) return '<p class="muted">데이터가 부족합니다</p>';
    const t0 = Math.min(...pts.map((p) => p[0])), t1 = Math.max(...pts.map((p) => p[0]));
    let v0 = Math.min(...pts.map((p) => p[1])), v1 = Math.max(...pts.map((p) => p[1]));
    const pad = (v1 - v0) * 0.08 || 1;
    v0 -= pad; v1 += pad;
    const x = (t) => pl + ((t - t0) / (t1 - t0 || 1)) * (W - pl - pr);
    const y = (v) => pt + (1 - (v - v0) / (v1 - v0)) * (H - pt - pb);
    let g = '';
    for (let i = 0; i <= 3; i++) {
      const v = v0 + ((v1 - v0) * i) / 3;
      g += `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/>` +
        `<text class="axis" x="${pl - 4}" y="${y(v) + 3}" text-anchor="end">${v >= 1000 ? num(v / 1000) + 'k' : num(v)}</text>`;
    }
    const fmtT = (t) => new Date(t).toISOString().slice(2, 7).replace('-', '/');
    g += `<text class="axis" x="${pl}" y="${H - 6}">${fmtT(t0)}</text>` +
      `<text class="axis" x="${W - pr}" y="${H - 6}" text-anchor="end">${fmtT(t1)}</text>`;
    const lines = series.map((s) =>
      `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" points="${s.pts.map((p) => x(p[0]).toFixed(1) + ',' + y(p[1]).toFixed(1)).join(' ')}"/>`).join('');
    const legend = series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img">${g}${lines}</svg><div class="legend">${legend}</div>`;
  }
  const T = (d) => new Date(d).getTime();

  // ---------- 화면 ----------
  function viewSum() {
    if (!db.snapshots.length) {
      return `<section class="card"><h2>아직 데이터가 없어요</h2>
        <p class="hint">설정 탭에서 <b>JSON 가져오기</b>로 기존 데이터를 불러오거나, 기록 탭에서 총 시드를 직접 추가하세요.</p>
        <button class="btn" data-tab="set">설정으로 이동</button></section>`;
    }
    const s = summary();
    const dh = diffHistory();
    const um = unmatchedWithdrawals();
    const pct = (s.diff / s.last.balance) * 100;
    return `
    <section class="card hero">
      <div class="label">현재 바이낸스 시드 · ${short(s.last.date)}${s.last.np ? ' · np' : ''}</div>
      <div class="big">${usd(s.last.balance)}</div>
      <div class="row2">
        <div><div class="label">입출금 제외 손익</div><div class="v ${cls(s.profit)}">${signed(s.profit)}$</div></div>
        <div><div class="label">수익률(입금 기준)</div><div class="v ${cls(s.profit)}">${num((s.profit / s.invested) * 100, 1)}%</div></div>
      </div>
    </section>

    <section class="card">
      <h2>코인별 시드 합 ↔ 실제 총 시드</h2>
      <div class="row3">
        <div><div class="label">코인 시드 합</div><div class="v">${usd(s.coinSum)}</div></div>
        <div><div class="label">실제 총 시드</div><div class="v">${usd(s.last.balance)}</div></div>
        <div><div class="label">오차</div><div class="v ${s.diff > 0 ? 'warn' : s.diff < 0 ? 'neg' : ''}">${signed(s.diff)}$<small> ${num(pct, 1)}%</small></div></div>
      </div>
      <p class="hint">${s.diff > 0 ? '코인별 추적이 실제보다 높게 잡혀 있어요.' : s.diff < 0 ? '코인별 추적이 실제보다 낮게 잡혀 있어요.' : '정확히 일치합니다.'}
      실제 시드(${short(s.last.date)}) 기준, 코인 시드는 각 코인의 마지막 기록 값입니다.</p>
      ${um.length ? `<p class="hint warn">⚠ 코인 출금 기록 중 총 시드 출금 내역에 없는 것: ${um.map((u) => `${u.coin} ${short(u.date)} ${usd(u.amount)}`).join(', ')}</p>` : ''}
      ${dh.length > 1 ? `<h3>시점별 오차</h3>${lineChart([
        { name: '실제 총 시드', color: 'var(--c1)', pts: dh.map((r) => [T(r.date), r.balance]) },
        { name: '코인 시드 합', color: 'var(--c2)', pts: dh.map((r) => [T(r.date), r.sum]) },
      ])}
      <table class="tbl"><thead><tr><th>날짜</th><th>실제</th><th>코인합</th><th>오차</th></tr></thead><tbody>
      ${[...dh].reverse().map((r) => `<tr><td>${short(r.date)}</td><td>${num(r.balance)}</td><td>${num(r.sum)}</td><td class="${r.diff > 0 ? 'warn' : 'neg'}">${signed(r.diff)}</td></tr>`).join('')}
      </tbody></table>` : ''}
    </section>

    <section class="card">
      <h2>입출금</h2>
      <div class="row3">
        <div><div class="label">누적 입금</div><div class="v">${usd(s.dep)}</div></div>
        <div><div class="label">누적 출금</div><div class="v">${usd(s.totalWd)}</div></div>
        <div><div class="label">코인 시드에서<br>출금 표기</div><div class="v">${usd(s.coinWd)}</div></div>
      </div>
      ${s.hasEst ? '<p class="hint">※ 추정 입금액이 포함돼 있어요 (기록 탭에서 확인).</p>' : ''}
    </section>

    <section class="card">
      <h2>총 시드 추이 <small class="muted">(입출금 미반영)</small></h2>
      ${lineChart([{ name: '바이낸스 USD', color: 'var(--c1)', pts: snaps().map((r) => [T(r.date), r.balance]) }])}
    </section>`;
  }

  const cancelBtn = (e) => (e ? '<button type="button" class="btn alt" data-cancel>취소</button>' : '');
  const val = (x) => (x === undefined || x === null ? '' : esc(x));

  function coinForm(c, e) {
    const t = e ? e.type : 't';
    const opt = (v, l) => `<option value="${v}"${t === v ? ' selected' : ''}>${l}</option>`;
    return `<form class="form" data-form="event" data-coin="${esc(c.sym)}"${e ? ` data-id="${e.id}"` : ''}>
      <div class="grid2">
        <label>종류<select name="type">${opt('t', '거래 (손익 반영)')}${opt('r', '밸런스조정')}${opt('w', '출금')}${opt('d', '시드추가')}${opt('i', '초기시드')}</select></label>
        <label>날짜<input type="date" name="date" value="${e ? val(e.date) : today()}"></label>
        <label>변경 후 시드($)<input type="number" step="any" name="seed" value="${e ? e.seed : ''}" required inputmode="decimal"></label>
        <label>출금액($, 출금일 때)<input type="number" step="any" name="amount" value="${e ? val(e.amount) : ''}" inputmode="decimal"></label>
      </div>
      <label>메모<input name="note" value="${e ? val(e.note) : ''}"></label>
      <button class="btn">저장</button>${cancelBtn(e)}</form>`;
  }

  function snapForm(r) {
    return `<form class="form" data-form="snap"${r ? ` data-id="${r.id}"` : ''}><div class="grid2">
      <label>날짜<input type="date" name="date" value="${r ? r.date : today()}" required></label>
      <label>바이낸스 시드($, 미실현 제외)<input type="number" step="any" name="balance" value="${r ? r.balance : ''}" required inputmode="decimal"></label></div>
      <label class="chk"><input type="checkbox" name="np"${!r || r.np ? ' checked' : ''}> 포지션 없음(np)</label>
      <label>메모<input name="note" value="${r ? val(r.note) : ''}"></label><button class="btn">저장</button>${cancelBtn(r)}</form>`;
  }

  function flowForm(f) {
    const t = f ? f.type : 'out';
    return `<form class="form" data-form="flow"${f ? ` data-id="${f.id}"` : ''}><div class="grid2">
      <label>구분<select name="type"><option value="out"${t === 'out' ? ' selected' : ''}>출금</option><option value="in"${t === 'in' ? ' selected' : ''}>입금</option></select></label>
      <label>날짜<input type="date" name="date" value="${f ? f.date : today()}" required></label>
      <label>금액($)<input type="number" step="any" name="usd" value="${f ? f.usd : ''}" required inputmode="decimal"></label>
      <label>코인 시드에서 출금<select name="coin"><option value="">총 시드에서만</option>${db.coins.map((c) => `<option${f && f.coin === c.sym ? ' selected' : ''}>${esc(c.sym)}</option>`).join('')}</select></label></div>
      <label class="chk"><input type="checkbox" name="est"${f && f.est ? ' checked' : ''}> 추정 금액</label>
      <label>메모<input name="note" value="${f ? val(f.note) : ''}"></label><button class="btn">저장</button>${cancelBtn(f)}</form>`;
  }

  function logForm(r) {
    return `<form class="form" data-form="log"${r ? ` data-id="${r.id}"` : ''}><label>날짜<input type="date" name="date" value="${r ? r.date : today()}" required></label>
      <label>내용<textarea name="text" rows="3" required>${r ? val(r.text) : ''}</textarea></label><button class="btn">저장</button>${cancelBtn(r)}</form>`;
  }

  const editBtn = (kind, id, coin) => `<button class="x" data-edit="${kind}" data-id="${id}"${coin ? ` data-coin="${esc(coin)}"` : ''} aria-label="수정">✎</button>`;

  function viewCoins() {
    const total = db.coins.reduce((a, c) => a + curSeed(c), 0);
    return db.coins.map((c) => {
      const st = coinStats(c);
      const cur = curSeed(c);
      const isOpen = openCoin === c.sym;
      return `<section class="card coin">
        <div class="coin-head" data-toggle="${esc(c.sym)}">
          <div><b>${esc(c.sym)}</b> <span class="chip">x${c.lev}</span>${c.weight ? ` <span class="muted">${c.weight}%</span>` : ''}</div>
          <div class="right"><b>${usd(cur)}</b><div class="muted">${num((cur / total) * 100, 1)}%</div></div>
        </div>
        <div class="row3 mini">
          <div><div class="label">거래 손익 합</div><div class="${cls(st.pnl)}">${signed(st.pnl)}</div></div>
          <div><div class="label">출금 표기</div><div>${usd(st.wd)}</div></div>
          <div><div class="label">기록 수</div><div>${c.events.length}</div></div>
        </div>
        ${isOpen ? `
          <button class="link" data-act="addev" data-coin="${esc(c.sym)}">${formOpen['ev' + c.sym] ? '닫기' : '+ 기록 추가'}</button>
          <button class="link" data-act="lev" data-coin="${esc(c.sym)}">레버리지 변경</button>
          ${formOpen['ev' + c.sym] ? coinForm(c) : ''}
          <ul class="list">${[...st.rows].reverse().map((e) => isEd('ev', e.id) ? `<li class="editli">${coinForm(c, e)}</li>` : `
            <li><span class="d">${short(e.date)}</span>
            <span class="badge b-${e.type}">${TYPE_LABEL[e.type]}</span>
            <span class="grow">${num(e.seed)}${e.type === 'w' ? ` <small class="muted">(−${num(e.amount || 0)} 출금)</small>` : ''}${e.note ? ` <small class="muted">${esc(e.note)}</small>` : ''}</span>
            <span class="delta ${e.pnlEvent ? cls(e.delta) : 'muted'}">${e.delta === null ? '' : signed(e.delta)}</span>
            ${editBtn('ev', e.id, c.sym)}<button class="x" data-del="ev" data-coin="${esc(c.sym)}" data-id="${e.id}" aria-label="삭제">×</button></li>`).join('')}
          </ul>
          <p class="hint">오른쪽 숫자는 직전 기록 대비 시드 변화입니다. 거래·출금만 손익으로 합산하고, 밸런스조정·시드추가는 제외합니다.</p>` : ''}
      </section>`;
    }).join('') + `<button class="link" data-act="addcoin">+ 코인 추가</button>`;
  }

  function viewRec() {
    const sn = [...snaps()].reverse();
    const fl = [...db.flows].sort(byDate).reverse();
    return `
    <section class="card"><h2>총 시드 기록</h2>
      <button class="link" data-act="addsnap">${formOpen.snap ? '닫기' : '+ 시드 기록 추가'}</button>
      ${formOpen.snap ? snapForm() : ''}
      <ul class="list">${sn.map((r) => isEd('snap', r.id) ? `<li class="editli">${snapForm(r)}</li>` : `<li><span class="d">${short(r.date)}</span><span class="grow">${num(r.balance, 2).replace(/\.00$/, '')}${r.np ? ' <span class="chip">np</span>' : ''}${r.note ? ` <small class="muted">${esc(r.note)}</small>` : ''}</span>${editBtn('snap', r.id)}<button class="x" data-del="snap" data-id="${r.id}" aria-label="삭제">×</button></li>`).join('')}</ul>
    </section>
    <section class="card"><h2>입출금 (USD)</h2>
      <button class="link" data-act="addflow">${formOpen.flow ? '닫기' : '+ 입출금 추가'}</button>
      ${formOpen.flow ? flowForm() : ''}
      <ul class="list">${fl.map((f) => isEd('flow', f.id) ? `<li class="editli">${flowForm(f)}</li>` : `<li><span class="d">${short(f.date)}</span><span class="badge ${f.type === 'in' ? 'b-in' : 'b-w'}">${f.type === 'in' ? '입금' : '출금'}</span><span class="grow">${usd(f.usd)}${f.est ? ' <span class="chip warnc">추정</span>' : ''}${f.coin ? ` <span class="chip">${esc(f.coin)}</span>` : ''}${f.note ? ` <small class="muted">${esc(f.note)}</small>` : ''}</span>${editBtn('flow', f.id)}<button class="x" data-del="flow" data-id="${f.id}" aria-label="삭제">×</button></li>`).join('')}</ul>
    </section>`;
  }

  function viewLog() {
    const lg = [...db.log].sort(byDate).reverse();
    return `<section class="card"><h2>전략 변경 · 메모</h2>
      <button class="link" data-act="addlog">${formOpen.log ? '닫기' : '+ 메모 추가'}</button>
      ${formOpen.log ? logForm() : ''}
      <ul class="list">${lg.map((r) => isEd('log', r.id) ? `<li class="editli">${logForm(r)}</li>` : `<li><span class="d">${short(r.date)}</span><span class="grow">${esc(r.text)}</span>${editBtn('log', r.id)}<button class="x" data-del="log" data-id="${r.id}" aria-label="삭제">×</button></li>`).join('')}</ul></section>`;
  }

  function viewSet() {
    return `<section class="card"><h2>백업 · 복원</h2>
      <p class="hint">데이터는 이 기기 브라우저에만 저장됩니다. 주기적으로 내보내기 하세요.</p>
      <button class="btn" data-act="export">JSON 내보내기</button>
      <label class="btn alt">JSON 가져오기<input type="file" accept="application/json" id="imp" hidden></label>
      <button class="btn danger" data-act="reset">모든 데이터 지우기</button></section>`;
  }

  const VIEWS = { sum: viewSum, coins: viewCoins, rec: viewRec, log: viewLog, set: viewSet };
  function render() {
    $('#view').innerHTML = VIEWS[tab]();
    $$('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  }

  // ---------- 이벤트 ----------
  const findCoin = (sym) => db.coins.find((c) => c.sym === sym);
  const commit = () => { save(); render(); };

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-tab],[data-toggle],[data-act],[data-del],[data-edit],[data-cancel]');
    if (!t) return;
    const d = t.dataset;
    if (d.tab) { tab = d.tab; editing = null; render(); window.scrollTo(0, 0); }
    else if (t.hasAttribute('data-cancel')) { editing = null; render(); }
    else if (d.edit) { editing = { kind: d.edit, id: d.id }; render(); }
    else if (d.toggle) { openCoin = openCoin === d.toggle ? null : d.toggle; render(); }
    else if (d.del) {
      if (!confirm('삭제할까요?')) return;
      if (d.del === 'ev') { const c = findCoin(d.coin); c.events = c.events.filter((e) => e.id !== d.id); }
      if (d.del === 'snap') db.snapshots = db.snapshots.filter((r) => r.id !== d.id);
      if (d.del === 'flow') db.flows = db.flows.filter((r) => r.id !== d.id);
      if (d.del === 'log') db.log = db.log.filter((r) => r.id !== d.id);
      commit();
    } else if (d.act) {
      const toggle = (k) => { formOpen[k] = !formOpen[k]; render(); };
      if (d.act === 'addev') toggle('ev' + d.coin);
      if (d.act === 'addsnap') toggle('snap');
      if (d.act === 'addflow') toggle('flow');
      if (d.act === 'addlog') toggle('log');
      if (d.act === 'lev') {
        const c = findCoin(d.coin);
        const v = parseFloat(prompt(`${c.sym} 레버리지 (현재 x${c.lev})`, c.lev));
        if (v > 0) { c.lev = v; commit(); }
      }
      if (d.act === 'addcoin') {
        const sym = (prompt('코인 심볼 (예: DOGE)') || '').trim().toUpperCase();
        if (!sym || findCoin(sym)) return;
        const lev = parseFloat(prompt('레버리지', '2')) || 1;
        const seed = parseFloat(prompt('시작 시드($)', '0')) || 0;
        db.coins.push({ sym, lev, weight: 0, events: [{ id: nid(), seed, date: today(), type: 'i' }] });
        openCoin = sym; commit();
      }
      if (d.act === 'export') {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }));
        a.download = `invest-log-${today()}.json`;
        a.click();
      }
      if (d.act === 'reset' && confirm('이 기기의 모든 기록이 지워집니다. 내보내기로 백업하셨나요?')) {
        db = JSON.parse(JSON.stringify(EMPTY)); commit();
      }
    }
  });

  document.addEventListener('submit', (ev) => {
    const f = ev.target.closest('form[data-form]');
    if (!f) return;
    ev.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    const kind = f.dataset.form;
    const id = f.dataset.id;
    editing = null;
    if (kind === 'event') {
      const c = findCoin(f.dataset.coin);
      const e = id ? c.events.find((x) => x.id === id) : { id: nid() };
      const old = { type: e.type, date: e.date, amount: e.amount };
      Object.assign(e, { seed: +v.seed, date: v.date || null, type: v.type, note: v.note || undefined });
      if (v.type === 'w') e.amount = +v.amount || 0; else delete e.amount;
      if (v.type === 'w' && e.amount) {
        // 총 시드 출금과 연결: 기존 짝이 있으면 같이 수정, 없으면 새로 만든다
        const link = old.type === 'w' && db.flows.find((x) => x.type === 'out' && x.date === old.date && x.usd === old.amount);
        if (link) Object.assign(link, { date: e.date || link.date, usd: e.amount, coin: c.sym });
        else db.flows.push({ id: nid(), date: e.date || today(), type: 'out', usd: e.amount, note: v.note || '', coin: c.sym, est: false });
      }
      if (!id) c.events.push(e);
      formOpen['ev' + c.sym] = false;
    }
    if (kind === 'snap') {
      const r = id ? db.snapshots.find((x) => x.id === id) : { id: nid() };
      Object.assign(r, { date: v.date, balance: +v.balance, np: !!v.np, note: v.note || '' });
      if (!id) db.snapshots.push(r);
      formOpen.snap = false;
    }
    if (kind === 'flow') {
      const r = id ? db.flows.find((x) => x.id === id) : { id: nid() };
      const old = { date: r.date, usd: r.usd, coin: r.coin };
      Object.assign(r, { date: v.date, type: v.type, usd: +v.usd, note: v.note || '', coin: v.coin || '', est: !!v.est });
      if (id && old.coin && old.coin === r.coin) {
        // 코인 쪽 출금 기록도 같은 날짜/금액으로 맞춘다
        const ce = findCoin(old.coin).events.find((x) => x.type === 'w' && x.date === old.date && x.amount === old.usd);
        if (ce) Object.assign(ce, { date: r.date, amount: r.usd });
      }
      if (!id) db.flows.push(r);
      formOpen.flow = false;
    }
    if (kind === 'log') {
      const r = id ? db.log.find((x) => x.id === id) : { id: nid() };
      Object.assign(r, { date: v.date, text: v.text });
      if (!id) db.log.push(r);
      formOpen.log = false;
    }
    commit();
  });

  document.addEventListener('change', (ev) => {
    if (ev.target.id !== 'imp') return;
    const file = ev.target.files[0];
    if (!file) return;
    file.text().then((txt) => {
      try {
        const j = JSON.parse(txt);
        if (!j.coins || !j.snapshots || !j.flows) throw new Error('형식 오류');
        j.log = j.log || [];
        if (db.snapshots.length && !confirm('현재 기록을 가져온 데이터로 바꿉니다. 계속할까요?')) return;
        db = j; commit(); alert('가져오기 완료');
      } catch (e) { alert('가져오기 실패: ' + e.message); }
    });
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
})();

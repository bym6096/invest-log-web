(function () {
  const KEY = 'invest.v1';
  const APP_VERSION = 'v10';
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
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) { /* 저장소 접근 불가 시 기본 데이터 */ }
    return JSON.parse(JSON.stringify(EMPTY));
  }
  // 스냅샷의 after: 그날 입출금이 이미 반영된 잔고인지 (옛 데이터는 메모 끝이 '후'면 반영된 것으로 본다)
  function normalize(d) {
    d.snapshots.forEach((r) => { if (r.after === undefined) r.after = /후$/.test(r.note || ''); });
    return d;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ }
  }

  // ---------- 유틸 ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (n, d = 0) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const usd = (n) => '$' + num(n);
  const signed = (n, d = 0) => (n > 0 ? '+' : n < 0 ? '−' : '') + num(Math.abs(n), d);
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
    let prev = null, pnl = 0, wd = 0, fund = 0, fee = 0;
    const rows = coin.events.map((e) => {
      let delta = null;
      if (prev !== null && (e.type === 't' || e.type === 'w')) {
        delta = e.seed - prev + (e.type === 'w' ? e.amount || 0 : 0);
        pnl += delta;
      } else if (prev !== null) {
        delta = e.seed - prev;
      }
      if (e.type === 'w') wd += e.amount || 0;
      fund += e.funding || 0; fee += e.fee || 0;
      const row = { ...e, delta, pnlEvent: e.type === 't' || e.type === 'w' };
      prev = e.seed;
      return row;
    });
    return { rows, pnl, wd, fund, fee };
  }

  // base ~ last 사이에 발생한 입출금만 반영한다. 같은 날짜는 잔고가 입출금 전/후 중 어느 쪽인지(after)로 판단.
  function profitBetween(base, last) {
    const afterBase = (f) => f.date > base.date || (f.date === base.date && !base.after);
    const beforeLast = (f) => f.date < last.date || (f.date === last.date && last.after);
    const flows = db.flows.filter((f) => afterBase(f) && beforeLast(f));
    const dep = flows.filter((f) => f.type === 'in').reduce((a, f) => a + (f.usd || 0), 0);
    const wd = flows.filter((f) => f.type === 'out').reduce((a, f) => a + (f.usd || 0), 0);
    const profit = last.balance - base.balance - dep + wd;
    return { dep, wd, profit, invested: base.balance + dep };
  }

  // 기준 시점부터, 입출금이 없었다고 가정한 시드 (입금은 빼고 출금은 더함)
  function adjustedSeries(base) {
    const list = snaps();
    const i = list.indexOf(base);
    return list.slice(i < 0 ? 0 : i).map((r) => ({ date: r.date, actual: r.balance, adj: base.balance + profitBetween(base, r).profit }));
  }

  function baseSnap(list, last) {
    const b = list.find((x) => x.id === db.baseline);
    return b && b.date <= last.date ? b : list[0];
  }

  function summary() {
    const s = snaps();
    const last = s[s.length - 1];
    const base = baseSnap(s, last);
    const coinSum = db.coins.reduce((a, c) => a + curSeed(c), 0);
    const cur = profitBetween(base, last);
    const all = profitBetween(s[0], last);
    const diff = coinSum - last.balance;
    const coinWd = db.coins.reduce((a, c) => a + coinStats(c).wd, 0);
    const totalWd = db.flows.filter((f) => f.type === 'out').reduce((a, f) => a + (f.usd || 0), 0);
    const hasEst = db.flows.some((f) => f.est);
    return { first: s[0], base, last, coinSum, cur, all, diff, coinWd, totalWd, hasEst };
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
    if (series.every((x) => x.pts.length < 2)) return '<p class="hint">기준 시점 이후 기록이 더 쌓이면 그래프가 표시돼요.</p>';
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


  // ---------- 텍스트 붙여넣기 입력 (바이낸스 선물 Position History) ----------
  // 갤러리의 글자 추출 등으로 복사한 텍스트를 읽는다. 글자 순서가 달라도 되도록 라벨 위치가 아니라 값의 종류로 판별한다.
  const NUM = /^[+-]?\d[\d,]*(?:\.\d+)?$/;
  const DT = /\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?/g;
  const toNum = (w) => parseFloat(String(w).replace(/,/g, ''));

  function parseBinanceText(raw) {
    const text = String(raw).replace(/[−–—]/g, '-').replace(/ /g, ' ');
    // 1) 손익 상세 팝업: "Realized PNL" 뒤에 "(USDT)" 라벨이 오지 않는 첫 지점부터. 값 순서는 실현/청산손익/펀딩비/거래수수료/보험청산수수료
    let body = text, bd = null;
    const bi = text.search(/Realized\s+PNL(?!\s*\()/i);
    if (bi >= 0) {
      const vals = [...text.slice(bi).matchAll(/([+-]?\d[\d,]*(?:\.\d+)?)\s*USDT/gi)].map((m) => toNum(m[1]));
      if (vals.length >= 4) {
        bd = { realized: vals[0], closing: vals[1], funding: vals[2], fee: vals[3], ins: vals[4] || 0, used: false };
        body = text.slice(0, bi);
      }
    }
    // 2) 포지션 카드: 심볼(SUIUSDT) 단위로 자르고, 카드 안에서 값을 찾는다
    const syms = [...body.matchAll(/\b([A-Z0-9]{2,15})(USDT|USDC|BUSD)\b/g)];
    const items = syms.map((m, i) => {
      const chunk = body.slice(m.index + m[0].length, i + 1 < syms.length ? syms[i + 1].index : body.length);
      const dts = chunk.match(DT) || [];
      const words = chunk.replace(DT, ' ').split(/\s+/).filter(Boolean);
      const first = words.find((w) => NUM.test(w) || w === '--'); // 카드에서 가장 먼저 나오는 숫자가 실현 손익
      const coin = m[1].replace(/^1000+/, '');
      const it = { coin, amount: null, date: '', funding: null, fee: null, note: '', source: `${m[0]} ${first || ''}`.trim() };
      if (!first || first === '--') { it.note = '실현 손익을 읽지 못했어요 (2026년 이전 포지션은 "--"로 표시돼요)'; return it; }
      it.amount = toNum(first);
      if (!words.some((w) => /%$/.test(w))) it.note = 'ROI를 찾지 못했어요. 손익 값을 꼭 확인하세요';
      if (dts.length >= 2) it.date = dts.slice().sort().pop().slice(0, 10); // 종료 시각은 시작 시각보다 늦다
      else it.note = (it.note ? it.note + ' / ' : '') + '종료 날짜를 못 찾았어요';
      return it;
    });
    // 3) 상세 팝업의 펀딩비·수수료를 실현 손익이 같은 카드에 붙인다
    if (bd) {
      const hit = items.find((it) => it.amount !== null && Math.abs(it.amount - bd.realized) < 0.011);
      const target = hit || { coin: '', amount: bd.realized, date: '', funding: null, fee: null, note: '손익 상세만 있어요. 코인과 날짜를 직접 고르세요', source: 'Realized PNL 상세' };
      target.funding = bd.funding; target.fee = bd.fee; target.matched = !!hit;
      if (Math.abs(bd.closing + bd.funding + bd.fee + bd.ins - bd.realized) > 0.05) target.note = (target.note ? target.note + ' / ' : '') + '상세 항목 합계가 실현 손익과 달라요';
      if (!hit) items.push(target);
    }
    return items;
  }

  let shot = null; // { error, items }
  let pasteDraft = '';
  const dateKey = (it) => it.date || today();
  const sortShot = () => { shot.items.sort((a, b) => (dateKey(a) < dateKey(b) ? -1 : dateKey(a) > dateKey(b) ? 1 : 0)); };
  const round2 = (x) => Math.round(x * 100) / 100;

  function runPaste(text) {
    const items = parseBinanceText(text).filter((x) => x.amount !== null || x.note);
    if (!items.length) {
      shot = { error: '읽을 수 있는 기록을 찾지 못했어요. SUIUSDT 같은 코인 이름과 Realized PNL이 들어 있는 텍스트인지 확인하세요.', items: null };
      return render();
    }
    // 손익 상세 팝업과 짝이 맞는 카드가 있으면 그것만 기본 선택 (같이 찍힌 다른 카드는 해제)
    const focus = items.some((x) => x.matched);
    shot = {
      error: '',
      items: items.map((x) => {
        const coin = findCoin(x.coin.toUpperCase()) ? x.coin.toUpperCase() : '';
        const bad = x.amount === null;
        let note = x.note;
        if (focus && !x.matched) note = (note ? note + ' / ' : '') + '손익 상세 팝업과 다른 카드예요. 필요하면 체크하세요';
        // 날짜를 못 읽은 카드는 화면이 잘린 경우가 많아 기본 해제
        const on = !bad && !!coin && !!x.date && (!focus || !!x.matched);
        return { on, coin, amount: bad ? 0 : x.amount, date: x.date, funding: x.funding, fee: x.fee, note, source: x.source };
      }),
    };
    sortShot();
    markDup();
    render();
  }

  // 같은 코인·날짜·손익의 거래 기록이 이미 있으면 중복으로 보고 기본 해제
  function isDup(it) {
    const c = findCoin(it.coin);
    if (!c || !it.date) return false;
    return coinStats(c).rows.some((r) => r.pnlEvent && r.date === it.date && r.delta !== null && Math.abs(r.delta - it.amount) < 0.005);
  }
  function markDup() { shot.items.forEach((it) => { if (isDup(it)) it.on = false; }); }

  // 선택된 거래를 날짜순으로 이어 붙였을 때 코인별 시드 변화
  function planShot(items) {
    const run = {};
    return items.map((it) => {
      if (!it.on) return null;
      const c = findCoin(it.coin);
      if (!c) return null;
      const before = run[c.sym] !== undefined ? run[c.sym] : (seedAt(c, dateKey(it)) || 0);
      const after = round2(before + (+it.amount || 0));
      run[c.sym] = after;
      return { before, after };
    });
  }

  function insertEvent(c, ev) {
    let idx = 0;
    for (let k = c.events.length - 1; k >= 0; k--) {
      const d = c.events[k].date;
      if (!d || d <= ev.date) { idx = k + 1; break; }
    }
    c.events.splice(idx, 0, ev);
  }

  function saveShot() {
    sortShot();
    const plans = planShot(shot.items);
    let n = 0;
    shot.items.forEach((it, i) => {
      if (!it.on || !plans[i]) return;
      const ev = { id: nid(), seed: plans[i].after, date: dateKey(it), type: 't', note: it.note && /^(상세|ROI|종료)/.test(it.note) ? undefined : (it.note || undefined) };
      if (it.funding !== null && it.funding !== undefined && it.funding !== '') ev.funding = +it.funding;
      if (it.fee !== null && it.fee !== undefined && it.fee !== '') ev.fee = +it.fee;
      insertEvent(findCoin(it.coin), ev);
      n++;
    });
    shot = null; pasteDraft = '';
    commit();
    alert(`${n}건 저장했어요.`);
  }

  const optNum = (x) => (x === null || x === undefined ? '' : x);

  function shotCard() {
    const head = '<h2>📋 텍스트로 입력 (바이낸스)</h2>';
    if (shot && shot.items) {
      const plans = planShot(shot.items);
      const rows = shot.items.map((it, i) => {
        const pv = plans[i];
        return `<div class="shotrow${it.on ? '' : ' off'}">
          <div class="grid2"><label class="chk"><input type="checkbox" data-sf="on" data-i="${i}"${it.on ? ' checked' : ''}> 저장</label>
          <label><select data-sf="coin" data-i="${i}"><option value="">코인 선택</option>${db.coins.map((c) => `<option${c.sym === it.coin ? ' selected' : ''}>${esc(c.sym)}</option>`).join('')}</select></label></div>
          <div class="grid2">
            <label>실현 손익($)<input type="number" step="any" data-sf="amount" data-i="${i}" value="${it.amount}" inputmode="decimal"></label>
            <label>날짜<input type="date" data-sf="date" data-i="${i}" value="${val(it.date)}"></label>
            <label>펀딩비($)<input type="number" step="any" data-sf="funding" data-i="${i}" value="${optNum(it.funding)}" inputmode="decimal"></label>
            <label>거래수수료($)<input type="number" step="any" data-sf="fee" data-i="${i}" value="${optNum(it.fee)}" inputmode="decimal"></label>
          </div>
          ${pv ? `<div class="hint">${esc(it.coin)} 시드 ${num(pv.before)} → <b>${num(pv.after)}</b></div>` : ''}
          ${isDup(it) ? '<div class="hint warn">⚠ 같은 날짜·손익의 기록이 이미 있어요 (중복이면 저장하지 마세요)</div>' : ''}
          ${!it.coin ? '<div class="hint warn">⚠ 코인을 선택해야 저장할 수 있어요</div>' : ''}
          ${!it.date ? '<div class="hint warn">날짜가 비어 있어요. 비워두면 오늘 날짜로 저장돼요.</div>' : ''}
          ${it.note ? `<div class="hint warn">${esc(it.note)}</div>` : ''}
          <div class="hint">읽은 내용: ${esc(it.source)}</div></div>`;
      }).join('');
      const okCount = shot.items.filter((it) => it.on && it.coin).length;
      return `<section class="card">${head}<p class="hint">읽은 결과예요. <b>숫자를 꼭 확인</b>하고 저장하세요.</p>${rows}
        <button class="btn" data-act="shotsave"${okCount ? '' : ' disabled'}>${okCount}건 저장</button>
        <button class="btn alt" data-act="shotcancel">닫기</button></section>`;
    }
    return `<section class="card">${head}
      ${shot && shot.error ? `<p class="hint warn">⚠ ${esc(shot.error)}</p>` : ''}
      <p class="hint">① 바이낸스 Position History 스크린샷 (손익 상세 팝업을 열어 찍으면 펀딩비·수수료까지) → ② 갤러리에서 열어 글자 추출(T 아이콘)로 복사 → ③ 아래에 붙여넣기</p>
      <textarea id="pastebox" rows="5" placeholder="여기에 붙여넣기">${esc(pasteDraft)}</textarea>
      <button class="btn" data-act="parse">읽기</button></section>`;
  }

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
      <label class="basepick">기준 시점<select id="base">${[...snaps()].reverse().filter((r) => r.date <= s.last.date).map((r) =>
        `<option value="${r.id}"${r.id === s.base.id ? ' selected' : ''}>${short(r.date)} · ${num(r.balance, 2).replace(/\.00$/, '')}${r.after ? ' (입출금 후)' : ''}</option>`).join('')}</select></label>
      <div class="row2">
        <div><div class="label">입출금 제외 손익</div><div class="v ${cls(s.cur.profit)}">${signed(s.cur.profit)}$</div></div>
        <div><div class="label">수익률(기준 시드+입금)</div><div class="v ${cls(s.cur.profit)}">${num((s.cur.profit / s.cur.invested) * 100, 1)}%</div></div>
      </div>
      <p class="hint">${short(s.base.date)} 이후 입금 ${usd(s.cur.dep)} · 출금 ${usd(s.cur.wd)} 반영.
      전체 기간(${short(s.first.date)}~) 누적은 <span class="${cls(s.all.profit)}">${signed(s.all.profit)}$</span></p>
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
        <div><div class="label">누적 입금</div><div class="v">${usd(s.all.dep)}</div></div>
        <div><div class="label">누적 출금</div><div class="v">${usd(s.totalWd)}</div></div>
        <div><div class="label">코인 시드에서<br>출금 표기</div><div class="v">${usd(s.coinWd)}</div></div>
      </div>
      ${s.hasEst ? '<p class="hint">※ 추정 입금액이 포함돼 있어요 (기록 탭에서 확인).</p>' : ''}
    </section>

    ${(() => {
      const f = db.coins.reduce((a, c) => { const t = coinStats(c); return { fund: a.fund + t.fund, fee: a.fee + t.fee }; }, { fund: 0, fee: 0 });
      return f.fund || f.fee ? `<section class="card"><h2>펀딩비 · 수수료 <small class="muted">(기록된 거래 합계)</small></h2><div class="row3"><div><div class="label">펀딩비</div><div class="v ${cls(f.fund)}">${signed(f.fund, 2)}$</div></div><div><div class="label">거래수수료</div><div class="v ${cls(f.fee)}">${signed(f.fee, 2)}$</div></div><div><div class="label">합계</div><div class="v ${cls(f.fund + f.fee)}">${signed(f.fund + f.fee, 2)}$</div></div></div><p class="hint">실현 손익에는 이미 포함된 값이에요. 참고용으로만 보여줘요.</p></section>` : '';
    })()}
    <section class="card">
      <h2>총 시드 추이 <small class="muted">(입출금 미반영)</small></h2>
      ${lineChart([{ name: '바이낸스 USD', color: 'var(--c1)', pts: snaps().map((r) => [T(r.date), r.balance]) }])}
    </section>
    ${(() => {
      const ser = adjustedSeries(s.base);
      const end = ser[ser.length - 1];
      return `<section class="card">
      <h2>입출금 반영 시드 추이 <small class="muted">(${short(s.base.date)} 기준~)</small></h2>
      <div class="row2">
        <div><div class="label">실제 총 시드</div><div class="v">${usd(end.actual)}</div></div>
        <div><div class="label">입출금 반영 시드</div><div class="v ${cls(end.adj - s.base.balance)}">${usd(end.adj)}</div></div>
      </div>
      ${lineChart([
        { name: '실제 총 시드', color: 'var(--c1)', pts: ser.map((r) => [T(r.date), r.actual]) },
        { name: '입출금 반영', color: 'var(--c2)', pts: ser.map((r) => [T(r.date), r.adj]) },
      ])}
      <p class="hint">입출금 반영 시드는 입금은 빼고 출금은 더해서, 입출금이 없었다고 가정한 시드예요. 두 선의 간격이 누적 출금(−입금)이고, 기준 시드 ${usd(s.base.balance)} 대비 변화가 입출금 제외 손익이에요. 기준 시점은 맨 위에서 바꿀 수 있어요.</p></section>`;
    })()}`;
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
        <label>펀딩비($, 지출은 −)<input type="number" step="any" name="funding" value="${e ? val(e.funding) : ''}" inputmode="decimal"></label>
        <label>거래수수료($, 지출은 −)<input type="number" step="any" name="fee" value="${e ? val(e.fee) : ''}" inputmode="decimal"></label>
      </div>
      <label>메모<input name="note" value="${e ? val(e.note) : ''}"></label>
      <button class="btn">저장</button>${cancelBtn(e)}</form>`;
  }

  function snapForm(r) {
    return `<form class="form" data-form="snap"${r ? ` data-id="${r.id}"` : ''}><div class="grid2">
      <label>날짜<input type="date" name="date" value="${r ? r.date : today()}" required></label>
      <label>바이낸스 시드($, 미실현 제외)<input type="number" step="any" name="balance" value="${r ? r.balance : ''}" required inputmode="decimal"></label></div>
      <label class="chk"><input type="checkbox" name="np"${!r || r.np ? ' checked' : ''}> 포지션 없음(np)</label>
      <label class="chk"><input type="checkbox" name="after"${r && r.after ? ' checked' : ''}> 이 날짜의 입출금이 이미 반영된 잔고</label>
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
    return shotCard() + db.coins.map((c) => {
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
        ${st.fund || st.fee ? `<div class="row3 mini"><div><div class="label">펀딩비 합</div><div class="${cls(st.fund)}">${signed(st.fund, 2)}</div></div><div><div class="label">거래수수료 합</div><div class="${cls(st.fee)}">${signed(st.fee, 2)}</div></div><div></div></div>` : ''}
        ${isOpen ? `
          <button class="link" data-act="addev" data-coin="${esc(c.sym)}">${formOpen['ev' + c.sym] ? '닫기' : '+ 기록 추가'}</button>
          <button class="link" data-act="lev" data-coin="${esc(c.sym)}">레버리지 변경</button>
          ${formOpen['ev' + c.sym] ? coinForm(c) : ''}
          <ul class="list">${[...st.rows].reverse().map((e) => isEd('ev', e.id) ? `<li class="editli">${coinForm(c, e)}</li>` : `
            <li><span class="d">${short(e.date)}</span>
            <span class="badge b-${e.type}">${TYPE_LABEL[e.type]}</span>
            <span class="grow">${num(e.seed)}${e.type === 'w' ? ` <small class="muted">(−${num(e.amount || 0)} 출금)</small>` : ''}${e.note ? ` <small class="muted">${esc(e.note)}</small>` : ''}${e.funding || e.fee ? `<br><small class="muted">${e.funding ? `펀딩 ${signed(e.funding, 2)}` : ''}${e.funding && e.fee ? ' · ' : ''}${e.fee ? `수수료 ${signed(e.fee, 2)}` : ''}</small>` : ''}</span>
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
      <ul class="list">${sn.map((r) => isEd('snap', r.id) ? `<li class="editli">${snapForm(r)}</li>` : `<li><span class="d">${short(r.date)}</span><span class="grow">${num(r.balance, 2).replace(/\.00$/, '')}${r.np ? ' <span class="chip">np</span>' : ''}${r.after ? ' <span class="chip">입출금 후</span>' : ''}${r.note ? ` <small class="muted">${esc(r.note)}</small>` : ''}</span>${editBtn('snap', r.id)}<button class="x" data-del="snap" data-id="${r.id}" aria-label="삭제">×</button></li>`).join('')}</ul>
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
    return `<section class="card"><h2>앱 정보</h2>
      <p class="hint">실행 중인 버전: <b>${APP_VERSION}</b></p>
      <button class="btn alt" data-act="hardrefresh">최신 버전으로 새로고침</button>
      <p class="hint">화면이 옛날 그대로면 눌러보세요. 앱 파일 캐시만 지우고, 입력한 기록은 지워지지 않아요.</p></section>
      <section class="card"><h2>백업 · 복원</h2>
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
      if (d.act === 'shotcancel') { shot = null; pasteDraft = ''; render(); }
      if (d.act === 'shotsave') saveShot();
      if (d.act === 'hardrefresh') {
        (async () => {
          try {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((r) => r.unregister()));
            await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
          } catch (e) { /* 지원하지 않으면 새로고침만 */ }
          location.href = location.pathname + '?r=' + Date.now();
        })();
      }
      if (d.act === 'parse') runPaste($('#pastebox').value);
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
      for (const k of ['funding', 'fee']) { if (v[k] === '' || v[k] === undefined) delete e[k]; else e[k] = +v[k]; }
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
      Object.assign(r, { date: v.date, balance: +v.balance, np: !!v.np, after: !!v.after, note: v.note || '' });
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
    const sf = ev.target.dataset.sf;
    if (sf && shot && shot.items) {
      const it = shot.items[+ev.target.dataset.i];
      const t = ev.target;
      if (sf === 'on') it.on = t.checked;
      else if (sf === 'amount') it.amount = parseFloat(t.value) || 0;
      else if (sf === 'funding' || sf === 'fee') it[sf] = t.value === '' ? null : parseFloat(t.value);
      else it[sf] = t.value;
      if (sf === 'coin') it.on = !!it.coin;
      sortShot();
      render();
      return;
    }
    if (ev.target.id === 'base') { db.baseline = ev.target.value; commit(); return; }
    if (ev.target.id !== 'imp') return;
    const file = ev.target.files[0];
    if (!file) return;
    file.text().then((txt) => {
      try {
        const j = JSON.parse(txt);
        if (!j.coins || !j.snapshots || !j.flows) throw new Error('형식 오류');
        j.log = j.log || [];
        if (db.snapshots.length && !confirm('현재 기록을 가져온 데이터로 바꿉니다. 계속할까요?')) return;
        db = normalize(j); commit(); alert('가져오기 완료');
      } catch (e) { alert('가져오기 실패: ' + e.message); }
    });
  });

  document.addEventListener('input', (ev) => { if (ev.target.id === 'pastebox') pasteDraft = ev.target.value; });
  try { localStorage.removeItem('invest.ai'); } catch (e) { /* 이전 버전의 API 키 잔여분 삭제 */ }

  // 브라우저는 서비스워커 업데이트를 매번 확인하지 않아서, 실행할 때마다 직접 확인한다
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
  render();
})();

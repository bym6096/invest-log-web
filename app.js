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


  // ---------- 스크린샷 입력 (Claude API) ----------
  // API 키는 백업 JSON에 들어가지 않도록 데이터(db)와 분리해서 저장한다.
  const AI_KEY = 'invest.ai';
  const AI_MODELS = { 'claude-opus-5-5': 'Claude Opus 5.5 (기본, 정확)', 'claude-sonnet-5-5': 'Claude Sonnet 5.5 (더 저렴)' };
  function getAI() {
    try { return { model: 'claude-opus-5-5', ...(JSON.parse(localStorage.getItem(AI_KEY)) || {}) }; } catch (e) { return { model: 'claude-opus-5-5' }; }
  }
  function setAI(v) {
    try { localStorage.setItem(AI_KEY, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }

  const SHOT_SCHEMA = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['trade', 'balance'] },
            coin: { type: 'string' },
            amount: { type: 'number' },
            date: { type: 'string' },
            note: { type: 'string' },
            source: { type: 'string' },
          },
          required: ['kind', 'coin', 'amount', 'date', 'note', 'source'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  };

  const SHOT_SYSTEM = `You read screenshots from a crypto exchange app (mainly Binance USDⓈ-M futures) and extract records for a personal trading log.
Return one record per item:
- kind "trade": a closed / realized position result. amount = realized PnL in USD(T), signed (a loss is negative). coin = base asset ticker in uppercase (BTCUSDT -> BTC, 1000PEPEUSDT -> PEPE). date = the closing date as YYYY-MM-DD.
- kind "balance": an account / wallet total balance screen. amount = total balance in USD (exclude unrealized PnL when the screen separates it). coin = "".
Rules: ignore unrealized PnL of still-open positions. Never guess numbers you cannot read; skip unreadable records. If the date is not visible use "". If the year is missing, assume the year of today's date, unless that puts the date after today, then use the previous year. "source" = the short text/numbers you actually read for that record. "note" = "" unless something is ambiguous (write it briefly in Korean). If the screenshot has nothing relevant, return an empty items array.`;

  // 긴 변 1600px 이하 JPEG로 줄여 전송량을 줄인다 (폰 스크린샷은 수 MB)
  async function toJpegBase64(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  }

  async function callClaude(ai, content) {
    const post = (withFallback) => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ai.key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        ...(withFallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
      },
      body: JSON.stringify({
        model: ai.model,
        max_tokens: 4096,
        system: SHOT_SYSTEM,
        messages: [{ role: 'user', content }],
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: SHOT_SCHEMA } },
        ...(withFallback ? { fallbacks: 'default' } : {}),
      }),
    });
    let r = await post(true);
    if (r.status === 400) r = await post(false); // 폴백 옵션이 거부되면 옵션 없이 한 번 더
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j.error && j.error.message) || '';
      if (r.status === 401) throw new Error('API 키가 올바르지 않아요. 설정에서 다시 확인하세요.');
      if (r.status === 429) throw new Error('요청이 너무 많아요. 잠시 후 다시 시도하세요.');
      if (r.status === 402 || /credit|billing/i.test(msg)) throw new Error('API 크레딧이 부족해요. Anthropic 콘솔에서 확인하세요.');
      throw new Error(`요청 실패 (${r.status}) ${msg}`);
    }
    if (j.stop_reason === 'refusal') throw new Error('이미지를 처리할 수 없다고 응답했어요.');
    if (j.stop_reason === 'max_tokens') throw new Error('응답이 잘렸어요. 스크린샷을 나눠서 올려보세요.');
    const block = (j.content || []).find((b) => b.type === 'text');
    if (!block) throw new Error('응답에서 결과를 찾지 못했어요.');
    return JSON.parse(block.text).items || [];
  }

  let shot = null; // { busy, error, items }
  const dateKey = (it) => it.date || today();
  const sortShot = () => { shot.items.sort((a, b) => (dateKey(a) < dateKey(b) ? -1 : dateKey(a) > dateKey(b) ? 1 : 0)); };
  const round2 = (x) => Math.round(x * 100) / 100;

  async function runShot(files) {
    const ai = getAI();
    shot = { busy: true, error: '', items: null };
    render();
    try {
      const content = [];
      for (const f of files) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await toJpegBase64(f) } });
      content.push({ type: 'text', text: `Today's date: ${today()}. Coins tracked in the app: ${db.coins.map((c) => c.sym).join(', ') || '(none)'}. Extract the records from the screenshot(s).` });
      const items = await callClaude(ai, content);
      shot = {
        busy: false, error: '',
        items: items.map((x) => {
          const sym = String(x.coin || '').toUpperCase().replace(/(USDT|USDC|BUSD|USD)(PERP)?$/, '').replace(/^1000+/, '');
          const it = { on: true, kind: x.kind, coin: findCoin(sym) ? sym : '', amount: x.amount, date: /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : '', np: false, note: x.note || '', source: x.source || '' };
          if (it.kind === 'trade' && !it.coin) it.on = false; // 코인을 못 맞췄으면 직접 고르기 전엔 저장하지 않는다
          return it;
        }),
      };
      sortShot();
      markDup();
    } catch (e) {
      shot = { busy: false, error: e instanceof TypeError ? '네트워크 연결을 확인하세요. (인터넷 또는 브라우저 차단 가능성)' : e.message, items: null };
    }
    render();
  }

  // 같은 코인·날짜·손익의 거래 기록이 이미 있으면 중복으로 보고 기본 해제
  function isDup(it) {
    if (it.kind !== 'trade') return false;
    const c = findCoin(it.coin);
    if (!c || !it.date) return false;
    return coinStats(c).rows.some((r) => r.pnlEvent && r.date === it.date && r.delta !== null && Math.abs(r.delta - it.amount) < 0.005);
  }
  function markDup() { shot.items.forEach((it) => { if (isDup(it)) it.on = false; }); }

  // 선택된 거래를 날짜순으로 이어 붙였을 때 코인별 시드 변화
  function planShot(items) {
    const run = {};
    return items.map((it) => {
      if (!it.on || it.kind !== 'trade') return null;
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
      if (!it.on) return;
      if (it.kind === 'trade' && plans[i]) {
        insertEvent(findCoin(it.coin), { id: nid(), seed: plans[i].after, date: dateKey(it), type: 't', note: it.note || undefined });
        n++;
      } else if (it.kind === 'balance') {
        db.snapshots.push({ id: nid(), date: dateKey(it), balance: +it.amount, np: !!it.np, after: false, note: it.note || '' });
        n++;
      }
    });
    shot = null;
    commit();
    alert(`${n}건 저장했어요.`);
  }

  function shotCard() {
    const ai = getAI();
    const head = '<h2>📷 스크린샷으로 입력</h2>';
    if (!ai.key) return `<section class="card">${head}<p class="hint">설정 탭에서 Claude API 키를 먼저 등록하세요.</p><button class="btn" data-tab="set">설정으로 이동</button></section>`;
    if (shot && shot.busy) return `<section class="card">${head}<p class="hint">스크린샷을 읽는 중이에요… (10~30초)</p></section>`;
    if (shot && shot.items) {
      const plans = planShot(shot.items);
      const rows = shot.items.map((it, i) => {
        const dup = isDup(it);
        const pv = plans[i];
        return `<div class="shotrow${it.on ? '' : ' off'}">
          <div class="grid2"><label class="chk"><input type="checkbox" data-sf="on" data-i="${i}"${it.on ? ' checked' : ''}> 저장</label>
          <select data-sf="kind" data-i="${i}"><option value="trade"${it.kind === 'trade' ? ' selected' : ''}>코인 거래 손익</option><option value="balance"${it.kind === 'balance' ? ' selected' : ''}>총 시드</option></select></div>
          <div class="grid2">
            ${it.kind === 'trade' ? `<label>코인<select data-sf="coin" data-i="${i}"><option value="">선택</option>${db.coins.map((c) => `<option${c.sym === it.coin ? ' selected' : ''}>${esc(c.sym)}</option>`).join('')}</select></label>` : '<span></span>'}
            <label>${it.kind === 'trade' ? '실현 손익($)' : '잔고($)'}<input type="number" step="any" data-sf="amount" data-i="${i}" value="${it.amount}" inputmode="decimal"></label>
            <label>날짜<input type="date" data-sf="date" data-i="${i}" value="${val(it.date)}"></label>
            ${it.kind === 'balance' ? `<label class="chk"><input type="checkbox" data-sf="np" data-i="${i}"${it.np ? ' checked' : ''}> 포지션 없음(np)</label>` : '<span></span>'}
          </div>
          ${pv ? `<div class="hint">${esc(it.coin)} 시드 ${num(pv.before)} → <b>${num(pv.after)}</b></div>` : ''}
          ${dup ? '<div class="hint warn">⚠ 같은 날짜·손익의 기록이 이미 있어요 (중복이면 저장하지 마세요)</div>' : ''}
          ${it.kind === 'trade' && !it.coin ? '<div class="hint warn">⚠ 코인을 선택해야 저장할 수 있어요</div>' : ''}
          ${!it.date ? '<div class="hint warn">날짜를 못 읽었어요. 비워두면 오늘 날짜로 저장돼요.</div>' : ''}
          ${it.note ? `<div class="hint warn">${esc(it.note)}</div>` : ''}
          <div class="hint">읽은 내용: ${esc(it.source)}</div></div>`;
      }).join('');
      const okCount = shot.items.filter((it) => it.on && (it.kind === 'balance' || it.coin)).length;
      return `<section class="card">${head}
        ${shot.items.length ? `<p class="hint">AI가 읽은 결과예요. <b>숫자를 꼭 확인</b>하고 저장하세요.</p>${rows}
        <button class="btn" data-act="shotsave"${okCount ? '' : ' disabled'}>${okCount}건 저장</button>` : '<p class="hint">읽을 수 있는 기록을 찾지 못했어요.</p>'}
        <button class="btn alt" data-act="shotcancel">닫기</button></section>`;
    }
    return `<section class="card">${head}
      ${shot && shot.error ? `<p class="hint warn">⚠ ${esc(shot.error)}</p>` : '<p class="hint">포지션 결과 스크린샷을 올리면 코인별 손익을 읽어 시드에 반영해요. 저장 전에 확인 화면이 나와요.</p>'}
      <label class="btn">스크린샷 선택<input type="file" accept="image/*" multiple hidden id="shotfile"></label></section>`;
  }

  function aiCard() {
    const ai = getAI();
    return `<section class="card"><h2>스크린샷 입력 (Claude API)</h2>
      <form class="form" data-form="ai">
        <label>API 키<input type="password" name="key" value="${val(ai.key)}" placeholder="sk-ant-..." autocomplete="off" autocapitalize="off"></label>
        <label>모델<select name="model">${Object.entries(AI_MODELS).map(([id, l]) => `<option value="${id}"${ai.model === id ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <button class="btn">저장</button></form>
      ${ai.key ? '<button class="btn danger" data-act="aidel">API 키 삭제</button>' : ''}
      <p class="hint">키는 <b>이 폰의 브라우저에만</b> 저장되고, JSON 백업에는 포함되지 않아요. 스크린샷은 입력할 때만 Anthropic으로 전송돼요. 이 앱 전용 키를 새로 만들고 콘솔에서 월 사용 한도를 걸어두길 권해요.</p></section>`;
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
    return aiCard() + `<section class="card"><h2>백업 · 복원</h2>
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
      if (d.act === 'shotcancel') { shot = null; render(); }
      if (d.act === 'shotsave') saveShot();
      if (d.act === 'aidel' && confirm('저장된 API 키를 삭제할까요?')) { const a = getAI(); delete a.key; setAI(a); render(); }
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
    if (kind === 'ai') {
      setAI({ key: (v.key || '').trim() || undefined, model: AI_MODELS[v.model] ? v.model : 'claude-opus-5-5' });
      render(); alert('저장했어요.');
      return;
    }
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
    if (ev.target.id === 'shotfile') {
      const files = [...ev.target.files].slice(0, 5);
      if (files.length) runShot(files);
      return;
    }
    const sf = ev.target.dataset.sf;
    if (sf && shot && shot.items) {
      const it = shot.items[+ev.target.dataset.i];
      const t = ev.target;
      if (sf === 'on' || sf === 'np') it[sf] = t.checked;
      else if (sf === 'amount') it.amount = parseFloat(t.value) || 0;
      else it[sf] = t.value;
      if (sf === 'kind' && it.kind === 'trade' && !it.coin) it.on = false;
      if (sf === 'coin' && it.coin) it.on = true;
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

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
})();

/* Bir Nefest!val! — Bilet Gelir Motoru
 * Faz fiyatlı bilet satış simülatörü.
 *  - Canlı satış: satılan bilet sayısına göre aktif faz, anlık fiyat ve başabaşa ilerleme.
 *  - Senaryo simülasyonu (Monte Carlo): potansiyel alıcılar sırayla gelir; ödeme isteği o anki
 *    faz fiyatını karşılayan bilet alır, kota dolunca fiyat otomatik olarak sonraki faza geçer.
 * Model fonksiyonları DOM'a dokunmaz; Node'da require('./bilet-motoru.js') ile test edilebilir. */
(function () {
  'use strict';

  /* ================= Model ================= */

  // Varsayılan senaryo: Figma "Ana Üretim Sistemi" gelir planı ve bilet fazları.
  // Talep varsayımları örnektir; ön kayıt ve gerçek satış verisiyle güncellenmelidir.
  const DEFAULTS = {
    phases: [
      { name: 'ZERO DAY', price: 400, quota: 70 },
      { name: 'PHASE 2', price: 600, quota: 25 },
      { name: 'PHASE 3', price: 900, quota: 25 },
      { name: 'PHASE 4', price: 1250, quota: 25 },
      { name: 'PHASE 5', price: 2000, quota: 25 }
    ],
    door: { name: 'KAPI', price: 2500, quota: 50 },
    camp: { price: 450, quota: 70 },
    income: { sponsor: 225000, food: 45000, merch: 20000 },
    cost: 507500,
    cutPct: 18,
    crew: 50,
    siteCap: 300,
    safeTarget: 220,
    demand: { online: 420, doorPool: 100, spreadPct: 25, wtpMedian: 1100, doorWtp: 2600, sensitivity: 'orta', campRate: 32 },
    runs: 2000,
    seed: 2027
  };

  // Ödeme isteği log-normal dağılır; hassasiyet yükseldikçe dağılım daralır (fiyat eşiği keskinleşir).
  const SENSITIVITY = { dusuk: 0.9, orta: 0.6, yuksek: 0.35 };
  const RUN_OPTIONS = [500, 2000, 5000];

  const clone = o => JSON.parse(JSON.stringify(o));
  const pick = (o, k) => (o && typeof o === 'object' ? o[k] : undefined);
  const clampNum = (v, min, max, fb) => {
    const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb;
  };
  const clampInt = (v, min, max, fb) => Math.round(clampNum(v, min, max, fb));
  const cleanName = (v, fb) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 16) : fb);

  // Dışarıdan gelen her parametre setini (form, paylaşım bağlantısı, kayıt) güvenli sınırlara çeker.
  function sanitize(raw) {
    const d = DEFAULTS;
    const r = raw && typeof raw === 'object' ? raw : {};
    const step = (s, fb) => ({
      name: cleanName(pick(s, 'name'), fb.name),
      price: clampInt(pick(s, 'price'), 0, 100000, fb.price),
      quota: clampInt(pick(s, 'quota'), 0, 100000, fb.quota)
    });
    const sens = pick(r.demand, 'sensitivity');
    return {
      phases: d.phases.map((fb, i) => step(pick(r.phases, i), fb)),
      door: step(r.door, d.door),
      camp: {
        price: clampInt(pick(r.camp, 'price'), 0, 100000, d.camp.price),
        quota: clampInt(pick(r.camp, 'quota'), 0, 100000, d.camp.quota)
      },
      income: {
        sponsor: clampInt(pick(r.income, 'sponsor'), 0, 1e9, d.income.sponsor),
        food: clampInt(pick(r.income, 'food'), 0, 1e9, d.income.food),
        merch: clampInt(pick(r.income, 'merch'), 0, 1e9, d.income.merch)
      },
      cost: clampInt(r.cost, 0, 1e9, d.cost),
      cutPct: clampNum(r.cutPct, 0, 90, d.cutPct),
      crew: clampInt(r.crew, 0, 100000, d.crew),
      siteCap: clampInt(r.siteCap, 0, 1000000, d.siteCap),
      safeTarget: clampInt(r.safeTarget, 0, 1000000, d.safeTarget),
      demand: {
        online: clampInt(pick(r.demand, 'online'), 0, 5000, d.demand.online),
        doorPool: clampInt(pick(r.demand, 'doorPool'), 0, 5000, d.demand.doorPool),
        spreadPct: clampNum(pick(r.demand, 'spreadPct'), 0, 100, d.demand.spreadPct),
        wtpMedian: clampInt(pick(r.demand, 'wtpMedian'), 1, 100000, d.demand.wtpMedian),
        doorWtp: clampInt(pick(r.demand, 'doorWtp'), 1, 100000, d.demand.doorWtp),
        sensitivity: Object.prototype.hasOwnProperty.call(SENSITIVITY, sens) ? sens : d.demand.sensitivity,
        campRate: clampNum(pick(r.demand, 'campRate'), 0, 100, d.demand.campRate)
      },
      runs: RUN_OPTIONS.includes(Number(r.runs)) ? Number(r.runs) : d.runs,
      seed: clampInt(r.seed, 1, 2147483646, d.seed)
    };
  }

  // Online fazlar + kapı tek bir fiyat merdiveni olarak satılır.
  function ladder(p) {
    return p.phases.map(s => ({ name: s.name, price: s.price, quota: s.quota, door: false }))
      .concat({ name: p.door.name, price: p.door.price, quota: p.door.quota, door: true });
  }
  const seatCap = p => Math.max(0, p.siteCap - p.crew);
  const extraIncome = p => p.income.sponsor + p.income.food + p.income.merch;
  const keepRate = p => 1 - p.cutPct / 100;
  const sellable = p => Math.min(ladder(p).reduce((a, s) => a + s.quota, 0), seatCap(p));

  // Plan: tüm kotalar dolarsa (Figma gelir planı + başabaş hesabıyla aynı yöntem).
  function plan(p) {
    const cap = seatCap(p);
    let left = cap;
    const rows = ladder(p).map(s => {
      const sold = Math.max(0, Math.min(s.quota, left));
      left -= sold;
      return { name: s.name, door: s.door, price: s.price, quota: s.quota, sold, gross: sold * s.price };
    });
    const paid = rows.reduce((a, r) => a + r.sold, 0);
    const ticketGross = rows.reduce((a, r) => a + r.gross, 0);
    const campSold = Math.min(p.camp.quota, paid);
    const campGross = campSold * p.camp.price;
    const gross = ticketGross + campGross;
    const net = gross * keepRate(p);
    const nonTicket = extraIncome(p);
    const gap = p.cost - nonTicket;
    const avgNet = paid > 0 ? net / paid : 0;
    const need = g => (g <= 0 ? 0 : avgNet > 0 ? Math.ceil(g / avgNet) : Infinity);
    return {
      rows, paid, cap, ticketGross, campSold, campGross, gross, net, nonTicket, gap, avgNet,
      quotaTotal: rows.reduce((a, r) => a + r.quota, 0),
      breakEven: need(gap),
      result: net + nonTicket - p.cost,
      grossResult: gross + nonTicket - p.cost,
      onsite: paid + p.crew,
      stress: [150000, 175000].map(s => ({ sponsor: s, need: need(p.cost - (s + p.income.food + p.income.merch)) }))
    };
  }

  // Canlı satış durumu: n bilet satıldığında aktif faz, anlık fiyat, eşik ve para durumu.
  function live(p, n) {
    const steps = ladder(p);
    const cap = sellable(p);
    const sold = Math.max(0, Math.min(cap, Math.round(Number(n)) || 0));
    let cum = 0, ticketGross = 0, active = -1, start = 0, end = 0;
    steps.forEach((s, i) => {
      ticketGross += Math.max(0, Math.min(s.quota, sold - cum)) * s.price;
      if (active < 0 && s.quota > 0 && sold < cap && sold < cum + s.quota) {
        active = i; start = cum; end = Math.min(cum + s.quota, cap);
      }
      cum += s.quota;
    });
    let next = -1;
    if (active >= 0 && end < cap) {
      for (let j = active + 1; j < steps.length; j++) if (steps[j].quota > 0) { next = j; break; }
    }
    const pl = plan(p);
    const campShare = pl.paid > 0 ? pl.campSold / pl.paid : 0;
    const campGross = Math.min(p.camp.quota, Math.round(sold * campShare)) * p.camp.price;
    const net = (ticketGross + campGross) * keepRate(p);
    const lastPriced = steps.filter(s => s.quota > 0).pop();
    return {
      steps, cap, sold, active, start, end,
      activeStep: active >= 0 ? steps[active] : null,
      next, nextStep: next >= 0 ? steps[next] : null,
      remaining: active >= 0 ? end - sold : 0,
      price: active >= 0 ? steps[active].price : (lastPriced ? lastPriced.price : 0),
      ticketGross, campGross, net,
      result: net + extraIncome(p) - p.cost,
      progress: p.cost > 0 ? (net + extraIncome(p)) / p.cost : 1,
      soldOut: sold >= cap
    };
  }

  // Satış sırasıyla ilerlerken net sonucun sıfırı geçtiği bilet numarası (yoksa null).
  function breakEvenSold(p) {
    const extra = extraIncome(p);
    if (extra >= p.cost) return 0;
    const pl = plan(p), keep = keepRate(p);
    const campShare = pl.paid > 0 ? pl.campSold / pl.paid : 0;
    let n = 0, gross = 0;
    for (const s of ladder(p)) {
      for (let k = 0; k < s.quota && n < pl.cap; k++) {
        n++; gross += s.price;
        const camp = Math.min(p.camp.quota, Math.round(n * campShare)) * p.camp.price;
        if ((gross + camp) * keep + extra >= p.cost) return n;
      }
    }
    return null;
  }

  // Tohumlu RNG: aynı tohum aynı sonucu verir; öneri karşılaştırmaları aynı rastgele sayılarla yapılır.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function runSeed(seed, r) {
    let h = (seed ^ Math.imul(r + 1, 0x9E3779B1)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }
  function gauss(rng) {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  }

  function simulate(p, runs, seed) {
    const steps = ladder(p);
    const nOn = p.phases.length, d = nOn;
    const cap = seatCap(p);
    const sigma = SENSITIVITY[p.demand.sensitivity] || SENSITIVITY.orta;
    const med = Math.max(1, p.demand.wtpMedian);
    const medDoor = Math.max(1, p.demand.doorWtp);
    const spread = p.demand.spreadPct / 100;
    const campRate = p.demand.campRate / 100;
    const keep = keepRate(p), extra = extraIncome(p);
    const results = new Float64Array(runs), paidArr = new Float64Array(runs);
    const soldSum = new Float64Array(steps.length), soldOut = new Float64Array(steps.length), grossSum = new Float64Array(steps.length);
    let campSum = 0, grossAll = 0, ok = 0;

    for (let r = 0; r < runs; r++) {
      const rng = mulberry32(runSeed(seed, r));
      const rngDoor = mulberry32(runSeed(seed ^ 0x5BD1E995, r));
      const shock = Math.max(0, 1 + spread * gauss(rng)); // festival geneli talep şoku
      const nOnline = Math.round(p.demand.online * shock);
      const nDoor = Math.round(p.demand.doorPool * Math.max(0, shock * (1 + 0.5 * spread * gauss(rngDoor))));
      const sold = new Array(steps.length).fill(0);
      let i = 0, total = 0;
      while (i < nOn && steps[i].quota <= 0) i++;
      for (let k = 0; k < nOnline && i < nOn && total < cap; k++) {
        if (med * Math.exp(sigma * gauss(rng)) >= steps[i].price) {
          sold[i]++; total++;
          if (sold[i] >= steps[i].quota) { i++; while (i < nOn && steps[i].quota <= 0) i++; }
        }
      }
      for (let k = 0; k < nDoor && sold[d] < steps[d].quota && total < cap; k++) {
        if (medDoor * Math.exp(sigma * gauss(rngDoor)) >= steps[d].price) { sold[d]++; total++; }
      }
      let camp = 0;
      for (let k = 0; k < total && camp < p.camp.quota; k++) if (rngDoor() < campRate) camp++;

      let gross = camp * p.camp.price;
      for (let s = 0; s < steps.length; s++) {
        const g = sold[s] * steps[s].price;
        gross += g; soldSum[s] += sold[s]; grossSum[s] += g;
        if (steps[s].quota > 0 && sold[s] >= steps[s].quota) soldOut[s]++;
      }
      campSum += camp; grossAll += gross;
      const res = gross * keep + extra - p.cost;
      results[r] = res; paidArr[r] = total;
      if (res >= 0) ok++;
    }

    const sorted = Float64Array.from(results).sort();
    const paidSorted = Float64Array.from(paidArr).sort();
    const q = (arr, f) => arr[Math.min(runs - 1, Math.max(0, Math.round(f * (runs - 1))))];
    let paidSum = 0; for (const v of paidArr) paidSum += v;
    return {
      runs, seed, ok,
      pBreakEven: ok / runs,
      p10: q(sorted, 0.1), p50: q(sorted, 0.5), p90: q(sorted, 0.9),
      paidP10: q(paidSorted, 0.1), paidP50: q(paidSorted, 0.5), paidP90: q(paidSorted, 0.9),
      paidMean: paidSum / runs, grossMean: grossAll / runs, campAvg: campSum / runs,
      steps: steps.map((s, k) => ({
        name: s.name, door: s.door, price: s.price, quota: s.quota,
        avgSold: soldSum[k] / runs,
        pSoldOut: s.quota > 0 ? soldOut[k] / runs : null,
        avgGross: grossSum[k] / runs
      })),
      results: sorted
    };
  }

  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const e = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
  }

  // Kutu kenarları adımın katlarına hizalanır; böylece 0 her zaman bir kenardır (açık/fazla ayrımı net).
  function histogram(sorted, target) {
    const lo = sorted[0], hi = sorted[sorted.length - 1];
    const step = niceStep((hi - lo) / (target || 22) || Math.max(1000, Math.abs(hi) / 10));
    const start = Math.floor(lo / step) * step;
    const nb = Math.max(1, Math.floor((hi - start) / step) + 1);
    const counts = new Array(nb).fill(0);
    for (const v of sorted) counts[Math.min(nb - 1, Math.floor((v - start) / step))]++;
    return { start, step, bins: counts.map((c, i) => ({ x0: start + i * step, x1: start + (i + 1) * step, count: c })) };
  }

  const round50 = v => Math.max(0, Math.round(v / 50) * 50);

  // "Daha iyi senaryo" için denenen tek adımlık kaldıraçlar.
  const LEVERS = [
    { id: 'phase-up', kind: 'Fiyat', label: () => 'Online faz fiyatlarını %10 artır', apply: p => p.phases.forEach(s => { s.price = round50(s.price * 1.1); }) },
    { id: 'phase-down', kind: 'Fiyat', label: () => 'Online faz fiyatlarını %10 düşür', apply: p => p.phases.forEach(s => { s.price = round50(s.price * 0.9); }) },
    { id: 'door-down', kind: 'Fiyat', label: p => `${p.door.name} fiyatını %20 düşür`, apply: p => { p.door.price = round50(p.door.price * 0.8); } },
    { id: 'camp-up', kind: 'Fiyat', label: () => 'Kamp fiyatını 50 TL artır', apply: p => { p.camp.price += 50; } },
    { id: 'shift', kind: 'Kota', label: p => `${p.phases[0].name} kotasından 20 bileti ${p.phases[1].name} kotasına kaydır`, apply: p => { const m = Math.min(20, p.phases[0].quota); p.phases[0].quota -= m; p.phases[1].quota += m; } },
    { id: 'sponsor', kind: 'Gelir', label: () => 'Nakit sponsoru 25.000 TL artır', apply: p => { p.income.sponsor += 25000; } },
    { id: 'cost', kind: 'Gider', label: () => 'Baz nakit gideri %5 azalt', apply: p => { p.cost = Math.round((p.cost * 0.95) / 500) * 500; } },
    { id: 'reach', kind: 'Talep', label: () => 'Erişimi %20 artır (ön kayıt, içerik, pazarlama)', apply: p => { p.demand.online = Math.round(p.demand.online * 1.2); p.demand.doorPool = Math.round(p.demand.doorPool * 1.2); } }
  ];

  function evaluateLevers(p, runs, seed) {
    const base = simulate(p, runs, seed);
    const baseKey = JSON.stringify(p);
    const out = [];
    for (const lv of LEVERS) {
      const q = clone(p);
      const label = lv.label(p);
      lv.apply(q);
      const s = sanitize(q);
      if (JSON.stringify(s) === baseKey) continue;
      const r = simulate(s, runs, seed);
      out.push({ id: lv.id, kind: lv.kind, label, from: base.pBreakEven, to: r.pBreakEven, dP: r.pBreakEven - base.pBreakEven, dMed: r.p50 - base.p50 });
    }
    return out
      .filter(o => o.dP > 0.004 || (o.dP >= 0 && o.dMed > 500))
      .sort((a, b) => b.dP - a.dP || b.dMed - a.dMed);
  }

  const api = { DEFAULTS, SENSITIVITY, RUN_OPTIONS, LEVERS, sanitize, ladder, plan, live, breakEvenSold, simulate, histogram, evaluateLevers, niceStep };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  /* ================= Arayüz ================= */

  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = new Intl.NumberFormat('tr-TR');
  const nf1 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });
  const TL = n => (Number.isFinite(n) ? nf.format(Math.round(n)) + ' TL' : '—');
  const SG = n => (n >= 0 ? '+' : '−') + nf.format(Math.abs(Math.round(n))) + ' TL';
  const PC = x => '%' + nf.format(Math.round(x * 100));
  const PC1 = x => '%' + nf1.format(x * 100);
  const K = (v, signed) => {
    const a = Math.abs(v);
    const s = signed === false ? '' : v < 0 ? '−' : v > 0 ? '+' : '';
    return s + (a >= 1000 ? nf1.format(a / 1000) + 'K' : nf.format(Math.round(a)));
  };
  const idx2 = i => String(i + 1).padStart(2, '0');
  const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  const setPath = (o, path, v) => {
    const ks = path.split('.');
    let t = o;
    for (let i = 0; i < ks.length - 1; i++) t = t[ks[i]];
    t[ks[ks.length - 1]] = v;
  };

  const KEY = 'nefestival-bilet-motoru';
  const store = {
    get(k, fb) { try { const v = localStorage.getItem(KEY + ':' + k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } },
    set(k, v) { try { localStorage.setItem(KEY + ':' + k, JSON.stringify(v)); } catch (e) { /* depolama kapalı: sayfa yine çalışır */ } }
  };

  const FIELDS = {
    income: [
      ['income.sponsor', 'Nakit sponsor', 'TL'],
      ['income.food', 'Yeme içme ve stant', 'TL'],
      ['income.merch', 'Merch ve içerik', 'TL'],
      ['cost', 'Baz nakit gider', 'TL'],
      ['cutPct', 'Platform + ödeme + vergi kesintisi', '%', 'Brüt bilet ve kamp gelirinden düşülür']
    ],
    site: [
      ['siteCap', 'Saha kapasitesi', 'kişi'],
      ['crew', 'Ekip / davetli (ücretsiz)', 'kişi'],
      ['safeTarget', 'Güvenli satış hedefi', 'kişi']
    ],
    demand: [
      ['demand.online', 'Online potansiyel alıcı', 'kişi', 'Satış döneminde bilet almayı düşünecek kişi'],
      ['demand.doorPool', 'Kapı potansiyeli', 'kişi', 'Etkinlik günü kapıya gelip bilet soracak kişi'],
      ['demand.wtpMedian', 'Online medyan ödeme isteği', 'TL', 'Online alıcıların yarısı bu fiyata kadar öder'],
      ['demand.doorWtp', 'Kapıda medyan ödeme isteği', 'TL', 'Etkinlik günü gelenlerin yarısı bu fiyata kadar öder'],
      ['demand.spreadPct', 'Talep belirsizliği', '±%', 'Toplam talebin senaryodan senaryoya oynama payı'],
      ['demand.campRate', 'Kamp alma oranı', '%', 'Bilet alanın kamp eklentisi alma olasılığı']
    ]
  };

  let P = boot();
  let sold = Math.round(sellable(P) / 2);
  let sim = null, simP = null, simKey = '', levers = [], leverRuns = 0, undoP = null;
  const keyOf = p => JSON.stringify(p);

  function boot() {
    const m = location.hash.match(/[#&]s=([^&]+)/);
    if (m) {
      try {
        const json = decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))));
        history.replaceState(null, '', location.pathname + location.search);
        setTimeout(() => status('Paylaşılan senaryo yüklendi.'), 0);
        return sanitize(JSON.parse(json));
      } catch (e) {
        setTimeout(() => status('Paylaşım bağlantısı okunamadı; kayıtlı ayarlar açıldı.'), 0);
      }
    }
    const saved = store.get('params', null);
    return saved ? sanitize(saved) : clone(DEFAULTS);
  }

  function shareUrl(p) {
    const b = btoa(unescape(encodeURIComponent(JSON.stringify(p)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return location.origin + location.pathname + '#s=' + b;
  }

  /* ---------- Parametre paneli ---------- */

  function buildParams() {
    const rows = ladder(P).map((s, i) => {
      const base = s.door ? 'door' : 'phases.' + i;
      const who = s.door ? 'Kapı' : (i + 1) + '. faz';
      return `<div class="prow${s.door ? ' is-door' : ''}">
        <span class="pidx mono">${s.door ? 'KP' : idx2(i)}</span>
        <input type="text" data-path="${base}.name" value="${esc(s.name)}" maxlength="16" spellcheck="false" aria-label="${who} adı">
        <input type="number" data-path="${base}.price" value="${s.price}" min="0" step="50" inputmode="numeric" aria-label="${who} fiyatı (TL)">
        <input type="number" data-path="${base}.quota" value="${s.quota}" min="0" step="1" inputmode="numeric" aria-label="${who} kotası (bilet)">
      </div>`;
    }).join('');
    $('#phaseRows').innerHTML = `
      <div class="prow is-head" aria-hidden="true"><span></span><span>Faz</span><span>Fiyat TL</span><span>Kota</span></div>
      ${rows}
      <div class="prow is-camp">
        <span class="pidx mono">+</span><span class="plabel">Kamp eklentisi</span>
        <input type="number" data-path="camp.price" value="${P.camp.price}" min="0" step="50" inputmode="numeric" aria-label="Kamp fiyatı (TL)">
        <input type="number" data-path="camp.quota" value="${P.camp.quota}" min="0" step="1" inputmode="numeric" aria-label="Kamp kotası">
      </div>`;
    fillFields('#fIncome', FIELDS.income);
    fillFields('#fSite', FIELDS.site);
    fillFields('#fDemand', FIELDS.demand);
    $$('[data-sens]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sens === P.demand.sensitivity)));
    $('#runsSel').value = String(P.runs);
  }

  function fillFields(sel, list) {
    $(sel).innerHTML = list.map(([path, label, unit, hint]) => `
      <label class="field">
        <span class="flabel">${label}${hint ? `<small>${hint}</small>` : ''}</span>
        <span class="fin"><input type="number" data-path="${path}" value="${getPath(P, path)}" min="0" step="${unit === 'TL' ? 500 : unit === '%' ? 0.5 : 1}" inputmode="decimal"><em>${unit}</em></span>
      </label>`).join('');
  }

  function changed() {
    store.set('params', P);
    sold = Math.min(sold, sellable(P));
    renderLive();
    markStale();
  }

  function markStale() {
    const stale = !!sim && keyOf(P) !== simKey;
    $('#staleBar').hidden = !stale;
    $('#simBody').classList.toggle('is-stale', stale);
    $('#runBtn').classList.toggle('is-due', stale);
  }

  let statusTimer = 0;
  function status(msg, undoable) {
    const el = $('#status');
    el.innerHTML = esc(msg) + (undoable && undoP ? ' <button type="button" class="link" id="undoBtn">Geri al</button>' : '');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.textContent = ''; }, 9000);
  }

  /* ---------- Canlı satış ---------- */

  function kpis(sel, items) {
    $(sel).innerHTML = items.map(([label, value, detail, tone, badge]) => `
      <div class="kpi${tone ? ' is-' + tone : ''}">
        <p class="k-l mono">${esc(label)}</p>
        <p class="k-v">${esc(value)}</p>
        <p class="k-d">${esc(detail)}</p>
        ${badge ? `<span class="k-badge">${esc(badge)}</span>` : ''}
      </div>`).join('');
  }

  function renderLive() {
    const L = live(P, sold);
    const cap = L.cap;
    const den = cap || 1;
    const act = L.activeStep;
    sold = L.sold;

    kpis('#liveKpis', [
      ['SATILAN / KAPASİTE', `${nf.format(L.sold)} / ${nf.format(cap)}`, `Kalan bilet: ${nf.format(cap - L.sold)}`],
      ['SATIŞ ORANI', PC(L.sold / den), act ? `${act.name} içinde` : 'Satış kapandı'],
      ['ANLIK FİYAT', act ? TL(act.price) : '—', act ? `${act.name} fiyatı` : 'Tüm kotalar doldu'],
      ['SONRAKİ EŞİK', act ? `${nf.format(L.remaining)} bilet` : '—',
        act ? (L.nextStep ? `${PC(L.end / den)} · ${L.nextStep.name} ${TL(L.nextStep.price)}` : 'Son faz') : '—']
    ]);

    let cum = 0;
    $('#phaseCards').innerHTML = L.steps.map((s, i) => {
      const a = cum, b = Math.min(cum + s.quota, cap);
      cum += s.quota;
      const off = s.quota <= 0 || a >= cap;
      const state = off ? 'off' : i === L.active ? 'on' : L.sold >= b ? 'done' : 'next';
      const range = s.door ? 'ETKİNLİK GÜNÜ' : `%${nf.format(Math.round((a / den) * 100))}–${nf.format(Math.round((b / den) * 100))}`;
      const inStep = Math.max(0, Math.min(b - a, L.sold - a));
      const meta = off ? 'KAPALI' : state === 'done' ? 'DOLDU' : state === 'on' ? `${nf.format(inStep)}/${nf.format(b - a)} SATILDI` : `${nf.format(b - a)} BİLET`;
      return `<button type="button" class="pcard is-${state}" data-jump="${a}"${off ? ' disabled' : ''}
          aria-label="${esc(s.name)}, ${TL(s.price)}, ${meta}. Satışı bu fazın başına taşı">
        <span class="pc-top mono"><span>${s.door ? 'KP' : idx2(i)}</span><span>${range}</span></span>
        <span class="pc-name">${esc(s.name)}</span>
        <span class="pc-price">${TL(s.price)}</span>
        <span class="pc-meta mono">${meta}</span>
        <span class="pc-bar" aria-hidden="true"><i style="width:${b > a ? (inStep / (b - a)) * 100 : 0}%"></i></span>
      </button>`;
    }).join('');

    const range = $('#soldRange'), numIn = $('#soldNum');
    range.max = String(cap); range.value = String(L.sold);
    numIn.max = String(cap);
    if (document.activeElement !== numIn) numIn.value = String(L.sold);
    $('#soldOut').textContent = `${nf.format(L.sold)} / ${nf.format(cap)} bilet`;

    const be = breakEvenSold(P);
    $('#beFill').style.width = Math.max(0, Math.min(1, L.progress)) * 100 + '%';
    $('#beBar').setAttribute('aria-valuenow', String(Math.round(Math.max(0, Math.min(1, L.progress)) * 100)));
    $('#beText').textContent = L.result >= 0 ? `Başabaş aşıldı: ${SG(L.result)}` : `Başabaşa ${TL(-L.result)} kaldı`;
    $('#beMeta').textContent = be === null ? 'Bu kotalarla başabaşa ulaşılamıyor'
      : be === 0 ? 'Bilet dışı gelir gideri tek başına karşılıyor'
      : `Başabaş noktası: ${nf.format(be)}. bilet (satış sırasıyla)`;

    let head;
    if (!act) head = L.result >= 0 ? 'Tüm kotalar doldu; plan başabaşın üstünde kapanıyor.' : 'Tüm kotalar doldu ama başabaşa ulaşılamadı.';
    else if (act.door) head = `Online satış bitti; kapıda ${TL(act.price)} ile ${nf.format(L.remaining)} bilet kaldı.`;
    else head = `Fiyatı ${TL(act.price)}’de tut; ${nf.format(L.remaining)} bilet sonra ` +
      (L.nextStep ? `${L.nextStep.name} fazına geç (${TL(L.nextStep.price)}).` : 'satış kapanır.');
    $('#liveHead').textContent = head;
    $('#liveSub').textContent = `${nf.format(L.sold)} / ${nf.format(cap)} bilet satıldı · Satış oranı ${PC(L.sold / den)} · Şu anki net sonuç ${SG(L.result)}`;
    $('#jumpBtn').disabled = !act;

    drawLadder();
  }

  function setSold(n) {
    sold = Math.max(0, Math.min(sellable(P), Math.round(n) || 0));
    renderLive();
  }

  /* ---------- Grafikler ---------- */

  function tipAt(host, html, x, y) {
    let tip = $('.tip', host);
    if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; tip.setAttribute('role', 'presentation'); host.appendChild(tip); }
    tip.innerHTML = html;
    tip.hidden = false;
    const w = host.clientWidth;
    tip.style.left = Math.max(70, Math.min(w - 70, x)) + 'px';
    tip.style.top = y + 'px';
  }
  const tipOff = host => { const t = $('.tip', host); if (t) t.hidden = true; };

  function drawLadder() {
    const host = $('#ladderChart');
    const W = host.clientWidth;
    if (!W) return;
    const L = live(P, sold);
    const be = breakEvenSold(P);
    const cap = Math.max(1, L.cap);
    const H = W < 560 ? 230 : 280;
    const m = { l: 50, r: 16, t: 34, b: 34 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const priced = L.steps.filter(s => s.quota > 0);
    const maxPrice = Math.max(1, ...priced.map(s => s.price));
    const ys = niceStep(maxPrice / 4);
    const yTop = Math.ceil((maxPrice * 1.1) / ys) * ys;
    const X = n => m.l + (n / cap) * iw;
    const Y = v => m.t + ih - (v / yTop) * ih;

    let grid = '', bands = '', labels = '', pathOn = '', pathDoor = '';
    for (let v = 0; v <= yTop + 1e-9; v += ys) {
      grid += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>` +
        `<text class="tick" x="${m.l - 8}" y="${Y(v) + 3.5}" text-anchor="end">${nf.format(v)}</text>`;
    }
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const n = Math.round(cap * f);
      grid += `<text class="tick" x="${X(n)}" y="${m.t + ih + 18}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}">${nf.format(n)}</text>`;
    }
    let cum = 0, prevY = null;
    L.steps.forEach((s, i) => {
      if (s.quota <= 0 || cum >= cap) { cum += s.quota; return; }
      const a = cum, b = Math.min(cum + s.quota, cap);
      cum += s.quota;
      const x0 = X(a), x1 = X(b), y = Y(s.price);
      if (i === L.active) bands += `<rect class="band" x="${x0}" y="${m.t}" width="${x1 - x0}" height="${ih}"/>`;
      if (a > 0) bands += `<line class="divider" x1="${x0}" x2="${x0}" y1="${m.t}" y2="${m.t + ih}"/>`;
      if (s.door) pathDoor = `M${x0},${prevY == null ? y : prevY} V${y} H${x1}`;
      else pathOn += (pathOn ? ` V${y}` : `M${x0},${y}`) + ` H${x1}`;
      prevY = y;
      if (x1 - x0 >= 56) {
        const below = y + 16 <= m.t + ih - 4;
        labels += `<text class="slabel${i === L.active ? ' on' : ''}" x="${(x0 + x1) / 2}" y="${below ? y + 16 : y - 8}" text-anchor="middle">${esc(s.name)}</text>`;
      }
    });

    let marks = '';
    if (be) {
      const xb = X(be), right = xb > W - 130;
      marks += `<line class="be" x1="${xb}" x2="${xb}" y1="${m.t - 8}" y2="${m.t + ih}"/>` +
        `<text class="be-t" x="${right ? xb - 6 : xb + 6}" y="${m.t - 12}" text-anchor="${right ? 'end' : 'start'}">BAŞABAŞ · ${nf.format(be)}. BİLET</text>`;
    }
    const cx = X(L.sold), cy = Y(L.price);
    const anchor = cx > W - 90 ? 'end' : cx < m.l + 60 ? 'start' : 'middle';
    marks += `<circle class="now" cx="${cx}" cy="${cy}" r="6"/>` +
      `<text class="now-t" x="${cx}" y="${cy - 13}" text-anchor="${anchor}">${PC(L.sold / cap)} · ${TL(L.price)}</text>`;

    host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Fiyat merdiveni: ${esc(priced.map(s => s.name + ' ' + TL(s.price)).join(', '))}. Şu an ${nf.format(L.sold)} bilet satıldı, anlık fiyat ${TL(L.price)}.">
      <text class="axis" x="${m.l}" y="14">FİYAT (TL)</text>
      <text class="axis" x="${W - m.r}" y="${H - 2}" text-anchor="end">SATILAN BİLET →</text>
      ${bands}${grid}
      <path class="step" d="${pathOn}"/>
      ${pathDoor ? `<path class="step door" d="${pathDoor}"/>` : ''}
      ${labels}${marks}
      <line class="cross" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>
      <rect class="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}"/>
    </svg>`;

    const svg = $('svg', host), hit = $('.hit', svg), cross = $('.cross', svg);
    const at = e => {
      const r = svg.getBoundingClientRect();
      const px = e.clientX - r.left;
      return { px, n: Math.max(0, Math.min(L.cap, Math.round(((px - m.l) / iw) * cap))) };
    };
    hit.addEventListener('pointermove', e => {
      const { n } = at(e);
      const S = live(P, n);
      const x = X(n);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      const name = S.activeStep ? S.activeStep.name : 'Tükendi';
      tipAt(host, `<b>${nf.format(n)}. bilet noktası</b><br>${esc(name)} · ${TL(S.price)}<br><span>Net sonuç ${SG(S.result)}</span>`, x, Y(S.price) - 12);
    });
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tipOff(host); });
    hit.addEventListener('click', e => setSold(at(e).n));
  }

  function drawHist() {
    const host = $('#histChart');
    const W = host.clientWidth;
    if (!W || !sim) return;
    const H = W < 560 ? 220 : 260;
    const m = { l: 44, r: 16, t: 30, b: 34 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const hg = histogram(sim.results);
    const x0 = hg.start, x1 = hg.bins[hg.bins.length - 1].x1;
    const maxC = Math.max(...hg.bins.map(b => b.count));
    const cs = niceStep(maxC / 4);
    const cTop = Math.max(cs, Math.ceil(maxC / cs) * cs);
    const X = v => m.l + ((v - x0) / (x1 - x0)) * iw;
    const Y = c => m.t + ih - (c / cTop) * ih;

    let g = '';
    for (let c = 0; c <= cTop + 1e-9; c += cs) {
      g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(c)}" y2="${Y(c)}"/>` +
        `<text class="tick" x="${m.l - 8}" y="${Y(c) + 3.5}" text-anchor="end">${nf.format(c)}</text>`;
    }
    const xs = niceStep((x1 - x0) / (W < 560 ? 3 : 5));
    for (let v = Math.ceil(x0 / xs) * xs; v <= x1 + 1e-9; v += xs) {
      g += `<text class="tick" x="${X(v)}" y="${m.t + ih + 18}" text-anchor="middle">${K(v)}</text>`;
    }
    const bars = hg.bins.map((b, i) => {
      if (!b.count) return '';
      const bx = X(b.x0) + 1, bw = Math.max(1, X(b.x1) - X(b.x0) - 2);
      const by = Y(b.count), bh = m.t + ih - by;
      const r = Math.min(3, bw / 2, bh);
      const d = `M${bx},${m.t + ih} V${by + r} Q${bx},${by} ${bx + r},${by} H${bx + bw - r} Q${bx + bw},${by} ${bx + bw},${by + r} V${m.t + ih} Z`;
      return `<path class="bar ${b.x1 <= 0 ? 'neg' : 'pos'}" data-i="${i}" d="${d}"/>`;
    }).join('');
    let marks = '';
    if (x0 < 0 && x1 > 0) {
      const xz = X(0);
      marks += `<line class="zero" x1="${xz}" x2="${xz}" y1="${m.t - 8}" y2="${m.t + ih}"/>` +
        `<text class="zlab" x="${xz - 6}" y="${m.t - 12}" text-anchor="end">← AÇIK</text>` +
        `<text class="zlab" x="${xz + 6}" y="${m.t - 12}">FAZLA →</text>`;
    }
    const xm = X(sim.p50);
    marks += `<line class="med" x1="${xm}" x2="${xm}" y1="${m.t}" y2="${m.t + ih}"/>`;
    const hits = hg.bins.map((b, i) => `<rect class="hit" data-i="${i}" x="${X(b.x0)}" y="${m.t}" width="${Math.max(1, X(b.x1) - X(b.x0))}" height="${ih}"/>`).join('');

    host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="${nf.format(sim.runs)} senaryonun net sonuç dağılımı. Medyan ${SG(sim.p50)}, başabaş olasılığı ${PC(sim.pBreakEven)}.">
      <text class="axis" x="${m.l}" y="12">SENARYO SAYISI</text>
      <text class="axis" x="${W - m.r}" y="${H - 2}" text-anchor="end">NET SONUÇ (TL)</text>
      ${g}${bars}${marks}${hits}
    </svg>`;

    const svg = $('svg', host);
    $$('.hit', svg).forEach(h => {
      h.addEventListener('pointerenter', () => {
        const i = Number(h.dataset.i), b = hg.bins[i];
        $$('.bar', svg).forEach(el => el.classList.toggle('is-dim', el.dataset.i !== h.dataset.i));
        tipAt(host, `<b>${K(b.x0)} … ${K(b.x1)} TL</b><br>${nf.format(b.count)} senaryo (${PC1(b.count / sim.runs)})`,
          (X(b.x0) + X(b.x1)) / 2, Y(b.count) - 10);
      });
    });
    svg.addEventListener('pointerleave', () => { $$('.bar', svg).forEach(el => el.classList.remove('is-dim')); tipOff(host); });

    $('#histMed').textContent = `Medyan ${SG(sim.p50)}`;
    $('#histTable').innerHTML = `<table><thead><tr><th>Net sonuç aralığı</th><th class="n">Senaryo</th><th class="n">Pay</th></tr></thead><tbody>${
      hg.bins.filter(b => b.count).map(b => `<tr><td>${K(b.x0)} … ${K(b.x1)} TL</td><td class="n">${nf.format(b.count)}</td><td class="n">${PC1(b.count / sim.runs)}</td></tr>`).join('')
    }</tbody></table>`;
  }

  /* ---------- Senaryo simülasyonu ---------- */

  function renderSim() {
    $('#simEmpty').hidden = !!sim;
    $('#simBody').hidden = !sim;
    if (!sim) return;
    const p = simP, pl = plan(p);
    const pb = sim.pBreakEven;
    const tone = pb >= 0.8 ? 'good' : pb >= 0.5 ? 'warn' : 'bad';

    kpis('#simKpis', [
      ['BAŞABAŞ OLASILIĞI', PC(pb), `${nf.format(sim.ok)} / ${nf.format(sim.runs)} senaryo`, tone, { good: '✓ Güçlü', warn: '! Riskli', bad: '✕ Zayıf' }[tone]],
      ['MEDYAN NET SONUÇ', SG(sim.p50), `P10 ${K(sim.p10)} · P90 ${K(sim.p90)} TL`],
      ['MEDYAN ÜCRETLİ KATILIMCI', `${nf.format(sim.paidP50)} kişi`, `P10 ${nf.format(sim.paidP10)} · P90 ${nf.format(sim.paidP90)} · Plan ${nf.format(pl.paid)}`],
      ['BAŞABAŞ İÇİN GEREKEN', pl.breakEven === Infinity ? 'Ulaşılamaz' : `~${nf.format(pl.breakEven)} kişi`, `Plan ortalaması ${TL(pl.avgNet)} net / kişi`]
    ]);

    drawHist();

    const title = { good: 'Güçlü senaryo', warn: 'Riskli ama yapılabilir', bad: 'Zayıf senaryo' }[tone];
    const notes = [];
    const stall = sim.steps.find(s => !s.door && s.quota > 0 && s.pSoldOut < 0.5);
    if (stall) notes.push(`${stall.name} kotası yalnız ${PC(stall.pSoldOut)} olasılıkla doluyor; sonraki online fazlar çoğu senaryoda hiç açılmıyor.`);
    const door = sim.steps[sim.steps.length - 1];
    if (door.quota > 0) notes.push(`${door.name}: ortalama ${nf1.format(door.avgSold)} / ${nf.format(door.quota)} bilet satılıyor.`);
    if (pl.quotaTotal + p.crew > p.siteCap) notes.push(`Kotalar (${nf.format(pl.quotaTotal)}) + ekip (${nf.format(p.crew)}) saha kapasitesini (${nf.format(p.siteCap)}) aşıyor; fazlası satılamaz.`);
    if (pl.breakEven === Infinity || pl.breakEven > pl.cap) notes.push('Plan fiyatlarıyla başabaş, satılabilir kapasitenin üstünde kalıyor.');
    else if (pl.breakEven > p.safeTarget) notes.push(`Başabaş (~${nf.format(pl.breakEven)} kişi) güvenli satış hedefinin (${nf.format(p.safeTarget)}) üstünde.`);

    const list = levers.slice(0, 4);
    $('#simVerdict').innerHTML = `
      <p class="v-over mono">NET KARAR · ${esc(title.toUpperCase())}</p>
      <h3 class="v-head">Başabaş olasılığı ${PC(pb)}; medyan net sonuç ${SG(sim.p50)}.</h3>
      <p class="v-sub">Kötü senaryo (P10) ${SG(sim.p10)} · iyi senaryo (P90) ${SG(sim.p90)} · plan (tüm kotalar dolarsa) ${SG(pl.result)}</p>
      ${notes.length ? `<ul class="v-notes">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <div class="v-levers">
        <p class="v-over mono">DAHA İYİ SENARYO İÇİN · ${nf.format(leverRuns)} SENARYOLUK KARŞILAŞTIRMA</p>
        <ul>${list.length ? list.map(o => `
          <li class="lever">
            <span class="chip mono">${esc(o.kind)}</span>
            <span class="lv-body"><span class="lv-t">${esc(o.label)}</span>
              <span class="lv-m">Başabaş olasılığı ${PC(o.from)} → <b>${PC(o.to)}</b> · Medyan net ${SG(o.dMed)}</span></span>
            <button type="button" class="apply" data-lever="${esc(o.id)}">Uygula</button>
          </li>`).join('') : '<li class="lever none">Denenen tek adımlık değişikliklerin hiçbiri sonucu belirgin biçimde iyileştirmiyor. Talep varsayımlarını gözden geçir.</li>'}
        </ul>
      </div>`;

    const rows = sim.steps.map((s, i) => `
      <tr>
        <td><span class="mono idx">${s.door ? 'KP' : idx2(i)}</span>${esc(s.name)}</td>
        <td class="n">${TL(s.price)}</td>
        <td class="n">${nf.format(s.quota)}</td>
        <td class="n">${nf1.format(s.avgSold)}</td>
        <td><span class="fill"><span class="fillbar" aria-hidden="true"><i style="width:${(s.pSoldOut || 0) * 100}%"></i></span><span class="n">${s.pSoldOut == null ? '—' : PC(s.pSoldOut)}</span></span></td>
        <td class="n">${TL(s.avgGross)}</td>
      </tr>`).join('');
    $('#stepTable').innerHTML = `<table>
      <thead><tr><th>Faz</th><th class="n">Fiyat</th><th class="n">Kota</th><th class="n">Ort. satılan</th><th>Dolma olasılığı</th><th class="n">Ort. brüt gelir</th></tr></thead>
      <tbody>${rows}
        <tr><td><span class="mono idx">+</span>Kamp eklentisi</td><td class="n">${TL(p.camp.price)}</td><td class="n">${nf.format(p.camp.quota)}</td><td class="n">${nf1.format(sim.campAvg)}</td><td>—</td><td class="n">${TL(sim.campAvg * p.camp.price)}</td></tr>
      </tbody>
      <tfoot><tr><td>Toplam</td><td></td><td class="n">${nf.format(pl.quotaTotal)}</td><td class="n">${nf1.format(sim.paidMean)}</td><td></td><td class="n">${TL(sim.grossMean)}</td></tr></tfoot>
    </table>`;

    const cells = [
      ['Bilet brüt geliri', TL(pl.ticketGross)],
      ['Kamp brüt geliri', TL(pl.campGross)],
      [`Kesinti sonrası net (−%${nf1.format(p.cutPct)})`, TL(pl.net)],
      ['Bilet dışı gelir', TL(pl.nonTicket)],
      ['Baz nakit gider', TL(p.cost)],
      ['Net sonuç', SG(pl.result), pl.result >= 0 ? 'pos' : 'neg'],
      ['Brüt fark (Figma’daki operasyon tamponu)', SG(pl.grossResult)],
      ['Başabaş (ortalama gelirle)', pl.breakEven === Infinity ? 'Ulaşılamaz' : `~${nf.format(pl.breakEven)} kişi`],
      ['Sahadaki toplam kişi', `${nf.format(pl.onsite)} / ${nf.format(p.siteCap)}`],
      ...pl.stress.map(s => [`Sponsor ${K(s.sponsor, false)} TL kalırsa`,
        s.need === Infinity ? 'Ulaşılamaz' : `~${nf.format(s.need)} ücretli${s.need > pl.cap ? ' · kapasite aşılır' : ''}`])
    ];
    $('#planGrid').innerHTML = cells.map(([l, v, t]) => `<div class="pg${t ? ' is-' + t : ''}"><span>${esc(l)}</span><b>${esc(v)}</b></div>`).join('');
  }

  function run(opts) {
    const o = opts || {};
    const btn = $('#runBtn');
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.textContent = 'Simüle ediliyor…';
    if (o.switchTab !== false) showTab('sim');
    setTimeout(() => {
      const t0 = performance.now();
      simP = clone(P);
      sim = simulate(simP, simP.runs, simP.seed);
      // Öneri karşılaştırması iş yüküne göre ölçeklenir: büyük talep havuzunda sayfa donmasın.
      const pool = Math.max(1, simP.demand.online + simP.demand.doorPool);
      leverRuns = Math.max(200, Math.min(2000, simP.runs, Math.floor(12e6 / ((LEVERS.length + 1) * pool))));
      levers = evaluateLevers(simP, leverRuns, simP.seed);
      simKey = keyOf(P);
      const ms = Math.round(performance.now() - t0);
      renderSim();
      markStale();
      btn.disabled = false;
      btn.classList.remove('is-busy');
      btn.textContent = '▶ Simüle et';
      $('#simMeta').textContent = `${nf.format(sim.runs)} senaryo · tohum ${simP.seed} · ${nf.format(ms)} ms`;
      const body = $('#simBody');
      body.classList.remove('reveal');
      void body.offsetWidth;
      body.classList.add('reveal');
      if (o.quiet !== true) $('#announce').textContent = `Simülasyon tamamlandı. Başabaş olasılığı ${PC(sim.pBreakEven)}, medyan net sonuç ${SG(sim.p50)}.`;
    }, 40);
  }

  /* ---------- Kayıtlı senaryolar ---------- */

  function savedList() {
    const raw = store.get('scenarios', []);
    return Array.isArray(raw) ? raw.filter(s => s && typeof s === 'object' && s.params) : [];
  }

  function saveScenario(name) {
    const s = sim && simKey === keyOf(P) ? sim : simulate(P, P.runs, P.seed);
    const pl = plan(P);
    const list = savedList();
    list.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: String(name).trim().slice(0, 40) || 'Adsız senaryo',
      at: Date.now(),
      params: clone(P),
      sum: { pb: s.pBreakEven, p50: s.p50, p10: s.p10, planResult: pl.result, be: pl.breakEven === Infinity ? null : pl.breakEven, paid: s.paidP50 }
    });
    store.set('scenarios', list.slice(-30));
    renderSaved();
  }

  function renderSaved() {
    const list = savedList();
    $('#savCount').textContent = list.length ? String(list.length) : '';
    if (!list.length) {
      $('#savedList').innerHTML = '<p class="empty-s">Henüz kayıtlı senaryo yok. Parametreleri ayarla, simüle et ve üstten bir adla kaydet.</p>';
      return;
    }
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const best = list.reduce((b, s) => (!b || num(s.sum && s.sum.pb) > num(b.sum && b.sum.pb) ||
      (num(s.sum && s.sum.pb) === num(b.sum && b.sum.pb) && num(s.sum && s.sum.p50) > num(b.sum && b.sum.p50)) ? s : b), null);
    $('#savedList').innerHTML = `<table>
      <thead><tr><th>Senaryo</th><th>Fiyat merdiveni</th><th class="n">Başabaş olasılığı</th><th class="n">Medyan net</th><th class="n">P10</th><th class="n">Plan net sonuç</th><th class="n">Başabaş</th><th></th></tr></thead>
      <tbody>${list.slice().reverse().map(s => {
        const p = sanitize(s.params), m = s.sum || {};
        const ladderTxt = p.phases.map(x => nf.format(x.price)).join(' · ') + ' | ' + nf.format(p.door.price);
        return `<tr${s === best ? ' class="is-best"' : ''}>
          <td><b>${esc(s.name)}</b>${s === best ? ' <span class="chip mono">EN İYİ</span>' : ''}<br><small>${esc(new Date(num(s.at)).toLocaleString('tr-TR'))}</small></td>
          <td class="mono small">${esc(ladderTxt)}</td>
          <td class="n">${PC(num(m.pb))}</td>
          <td class="n">${SG(num(m.p50))}</td>
          <td class="n">${K(num(m.p10))}</td>
          <td class="n">${SG(num(m.planResult))}</td>
          <td class="n">${m.be == null ? '—' : '~' + nf.format(num(m.be))}</td>
          <td class="acts"><button type="button" class="ghost sm" data-load="${esc(s.id)}">Yükle</button><button type="button" class="ghost sm danger" data-del="${esc(s.id)}">Sil</button></td>
        </tr>`;
      }).join('')}</tbody></table>`;
  }

  /* ---------- Sekmeler ---------- */

  const TABS = ['live', 'sim', 'sav'];
  function showTab(id) {
    TABS.forEach(t => {
      const on = t === id;
      const tab = $('#t-' + t);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      $('#p-' + t).hidden = !on;
    });
    if (id === 'live') drawLadder();
    if (id === 'sim') drawHist();
    store.set('tab', id);
  }

  /* ---------- Olaylar ---------- */

  function wire() {
    const params = $('#params');
    params.addEventListener('input', e => {
      const el = e.target;
      if (!el.dataset || !el.dataset.path) return;
      let v = el.value;
      if (el.type === 'number') {
        if (v === '' || !Number.isFinite(Number(v))) return;
        v = Number(v);
      }
      const q = clone(P);
      setPath(q, el.dataset.path, v);
      P = sanitize(q);
      changed();
    });
    params.addEventListener('change', e => {
      const el = e.target;
      if (el.dataset && el.dataset.path) el.value = getPath(P, el.dataset.path);
    });
    $$('[data-sens]').forEach(b => b.addEventListener('click', () => {
      P.demand.sensitivity = b.dataset.sens;
      $$('[data-sens]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      changed();
    }));
    $('#runsSel').addEventListener('change', e => { P = sanitize({ ...P, runs: Number(e.target.value) }); changed(); });

    $('#runBtn').addEventListener('click', () => run());
    $('#reseedBtn').addEventListener('click', () => {
      P = sanitize({ ...P, seed: 1 + Math.floor(Math.random() * 2147483000) });
      store.set('params', P);
      run();
    });
    $('#resetBtn').addEventListener('click', () => {
      undoP = clone(P);
      P = clone(DEFAULTS);
      buildParams();
      sold = Math.round(sellable(P) / 2);
      changed();
      status('Varsayılan senaryo yüklendi.', true);
    });

    document.addEventListener('click', e => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest('[data-run]')) { run(); return; }
      if (t.id === 'undoBtn' && undoP) {
        P = sanitize(undoP); undoP = null;
        buildParams(); changed();
        status('Değişiklik geri alındı.');
        if (sim) run({ switchTab: false });
        return;
      }
      const lvBtn = t.closest('[data-lever]');
      if (lvBtn) {
        const lv = LEVERS.find(l => l.id === lvBtn.dataset.lever);
        if (!lv) return;
        undoP = clone(P);
        const label = lv.label(P);
        const q = clone(P);
        lv.apply(q);
        P = sanitize(q);
        buildParams(); changed();
        status(`Uygulandı: ${label}.`, true);
        run();
        return;
      }
      const jump = t.closest('[data-jump]');
      if (jump && !jump.disabled) { setSold(Number(jump.dataset.jump)); return; }
      const stepBtn = t.closest('[data-step]');
      if (stepBtn) { setSold(stepBtn.dataset.step === 'reset' ? 0 : sold + Number(stepBtn.dataset.step)); return; }
      const load = t.closest('[data-load]');
      if (load) {
        const s = savedList().find(x => x.id === load.dataset.load);
        if (!s) return;
        undoP = clone(P);
        P = sanitize(s.params);
        buildParams(); changed();
        status(`“${s.name}” yüklendi.`, true);
        run();
        return;
      }
      const del = t.closest('[data-del]');
      if (del) {
        if (del.dataset.armed !== '1') {
          del.dataset.armed = '1';
          del.textContent = 'Emin misin?';
          setTimeout(() => { if (del.isConnected) { del.dataset.armed = ''; del.textContent = 'Sil'; } }, 3500);
          return;
        }
        store.set('scenarios', savedList().filter(x => x.id !== del.dataset.del));
        renderSaved();
      }
    });

    $('#jumpBtn').addEventListener('click', () => { const L = live(P, sold); if (L.activeStep) setSold(L.end); });
    $('#soldRange').addEventListener('input', e => setSold(Number(e.target.value)));
    $('#soldNum').addEventListener('input', e => { if (e.target.value !== '') setSold(Number(e.target.value)); });
    $('#soldNum').addEventListener('change', e => { e.target.value = String(sold); });

    $('#saveForm').addEventListener('submit', e => {
      e.preventDefault();
      const name = $('#saveName').value.trim();
      if (!name) { $('#saveName').focus(); return; }
      saveScenario(name);
      $('#saveName').value = '';
      status(`“${name}” kaydedildi.`);
    });
    $('#shareBtn').addEventListener('click', async () => {
      const url = shareUrl(P);
      const out = $('#shareOut');
      out.value = url;
      out.hidden = false;
      try {
        await navigator.clipboard.writeText(url);
        status('Paylaşım bağlantısı panoya kopyalandı.');
      } catch (err) {
        out.focus(); out.select();
        status('Bağlantıyı kutudan kopyalayabilirsin.');
      }
    });

    const tabs = $('.tabs');
    tabs.addEventListener('click', e => {
      const b = e.target.closest('[role="tab"]');
      if (b) showTab(b.id.slice(2));
    });
    tabs.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const cur = TABS.indexOf(document.activeElement.id.slice(2));
      if (cur < 0) return;
      const nx = TABS[(cur + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
      showTab(nx);
      $('#t-' + nx).focus();
    });

    let raf = 0;
    const redraw = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { drawLadder(); drawHist(); }); };
    if ('ResizeObserver' in window) new ResizeObserver(redraw).observe($('.stage'));
    else window.addEventListener('resize', redraw);
  }

  function init() {
    buildParams();
    wire();
    renderLive();
    renderSaved();
    renderSim();
    const tab = store.get('tab', 'live');
    showTab(TABS.includes(tab) ? tab : 'live');
    run({ switchTab: false, quiet: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

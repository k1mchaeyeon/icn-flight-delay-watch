// 한국공항공사 "실시간 항공기 운항정보 조회" (14개 공항 출발편, dir=arr 이면 도착편)와 "노선별 소요시간 및 거리" 중계.
// 인증키는 Netlify 환경 변수 DATA_GO_KR_KEY 에서만 읽고 응답에 싣지 않는다.
const STATUS = 'https://apis.data.go.kr/B551178/flight-status';
const ROUTES = 'https://apis.data.go.kr/B551178/flight-routes';
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });
const today = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');

const keyParam = () => {
  let k = (process.env.DATA_GO_KR_KEY || '').split('DATA_GO_KR_KEY').join('').replace(/^[=:\s]+|\s+$/g, '');
  for (let i = 0; i < 4 && /%[0-9A-Fa-f]{2}/.test(k); i++) { try { k = decodeURIComponent(k); } catch { break; } }
  return k ? encodeURIComponent(k) : '';
};

async function call(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch {
    const m = text.match(/<returnAuthMsg>([^<]+)</) || text.match(/<resultMsg>([^<]+)</) || text.match(/<errMsg>([^<]+)</);
    throw new Error(`${r.status} ${m ? m[1] : '응답 형식 오류'}`);
  }
  const gw = data?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (gw) throw new Error(`${gw.returnReasonCode || r.status} ${gw.returnAuthMsg || gw.errMsg || ''}`);
  const root = data?.response || data;
  const head = root?.header || {};
  if (head.resultCode && !/^0+$/.test(String(head.resultCode))) throw new Error(`${head.resultCode} ${head.resultMsg || ''}`);
  const body = root?.body || {};
  let items = body.items ?? [];
  if (items && !Array.isArray(items)) items = items.item ?? [];
  if (!Array.isArray(items)) items = [items];
  return { items, total: Number(body.totalCount) || items.length };
}

const pick = (o, ...names) => {
  const keys = Object.keys(o);
  for (const n of names) {
    const k = keys.find((x) => x.toLowerCase() === n.toLowerCase());
    if (k != null && o[k] != null && String(o[k]).trim() !== '') return String(o[k]).trim();
  }
  return null;
};
// 시각 값을 그날 0시 기준 분으로 (YYYYMMDDHHmm 또는 HHmm 모두 받는다)
const toMin = (v, day) => {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length >= 12) {
    const t = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10), +d.slice(10, 12));
    const t0 = Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8));
    return Math.round((t - t0) / 60000);
  }
  if (d.length === 4 || d.length === 3) { const s = d.padStart(4, '0'); return +s.slice(0, 2) * 60 + +s.slice(2, 4); }
  return null;
};

// 한 번에 받을 수 있는 행 수 제한이 문서에 없어서 큰 값부터 줄여 가며 받는다.
async function allPages(make) {
  let lastErr;
  for (const rows of [500, 200, 100]) {
    try {
      const first = await call(make(1, rows));
      let items = first.items;
      const pages = Math.min(Math.ceil(first.total / rows), 12);
      if (pages > 1) { const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => call(make(i + 2, rows)))); for (const r of rest) items = items.concat(r.items); }
      return { items, total: first.total };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export default async (req) => {
  const key = keyParam();
  if (!key) return json({ error: 'DATA_GO_KR_KEY 환경 변수가 없습니다.' }, 500);
  const q = new URL(req.url).searchParams;
  const cache = { 'cache-control': 'public, max-age=300', 'netlify-cdn-cache-control': 'public, s-maxage=900' };
  if (q.get('debug') === '2') {
    const out = {};
    const tries = { small: `${STATUS}/depart?serviceKey=${key}&pageNo=1&numOfRows=5&type=json`, day: `${STATUS}/depart?serviceKey=${key}&pageNo=1&numOfRows=5&searchday=${today()}&type=json`,
      gmp: `${STATUS}/depart?serviceKey=${key}&pageNo=1&numOfRows=5&searchday=${today()}&airport_code=GMP&type=json`, xml: `${STATUS}/depart?serviceKey=${key}&pageNo=1&numOfRows=5`,
      info: `${STATUS}/info?serviceKey=${key}&pageNo=1&numOfRows=5&type=json`, detail: `${STATUS}/detail?serviceKey=${key}&pageNo=1&numOfRows=5&type=json`, routes: `${ROUTES}/info?serviceKey=${key}&pageNo=1&numOfRows=5&type=json` };
    for (const [n, u] of Object.entries(tries)) {
      try { const r = await fetch(u, { signal: AbortSignal.timeout(8000) }); out[n] = { status: r.status, text: (await r.text()).slice(0, 700).split(key).join('***') }; } catch (e) { out[n] = { error: String(e.message || e) }; }
    }
    return json(out, 200, { 'cache-control': 'no-store' });
  }
  try {
    if (q.get('what') === 'routes') {
      const { items, total } = await allPages((p, n) => `${ROUTES}/info?serviceKey=${key}&pageNo=${p}&numOfRows=${n}&type=json`);
      if (q.get('debug') === '1') return json({ total, sample: items[0] ?? null }, 200, { 'cache-control': 'no-store' });
      return json({ source: '한국공항공사 노선별 소요시간 및 거리 정보', total, routes: items.map((o) => ({ from: pick(o, 'ARP'), to: pick(o, 'ODP'), kind: pick(o, 'TOF'), time_min: Number(pick(o, 'TIME')) || null, km: Number(pick(o, 'KM')) || null })) },
        200, { 'cache-control': 'public, max-age=3600', 'netlify-cdn-cache-control': 'public, s-maxage=86400' });
    }
    const day = /^\d{8}$/.test(q.get('date') || '') ? q.get('date') : today();
    const arr = q.get('dir') === 'arr';
    const first = await allPages((p, n) => `${STATUS}/${arr ? 'arrival' : 'depart'}?serviceKey=${key}&pageNo=${p}&numOfRows=${n}&searchday=${day}&type=json`);
    const items = first.items;
    if (q.get('debug') === '1') return json({ day, total: first.total, sample: items[0] ?? null, sample2: items[Math.floor(items.length / 2)] ?? null }, 200, { 'cache-control': 'no-store' });
    const nowMin = day === today() ? Math.round(((Date.now() + 9 * 3600 * 1000) % 86400000) / 60000) : 99999;
    const flights = [];
    for (const o of items) {
      if (/^y/i.test(pick(o, 'codeshare') || '') && pick(o, 'masterflightid') && pick(o, 'masterflightid') !== pick(o, 'flightid')) continue;
      const sm = toMin(pick(o, 'scheduledatetime'), day), em = toMin(pick(o, 'estimateddatetime'), day);
      const status = pick(o, 'rmkKor');
      // 도착편은 sched/est 가 도착 예정·변경 시각, gone 은 도착 완료
      flights.push({ flight: pick(o, 'flightid'), airline: pick(o, 'airline'), from: pick(o, 'depAirportCode'), from_name: pick(o, 'depAirport'), to: pick(o, 'arrvAirportCode', 'arrAirportCode'), to_name: pick(o, 'arrAirport'),
        line: pick(o, 'line'), sched_min: sm, est_min: em, delay_min: sm != null && em != null ? em - sm : null, status, cancelled: /결항/.test(status || ''), gone: (arr ? /도착/ : /출발/).test(status || '') || (em != null && em <= nowMin) });
    }
    const by = new Map();
    for (const f of flights) {
      const ap = arr ? f.to : f.from;
      if (!ap) continue;
      const a = by.get(ap) || { code: ap, name: arr ? f.to_name : f.from_name, total: 0, departed: 0, late15: 0, cancelled: 0, sum: 0, worst: null };
      a.total++;
      if (f.cancelled) a.cancelled++;
      else if (f.gone && f.delay_min != null) { a.departed++; a.sum += Math.max(0, f.delay_min); if (f.delay_min >= 15) a.late15++; if (!a.worst || f.delay_min > a.worst.delay_min) a.worst = { flight: f.flight, to: arr ? f.from : f.to, delay_min: f.delay_min }; }
      by.set(ap, a);
    }
    const airports = [...by.values()].map((a) => ({ ...a, avg: a.departed ? Math.round(a.sum / a.departed) : 0, sum: undefined })).sort((a, b) => b.total - a.total);
    return json({ source: '한국공항공사 실시간 항공기 운항정보 조회', dir: arr ? 'arr' : 'dep', day, at: Math.floor(Date.now() / 1000), total: first.total, airports, flights: q.get('flights') === '1' ? flights : undefined }, 200, cache);
  } catch (e) {
    return json({ error: String(e.message || e) }, 502, { 'cache-control': 'no-store' });
  }
};
export const config = { path: '/api/kac' };

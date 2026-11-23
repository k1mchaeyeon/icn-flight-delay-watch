// 모델 학습용 하루치 자료를 배포된 중계 주소에서 받아 파일로 저장한다. 인증키는 여기서 쓰지 않는다.
// 사용: node scripts/collect.mjs <저장 폴더> [며칠 전부터=1]
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.COLLECT_BASE || 'https://chain-delay-watch.vercel.app';
const out = process.argv[2] || 'data';
const back = Math.max(1, Math.min(3, Number(process.argv[3]) || 1));
const dayStr = (offset) => new Date(Date.now() + 9 * 3600 * 1000 - offset * 86400000).toISOString().slice(0, 10);
const exists = (p) => access(p).then(() => true, () => false);

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      const j = await r.json();
      if (r.ok && !j.error) return j;
      console.error(`시도 ${i + 1} 실패: ${url} → ${r.status} ${j.error || ''}`);
    } catch (e) { console.error(`시도 ${i + 1} 실패: ${url} → ${e.message}`); }
    await new Promise((res) => setTimeout(res, 5000 * (i + 1)));
  }
  return null;
}
async function save(dir, name, obj) {
  await mkdir(path.join(out, dir), { recursive: true });
  await writeFile(path.join(out, dir, name), JSON.stringify(obj));
  console.log(`저장: ${dir}/${name}`);
}

let failed = 0;
for (let d = back; d >= 1; d--) {
  const day = dayStr(d), ymd = day.replace(/-/g, '');
  if (!(await exists(path.join(out, 'icn_flights', `${day}.json`)))) {
    const j = await get(`${BASE}/api/flights?date=${ymd}`);
    if (j && j.flights?.length) await save('icn_flights', `${day}.json`, j); else { failed++; console.error(`인천공항 운항 ${day} 받지 못함`); }
  }
  if (!(await exists(path.join(out, 'kac_departures', `${day}.json`)))) {
    const j = await get(`${BASE}/api/kac?flights=1&date=${ymd}`);
    if (j && j.flights?.length) await save('kac_departures', `${day}.json`, j); else { failed++; console.error(`한국공항공사 운항 ${day} 받지 못함`); }
  }
  // 도착 시각: 제주처럼 ADS-B로 착륙을 못 잡는 공항의 앞 편 도착 시각을 채운다 (2026-11-23 추가)
  if (!(await exists(path.join(out, 'kac_arrivals', `${day}.json`)))) {
    const j = await get(`${BASE}/api/kac?flights=1&dir=arr&date=${ymd}`);
    if (j && j.flights?.length) await save('kac_arrivals', `${day}.json`, j); else { failed++; console.error(`한국공항공사 도착 ${day} 받지 못함`); }
  }
}
// 날씨는 최근 30시간 관측만 받을 수 있다. 예약 실행이 몇 시간씩 늦어져도 빈 시간이 없도록
// 하루 두 번 받아 실행 시각 이름으로 따로 저장한다 (겹치는 관측은 학습 전에 시각으로 중복 제거).
const w = await get(`${BASE}/api/weather?raw=1`);
const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 13).replace('T', '_') + '시';
if (w && w.metars?.length) await save('icn_weather', `${stamp}.json`, w); else { failed++; console.error('날씨 받지 못함'); }
if (!(await exists(path.join(out, 'kac_routes.json')))) {
  const r = await get(`${BASE}/api/kac?what=routes`);
  if (r && r.routes?.length) { await writeFile(path.join(out, 'kac_routes.json'), JSON.stringify(r)); console.log('저장: kac_routes.json'); }
}
if (failed) { console.error(`${failed}건 실패`); process.exitCode = 1; }

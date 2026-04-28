'use strict';

/* ================================================================
   상수뉴스 — app.js
   ================================================================ */

// ── Debug Mode (?debug=1) ─────────────────────────────────────
const DBG = new URLSearchParams(location.search).get('debug') === '1';
function dbg(msg) {
  console.log('[DBG]', msg);
  if (!DBG) return;
  const box = document.getElementById('debugBox');
  if (!box) return;
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString('ko')}] ${msg}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// ── Config ───────────────────────────────────────────────────
const CFG = {
  rss2json:     'https://api.rss2json.com/v1/api.json',
  geminiBase:   'https://generativelanguage.googleapis.com/v1beta/models',
  cachePrefix:  'econ_',
  newsCacheTtl: 24 * 60 * 60 * 1000,
  analysisTtl:  24 * 60 * 60 * 1000,
  newsCount:    10,
  fetchTimeout: 12000,
  geminiTimeout:35000,
  maxCategories:10,
};

// ── Default Categories ────────────────────────────────────────
const DEFAULT_CATEGORIES = [
  { id:'ko-econ',   name:'한국 경제',   query:'한국 경제',             lang:'ko', color:'#2E7D32' },
  { id:'ko-biz',    name:'한국 산업',   query:'한국 기업 산업',         lang:'ko', color:'#7c3aed' },
  { id:'us-market', name:'미국 시장',   query:'US stock market',        lang:'en', color:'#1d4ed8' },
  { id:'us-econ',   name:'미국 경제',   query:'US economy',             lang:'en', color:'#c2410c' },
  { id:'global',    name:'글로벌',      query:'global economy',          lang:'en', color:'#065f46' },
  { id:'forex',     name:'환율/원자재', query:'exchange rate commodity', lang:'en', color:'#92400e' },
];

const COLOR_PALETTE = [
  '#2E7D32','#7c3aed','#1d4ed8','#c2410c','#065f46',
  '#92400e','#0e7490','#be185d','#ca8a04','#4338ca',
];

let CATEGORIES = [];

// ── State ────────────────────────────────────────────────────
const S = {
  news:        [],
  activeTab:   'all',
  activeFilter:new Set(),
  apiKey:      null,
  model:       'gemini-2.5-flash',
  isDark:      false,
  lastUpdated: 0,
  expandedIds: new Set(),
  analyzingIds:new Set(),
};

// ── Bootstrap ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if (DBG) {
    const box = document.getElementById('debugBox');
    if (box) box.style.display = 'block';
    dbg('=== 🔍 디버그 모드 ON ===');
    dbg(`UA: ${navigator.userAgent.substring(0, 100)}`);
    dbg(`localStorage 키: ${Object.keys(localStorage).join(', ') || '(없음)'}`);
  }

  loadCategories();
  loadSettings();
  applyTheme();
  renderChips();
  registerSW();

  const cached = loadNewsCache();
  if (cached) {
    S.news = cached;
    renderAll();
    setUpdatedLabel(S.lastUpdated);
  }

  if (!S.apiKey) {
    showModal('apiKeyModal');
    if (!cached) showLoading('API 키를 입력하면 뉴스를 불러옵니다');
    return;
  }

  if (!cached) await fetchAll();
});

// ── Categories ────────────────────────────────────────────────
function loadCategories() {
  try {
    const raw = localStorage.getItem('econ_categories');
    if (raw) { CATEGORIES = JSON.parse(raw); return; }
  } catch {}
  CATEGORIES = DEFAULT_CATEGORIES.map(c => ({ ...c }));
  saveCategories();
}

function saveCategories() {
  localStorage.setItem('econ_categories', JSON.stringify(CATEGORIES));
}

function buildGoogleNewsUrl(query, lang) {
  const base = 'https://news.google.com/rss/search';
  return lang === 'ko'
    ? `${base}?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`
    : `${base}?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

function addCategory() {
  if (CATEGORIES.length >= CFG.maxCategories) {
    toast(`카테고리는 최대 ${CFG.maxCategories}개까지 가능합니다`); return;
  }
  const nameEl  = id('catName');
  const queryEl = id('catQuery');
  const langEl  = id('catLang');
  const name    = nameEl.value.trim();
  const query   = queryEl.value.trim();
  const lang    = langEl.value;
  if (!name || !query) { toast('이름과 검색어를 입력해주세요'); return; }

  CATEGORIES.push({
    id:    'cat_' + Date.now(),
    name, query, lang,
    color: COLOR_PALETTE[CATEGORIES.length % COLOR_PALETTE.length],
  });
  saveCategories();
  nameEl.value = '';
  queryEl.value = '';
  renderCategoriesList();
  renderChips();
  toast(`"${name}" 카테고리 추가됨`);
}

function deleteCategory(catId) {
  CATEGORIES = CATEGORIES.filter(c => c.id !== catId);
  S.news     = S.news.filter(n => n.feedId !== catId);
  S.activeFilter.delete(catId);
  saveCategories();
  renderCategoriesList();
  renderChips();
  renderAll();
  toast('카테고리 삭제됨');
}

function resetCategories() {
  CATEGORIES = DEFAULT_CATEGORIES.map(c => ({ ...c }));
  S.news = [];
  S.expandedIds.clear();
  saveCategories();
  renderCategoriesList();
  renderChips();
  renderAll();
  toast('기본 카테고리로 초기화됨');
}

function renderCategoriesList() {
  const el = id('categoriesList');
  if (!el) return;
  if (!CATEGORIES.length) {
    el.innerHTML = '<p style="font-size:.8rem;color:var(--text-3);text-align:center;padding:8px">카테고리 없음</p>';
    return;
  }
  el.innerHTML = CATEGORIES.map(c => `
    <div class="cat-item">
      <span class="cat-dot" style="background:${c.color}"></span>
      <span class="cat-item-name">${esc(c.name)}</span>
      <span class="cat-item-query">'${esc(c.query)}'</span>
      <span class="cat-item-lang">${c.lang === 'ko' ? '🇰🇷' : '🇺🇸'}</span>
      <button class="cat-item-del" onclick="deleteCategory('${esc(c.id)}')" title="삭제">✕</button>
    </div>`).join('');
}

// ── Settings ─────────────────────────────────────────────────
function loadSettings() {
  S.apiKey      = ls('gemini_key')   || null;
  S.model       = ls('gemini_model') || 'gemini-2.5-flash';
  S.isDark      = ls('dark_mode')    === 'true';
  S.lastUpdated = parseInt(ls('last_updated') || '0', 10);
}

function saveApiKey() {
  const el  = id('apiKeyInput');
  const key = el.value.trim();
  if (!key) { el.classList.add('shake'); setTimeout(() => el.classList.remove('shake'), 500); return; }
  S.apiKey = key;
  ls('gemini_key', key);
  hideModal('apiKeyModal');
  fetchAll();
}

function saveSettings() {
  const keyVal = id('settingsApiKeyInput').value.trim();
  if (keyVal) { S.apiKey = keyVal; ls('gemini_key', keyVal); }
  S.model = id('modelSelect').value;
  ls('gemini_model', S.model);
  closeSettings();
  toast(`설정 저장됨 (모델: ${S.model})`);
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '●'.repeat(key.length);
  return key.slice(0, 4) + '●'.repeat(Math.max(8, key.length - 8)) + key.slice(-4);
}

function showSettings() {
  const inp = id('settingsApiKeyInput');
  inp.value = '';
  inp.placeholder = S.apiKey ? `현재: ${maskKey(S.apiKey)}` : 'API 키 입력 (변경 시에만)';
  const sel = id('modelSelect');
  if (![...sel.options].some(o => o.value === S.model)) {
    const opt = document.createElement('option');
    opt.value = S.model; opt.textContent = S.model;
    sel.insertBefore(opt, sel.firstChild);
  }
  sel.value = S.model;
  renderCategoriesList();
  showModal('settingsModal');
}

async function loadAvailableModels() {
  const apiKey = id('settingsApiKeyInput').value.trim() || S.apiKey;
  if (!apiKey) { toast('API 키를 먼저 입력해 주세요'); return; }
  const btn = id('loadModelsBtn');
  btn.textContent = '⏳'; btn.disabled = true;
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data   = await resp.json();
    const models = (data.models || [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace('models/', ''))
      .filter(n => n.startsWith('gemini'));
    if (!models.length) throw new Error('사용 가능한 모델 없음');
    const sel     = id('modelSelect');
    const current = sel.value;
    sel.innerHTML = models.map(m =>
      `<option value="${esc(m)}"${m === current ? ' selected' : ''}>${esc(m)}</option>`
    ).join('');
    if (!models.includes(current) && models.length) sel.value = models[0];
    toast(`모델 ${models.length}개 조회됨`);
  } catch (e) {
    toast(`모델 조회 실패: ${e.message}`);
  } finally {
    btn.textContent = '🔍'; btn.disabled = false;
  }
}

function closeSettings() { hideModal('settingsModal'); }

function clearAnalysisCache() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith(CFG.cachePrefix + 'ai_'));
  keys.forEach(k => localStorage.removeItem(k));
  toast(`분석 캐시 ${keys.length}개 삭제됨`);
}

function clearAllCache() {
  Object.keys(localStorage).filter(k => k.startsWith(CFG.cachePrefix))
    .forEach(k => localStorage.removeItem(k));
  localStorage.removeItem('last_updated');
  S.news = []; S.expandedIds.clear(); S.lastUpdated = 0;
  renderAll(); setUpdatedLabel(0);
  toast('전체 캐시 초기화됨');
}

// ── RSS Fetch ─────────────────────────────────────────────────
async function fetchAll() {
  showLoading('뉴스를 불러오는 중...');
  S.news = []; S.expandedIds.clear();

  const results = await Promise.allSettled(CATEGORIES.map(c => fetchFeed(c)));

  results.forEach((r, i) => {
    S.news.push(
      r.status === 'fulfilled'
        ? { feedId: CATEGORIES[i].id, items: r.value, error: null }
        : { feedId: CATEGORIES[i].id, items: [], error: r.reason?.message || '로드 실패' }
    );
  });

  S.lastUpdated = Date.now();
  ls('last_updated', String(S.lastUpdated));
  saveNewsCache();
  hideLoading();
  renderAll();
  setUpdatedLabel(S.lastUpdated);
}

// ── RSS Proxy Chain ───────────────────────────────────────────
function parseRssXml(xmlString, catId) {
  const doc = new DOMParser().parseFromString(xmlString, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML 파싱 실패');

  const nodes = [...doc.querySelectorAll('item')];
  const entries = [...doc.querySelectorAll('entry')];
  const items = nodes.length ? nodes : entries;
  if (!items.length) throw new Error('RSS 항목 없음');

  return items.slice(0, CFG.newsCount).map(n => {
    const txt = tag => (n.querySelector(tag)?.textContent || '').trim();

    // Google News: title = "기사 제목 - 매체명"
    const titleRaw = txt('title') || '제목 없음';
    const sourceEl = n.querySelector('source');
    let source = sourceEl ? sourceEl.textContent.trim() : '';
    let title  = titleRaw;
    if (!source) {
      const di = titleRaw.lastIndexOf(' - ');
      if (di > 15) { title = titleRaw.slice(0, di); source = titleRaw.slice(di + 3); }
    }

    const linkEl = n.querySelector('link');
    const link   = linkEl
      ? (linkEl.textContent.trim() || linkEl.getAttribute('href') || '#')
      : '#';

    return {
      id:          makeId(title || link),
      title, source, link,
      description: stripHtml(txt('description') || txt('summary') || txt('content') || '').substring(0, 600),
      pubDate:     txt('pubDate') || txt('published') || txt('updated') || '',
      feedId:      catId,
    };
  });
}

const PROXIES = [
  {
    name: 'allorigins',
    async fetch(url, catId) {
      const resp = await fetch(
        `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
        { signal: AbortSignal.timeout(CFG.fetchTimeout) }
      );
      if (!resp.ok) throw new Error(`allorigins HTTP ${resp.status}`);
      const data = await resp.json();
      if (!data.contents) throw new Error('allorigins: 응답 없음');
      return parseRssXml(data.contents, catId);
    },
  },
  {
    name: 'corsproxy',
    async fetch(url, catId) {
      const resp = await fetch(
        `https://corsproxy.io/?${encodeURIComponent(url)}`,
        { signal: AbortSignal.timeout(CFG.fetchTimeout) }
      );
      if (!resp.ok) throw new Error(`corsproxy HTTP ${resp.status}`);
      return parseRssXml(await resp.text(), catId);
    },
  },
  {
    name: 'rss2json',
    async fetch(url, catId) {
      const params = new URLSearchParams({ rss_url: url, count: CFG.newsCount });
      const resp = await fetch(`${CFG.rss2json}?${params}`,
        { signal: AbortSignal.timeout(CFG.fetchTimeout) }
      );
      if (!resp.ok) throw new Error(`rss2json HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.status !== 'ok' || !data.items?.length) throw new Error('rss2json: 항목 없음');
      return data.items.map(item => {
        const raw = (item.title || '제목 없음').trim();
        const di  = raw.lastIndexOf(' - ');
        const title  = di > 15 ? raw.slice(0, di)  : raw;
        const source = di > 15 ? raw.slice(di + 3) : '';
        return {
          id:          makeId(title || item.link || ''),
          title, source,
          link:        item.link || '#',
          description: stripHtml(item.description || item.content || '').substring(0, 600),
          pubDate:     item.pubDate || '',
          feedId:      catId,
        };
      });
    },
  },
];

async function tryRssUrl(url, catId) {
  for (const proxy of PROXIES) {
    try {
      console.log(`[RSS] ${catId} → ${proxy.name}`);
      const items = await proxy.fetch(url, catId);
      console.log(`[RSS] ${catId} ✓ ${proxy.name} (${items.length}개)`);
      return items;
    } catch (e) {
      console.warn(`[RSS] ${catId} ✗ ${proxy.name}: ${e.message}`);
      await sleep(500);
    }
  }
  throw new Error('뉴스를 불러올 수 없습니다. 다시 시도 버튼을 눌러주세요.');
}

async function fetchFeed(cat) {
  return tryRssUrl(buildGoogleNewsUrl(cat.query, cat.lang), cat.id);
}

// ── Gemini Analysis ──────────────────────────────────────────

const FALLBACK_MODELS = ['gemini-2.0-flash', 'gemini-flash-latest'];

async function analyzeItem(item, catId, reason = '알 수 없음', maxTokens = 8192) {
  const cacheKey = CFG.cachePrefix + 'ai_' + item.id;

  if (maxTokens === 8192) {
    const hit = readCache(cacheKey, CFG.analysisTtl);
    if (hit) { console.log(`📦 캐시 사용: ${item.title.slice(0, 30)}`); return hit; }
    console.log(`🌐 Gemini 호출: ${item.title.slice(0, 40)} — 이유: ${reason}`);
  } else {
    console.log(`🔄 MAX_TOKENS 재시도 — maxTokens: ${maxTokens}`);
  }

  const cat    = CATEGORIES.find(c => c.id === catId);
  const isEn   = cat?.lang === 'en';
  const prompt = _buildPrompt(item, isEn);

  // 기본 모델 + 폴백 모델 (중복 제거)
  const modelQueue = [...new Set([S.model, ...FALLBACK_MODELS])];

  for (let mi = 0; mi < modelQueue.length; mi++) {
    const model = modelQueue[mi];
    if (mi > 0) console.log(`⚠️ ${modelQueue[mi - 1]} 실패 → ${model} 폴백 시도`);

    // 각 모델당 최대 2회 시도 (503 시 5초 대기 후 재시도)
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        console.log(`🔄 서버 과부하(503) — 5초 대기 후 ${model} 재시도...`);
        await sleep(5000);
      } else if (mi === 0) {
        console.log(`🌐 1차 시도: ${model}`);
      } else {
        console.log(`🌐 ${mi + 1}차 폴백: ${model}`);
      }

      try {
        const result = await _callGemini(model, prompt, maxTokens);
        writeCache(cacheKey, result);
        console.log(`✅ 분석 완료 [${model}]: ${item.title.slice(0, 40)}`);
        return result;

      } catch (err) {
        // MAX_TOKENS: 모델 유지, 토큰만 늘려서 재시도
        if (err._maxTokens) {
          if (maxTokens < 16384) {
            console.warn('⚠️ MAX_TOKENS 감지 — 16384 토큰으로 재시도');
            return analyzeItem(item, catId, reason, 16384);
          }
          throw new Error('AI 응답이 너무 길어 잘렸습니다. 다시 시도해주세요.');
        }
        // 503 첫 번째 시도: 루프 계속 (5초 대기 후 재시도)
        if (err._status === 503 && attempt === 0) continue;
        // 503 두 번째 시도: 다음 모델로 폴백
        if (err._status === 503) break;
        // 503 외 에러(400·404·429 등): 즉시 전파
        throw err;
      }
    }
  }

  // 모든 모델·재시도 소진
  throw new Error('AI 서버가 일시적으로 모두 바쁩니다. 1~5분 후 다시 시도해주세요.');
}

// 실제 Gemini API fetch — 성공 시 파싱된 결과 반환, 실패 시 ._status 태그 에러 throw
async function _callGemini(model, prompt, maxTokens) {
  const endpoint = `${CFG.geminiBase}/${model}:generateContent?key=${S.apiKey}`;
  console.log(`🌐 fetch: generativelanguage.googleapis.com — ${model}`);
  if (DBG) {
    const k = S.apiKey || '';
    dbg(`_callGemini: ${model}`);
    dbg(`키: ${k.slice(0, 4)}...${k.slice(-4)} (${k.length}자)`);
    dbg(`URL 끝: ...${endpoint.slice(-30)}`);
  }
  console.log(`📤 fetch 옵션: cache=no-store, credentials=omit, keyLength=${(S.apiKey||'').length}`);

  const resp = await fetch(endpoint, {
    method:      'POST',
    headers:     { 'Content-Type': 'application/json' },
    cache:       'no-store',
    credentials: 'omit',
    mode:        'cors',
    body:        JSON.stringify({
      contents:         [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature:     0.7,
        maxOutputTokens: maxTokens,
        thinkingConfig:  { thinkingBudget: 0 },
      },
    }),
    signal: AbortSignal.timeout(CFG.geminiTimeout),
  });

  console.log(`📨 응답: HTTP ${resp.status} [${model}]`);
  dbg(`HTTP ${resp.status} [${model}]`);

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    const msg  = body?.error?.message || `HTTP ${resp.status}`;
    console.error(`❌ ${model} 에러: ${resp.status} —`, msg);
    dbg(`❌ ${resp.status}: ${msg.substring(0, 150)}`);
    if (DBG) alert(`[DEBUG]\nHTTP ${resp.status}\n모델: ${model}\n키길이: ${(S.apiKey||'').length}\n첫4: ${(S.apiKey||'').slice(0,4)}\n에러: ${msg.substring(0, 200)}`);
    const isZeroQuota = msg.includes('limit: 0') || msg.includes('free_tier');
    const e = new Error(
      resp.status === 503 ? 'AI 서버가 일시적으로 바쁩니다. 자동으로 재시도 중...' :
      resp.status === 404 ? `[NO_MODEL] ${model} 모델을 찾을 수 없습니다. 설정에서 다른 모델을 선택해주세요.` :
      resp.status === 429 ? (isZeroQuota
        ? `[NO_QUOTA] ${model} 모델은 무료 사용이 불가합니다. 설정에서 gemini-2.5-flash로 변경해주세요.`
        : 'AI 할당량 초과입니다. 잠시 후 다시 시도해주세요.') :
      resp.status === 400 ? 'API 키가 유효하지 않습니다.' :
      msg
    );
    e._status = resp.status;
    throw e;
  }

  const data      = await resp.json();
  const candidate = data.candidates?.[0];
  const finish    = candidate?.finishReason || '알 수 없음';
  const usage     = data.usageMetadata || {};
  console.log(`🏁 finishReason: ${finish} [${model}]`);
  console.log(`📊 토큰:`, {
    prompt:   usage.promptTokenCount     || 0,
    thinking: usage.thoughtsTokenCount   || 0,
    output:   usage.candidatesTokenCount || 0,
    total:    usage.totalTokenCount      || 0,
  });

  if (finish === 'MAX_TOKENS') {
    const e = new Error('MAX_TOKENS');
    e._maxTokens = true;
    throw e;
  }

  const raw   = candidate?.content?.parts?.[0]?.text || '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('응답 파싱 실패');

  return JSON.parse(match[0]);
}

// 언어별 프롬프트 생성
function _buildPrompt(item, isEn) {
  if (isEn) return `이 영어 뉴스를 한국어로 번역하고 분석해 주세요.

제목: ${item.title}
내용: ${item.description || '(본문 없음)'}

아래 JSON 형식으로만 답변해 주세요 (코드블록·설명 없이 JSON만):
{
  "translated_title": "제목의 자연스러운 한국어 번역",
  "summary": "한 줄 요약 (1~2문장, 한국어)",
  "analysis": "관련 산업·거시경제 영향 분석 (3~4문장, 한국어)",
  "actions": [
    "투자자·기업의 구체적 대응 방안 1",
    "대응 방안 2",
    "대응 방안 3"
  ],
  "stocks": [
    {
      "name": "종목명",
      "ticker": "티커",
      "market": "KRX 또는 NASDAQ 또는 NYSE",
      "impact": "단기 영향 한 줄"
    }
  ]
}
stocks는 직접 관련 종목만 최대 4개. 관련 없으면 빈 배열 [].`;

  return `다음 경제 뉴스를 분석해 주세요.

제목: ${item.title}
내용: ${item.description || '(본문 없음)'}

아래 JSON 형식으로만 답변해 주세요 (코드블록·설명 없이 JSON만):
{
  "summary": "한 줄 요약 (1~2문장)",
  "analysis": "관련 산업·거시경제 영향 분석 (3~4문장, 한국어)",
  "actions": [
    "투자자·기업의 구체적 대응 방안 1",
    "대응 방안 2",
    "대응 방안 3"
  ],
  "stocks": [
    {
      "name": "종목명",
      "ticker": "티커",
      "market": "KRX 또는 NASDAQ 또는 NYSE",
      "impact": "단기 영향 한 줄"
    }
  ]
}
stocks는 직접 관련 종목만 최대 4개. 관련 없으면 빈 배열 [].`;
}

// ── Rendering ────────────────────────────────────────────────
function renderAll() {
  const main = id('newsMain');

  const visible = CATEGORIES.filter(c => {
    if (S.activeTab === 'ko' && c.lang !== 'ko') return false;
    if (S.activeTab === 'en' && c.lang !== 'en') return false;
    if (S.activeFilter.size > 0 && !S.activeFilter.has(c.id)) return false;
    return true;
  });

  const groups = visible.map(c => {
    const entry = S.news.find(n => n.feedId === c.id);
    return { cat: c, items: entry?.items || [], error: entry?.error || null };
  });

  const hasContent = groups.some(g => g.items.length > 0 || g.error);

  if (!hasContent && S.news.length > 0) {
    main.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <p class="empty-title">해당 뉴스가 없습니다</p>
        <p class="empty-sub">다른 탭이나 필터를 선택해 보세요</p>
      </div>`;
    return;
  }
  if (!hasContent) {
    main.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📰</div>
        <p class="empty-title">뉴스를 불러오세요</p>
        <p class="empty-sub">새로고침 버튼을 눌러 최신 뉴스를 가져옵니다</p>
      </div>`;
    return;
  }

  main.innerHTML = groups
    .filter(g => g.items.length > 0 || g.error)
    .map(g => renderGroup(g))
    .join('');
}

function renderGroup({ cat, items, error }) {
  const flag = cat.lang === 'ko' ? '🇰🇷' : '🇺🇸';
  return `
    <section class="feed-group" data-feed="${cat.id}">
      <div class="feed-header" style="--feed-color:${cat.color}">
        <div class="feed-badge-wrap">
          <span class="feed-badge">${flag} ${esc(cat.name)}</span>
          <span class="feed-query">'${esc(cat.query)}'</span>
        </div>
        <span class="feed-count">${items.length}개</span>
      </div>
      ${error ? `<div class="feed-error">⚠️ ${esc(error)}</div>` : ''}
      <div class="feed-cards">
        ${items.map(item => renderCard(item, cat)).join('')}
      </div>
    </section>`;
}

function renderCard(item, cat) {
  const expanded  = S.expandedIds.has(item.id);
  const analyzing = S.analyzingIds.has(item.id);
  const cached    = readCache(CFG.cachePrefix + 'ai_' + item.id, CFG.analysisTtl);
  const trTitle   = (cat.lang === 'en' && cached?.translated_title) ? cached.translated_title : null;

  let bodyHtml = '';
  if (expanded) {
    if (analyzing) {
      bodyHtml = `
        <div class="card-body">
          <div class="analysis-loading">
            <div class="loading-spinner"></div>
            <span>AI 분석 중…</span>
          </div>
        </div>`;
    } else if (cached) {
      bodyHtml = `<div class="card-body">${renderAnalysis(cached)}</div>`;
    } else {
      bodyHtml = `
        <div class="card-body">
          <div class="analysis-loading">
            <div class="loading-spinner"></div>
            <span>AI 분석 중…</span>
          </div>
        </div>`;
    }
  }

  return `
    <article class="news-card${expanded ? ' expanded' : ''}"
             data-id="${esc(item.id)}"
             data-feed="${esc(cat.id)}"
             onclick="onCardClick('${esc(item.id)}','${esc(cat.id)}')">
      <div class="card-header">
        <div class="card-meta">
          <span class="card-date">${fmtDate(item.pubDate)}</span>
          ${item.source ? `<span class="card-source">${esc(item.source)}</span>` : ''}
          <a href="${esc(item.link)}" target="_blank" rel="noopener noreferrer"
             class="card-link" onclick="event.stopPropagation()">원문 ↗</a>
        </div>
        <p class="card-title">
          ${esc(trTitle || item.title)}
          <svg class="card-chevron" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2.5" aria-hidden="true">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </p>
        ${trTitle ? `<p class="card-title-orig">${esc(item.title)}</p>` : ''}
      </div>
      ${bodyHtml}
    </article>`;
}

function renderAnalysis(a) {
  const translatedTitleHtml = a.translated_title
    ? `<div class="analysis-section">
        <p class="section-title">🇰🇷 번역 제목</p>
        <p class="translated-title-text">${esc(a.translated_title)}</p>
      </div>`
    : '';

  const stocksHtml = (a.stocks?.length)
    ? `<div class="analysis-section">
        <p class="section-title">📈 관련 종목</p>
        <div class="stock-list">
          ${a.stocks.map(s => `
            <div class="stock-item">
              <div class="stock-header">
                <span class="stock-name">${esc(s.name || '')}</span>
                <span class="stock-ticker">${esc(s.ticker || '')}</span>
                <span class="stock-market ${(s.market||'').includes('KR')||(s.market||'').includes('KS')?'kr':'us'}">${esc(s.market || '')}</span>
              </div>
              <p class="stock-impact">${esc(s.impact || '')}</p>
            </div>`).join('')}
        </div>
      </div>`
    : '';

  const actionsHtml = (a.actions?.length)
    ? `<div class="analysis-section">
        <p class="section-title">💡 대응 방안</p>
        <ol class="actions-list">
          ${a.actions.map(x => `<li>${esc(x)}</li>`).join('')}
        </ol>
      </div>`
    : '';

  return `
    <div class="analysis-result">
      ${translatedTitleHtml}
      <div class="analysis-section">
        <p class="section-title">📋 요약</p>
        <p class="summary-text">${esc(a.summary || '')}</p>
      </div>
      <div class="analysis-section">
        <p class="section-title">📊 경제 영향 분석</p>
        <p class="analysis-text">${esc(a.analysis || '')}</p>
      </div>
      ${actionsHtml}
      ${stocksHtml}
      <p class="analysis-disclaimer">⚠️ AI 참고 자료 · 투자 자문 아님</p>
    </div>`;
}

// ── Analysis Queue — 직렬화, 호출 간 2초 ──────────────────────
const analysisQueue = [];
let queueRunning = false;

function onCardClick(newsId, catId) {
  console.log(`🖱️ 카드 클릭됨: ${newsId}`);
  if (DBG) {
    const k = S.apiKey || '';
    dbg(`--- 카드 클릭 ---`);
    dbg(`키 길이: ${k.length}`);
    dbg(`첫4자: "${k.substring(0, 4)}"`);
    dbg(`끝4자: "${k.substring(k.length - 4)}"`);
    dbg(`앞뒤 공백: ${k !== k.trim()}`);
    dbg(`charCode[0]: ${k.charCodeAt(0)}, charCode[-1]: ${k.charCodeAt(k.length - 1)}`);
    dbg(`localStorage gemini_key 길이: ${(localStorage.getItem('gemini_key') || '').length}`);
  }

  if (S.expandedIds.has(newsId)) {
    if (S.analyzingIds.has(newsId)) return;
    S.expandedIds.delete(newsId);
    patchCard(newsId, catId);
    return;
  }

  S.expandedIds.add(newsId);

  const cached = readCache(CFG.cachePrefix + 'ai_' + newsId, CFG.analysisTtl);
  if (cached) {
    console.log(`🔍 캐시 확인: 있음 → 저장된 분석 표시`);
    patchCard(newsId, catId);
    return;
  }
  console.log(`🔍 캐시 확인: 없음 → Gemini API 호출 예정`);

  if (!S.apiKey) {
    toast('API 키를 먼저 설정해 주세요');
    showModal('apiKeyModal');
    return;
  }

  if (S.analyzingIds.has(newsId) || analysisQueue.some(q => q.newsId === newsId)) return;

  analysisQueue.push({ newsId, catId, reason: '카드클릭' });
  patchCard(newsId, catId);
  drainQueue();
}

function retryAnalysis(newsId, catId) {
  if (S.analyzingIds.has(newsId) || analysisQueue.some(q => q.newsId === newsId)) return;
  analysisQueue.push({ newsId, catId, reason: '재시도' });
  patchCard(newsId, catId);
  drainQueue();
}

async function drainQueue() {
  if (queueRunning) {
    console.log(`⏳ drainQueue: 이미 실행 중 — 대기열에 유지됨 (${analysisQueue.length}개)`);
    return;
  }
  queueRunning = true;
  console.log(`▶️ drainQueue 시작 — 대기: ${analysisQueue.length}개`);

  while (analysisQueue.length > 0) {
    const { newsId, catId, reason } = analysisQueue.shift();

    if (!S.expandedIds.has(newsId)) continue;

    S.analyzingIds.add(newsId);
    patchCard(newsId, catId);

    try {
      const item = findItem(newsId);
      if (!item) throw new Error('뉴스 항목을 찾을 수 없음');
      await analyzeItem(item, catId, reason);
      S.analyzingIds.delete(newsId);
      patchCard(newsId, catId);
    } catch (err) {
      S.analyzingIds.delete(newsId);
      patchCardError(newsId, catId, err.message);
    }

    if (analysisQueue.length > 0) await sleep(2000);
  }

  console.log('⏹️ drainQueue 완료');
  queueRunning = false;
}

function patchCard(newsId, catId) {
  const el   = document.querySelector(`[data-id="${newsId}"]`);
  if (!el) return;
  const cat  = CATEGORIES.find(c => c.id === catId);
  const item = findItem(newsId);
  if (!cat || !item) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderCard(item, cat);
  el.replaceWith(tmp.firstElementChild);
}

function patchCardError(newsId, catId, msg) {
  const el = document.querySelector(`[data-id="${newsId}"]`);
  if (!el) return;
  const body = el.querySelector('.card-body');
  if (!body) return;

  const isNoModel  = msg.startsWith('[NO_MODEL]');
  const isNoQuota  = msg.startsWith('[NO_QUOTA]');
  const is429      = msg.includes('할당량');
  const needsModel = isNoModel || isNoQuota;
  const display    = isNoModel ? msg.replace('[NO_MODEL] ', '')
                   : isNoQuota ? msg.replace('[NO_QUOTA] ', '')
                   : is429     ? 'AI 할당량 초과입니다. 잠시 후 다시 시도해주세요.'
                               : msg || 'AI 분석 실패. 다시 시도해주세요.';

  body.innerHTML = `
    <div class="analysis-error">
      ${needsModel ? '⚠️' : '❌'} ${esc(display)}<br>
      ${needsModel
        ? `<button class="btn-retry" onclick="showSettings();event.stopPropagation()" style="margin-right:6px">⚙️ 설정에서 모델 변경</button>`
        : ''}
      <button class="btn-retry" onclick="retryAnalysis('${esc(newsId)}','${esc(catId)}');event.stopPropagation()">↺ 다시 시도</button>
    </div>`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── UI Controls ──────────────────────────────────────────────
function setTab(tab) {
  S.activeTab = tab;
  qsa('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  renderAll();
}

async function handleRefresh() {
  const btn = id('refreshBtn');
  btn.classList.add('spinning');
  try { await fetchAll(); } finally { btn.classList.remove('spinning'); }
}

function toggleTheme() {
  S.isDark = !S.isDark;
  ls('dark_mode', String(S.isDark));
  applyTheme();
}

function applyTheme() {
  document.documentElement.dataset.theme = S.isDark ? 'dark' : 'light';
  id('iconSun')?.classList.toggle('hidden', S.isDark);
  id('iconMoon')?.classList.toggle('hidden', !S.isDark);
  const meta = id('themeColorMeta');
  if (meta) meta.content = S.isDark ? '#0A1A0E' : '#2E7D32';
}

function renderChips() {
  const bar = id('chipsBar');
  if (!bar) return;
  bar.innerHTML = CATEGORIES.map(c => `
    <button class="chip${S.activeFilter.has(c.id) ? ' active' : ''}"
            data-feed="${c.id}"
            onclick="toggleFilter('${c.id}')"
            style="--chip-color:${c.color}">
      ${esc(c.name)}
    </button>`).join('');
}

function toggleFilter(catId) {
  if (S.activeFilter.has(catId)) S.activeFilter.delete(catId);
  else S.activeFilter.add(catId);
  renderChips();
  renderAll();
}

function togglePw(inputId) { /* no-op: inputs are type=text */ }

// ── Modal Helpers ────────────────────────────────────────────
function showModal(modalId) {
  const el = id(modalId);
  if (!el) return;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('visible'));
}

function hideModal(modalId) {
  const el = id(modalId);
  if (!el) return;
  el.classList.remove('visible');
  setTimeout(() => el.classList.add('hidden'), 280);
}

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay') && e.target.classList.contains('visible')) {
    hideModal(e.target.id);
  }
});

// ── Loading ──────────────────────────────────────────────────
function showLoading(msg) {
  const el  = id('globalLoading');
  const txt = id('loadingText');
  if (el)  el.classList.remove('hidden');
  if (txt) txt.textContent = msg || '로딩 중…';
}

function hideLoading() { id('globalLoading')?.classList.add('hidden'); }

function setUpdatedLabel(ts) {
  const el = id('lastUpdated');
  if (!el) return;
  if (!ts) { el.textContent = ''; return; }
  const d = new Date(ts);
  el.textContent = `${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())} 기준`;
}

// ── Toast ────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const el = id('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2800);
}

// ── Cache Helpers ────────────────────────────────────────────
function readCache(key, ttl) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { d, t } = JSON.parse(raw);
    if (ttl && Date.now() - t > ttl) return null;
    return d;
  } catch { return null; }
}

function writeCache(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ d: data, t: Date.now() })); }
  catch { /* storage full */ }
}

function saveNewsCache() {
  writeCache(CFG.cachePrefix + 'news', { news: S.news, ts: S.lastUpdated });
}

function loadNewsCache() {
  try {
    const raw = localStorage.getItem(CFG.cachePrefix + 'news');
    if (!raw) return null;
    const { d } = JSON.parse(raw);
    const { news, ts } = d;
    if (!news?.length) return null;
    if (Date.now() - ts > CFG.newsCacheTtl) return null;
    S.lastUpdated = ts;
    return news;
  } catch { return null; }
}

// ── DOM / String Utilities ───────────────────────────────────
function id(i)  { return document.getElementById(i); }
function qsa(s) { return document.querySelectorAll(s); }
function pad(n) { return String(n).padStart(2, '0'); }

function ls(key, val) {
  if (val === undefined) return localStorage.getItem(key);
  localStorage.setItem(key, val);
}

function esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function stripHtml(html) {
  return (html || '')
    .replace(/<[^>]*>/g,' ')
    .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#039;/g,"'")
    .replace(/\s+/g,' ').trim();
}

function makeId(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function findItem(newsId) {
  for (const g of S.news) {
    const item = g.items?.find(i => i.id === newsId);
    if (item) return item;
  }
  return null;
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d    = new Date(dateStr);
    if (isNaN(d)) return '';
    const diff = Date.now() - d.getTime();
    const min  = Math.floor(diff / 60000);
    const hr   = Math.floor(diff / 3600000);
    if (min < 1)  return '방금 전';
    if (min < 60) return `${min}분 전`;
    if (hr < 24)  return `${hr}시간 전`;
    return `${d.getMonth()+1}/${d.getDate()}`;
  } catch { return ''; }
}

// ── Debug Utilities ──────────────────────────────────────────
function debugStorage() {
  console.group('💾 localStorage 전체 현황');
  Object.keys(localStorage).forEach(k => {
    const raw = localStorage.getItem(k);
    try {
      const p = JSON.parse(raw);
      if (p?.t) {
        const age = Math.round((Date.now() - p.t) / 60000);
        const preview = typeof p.d === 'object' ? JSON.stringify(p.d).slice(0, 100) : String(p.d).slice(0, 100);
        console.log(`[${k}] ${age}분 전 저장 →`, preview);
      } else {
        console.log(`[${k}]`, String(raw).slice(0, 100));
      }
    } catch { console.log(`[${k}]`, String(raw).slice(0, 100)); }
  });
  console.groupEnd();
}
window.debugStorage = debugStorage;

// ── Service Worker ───────────────────────────────────────────
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js')
      .then(reg => {
        // 1시간마다 새 SW 있는지 자동 체크
        setInterval(() => reg.update(), 60 * 60 * 1000);
        // 페이지 로드 시에도 한 번 체크
        reg.update();
        // 새 SW 발견 시 자동 갱신
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'activated') {
                console.log('[SW] 새 버전 활성화 - 새로고침');
                window.location.reload();
              }
            });
          }
        });
      })
      .catch(e => console.warn('[SW]', e.message));
  }
}

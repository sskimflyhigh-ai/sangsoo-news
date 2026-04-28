/* ================================================================
   상수뉴스 — service-worker.js
   ================================================================ */

const CACHE_VER = 'sangsunews-v8';
const STATIC    = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
];

// ── Install ───────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VER)
      .then(cache => cache.addAll(STATIC))
      .then(() => self.skipWaiting())
  );
});

// ── Activate ─────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VER)
      .then(cache => cache.addAll(STATIC))
  );
});
// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;

  // ① http/https 요청만 처리 — chrome-extension:// 등 완전 차단
  if (!request.url.startsWith('http')) return;

  // ② GET 요청만 처리
  if (request.method !== 'GET') return;

  // ③ 외부 도메인(RSS, Gemini, allorigins 등)은 SW 개입 없이 그대로 통과
  //    앱 레벨(localStorage)에서 캐싱하므로 SW 캐시 불필요
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // ④ 같은 출처 정적 파일만 캐시-퍼스트
  event.respondWith(cacheFirst(request));
});

// ── Cache-first with safe cache.put ──────────────────────────
async function cacheFirst(request) {
  try {
    const cached = await caches.match(request);
    if (cached) {
      console.log('[SW] 캐시 적중:', request.url.split('/').pop() || '/');
      return cached;
    }

    console.log('[SW] 새 fetch:', request.url.split('/').pop() || '/');
    const response = await fetch(request);

    if (response.ok) {
      // cache.put 실패(크롬 확장 등 이상 환경)해도 응답은 정상 반환
      try {
        const cache = await caches.open(CACHE_VER);
        await cache.put(request, response.clone());
      } catch (e) {
        console.warn('[SW] 캐시 저장 건너뜀:', e.message);
      }
    }

    return response;
  } catch (e) {
    console.error('[SW] fetch 실패:', e.message);
    return new Response('오프라인 상태입니다.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

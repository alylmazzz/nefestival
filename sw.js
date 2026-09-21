const CACHE = 'nefestival-v7';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'favicon.svg',
  'assets/brand/leaf.svg',
  'assets/poster.jpg',
  'assets/hero.jpg',
  'assets/coast-center.jpg',
  'assets/stage.jpg',
  'assets/portrait.jpg',
  'assets/logo-area-full.jpg',
  'assets/bay-center.jpg',
  'assets/botanical-center.jpg',
  'assets/logos/goethe-institut.png',
  'assets/logos/fashion-revolution.png',
  'assets/logos/kultur-turizm-bakanligi.png',
  'assets/logos/ege-universitesi.png',
  'assets/logos/red-bull.png',
  'assets/logos/sporthink.png',
  'assets/logos/novus-global.png',
  'assets/logos/mindcorp.png',
  'assets/signpost.jpg'
];
self.addEventListener('install', event => {
  // yeni sürüm, eski sekmelerin kapanmasını beklemeden devreye girer
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const stale = (await caches.keys()).filter(key => key !== CACHE);
    await Promise.all(stale.map(key => caches.delete(key)));
    await self.clients.claim();
    // güncellemede (eski önbellek varsa) açık sekmeleri yeni sürüme taşı; ilk ziyarette yenileme yok
    if (stale.length) {
      const windows = await self.clients.matchAll({ type: 'window' });
      windows.forEach(win => win.navigate(win.url).catch(() => {}));
    }
  })());
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // sayfalar önce ağdan: yayındaki son sürüm hemen görünür; çevrimdışıyken önbellek devreye girer
  const isPage = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isPage) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(cache => cache.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('index.html')))
    );
    return;
  }
  event.respondWith(caches.match(req).then(cached => cached || fetch(req)));
});

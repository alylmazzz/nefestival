const CACHE = 'nefestival-v3';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'favicon.svg',
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
  'assets/signpost.jpg'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
  );
});
self.addEventListener('fetch', event => {
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});

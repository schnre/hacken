// Offline-Fähigkeit: App-Dateien und Kartenbilder werden zwischengespeichert.
// Bei jeder Änderung an den Dateien VERSION erhöhen.
const VERSION = 'hacken-v3';
const SHELL = ["./", "index.html", "regeln.html", "styles.css", "js/app.js", "js/engine.js", "js/net.js", "js/vendor/peerjs.min.js", "icon.svg", "manifest.webmanifest"];
const CARDS = ["cards/agm/00.webp", "cards/agm/01.webp", "cards/agm/02.webp", "cards/agm/03.webp", "cards/agm/04.webp", "cards/agm/05.webp", "cards/agm/06.webp", "cards/agm/07.webp", "cards/agm/08.webp", "cards/agm/10.webp", "cards/agm/11.webp", "cards/agm/12.webp", "cards/agm/13.webp", "cards/agm/14.webp", "cards/agm/15.webp", "cards/agm/16.webp", "cards/agm/17.webp", "cards/agm/18.webp", "cards/agm/20.webp", "cards/agm/21.webp", "cards/agm/22.webp", "cards/agm/23.webp", "cards/agm/24.webp", "cards/agm/25.webp", "cards/agm/26.webp", "cards/agm/27.webp", "cards/agm/28.webp", "cards/agm/30.webp", "cards/agm/31.webp", "cards/agm/32.webp", "cards/agm/33.webp", "cards/agm/34.webp", "cards/agm/35.webp", "cards/agm/36.webp", "cards/agm/37.webp", "cards/agm/38.webp", "cards/agm/sym0.webp", "cards/agm/sym1.webp", "cards/agm/sym2.webp", "cards/agm/sym3.webp", "cards/jegen/00.webp", "cards/jegen/01.webp", "cards/jegen/02.webp", "cards/jegen/03.webp", "cards/jegen/04.webp", "cards/jegen/05.webp", "cards/jegen/06.webp", "cards/jegen/07.webp", "cards/jegen/08.webp", "cards/jegen/10.webp", "cards/jegen/11.webp", "cards/jegen/12.webp", "cards/jegen/13.webp", "cards/jegen/14.webp", "cards/jegen/15.webp", "cards/jegen/16.webp", "cards/jegen/17.webp", "cards/jegen/18.webp", "cards/jegen/20.webp", "cards/jegen/21.webp", "cards/jegen/22.webp", "cards/jegen/23.webp", "cards/jegen/24.webp", "cards/jegen/25.webp", "cards/jegen/26.webp", "cards/jegen/27.webp", "cards/jegen/28.webp", "cards/jegen/30.webp", "cards/jegen/31.webp", "cards/jegen/32.webp", "cards/jegen/33.webp", "cards/jegen/34.webp", "cards/jegen/35.webp", "cards/jegen/36.webp", "cards/jegen/37.webp", "cards/jegen/38.webp", "cards/jegen/sym0.webp", "cards/jegen/sym1.webp", "cards/jegen/sym2.webp", "cards/jegen/sym3.webp"];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll([...SHELL, ...CARDS].map((url) => new Request(url, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Netzwerk zuerst (damit nach einem Deploy sofort die neue Version kommt), offline aus dem Cache.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html'))),
  );
});

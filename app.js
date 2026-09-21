const $ = (s, ctx = document) => ctx.querySelector(s);
const $$ = (s, ctx = document) => Array.from(ctx.querySelectorAll(s));

// hareket azaltma tercihinde logo ve amblemdeki dalga (SVG) animasyonlarını durdur
if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) {
  $$('.brand-symbol svg, .hero-emblem svg').forEach(svg => svg.pauseAnimations && svg.pauseAnimations());
}

// mobile nav
const menuToggle = $('.menu-toggle');
const nav = $('#main-nav');
if (menuToggle && nav) {
  menuToggle.addEventListener('click', () => {
    const expanded = menuToggle.getAttribute('aria-expanded') === 'true';
    menuToggle.setAttribute('aria-expanded', String(!expanded));
    menuToggle.classList.toggle('active', !expanded);
    nav.classList.toggle('open', !expanded);
  });
  $$('#main-nav a').forEach(link => link.addEventListener('click', () => {
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.classList.remove('active');
    nav.classList.remove('open');
  }));
}

// smooth scroll buttons
$$('[data-scroll]').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = document.querySelector(btn.getAttribute('data-scroll'));
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

// countdown
const targetDate = new Date('2027-06-29T12:00:00+03:00').getTime();
function updateCountdown(){
  const now = Date.now();
  let diff = Math.max(0, targetDate - now);
  const days = Math.floor(diff / (1000*60*60*24));
  diff -= days * 1000*60*60*24;
  const hours = Math.floor(diff / (1000*60*60));
  diff -= hours * 1000*60*60;
  const minutes = Math.floor(diff / (1000*60));
  diff -= minutes * 1000*60;
  const seconds = Math.floor(diff / 1000);
  $('#cd-days').textContent = days;
  $('#cd-hours').textContent = hours.toString().padStart(2,'0');
  $('#cd-minutes').textContent = minutes.toString().padStart(2,'0');
  $('#cd-seconds').textContent = seconds.toString().padStart(2,'0');
}
updateCountdown();
setInterval(updateCountdown, 1000);

// reveal on scroll
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) entry.target.classList.add('visible');
  });
}, { threshold: .14 });
$$('.reveal').forEach(el => observer.observe(el));

// parallax
const parallaxNodes = $$('.parallax');
function handleParallax() {
  const y = window.scrollY;
  parallaxNodes.forEach(node => {
    const depth = Number(node.dataset.depth || 0.1);
    node.style.transform = `translate3d(0, ${y * depth}px, 0)`;
  });
}
handleParallax();
window.addEventListener('scroll', handleParallax, { passive: true });

// tilt cards
function setupTilt(el) {
  const reset = () => { el.style.transform = 'perspective(1100px) rotateX(0deg) rotateY(0deg) translateY(0px)'; };
  el.addEventListener('mousemove', (e) => {
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const ry = ((x / r.width) - .5) * 10;
    const rx = ((.5 - y / r.height)) * 10;
    el.style.transform = `perspective(1100px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-4px)`;
  });
  el.addEventListener('mouseleave', reset);
  el.addEventListener('blur', reset);
}
$$('.tilt-card, .zone-card').forEach(setupTilt);

// MindCorp logosu: imlece göre diğer kartlardan daha belirgin eğilme
if (!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) {
  $$('.logo-mindcorp').forEach(el => {
    el.addEventListener('mousemove', (e) => {
      const r = el.getBoundingClientRect();
      const ry = ((e.clientX - r.left) / r.width - .5) * 36;
      const rx = (.5 - (e.clientY - r.top) / r.height) * 36;
      el.style.transform = `perspective(520px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-6px) scale(1.06)`;
    });
    el.addEventListener('mouseleave', () => { el.style.transform = ''; });
  });
}

// floating tips
const floatingTip = $('#floatingTip');
function showTip(text, x, y) {
  if (!floatingTip) return;
  floatingTip.textContent = text;
  floatingTip.classList.add('visible');
  const pad = 18;
  const maxX = window.innerWidth - floatingTip.offsetWidth - pad;
  const maxY = window.innerHeight - floatingTip.offsetHeight - pad;
  floatingTip.style.left = `${Math.min(Math.max(pad, x + 18), maxX)}px`;
  floatingTip.style.top = `${Math.min(Math.max(pad, y + 18), maxY)}px`;
}
function hideTip() {
  floatingTip?.classList.remove('visible');
}
$$('[data-tip], [data-bubble]').forEach(el => {
  const text = el.dataset.tip || el.dataset.bubble;
  el.addEventListener('mouseenter', (e) => showTip(text, e.clientX, e.clientY));
  el.addEventListener('mousemove', (e) => showTip(text, e.clientX, e.clientY));
  el.addEventListener('mouseleave', hideTip);
  el.addEventListener('focusin', () => {
    const r = el.getBoundingClientRect();
    showTip(text, r.left + 24, r.top + 24);
  });
  el.addEventListener('focusout', hideTip);
});

// etkinlik mekânı: haritadaki numara ile bölge kartı birlikte yanar
const venueItems = $$('.venue-pin, .venue-zone');
function setVenueZone(id) {
  venueItems.forEach(el => el.classList.toggle('is-active', el.dataset.zone === id));
}
venueItems.forEach(el => {
  el.addEventListener('mouseenter', () => setVenueZone(el.dataset.zone));
  el.addEventListener('mouseleave', () => setVenueZone(null));
  el.addEventListener('focusin', () => setVenueZone(el.dataset.zone));
  el.addEventListener('focusout', () => setVenueZone(null));
});
$$('.venue-pin').forEach(pin => {
  pin.addEventListener('click', (e) => {
    // kart zaten ekrandaysa kaydırma yok, yalnızca vurgula; değilse bağlantı karta götürür
    const card = document.getElementById(pin.getAttribute('href').slice(1));
    const r = card?.getBoundingClientRect();
    if (r && r.top >= 0 && r.bottom <= window.innerHeight) {
      e.preventDefault();
      setVenueZone(pin.dataset.zone);
    }
  });
});

// tabs
const tabButtons = $$('.tab-btn');
const tabPanels = $$('.tab-panel');
tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    tabPanels.forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    const panel = document.getElementById(btn.getAttribute('aria-controls'));
    panel?.classList.add('active');
  });
});

// forms/local persistence
const toast = $('#toast');
function showToast(message){
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 3200);
}

function saveSubmission(name, payload) {
  const key = 'nefestival-submissions';
  const current = JSON.parse(localStorage.getItem(key) || '[]');
  current.unshift({ id: crypto.randomUUID(), form: name, createdAt: new Date().toISOString(), payload });
  localStorage.setItem(key, JSON.stringify(current));
}

$$('.smart-form').forEach(form => {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    saveSubmission(form.dataset.formName || 'form', data);
    const status = $('.form-status', form);
    if (status) status.textContent = 'Başvurun kaydedildi. Festival ekibi seninle doğru aşamada iletişime geçebilecek şekilde not alındı.';
    form.reset();
    showToast('Bilgilerin kaydedildi.');
  });
});

// register service worker when available
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

'use strict';

(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // barre de navigation : plus opaque dès qu'on défile
  const nav = document.getElementById('nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 24);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // apparition au défilement
  const items = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduce) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach((el) => io.observe(el));
  } else {
    items.forEach((el) => el.classList.add('in'));
  }

  // léger effet de profondeur sur la capture du haut (souris uniquement)
  const frame = document.getElementById('heroFrame');
  if (frame && !reduce && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    const host = frame.parentElement;
    host.addEventListener('pointermove', (e) => {
      const r = host.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      frame.style.transform = `perspective(1100px) rotateY(${x * 7}deg) rotateX(${-y * 6}deg)`;
    });
    host.addEventListener('pointerleave', () => { frame.style.transform = ''; });
  }

  // visionneuse : un clic sur une capture l'agrandit
  const box = document.getElementById('lightbox');
  const big = box.querySelector('img');
  const close = () => { box.classList.remove('open'); big.removeAttribute('src'); };
  document.querySelectorAll('.shot img').forEach((img) => {
    img.addEventListener('click', () => {
      big.src = img.currentSrc || img.src;
      big.alt = img.alt;
      box.classList.add('open');
    });
  });
  box.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
})();

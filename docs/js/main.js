/**
 * 图提取 ImageGrab · 官网交互脚本
 * 功能：移动端汉堡菜单 / 导航吸顶阴影 / 滚动进入动画 / 导航高亮（滚动监听）
 * 原生 JS 实现，无任何依赖
 */
(() => {
  'use strict';

  /* ===================== 元素引用 ===================== */
  const navbar = document.getElementById('navbar');
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');
  const yearEl = document.getElementById('year');

  /* ===================== 1. 移动端汉堡菜单 ===================== */
  navToggle.addEventListener('click', () => {
    const open = document.body.classList.toggle('menu-open');
    navToggle.classList.toggle('open', open);
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    navToggle.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
  });

  // 点击菜单中的链接后自动收起（移动端体验）
  navLinks.addEventListener('click', (e) => {
    if (e.target.closest('a')) {
      document.body.classList.remove('menu-open');
      navToggle.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
    }
  });

  /* ===================== 2. 导航栏吸顶阴影 ===================== */
  function onScroll() {
    navbar.classList.toggle('scrolled', window.scrollY > 8);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ===================== 3. 滚动进入视口的淡入上移动画 ===================== */
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          revealObserver.unobserve(entry.target); // 只播放一次
        }
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
  );
  document.querySelectorAll('.reveal').forEach((el) => revealObserver.observe(el));

  /* ===================== 4. 导航高亮：滚动监听当前区块 ===================== */
  const sections = Array.from(document.querySelectorAll('section[id]'));
  const linkMap = new Map(); // sectionId -> 导航链接
  navLinks.querySelectorAll('.nav-link').forEach((link) => {
    const id = (link.getAttribute('href') || '').replace('#', '');
    if (id) linkMap.set(id, link);
  });

  const spyObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const link = linkMap.get(entry.target.id);
        if (!link) return;
        navLinks.querySelectorAll('.nav-link').forEach((l) => l.classList.remove('active'));
        link.classList.add('active');
      });
    },
    { rootMargin: '-40% 0px -55% 0px' } // 视口中段命中即认为当前区块
  );
  sections.forEach((sec) => spyObserver.observe(sec));

  /* ===================== 5. Footer 年份自动更新 ===================== */
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());
})();

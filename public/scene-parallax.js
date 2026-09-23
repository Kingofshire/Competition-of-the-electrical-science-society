(function () {
  const bgImage = document.querySelector('.scene-bg__image');
  if (!bgImage) return;

  let targetProgress = 0;
  let currentScale = 1;
  let currentY = 0;

  function computeTarget() {
    const scrollY = window.scrollY || window.pageYOffset;
    const maxScroll = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
    targetProgress = Math.min(scrollY / maxScroll, 1);
  }

  window.addEventListener('scroll', computeTarget, { passive: true });
  window.addEventListener('resize', computeTarget);
  computeTarget();

  function tick() {
    const targetScale = 1 + targetProgress * 0.3;
    const targetY = targetProgress * 30;


    currentScale += (targetScale - currentScale) * 0.06;
    currentY += (targetY - currentY) * 0.06;

    bgImage.style.transform = `scale(${currentScale.toFixed(4)}) translateY(${currentY.toFixed(2)}px)`;

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
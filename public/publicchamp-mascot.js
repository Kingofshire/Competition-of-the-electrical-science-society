(function () {
  const el = document.getElementById('champMascot');
  const card = document.getElementById('content');
  if (!el || !card) return;

  const OVERLAP = 55;

  function position() {
    const cardRect = card.getBoundingClientRect();
    const mascotWidth = el.offsetWidth;
    el.style.left = (cardRect.left + OVERLAP - mascotWidth) + 'px';
    el.style.top = (cardRect.top + 24) + 'px';
  }

  position();
  window.addEventListener('resize', position);


  let t = 0;
  function idleLoop() {
    t += 0.018;
    el.style.setProperty('--floatY', (Math.sin(t) * 6).toFixed(2) + 'px');
    el.style.setProperty('--tilt', (Math.sin(t * 0.6) * 3).toFixed(2) + 'deg');
    requestAnimationFrame(idleLoop);
  }
  requestAnimationFrame(idleLoop);

  function peekOutOnce() {
    el.classList.add('is-poking');
    setTimeout(() => el.classList.remove('is-poking'), 550);
  }


  requestAnimationFrame(() => {
    el.classList.add('is-visible');
    setTimeout(() => {
      el.classList.add('is-peeking');
      setTimeout(peekOutOnce, 500); 
    }, 600);
  });


  setInterval(peekOutOnce, 7000);


  el.addEventListener('click', peekOutOnce);
})();
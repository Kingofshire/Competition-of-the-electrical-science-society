// Reusable timer sound controller. One controller owns one audio element per page.
(function (global) {
  const MIN_RATE = 1;
  const MAX_RATE = 2.4;
  const RAMP_START_RATIO = 0.25;
  const STORAGE_KEY = 'quizTickMuted';
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function createTickSound() {
    let audio = null;
    let active = false;
    let muted = false;
    let hidden = false;
    let retryListener = null;
    let unavailable = false;
    let blocked = false;
    try { muted = typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEY) === 'true'; } catch (_) {}

    function removeRetry() {
      if (retryListener && typeof window !== 'undefined') {
        window.removeEventListener('pointerdown', retryListener);
        window.removeEventListener('keydown', retryListener);
      }
      retryListener = null;
    }

    function setup() {
      if (audio || unavailable || typeof window === 'undefined' || typeof Audio === 'undefined') return audio;
      try {
        audio = new Audio('/music/tick.mp3');
        audio.preload = 'auto';
        audio.loop = true;
        audio.onerror = () => {
          unavailable = true;
          console.warn('Quiz tick sound could not be loaded.');
          document.dispatchEvent(new Event('tick-sound-state'));
          removeRetry();
          audio.pause();
        };
        audio.load();
      } catch (error) {
        unavailable = true;
        console.warn('Quiz tick sound is unavailable:', error);
      }
      return audio;
    }

    async function play() {
      const player = setup();
      if (!player || unavailable || !active || muted || hidden) return;
      try {
        await player.play();
        blocked = false;
        if (typeof document !== 'undefined') document.dispatchEvent(new Event('tick-sound-state'));
        removeRetry();
      } catch (error) {
        if (error && error.name === 'NotSupportedError') {
          unavailable = true;
          console.warn('Quiz tick sound format is not supported:', error);
          document.dispatchEvent(new Event('tick-sound-state'));
          return;
        }
        // Autoplay restrictions are expected. Retry once on the next gesture.
        blocked = true;
        document.dispatchEvent(new Event('tick-sound-state'));
        retryListener = () => { removeRetry(); void play(); };
        window.addEventListener('pointerdown', retryListener, { once: true });
        window.addEventListener('keydown', retryListener, { once: true });
      }
    }

    function onVisibilityChange() {
      hidden = document.visibilityState === 'hidden';
      if (hidden) { if (audio) audio.pause(); }
      else if (active && !muted) void play();
    }

    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);
    setup(); // Preload before the user starts the quiz.

    return {
      start() { active = true; if (audio) audio.currentTime = 0; void play(); },
      stop() { active = false; removeRetry(); if (audio) { audio.pause(); audio.currentTime = 0; } },
      pause() { if (audio) audio.pause(); },
      resume() { if (active) void play(); },
      setProgress(remainingRatio) {
        if (!audio) return;
        const progress = clamp((1 - clamp(remainingRatio, 0, 1) - (1 - RAMP_START_RATIO)) / RAMP_START_RATIO, 0, 1);
        const rate = clamp(MIN_RATE + (MAX_RATE - MIN_RATE) * progress, 0.25, 4);
        try { audio.playbackRate = rate; } catch (_) {}
      },
      setMuted(value) {
        muted = Boolean(value);
        try { localStorage.setItem(STORAGE_KEY, String(muted)); } catch (_) {}
        if (muted) { removeRetry(); if (audio) audio.pause(); }
        else if (active && !hidden) void play();
        return muted;
      },
      isMuted() { return muted || unavailable || blocked; },
      destroy() { this.stop(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange); }
    };
  }

  global.quizTickSound = createTickSound();
})(typeof window !== 'undefined' ? window : globalThis);

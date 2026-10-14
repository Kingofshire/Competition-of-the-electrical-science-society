// Reusable timer sound controller. One controller owns one audio element per page.
(function (global) {
  const MIN_RATE = 1;
  const MAX_RATE = 2.4;
  const RAMP_START_RATIO = 0.5;
  const STORAGE_KEY = 'quizTickMuted';
  const RATE_STORAGE_KEY = 'quizTickPlaybackRate';
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function createTickSound() {
    let audio = null;
    let audioLoadPromise = null;
    let active = false;
    let muted = false; // Initialize muted state
    let hidden = false;
    let retryListener = null;
    let unavailable = false;
    let blocked = false;
    let playbackRate = MIN_RATE;
    try { muted = typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEY) === 'true'; } catch (_) {}
    try {
      const savedRate = Number(sessionStorage.getItem(RATE_STORAGE_KEY));
      if (Number.isFinite(savedRate)) playbackRate = clamp(savedRate, MIN_RATE, MAX_RATE);
    } catch (_) {}

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
        audio = new Audio();
        audio.preload = 'none';
        audio.loop = true;
        audio.playbackRate = playbackRate;
        audio.onerror = () => {
          unavailable = true;
          console.warn('Quiz tick sound could not be loaded.');
          document.dispatchEvent(new Event('tick-sound-state'));
          removeRetry();
          audio.pause();
        };
        audioLoadPromise = global.loadAudioSource('tick').then(sourceUrl => {
          audio.src = sourceUrl;
          audio.load();
          return audio;
        }).catch(error => {
          unavailable = true;
          console.warn('Quiz tick sound could not be loaded:', error);
          document.dispatchEvent(new Event('tick-sound-state'));
          return null;
        });
      } catch (error) {
        unavailable = true;
        console.warn('Quiz tick sound is unavailable:', error);
      }
      return audio;
    }

    function handlePlayFailure(error) {
      if (error && error.name === 'NotSupportedError') {
        unavailable = true;
        console.warn('Quiz tick sound format is not supported:', error);
        document.dispatchEvent(new Event('tick-sound-state'));
        return;
      }
      blocked = true;
      document.dispatchEvent(new Event('tick-sound-state'));
      retryListener = () => { removeRetry(); void play(); };
      window.addEventListener('pointerdown', retryListener, { once: true });
      window.addEventListener('keydown', retryListener, { once: true });
    }

    function play() {
      const player = setup();
      if (!player || unavailable || !active || muted || hidden) return Promise.resolve();
      const requestPlayback = () => {
        if (!player.src || unavailable || !active || muted || hidden) return;
        let playPromise;
        try {
          playPromise = player.play();
        } catch (error) {
          handlePlayFailure(error);
          return;
        }
        Promise.resolve(playPromise).then(() => {
        blocked = false;
        if (typeof document !== 'undefined') document.dispatchEvent(new Event('tick-sound-state'));
        removeRetry();
        }).catch(handlePlayFailure);
      };

      if (player.src) {
        requestPlayback();
        return Promise.resolve();
      }

      return audioLoadPromise ? audioLoadPromise.then(requestPlayback) : Promise.resolve();
    }

    function onVisibilityChange() {
      hidden = document.visibilityState === 'hidden';
      if (hidden) { if (audio) audio.pause(); }
      else if (active && !muted) void play();
    }

    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);
    setup(); // Preload before the user starts the quiz.

    return {
      start() {
        if (!active && audio) {
          audio.currentTime = 0;
          try { audio.playbackRate = playbackRate; } catch (_) {}
        }
        active = true;
        void play();
      },
      stop() {
        active = false;
        removeRetry();
        if (audio) {
          audio.pause();
          audio.currentTime = 0;
          playbackRate = MIN_RATE;
          try { sessionStorage.removeItem(RATE_STORAGE_KEY); } catch (_) {}
          try { audio.playbackRate = MIN_RATE; } catch (_) {}
        }
      },
      pause() { if (audio) audio.pause(); },
      resume() { if (active) void play(); },
      setProgress(remainingRatio) {
        if (!audio) return;
        const ratio = Number.isFinite(Number(remainingRatio)) ? clamp(Number(remainingRatio), 0, 1) : 1;
        const progress = clamp((1 - ratio - (1 - RAMP_START_RATIO)) / RAMP_START_RATIO, 0, 1);
        const rate = clamp(MIN_RATE + (MAX_RATE - MIN_RATE) * progress, 0.25, 4);
        playbackRate = rate;
        try {
          audio.playbackRate = rate;
          sessionStorage.setItem(RATE_STORAGE_KEY, String(rate));
        } catch (_) {}
      },
      setMuted(value) {
        muted = Boolean(value);
        try { localStorage.setItem(STORAGE_KEY, String(muted)); } catch (_) {}
        if (muted) { removeRetry(); if (audio) audio.pause(); }
        else if (active && !hidden) void play();
        return muted;
      },
      toggleMuted() {
        const shouldUnmute = muted || blocked || unavailable;
        this.setMuted(!shouldUnmute);
        return !shouldUnmute;
      },
      isMuted() { return muted || unavailable || blocked; },
      destroy() {
        this.stop();
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
        global.releaseAudioSources();
      }
    };
  }

  global.quizTickSound = createTickSound();
})(typeof window !== 'undefined' ? window : globalThis);

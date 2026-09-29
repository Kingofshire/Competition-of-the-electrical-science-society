// One background track for the login/register page, shared across its mode tabs.
(function (global) {
  const MUSIC_URL = '/music/Instrumental%20Hook%20(1).mp3';
  const VOLUME = 0.35;
  const STORAGE_KEY = 'authBackgroundMusicMuted';

  function createBackgroundMusic() {
    let audio = null;
    let muted = false;
    let unavailable = false;
    let blocked = false;
    let enabled = true;
    let retryListener = null;
    let wasPlayingBeforeHidden = false;
    let fadeTimer = null;
    try { muted = typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEY) === 'true'; } catch (_) {}

    function notifyState() {
      if (typeof document !== 'undefined') document.dispatchEvent(new Event('bg-music-state'));
    }

    function removeRetry() {
      if (retryListener && typeof window !== 'undefined') {
        ['pointerdown', 'keydown', 'touchstart'].forEach(type => window.removeEventListener(type, retryListener));
      }
      retryListener = null;
    }

    function setup() {
      if (audio || unavailable || typeof window === 'undefined' || typeof Audio === 'undefined') return audio;
      try {
        audio = new Audio(MUSIC_URL);
        audio.preload = 'auto';
        audio.loop = true;
        audio.volume = VOLUME;
        audio.onerror = () => {
          unavailable = true;
          console.warn('Background music could not be loaded.');
          removeRetry();
          notifyState();
          audio.pause();
        };
        audio.load();
      } catch (error) {
        unavailable = true;
        console.warn('Background music is unavailable:', error);
        notifyState();
      }
      return audio;
    }

    async function play() {
      const player = setup();
      if (!player || !enabled || unavailable || muted || document.visibilityState === 'hidden') return;
      if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
      player.volume = VOLUME;
      try {
        await player.play();
        if (!enabled || muted) {
          player.pause();
          player.currentTime = 0;
          return;
        }
        blocked = false;
        wasPlayingBeforeHidden = true;
        removeRetry();
        notifyState();
      } catch (error) {
        if (!enabled || muted) return;
        if (error && error.name === 'NotSupportedError') {
          unavailable = true;
          console.warn('Background music format is not supported:', error);
          notifyState();
          return;
        }
        // Autoplay can be denied; wait for one real user gesture and retry.
        blocked = true;
        wasPlayingBeforeHidden = false;
        notifyState();
        if (!retryListener && typeof window !== 'undefined') {
          retryListener = () => { removeRetry(); void play(); };
          ['pointerdown', 'keydown', 'touchstart'].forEach(type => window.addEventListener(type, retryListener, { once: true }));
        }
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        wasPlayingBeforeHidden = Boolean(audio && !audio.paused);
        if (audio) audio.pause();
      } else if (wasPlayingBeforeHidden && !muted) {
        void play();
      }
    }

    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);
    const music = {
      play,
      stop(fadeMs = 0) {
        enabled = false;
        removeRetry();
        wasPlayingBeforeHidden = false;
        blocked = false;
        if (!audio) return Promise.resolve();
        if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
        if (!fadeMs || audio.paused) {
          audio.pause();
          audio.currentTime = 0;
          audio.volume = VOLUME;
          notifyState();
          return Promise.resolve();
        }
        const startingVolume = audio.volume;
        const startedAt = Date.now();
        return new Promise(resolve => {
          fadeTimer = setInterval(() => {
            const progress = Math.min(1, (Date.now() - startedAt) / fadeMs);
            audio.volume = startingVolume * (1 - progress);
            if (progress >= 1) {
              clearInterval(fadeTimer);
              fadeTimer = null;
              audio.pause();
              audio.currentTime = 0;
              audio.volume = VOLUME;
              notifyState();
              resolve();
            }
          }, 25);
        });
      },
      setMuted(value) {
        muted = Boolean(value);
        try { localStorage.setItem(STORAGE_KEY, String(muted)); } catch (_) {}
        if (muted) {
          enabled = false;
          wasPlayingBeforeHidden = false;
          removeRetry();
          if (audio) audio.pause();
        } else {
          enabled = true;
          void play();
        }
        notifyState();
        return muted;
      },
      isMuted() { return muted || unavailable || blocked; },
      destroy() {
        void this.stop();
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
    setup(); // Preload before trying autoplay on page load.
    return music;
  }

  global.authBackgroundMusic = createBackgroundMusic();
})(typeof window !== 'undefined' ? window : globalThis);

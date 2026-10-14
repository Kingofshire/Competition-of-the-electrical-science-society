(function (global) {
  const audioUrls = new Map();

  async function loadAudioSource(track) {
    if (!audioUrls.has(track)) {
      const sourcePromise = fetch(`/media/audio/${encodeURIComponent(track)}`)
        .then(response => {
          if (!response.ok) throw new Error(`Audio request failed (${response.status})`);
          return response.arrayBuffer();
        })
        .then(buffer => URL.createObjectURL(new Blob([buffer], { type: 'audio/mpeg' })))
        .catch(error => {
          audioUrls.delete(track);
          throw error;
        });
      audioUrls.set(track, sourcePromise);
    }
    return audioUrls.get(track);
  }

  function releaseAudioSources() {
    for (const sourcePromise of audioUrls.values()) {
      sourcePromise.then(url => URL.revokeObjectURL(url)).catch(() => {});
    }
    audioUrls.clear();
  }

  global.loadAudioSource = loadAudioSource;
  global.releaseAudioSources = releaseAudioSources;
})(window);

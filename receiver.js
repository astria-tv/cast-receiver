'use strict';

/**
 * Astria Cast Receiver
 *
 * Built on Cast Application Framework (CAF) v3.
 *
 * When you're ready to deploy:
 *   1. Host this directory at https://cast.astria.tv/
 *   2. Register the URL in the Google Cast SDK Developer Console:
 *      https://cast.google.com/publish
 *   3. Replace the receiverApplicationId 'CC1AD845' (Default Media Receiver)
 *      in useChromecast.ts with your new Application ID.
 *
 * Media notes:
 *   - The HLS URL sent by the sender already has the JWT embedded in the path
 *     (e.g. /olaris/m/stream/.../jwt/TOKEN/...) — no extra auth headers needed.
 *   - Content type is application/x-mpegURL (HLS), segments are fMP4.
 *   - Stream type is BUFFERED (seekable VOD).
 */

const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();

// ── Playback config (cross-origin media) ──────────────────────────────────────
// The receiver is hosted at cast.astria.tv but media is served from a different
// origin.  Configure CAF to allow cross-origin manifest and segment requests so
// HLS content loads without "Domains, protocols and ports must match" errors.

const playbackConfig = new cast.framework.PlaybackConfig();

playbackConfig.manifestRequestHandler = (requestInfo) => {
  requestInfo.withCredentials = false;
};

playbackConfig.segmentRequestHandler = (requestInfo) => {
  requestInfo.withCredentials = false;
};

playbackConfig.licenseRequestHandler = (requestInfo) => {
  requestInfo.withCredentials = false;
};

// ── DOM references ────────────────────────────────────────────────────────────

const els = {
  overlay:      document.getElementById('overlay'),
  poster:       document.getElementById('poster'),
  title:        document.getElementById('title'),
  subtitle:     document.getElementById('subtitle'),
  progressFill: document.getElementById('progress-fill'),
  timeCurrent:  document.getElementById('time-current'),
  timeTotal:    document.getElementById('time-total'),
  buffering:    document.getElementById('buffering'),
  errorDisplay: document.getElementById('error-display'),
};

function showError(msg) {
  els.errorDisplay.textContent = msg;
  els.errorDisplay.style.display = 'flex';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

// ── Overlay visibility ────────────────────────────────────────────────────────

let hideTimer = null;

/** Show the info overlay. Pass autohideMs > 0 to auto-dismiss after that delay. */
function showOverlay(autohideMs = 0) {
  clearTimeout(hideTimer);
  els.overlay.classList.add('visible');
  if (autohideMs > 0) {
    hideTimer = setTimeout(() => els.overlay.classList.remove('visible'), autohideMs);
  }
}

function hideOverlay() {
  clearTimeout(hideTimer);
  els.overlay.classList.remove('visible');
}

// ── Metadata ──────────────────────────────────────────────────────────────────

/**
 * Populate the UI from a CAF MediaMetadata object.
 * The sender (Player.tsx) passes: title, subtitle, and posterUrl (images[0].url).
 */
function applyMetadata(metadata) {
  if (!metadata) return;

  els.title.textContent = metadata.title ?? '';
  els.subtitle.textContent = metadata.subtitle ?? '';

  // images[0].url = posterUrl — not sent today but handled defensively
  const posterUrl = metadata.images?.[0]?.url;
  if (posterUrl) {
    els.poster.style.backgroundImage = `url(${posterUrl})`;
    els.poster.hidden = false;
  } else {
    els.poster.hidden = true;
  }
}

// ── Progress ──────────────────────────────────────────────────────────────────

function updateProgress() {
  try {
    const mediaInfo = playerManager.getMediaInformation();
    const duration = mediaInfo?.duration ?? 0;
    if (!(duration > 0)) return;

    // Try getCurrentTimeSec first (CAF v3), fall back to media element
    let currentTime = 0;
    if (typeof playerManager.getCurrentTimeSec === 'function') {
      currentTime = playerManager.getCurrentTimeSec();
    } else {
      const video = document.getElementById('media-player');
      currentTime = video?.currentTime ?? 0;
    }

    const pct = Math.min(100, (currentTime / duration) * 100);
    els.progressFill.style.width = `${pct}%`;
    els.timeCurrent.textContent = formatTime(currentTime);
    els.timeTotal.textContent = formatTime(duration);
  } catch (_) {
    // Silently ignore — progress will update on the next tick
  }
}

// ── Message interceptors ──────────────────────────────────────────────────────

/**
 * Intercept LOAD requests to populate the UI before playback starts.
 * We return the request unmodified — the CAF handles actual loading.
 */
playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.LOAD,
  (request) => {
    applyMetadata(request.media?.metadata);
    showOverlay();
    return request;
  },
);

// ── Event listeners ───────────────────────────────────────────────────────────

playerManager.addEventListener(
  cast.framework.events.EventType.PLAYING,
  () => {
    els.errorDisplay.style.display = 'none';
    showOverlay(4000);
  },
);

playerManager.addEventListener(
  cast.framework.events.EventType.PAUSE,
  () => showOverlay(),
);

playerManager.addEventListener(
  cast.framework.events.EventType.ENDED,
  () => hideOverlay(),
);

playerManager.addEventListener(
  cast.framework.events.EventType.ERROR,
  (event) => {
    const detail = event.detailedErrorCode ?? 'unknown';
    const reason = event.reason ?? '';
    const url = event.url ?? '';
    const inner = event.error?.message ?? event.error ?? '';
    showError(`Error ${detail}\n${reason}\n${inner}\n${url}`);
  },
);

playerManager.addEventListener(
  cast.framework.events.EventType.BUFFERING,
  ({ isBuffering }) => {
    els.buffering.hidden = !isBuffering;
    // Keep overlay visible while buffering so the user sees what's loading
    if (isBuffering) showOverlay();
  },
);

playerManager.addEventListener(
  cast.framework.events.EventType.TIME_UPDATE,
  () => updateProgress(),
);

// ── Start ─────────────────────────────────────────────────────────────────────

context.start({
  playbackConfig,
  // Use our plain <video> element instead of <cast-media-player>.
  // This gives us full UI control — no built-in overlay/controls.
  mediaElement: document.getElementById('media-player'),
  // Force Shaka Player for HLS instead of native playback.  Native HLS sets the
  // video src directly to the cross-origin manifest URL, which triggers the
  // Chromecast frame security error "Domains, protocols and ports must match".
  // Shaka fetches via XHR (respects CORS) and uses MSE — the video src becomes
  // a same-origin blob: URL, avoiding the restriction entirely.
  useShakaForHls: true,
});

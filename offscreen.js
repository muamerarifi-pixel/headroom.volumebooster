let ctx = null;
let graph = null;
let sourceNode = null;
let stream = null;
let currentSettings = defaultSettings();

async function ensureGraph() {
  if (!ctx) ctx = new AudioContext({ latencyHint: "interactive" });
  if (ctx.state === "suspended") await ctx.resume();
  if (!graph) {
    graph = createGraph(ctx);
    graph.output.connect(ctx.destination);
  }
  return { ctx, graph };
}

function teardownSource() {
  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch {
      /* already disconnected */
    }
    sourceNode = null;
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

async function startTab(streamId, settings) {
  teardownSource();
  currentSettings = normalizeSettings(settings);
  const audio = await ensureGraph();
  let media;
  try {
    media = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
  } catch (err) {
    throw new Error(
      err instanceof Error && err.message
        ? err.message
        : "Chrome refused tab capture. Reload the page and try again.",
    );
  }
  if (!media.getAudioTracks().length) {
    media.getTracks().forEach((t) => t.stop());
    throw new Error("This tab has no audio track.");
  }
  stream = media;
  sourceNode = audio.ctx.createMediaStreamSource(media);
  sourceNode.connect(audio.graph.input);
  audio.graph.applySettings(currentSettings);
  const track = media.getAudioTracks()[0];
  track.addEventListener("ended", () => {
    if (stream !== media) return;
    teardownSource();
    chrome.runtime.sendMessage({ type: "TRACK_ENDED" }).catch(() => {});
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return;
  (async () => {
    try {
      switch (message.type) {
        case "OFFSCREEN_START_TAB":
          await startTab(message.streamId, message.settings);
          sendResponse({ ok: true });
          return;
        case "OFFSCREEN_STOP":
          teardownSource();
          sendResponse({ ok: true });
          return;
        case "OFFSCREEN_SETTINGS":
          currentSettings = normalizeSettings(message.settings);
          graph?.applySettings(currentSettings);
          sendResponse({ ok: true });
          return;
        case "OFFSCREEN_METERS":
          sendResponse({ ok: true, meters: graph && stream ? graph.meters() : ZERO_METERS });
          return;
        default:
          sendResponse({ ok: false, error: "Unknown processor message." });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : "Capture failed." });
    }
  })();
  return true;
});

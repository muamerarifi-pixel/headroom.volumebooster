/*
 * Headroom page bridge (runs in the page's own JS world).
 * Players such as `new Audio(url).play()` never enter the DOM, so the page
 * engine can't see them. When play() is called on a media element that is
 * detached or inside a shadow root, hand the element to the engine.
 */
(() => {
  const KEY = Symbol.for("headroom.bridge");
  const proto = HTMLMediaElement.prototype;
  if (proto[KEY]) return;
  Object.defineProperty(proto, KEY, { value: true });

  const nativePlay = proto.play;
  proto.play = {
    play() {
      try {
        if (!this.isConnected || this.getRootNode() !== document) {
          document.dispatchEvent(new MouseEvent("headroom:media", { relatedTarget: this }));
        }
      } catch {
        /* never break the page */
      }
      return nativePlay.apply(this, arguments);
    },
  }.play;
})();

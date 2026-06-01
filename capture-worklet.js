// AudioWorkletProcessor that batches mic samples and posts them to the main
// thread. Runs on the audio render thread — no main-thread jank, no
// ScriptProcessor deprecation warnings, no buffer-size compromises.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // ~5ms batches at 48 kHz keeps trigger latency low while limiting
    // postMessage rate to ~190/s. The buffer size is sample-rate-relative.
    this.batchSize = Math.max(128, Math.round(sampleRate * 0.005));
    this.batch = new Float32Array(this.batchSize);
    this.pos = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const room = this.batchSize - this.pos;
      const take = Math.min(room, ch.length - i);
      this.batch.set(ch.subarray(i, i + take), this.pos);
      this.pos += take;
      i += take;
      if (this.pos >= this.batchSize) {
        // transfer ownership of the buffer to avoid copying
        this.port.postMessage(this.batch, [this.batch.buffer]);
        this.batch = new Float32Array(this.batchSize);
        this.pos = 0;
      }
    }
    return true;
  }
}

registerProcessor("capture", CaptureProcessor);

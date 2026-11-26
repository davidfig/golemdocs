// Hands what the microphone hears to the page, about a twentieth of a second at a time (see recorder.ts). A file of its own: it runs
// in the audio thread.
class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.parts = [];
    this.frames = 0;
  }

  process([input]) {
    if (input.length) {
      this.parts.push(input.map((channel) => channel.slice()));
      this.frames += input[0].length;
      if (this.frames >= 2048) {
        this.port.postMessage(this.parts);
        this.parts = [];
        this.frames = 0;
      }
    }
    return true;
  }
}
registerProcessor('golem-recorder', Recorder);

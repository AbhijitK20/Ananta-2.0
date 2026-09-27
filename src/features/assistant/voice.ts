"use client";

/**
 * Voice, on the Web Speech API.
 *
 * `SpeechRecognition` for input and `speechSynthesis` for output: both are in the
 * browser, which is the entire point. There is no audio leaving the device for
 * transcription, no second secret to protect, no per-minute bill, and no third
 * party to be down during a demo.
 *
 * The cost of that choice, stated plainly: `webkitSpeechRecognition` is not in
 * every browser (Firefox has no implementation at all), and recognition is done
 * by the browser vendor, which means the transcript quality is whatever Chrome or
 * Safari think it is. The interfaces below exist so that swapping in a server-side
 * provider is a change to this file and to nothing else — `SpeechToTextProvider`
 * and `TextToSpeechProvider` are the seams, and the UI only ever calls them.
 *
 * ## The state machine
 *
 *   idle -> listening -> processing -> speaking -> idle
 *                  \-> error -> idle
 *
 * Every state has a visible label and a text equivalent, because "a dot changed
 * colour" is not an accessible status and a screen-reader user has no way to know
 * the app stopped listening.
 */

export type VoiceState = "idle" | "listening" | "processing" | "speaking" | "error";

export const VOICE_LABEL: Record<VoiceState, string> = {
  idle: "Voice off",
  listening: "Listening",
  processing: "Working that out",
  speaking: "Speaking",
  error: "Voice unavailable",
};

/** What a person is told, in words, next to the dot. */
export const VOICE_HINT: Record<VoiceState, string> = {
  idle: "Press the microphone to talk.",
  listening: "Listening. Say what you would like to do.",
  processing: "Got it. Working out an answer.",
  speaking: "Reading the answer aloud.",
  error: "Voice is not available. You can type instead.",
};

export interface SpeechToTextProvider {
  readonly supported: boolean;
  /** Why unsupported, for the UI to show instead of a dead button. */
  readonly reason: string;
  start(onPartial: (text: string) => void, onFinal: (text: string) => void): void;
  stop(): void;
  abort(): void;
}

export interface TextToSpeechProvider {
  readonly supported: boolean;
  speak(text: string, onEnd: () => void): void;
  cancel(): void;
}

// The DOM lib ships `SpeechRecognition` only in some versions and always under a
// vendor prefix, so the type is declared here rather than fought with.
interface SpeechRecognitionEventLike extends Event {
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/**
 * Browser speech recognition.
 *
 * `continuous: false` with interim results, deliberately. A traveller asks one
 * question and stops; a continuously-listening recogniser picks up the assistant
 * reading its own answer back and turns a two-turn conversation into a feedback
 * loop.
 */
export function browserSpeechToText(lang = "en-IN"): SpeechToTextProvider {
  const Ctor = recognitionCtor();
  let active: SpeechRecognitionLike | null = null;

  return {
    supported: Ctor !== null,
    reason:
      Ctor === null
        ? "This browser has no speech recognition. Firefox does not implement it; Chrome, Edge and Safari do. Typing works everywhere."
        : "",
    start(onPartial, onFinal) {
      if (!Ctor) return;
      const recognition = new Ctor();
      active = recognition;
      recognition.lang = lang;
      recognition.continuous = false;
      recognition.interimResults = true;
      let final = "";
      recognition.onresult = (event) => {
        let interim = "";
        for (let index = 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (!result) continue;
          if (result.isFinal) final += result[0]?.transcript ?? "";
          else interim += result[0]?.transcript ?? "";
        }
        if (interim.length > 0) onPartial(final + interim);
        if (final.length > 0) onFinal(final.trim());
      };
      recognition.onerror = (event) => {
        // "no-speech" and "aborted" are ordinary, not failures. Reporting them as
        // errors is what makes a mic button feel broken after a deliberate stop.
        if (event.error === "no-speech" || event.error === "aborted") onFinal("");
      };
      try {
        recognition.start();
      } catch {
        // start() throws if it is already running, which a double-tap causes.
        // Ignoring it is right: the existing session is the one the user wants.
      }
    },
    stop() {
      // stop() ends the session and still fires onresult with the final text;
      // abort() throws the audio away. Only stop() is right for "I'm done talking".
      active?.stop();
    },
    abort() {
      active?.abort();
      active = null;
    },
  };
}

export function browserTextToSpeech(lang = "en-IN"): TextToSpeechProvider {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  return {
    supported: synth !== null && synth !== undefined,
    speak(text, onEnd) {
      if (!synth || text.trim().length === 0) {
        onEnd();
        return;
      }
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      utterance.rate = 1.02;
      // A long answer read at the default pitch is tiring; slightly slower and
      // flat is easier to follow for a traveller who is also reading.
      utterance.pitch = 1;
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        onEnd();
      };
      utterance.onend = finish;
      // Safari fires neither onend nor onerror when a tab is backgrounded
      // mid-utterance, so the state machine would sit in "speaking" forever.
      // A bounded backstop is the only thing that recovers it.
      const backstop = setTimeout(finish, Math.max(8_000, text.length * 90));
      utterance.onend = () => {
        clearTimeout(backstop);
        finish();
      };
      synth.speak(utterance);
    },
    cancel() {
      synth?.cancel();
    },
  };
}

/**
 * Advance the state machine.
 *
 * Exported as a pure function so the transitions are testable without a browser
 * and so an illegal transition is a failed test rather than a stuck UI. `stop` is
 * accepted from any non-idle state because a traveller can always change their
 * mind mid-answer.
 */
export function nextVoiceState(current: VoiceState, event: "start" | "partial" | "final" | "speaking" | "end" | "error" | "stop"): VoiceState {
  switch (event) {
    case "start":
      return "listening";
    case "partial":
      return current === "listening" ? "listening" : current;
    case "final":
      return "processing";
    case "speaking":
      return "speaking";
    case "end":
      return "idle";
    case "error":
      return "error";
    case "stop":
      return "idle";
    default:
      return current;
  }
}

"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  Loader2,
  Mic,
  MicOff,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import {
  TALK_TO_DRAW_SAMPLE_CHIPS,
  type StrokeTimelineEntry,
} from "@/lib/jev/talk-to-draw";

interface BrowserSpeechRecognitionAlternative {
  transcript: string;
}

interface BrowserSpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: BrowserSpeechRecognitionAlternative;
}

interface BrowserSpeechRecognitionEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: BrowserSpeechRecognitionResult;
  };
}

interface BrowserSpeechRecognitionErrorEvent {
  error: string;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onresult: ((ev: BrowserSpeechRecognitionEvent) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type BrowserSpeechRecognitionCtor = new () => BrowserSpeechRecognition;

function getSpeechRecognitionCtor(): BrowserSpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    SpeechRecognition?: BrowserSpeechRecognitionCtor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

interface TalkToDrawBarProps {
  active: boolean;
  latestStroke: StrokeTimelineEntry | null;
  lastTranscript: string;
  evaluating: boolean;
  isHeuristic: boolean;
  hasActiveTalkGhost: boolean;
  onUtterance: (utterance: string, spokenAt: number) => void;
  onAcceptGhost: () => void;
  onDismissGhost: () => void;
  onClose: () => void;
}

export function TalkToDrawBar({
  active,
  latestStroke,
  lastTranscript,
  evaluating,
  isHeuristic,
  hasActiveTalkGhost,
  onUtterance,
  onAcceptGhost,
  onDismissGhost,
  onClose,
}: TalkToDrawBarProps) {
  const [speechSupported] = useState<boolean>(
    () => getSpeechRecognitionCtor() !== null
  );
  const [micEnabled, setMicEnabled] = useState<boolean>(
    () => getSpeechRecognitionCtor() !== null
  );
  const [listening, setListening] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [interimText, setInterimText] = useState("");
  const [typedInput, setTypedInput] = useState("");

  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const onUtteranceRef = useRef(onUtterance);
  const micEnabledRef = useRef(micEnabled);

  useEffect(() => {
    onUtteranceRef.current = onUtterance;
  }, [onUtterance]);

  useEffect(() => {
    micEnabledRef.current = micEnabled;
  }, [micEnabled]);

  useEffect(() => {
    if (!active || !micEnabled || !speechSupported) {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          // ignore stop errors
        }
        recognitionRef.current = null;
      }
      return;
    }

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;

    let cancelled = false;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onstart = () => {
      if (!cancelled) {
        setListening(true);
        setMicError(null);
      }
    };

    rec.onresult = (ev) => {
      if (cancelled) return;
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const transcript = res?.[0]?.transcript?.trim() ?? "";
        if (!transcript) continue;
        if (res.isFinal) {
          setInterimText("");
          onUtteranceRef.current(transcript, Date.now());
        } else {
          interim = interim ? `${interim} ${transcript}` : transcript;
        }
      }
      if (interim) {
        setInterimText(interim);
      }
    };

    rec.onerror = (ev) => {
      if (cancelled) return;
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        setMicError("Mic blocked — type below");
        setMicEnabled(false);
        setListening(false);
      } else if (ev.error === "audio-capture") {
        setMicError("No mic detected — type below");
        setMicEnabled(false);
        setListening(false);
      } else if (ev.error !== "no-speech" && ev.error !== "aborted") {
        setMicError("Voice paused — type below");
      }
    };

    rec.onend = () => {
      if (cancelled) return;
      setListening(false);
      if (micEnabledRef.current) {
        try {
          rec.start();
        } catch {
          // ignore restart error when browser blocks auto-restart
        }
      }
    };

    recognitionRef.current = rec;
    try {
      rec.start();
    } catch {
      queueMicrotask(() => {
        if (!cancelled) {
          setMicError("Voice unavailable — type below");
          setMicEnabled(false);
          setListening(false);
        }
      });
    }

    return () => {
      cancelled = true;
      rec.onstart = null;
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch {
        // ignore abort error
      }
      recognitionRef.current = null;
      setListening(false);
      setInterimText("");
    };
  }, [active, micEnabled, speechSupported]);

  if (!active) return null;

  const handleSubmitTyped = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = typedInput.trim();
    if (!cleaned) return;
    onUtterance(cleaned, Date.now());
    setTypedInput("");
  };

  const strokeLabel = latestStroke
    ? latestStroke.kind === "arrow"
      ? "Linked to arrow"
      : latestStroke.kind === "freedraw"
        ? "Linked to ink stroke"
        : `Linked to ${latestStroke.label || latestStroke.kind}`
    : "Draw an arrow or shape, then speak";

  return (
    <div
      role="region"
      aria-label="Talk-to-Draw voice and text sketch bar"
      onPointerDown={(e) => e.stopPropagation()}
      className="jev-glass pointer-events-auto flex w-full max-w-[min(660px,calc(100vw-24px))] flex-col gap-2 rounded-2xl border border-[#2563EB]/30 px-3 py-2.5 shadow-[0_18px_46px_-18px_rgba(37,99,235,0.28)] dark:border-[#38BDF8]/30"
    >
      {/* Top status row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!speechSupported}
            aria-pressed={micEnabled && speechSupported}
            aria-label={
              !speechSupported
                ? "Microphone unavailable in this browser, using type mode"
                : micEnabled
                  ? "Mute live microphone"
                  : "Enable live microphone"
            }
            onClick={() => {
              setMicError(null);
              setMicEnabled((v) => !v);
            }}
            title={
              !speechSupported
                ? "Web Speech API unavailable in this browser — type below"
                : micEnabled
                  ? "Mute microphone"
                  : "Enable live microphone"
            }
            className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:min-h-[28px] ${
              listening && micEnabled
                ? "bg-[#D94E28] text-white"
                : "bg-secondary text-foreground hover:bg-secondary/80"
            }`}
          >
            {listening && micEnabled ? (
              <>
                <span className="relative flex h-2 w-2" aria-hidden="true">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
                </span>
                <Mic className="h-3 w-3" aria-hidden="true" />
                <span>Listening</span>
              </>
            ) : (
              <>
                <MicOff className="h-3 w-3" aria-hidden="true" />
                <span>
                  {!speechSupported
                    ? "Type mode"
                    : micError
                      ? "Mic off"
                      : "Mic paused"}
                </span>
              </>
            )}
          </button>

          <span className="max-w-full truncate font-mono text-[10.5px] font-medium text-[#1D4ED8] dark:text-[#38BDF8]">
            {strokeLabel}
          </span>

          {micError && (
            <span
              role="status"
              aria-live="polite"
              className="font-mono text-[10px] text-muted-foreground"
            >
              · {micError}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {evaluating ? (
            <span
              role="status"
              aria-live="polite"
              className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden="true" />
              Parsing…
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-border/75 bg-card/85 px-2 py-0.5 font-mono text-[9.5px] font-medium text-muted-foreground">
              <Sparkles
                className="h-2.5 w-2.5 text-[#1D4ED8] dark:text-[#38BDF8]"
                aria-hidden="true"
              />
              {isHeuristic ? "Heuristic" : "AI"}
            </span>
          )}

          {hasActiveTalkGhost && (
            <>
              <button
                type="button"
                onClick={onAcceptGhost}
                className="inline-flex min-h-[36px] items-center gap-1 rounded-full bg-[#2563EB] px-3 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-[#1D4ED8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-[#38BDF8] dark:text-[#0F172A] sm:min-h-0 sm:px-2.5 sm:py-0.5 sm:text-[10.5px]"
              >
                <Check className="h-3 w-3" aria-hidden="true" />
                <span>Accept</span>
                <kbd className="font-mono text-[9px] opacity-80">↵</kbd>
              </button>
              <button
                type="button"
                onClick={onDismissGhost}
                className="min-h-[36px] rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:px-2 sm:py-0.5 sm:text-[10.5px]"
              >
                Dismiss
              </button>
            </>
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label="Close Talk-to-Draw"
            title="Close Talk-to-Draw (V)"
            className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:min-w-0"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Live interim transcript or last spoken phrase */}
      {(interimText || lastTranscript) && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-xl bg-secondary/60 px-2.5 py-1 text-[11.5px]"
        >
          <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.06em] text-muted-foreground">
            {interimText ? "Hearing" : "Heard"}
          </span>
          <span className="truncate font-medium italic text-foreground">
            &ldquo;{interimText || lastTranscript}&rdquo;
          </span>
        </div>
      )}

      {/* Universal inline text fallback + submit */}
      <form onSubmit={handleSubmitTyped} className="flex items-center gap-1.5">
        <input
          value={typedInput}
          onChange={(e) => setTypedInput(e.target.value)}
          placeholder="Speak or type while drawing… e.g. 'this caches the reads'"
          aria-label="Talk-to-Draw utterance input"
          className="h-9 min-w-0 flex-1 rounded-xl border border-border/80 bg-card/85 px-2.5 text-xs text-foreground placeholder:text-muted-foreground/85 outline-none focus:border-[#2563EB] focus-visible:ring-2 focus-visible:ring-ring dark:focus:border-[#38BDF8] sm:h-8"
        />
        <button
          type="submit"
          disabled={!typedInput.trim()}
          className="inline-flex h-9 shrink-0 items-center gap-1 rounded-xl bg-foreground px-3 text-xs font-semibold text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 sm:h-8 sm:px-2.5"
        >
          <Send className="h-3 w-3" aria-hidden="true" />
          <span>Sketch</span>
        </button>
      </form>

      {/* 1-click sample utterance chips */}
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-0.5 font-mono text-[9.5px] uppercase tracking-[0.05em] text-muted-foreground">
          Try:
        </span>
        {TALK_TO_DRAW_SAMPLE_CHIPS.map((phrase) => (
          <button
            key={phrase}
            type="button"
            onClick={() => onUtterance(phrase, Date.now())}
            className="min-h-[32px] max-w-full truncate rounded-full border border-border/75 bg-card/80 px-2.5 py-0.5 text-[10.5px] font-medium text-foreground/90 transition-colors hover:border-[#2563EB]/50 hover:bg-[#2563EB]/10 hover:text-[#1D4ED8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:border-[#38BDF8]/50 dark:hover:text-[#38BDF8] sm:min-h-0 sm:px-2"
          >
            &ldquo;{phrase}&rdquo;
          </button>
        ))}
      </div>
    </div>
  );
}

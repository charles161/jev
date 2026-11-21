"use client";

import React, { useState } from "react";
import {
  IconApiCard,
  IconClass,
  IconClose,
  IconEnter,
  IconEntity,
  IconEstimate,
  IconSequence,
  IconSpark,
  IconStateMachine,
  IconWand,
  type IconComponent,
} from "@/brand/icons";
import { matchPaletteCommands, parsePaletteInput, type PaletteCommand } from "@/lib/jev/notation-packs";
import { PROMPT_SPARKS } from "@/lib/jev/templates";

const COMMAND_ICONS: Record<PaletteCommand, IconComponent> = {
  er: IconEntity,
  seq: IconSequence,
  state: IconStateMachine,
  class: IconClass,
  api: IconApiCard,
  estimate: IconEstimate,
};

interface ThoughtBarProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  hasPredictions?: boolean;
  /** What Tab completes the typed text to ("api" -> "API Gateway"), shown as a hint. */
  completion?: string | null;
  onChange: (val: string) => void;
  /** Enter with text: a /command runs, anything else applies the highlighted option. */
  onSubmit: (prompt: string) => void;
  onClear: () => void;
  /** Tab with text: complete the word first, then cycle the three options. */
  onTypedTab?: (reverse: boolean) => void;
  onEmptyTab?: (reverse?: boolean) => void;
  onEmptyEnter?: () => void;
  onEmptyUndo?: () => void;
  onEmptyRedo?: () => void;
}

export function ThoughtBar({
  inputRef,
  value,
  hasPredictions = false,
  completion,
  onChange,
  onSubmit,
  onClear,
  onTypedTab,
  onEmptyTab,
  onEmptyEnter,
  onEmptyUndo,
  onEmptyRedo,
}: ThoughtBarProps) {
  const [focused, setFocused] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const isCommand = value.trimStart().startsWith("/");
  const commands = isCommand ? matchPaletteCommands(value) : [];
  const activeCommand = commands.length > 0 ? commands[Math.min(commandIndex, commands.length - 1)] : null;

  const runCommand = (command: PaletteCommand) => {
    const typed = parsePaletteInput(value);
    onSubmit(typed && typed.command === command ? value.trim() : `/${command}`);
    setCommandIndex(0);
  };

  const handleCommandKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): boolean => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (commands.length === 0) return true;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setCommandIndex((i) => (Math.min(i, commands.length - 1) + step + commands.length) % commands.length);
      return true;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (activeCommand) onChange(`/${activeCommand.command} `);
      return true;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (activeCommand) runCommand(activeCommand.command);
      return true;
    }
    return false;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const hasText = value.trim().length > 0;

    if (isCommand && handleCommandKeyDown(e)) return;

    if (e.key === "Tab") {
      if (hasText && onTypedTab) {
        e.preventDefault();
        onTypedTab(e.shiftKey);
        return;
      }
      if (!hasText && hasPredictions && onEmptyTab) {
        e.preventDefault();
        onEmptyTab(e.shiftKey);
        return;
      }
    }

    if (e.key === "Enter") {
      if (hasText) {
        e.preventDefault();
        onSubmit(value.trim());
        return;
      }
      if (!hasText && hasPredictions && onEmptyEnter) {
        e.preventDefault();
        onEmptyEnter();
        return;
      }
    }

    if (e.key === "Escape") {
      e.preventDefault();
      if (hasText) {
        onClear();
      } else {
        inputRef.current?.blur();
      }
      return;
    }

    // Undo / Redo canvas smoothly when the Thought Bar is focused & empty
    if (!hasText && (e.metaKey || e.ctrlKey)) {
      const lower = e.key.toLowerCase();
      if (lower === "z") {
        e.preventDefault();
        if (e.shiftKey) onEmptyRedo?.();
        else onEmptyUndo?.();
        return;
      }
      if (lower === "y") {
        e.preventDefault();
        onEmptyRedo?.();
      }
    }
  };

  const showCompletion = Boolean(
    completion && value.trim() && completion.toLowerCase() !== value.trim().toLowerCase()
  );

  return (
    <div className="pointer-events-auto flex w-full max-w-[min(660px,100vw)] flex-col items-center gap-2 px-3">
      {/* Quick starter sparks when focused, empty, and no prediction strip is already open */}
      {focused && !value.trim() && !hasPredictions && (
        <div className="flex max-w-full flex-wrap items-center justify-center gap-1.5">
          {PROMPT_SPARKS.map((spark) => (
            <button
              key={spark.label}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(spark.prompt);
              }}
              className="jev-glass inline-flex min-h-[36px] max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-[11.5px] font-medium text-foreground/90 shadow-xs transition-all hover:border-[#D94E28]/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
            >
              <IconSpark className="h-3 w-3 shrink-0 text-[#C2411D] dark:text-[#FF8562]" aria-hidden="true" />
              <span className="truncate">{spark.label}</span>
            </button>
          ))}
        </div>
      )}

      {focused && isCommand && (
        <div
          role="listbox"
          id="thought-bar-commands"
          aria-label="Commands"
          className="jev-glass w-full max-w-[420px] rounded-2xl p-1.5 shadow-[0_14px_40px_-14px_rgba(15,23,42,0.28)]"
        >
          {commands.length === 0 ? (
            <p className="px-2.5 py-2 text-[11.5px] text-muted-foreground">
              No such command. Try /er, /seq, /state, /class, /api or /estimate.
            </p>
          ) : (
            commands.map((c) => {
              const Icon = COMMAND_ICONS[c.command];
              const active = c === activeCommand;
              return (
                <div
                  key={c.command}
                  role="option"
                  id={`thought-bar-command-${c.command}`}
                  aria-selected={active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    runCommand(c.command);
                  }}
                  onMouseEnter={() => setCommandIndex(commands.indexOf(c))}
                  className={`flex min-h-[40px] cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 sm:min-h-0 ${
                    active ? "bg-[#D94E28]/12" : "hover:bg-secondary"
                  }`}
                >
                  <Icon
                    className={`h-4 w-4 shrink-0 ${active ? "text-[#C2411D] dark:text-[#FF8562]" : "text-foreground/75"}`}
                    aria-hidden="true"
                  />
                  <span className="w-[4.6rem] shrink-0 font-mono text-[12px] font-semibold text-foreground">/{c.command}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-semibold leading-tight text-foreground">{c.title}</span>
                    <span className="block truncate text-[10.5px] leading-tight text-muted-foreground">{c.hint}</span>
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Main Speed-of-Thought Input */}
      <div
        className={`jev-glass flex w-full items-center gap-2 rounded-2xl px-3 py-2 shadow-[0_14px_40px_-14px_rgba(15,23,42,0.28)] transition-all sm:gap-2.5 sm:px-3.5 ${
          focused
            ? "ring-2 ring-ring/55 border-ring/55"
            : "hover:border-foreground/20"
        }`}
      >
        <div
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-[#D94E28] text-white shadow-xs"
        >
          <IconWand className="h-3.5 w-3.5" />
        </div>

        <input
          ref={inputRef}
          type="text"
          value={value}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setCommandIndex(0);
            onChange(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          aria-controls={focused && isCommand ? "thought-bar-commands" : undefined}
          aria-autocomplete="list"
          aria-activedescendant={focused && activeCommand ? `thought-bar-command-${activeCommand.command}` : undefined}
          aria-label="Describe a component or diagram flow to draw"
          placeholder='Type what comes next ("api", "redis"), a flow ("app -> api") or / for commands…'
          className="min-h-[36px] min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground placeholder:text-muted-foreground/85 focus:outline-none sm:min-h-0"
        />

        {value.trim() ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {showCompletion && (
              <span
                aria-label={`Tab completes to ${completion}`}
                className="hidden items-center gap-1 rounded-md bg-[#2563EB]/10 px-2 py-0.5 font-mono text-[10.5px] font-medium text-[#1D4ED8] dark:bg-[#38BDF8]/15 dark:text-[#38BDF8] sm:inline-flex"
              >
                <kbd className="font-semibold">Tab</kbd>
                <span className="max-w-[140px] truncate">{completion}</span>
              </span>
            )}
            <button
              type="button"
              onClick={onClear}
              aria-label="Clear prompt"
              className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:min-w-0"
            >
              <IconClose className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onSubmit(value.trim())}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-xl bg-[#D94E28] px-3 py-1.5 text-xs font-semibold text-white shadow-xs transition-transform active:scale-95 hover:bg-[#C1411E] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card sm:min-h-0"
            >
              Draw
              <IconEnter className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <kbd className="hidden rounded-md border border-border bg-secondary px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground sm:inline-block">
            /
          </kbd>
        )}
      </div>
    </div>
  );
}

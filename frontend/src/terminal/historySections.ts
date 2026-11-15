import type { IMarker, Terminal } from "xterm";

export interface HistorySection {
  start: number;
  end: number;
  commands: number;
}

// Read only displayed output. Never inspect onData, shell input or credentials.
// Deliberately conservative: unfamiliar prompts use ordinary output sections.
const prompt = /^(?:\([^\r\n)]{1,60}\) )?(?:[\w.-]+@[\w.-]+:[^\r\n]*?[$#%]|\[[\w.-]+@[\w.-]+[^\]\r\n]*\][$#%]|PS [A-Za-z]:\\[^\r\n]*>|[A-Za-z]:\\[^\r\n]*>)\s+\S/;

export function createHistorySections(terminal: Terminal) {
  let checkpoint: IMarker | undefined;
  let checkpointLine = 0;
  let prompts: number[] = [];
  let dirty = true;
  let reflowed = false;
  let sections: HistorySection[] = [];
  let revision = 0;

  return {
    invalidate(reflow = false) { dirty = true; reflowed ||= reflow; },
    read() {
      if (!dirty) return { sections, revision };
      dirty = false;
      const buffer = terminal.buffer.active;
      const start = !reflowed && checkpoint && !checkpoint.isDisposed && terminal.markers.includes(checkpoint) ? checkpoint.line : 0;
      const shift = start - checkpointLine;
      prompts = start ? prompts.map((row) => row + shift).filter((row) => row >= 0 && row < start) : [];
      for (let row = start; row < buffer.length; row++) {
        const line = buffer.getLine(row);
        if (line && !line.isWrapped && prompt.test(line.translateToString(true, 0, Math.min(terminal.cols, 240)))) {
          prompts.push(row);
        }
      }
      checkpoint?.dispose();
      checkpoint = terminal.registerMarker(-buffer.cursorY);
      checkpointLine = buffer.baseY;
      reflowed = false;

      const end = buffer.length - 1;
      sections = [];
      // Keep log streams and an isolated long command navigable as output pages.
      if (prompts.length < 2) {
        const page = Math.max(20, terminal.rows);
        for (let row = 0; row <= end; row += page) {
          sections.push({ start: row, end: Math.min(end, row + page - 1), commands: 0 });
        }
      } else {
        if (prompts[0] > 0) sections.push({ start: 0, end: prompts[0] - 1, commands: 0 });
        prompts.forEach((row, index) => sections.push({ start: row, end: (prompts[index + 1] ?? end + 1) - 1, commands: 1 }));
      }
      revision += 1;
      return { sections, revision };
    },
    dispose() { checkpoint?.dispose(); },
  };
}

// Dense histories combine adjacent sections, rather than silently dropping any.
export function groupHistorySections(sections: HistorySection[], capacity: number): HistorySection[] {
  const count = Math.max(1, Math.floor(capacity));
  if (sections.length <= count) return sections;
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * sections.length / count);
    const end = Math.floor((index + 1) * sections.length / count);
    return {
      start: sections[start].start,
      end: sections[end - 1].end,
      commands: sections.slice(start, end).reduce((total, section) => total + section.commands, 0),
    };
  });
}

export function historySectionAtLine(sections: HistorySection[], line: number, maxTop: number) {
  if (line >= maxTop) return sections.length - 1;
  const next = sections.findIndex((section) => section.start > line);
  return next < 0 ? sections.length - 1 : Math.max(0, next - 1);
}

// Equal visual space per section, continuous scrolling inside long output blocks.
export function historyOffsetToLine(sections: HistorySection[], offset: number, maxTop: number) {
  const bounded = Math.min(sections.length, Math.max(0, offset));
  const index = Math.min(sections.length - 1, Math.floor(bounded));
  const start = Math.min(maxTop, sections[index].start);
  const end = Math.min(maxTop, sections[index + 1]?.start ?? maxTop);
  return Math.round(start + (end - start) * (bounded - index));
}

export function historyLineToOffset(sections: HistorySection[], line: number, maxTop: number) {
  if (line >= maxTop) return sections.length;
  const index = historySectionAtLine(sections, line, maxTop);
  const start = sections[index].start;
  const end = Math.min(maxTop, sections[index + 1]?.start ?? maxTop);
  return index + (end > start ? (line - start) / (end - start) : 0);
}

export function readHistoryPreview(terminal: Terminal, section: HistorySection) {
  const lines: string[] = [];
  const buffer = terminal.buffer.active;
  // A preview is ephemeral and bounded. React renders it as plain text.
  for (let row = section.start; row <= Math.min(section.end, section.start + 11) && lines.length < 4; row++) {
    const text = buffer.getLine(row)?.translateToString(true, 0, Math.min(terminal.cols, 180));
    if (text?.trim()) lines.push(text);
  }
  return { title: lines[0] ?? "Empty output", body: lines.slice(1).join("\n") };
}

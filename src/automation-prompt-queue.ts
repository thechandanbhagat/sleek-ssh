export type PromptQueueContext = Readonly<{ sessionId: string; contextKey: string; provider: string }>;
export type QueuedAgentPrompt = Readonly<{ id: number; text: string }>;
export const AUTOMATION_QUEUE_LIMITS = Object.freeze({ prompts: 20, characters: 16_000 });

function validateContext(context: PromptQueueContext): PromptQueueContext {
  if (!context || [context.sessionId, context.contextKey, context.provider].some(value => typeof value !== "string" || !value.trim() || value.includes("\0"))
    || !["claude", "codex"].includes(context.provider)) throw new Error("Choose a connected SSH session and a supported agent for this queue.");
  return Object.freeze({ sessionId: context.sessionId, contextKey: context.contextKey, provider: context.provider });
}

export function createAutomationPromptQueue() {
  let prompts: readonly QueuedAgentPrompt[] = Object.freeze([]);
  let context: PromptQueueContext | null = null;
  let paused = false;
  let sequence = 0;
  const matches = (candidate: PromptQueueContext, transport = true) => !context || (context.contextKey === candidate.contextKey
    && context.provider === candidate.provider && (!transport || context.sessionId === candidate.sessionId));
  const clearIfEmpty = () => { if (!prompts.length) { context = null; paused = false; } };
  const requireId = (id: number) => { if (!Number.isSafeInteger(id) || id < 1) throw new Error("Choose a queued prompt."); };
  return Object.freeze({
    state: () => Object.freeze({ prompts, context, paused }),
    enqueue(text: string, target: PromptQueueContext, first = false): QueuedAgentPrompt {
      const validated = validateContext(target);
      if (typeof text !== "string" || !text.trim() || text.length > AUTOMATION_QUEUE_LIMITS.characters || text.includes("\0")) {
        throw new Error(`Enter a prompt of at most ${AUTOMATION_QUEUE_LIMITS.characters} characters without NUL characters.`);
      }
      if (prompts.length >= AUTOMATION_QUEUE_LIMITS.prompts) throw new Error(`Queue up to ${AUTOMATION_QUEUE_LIMITS.prompts} prompts per SSH session.`);
      if (!matches(validated)) throw new Error("This queue belongs to another SSH connection or agent. Resume its original session first.");
      if (!prompts.length) { context = validated; paused = false; }
      const prompt = Object.freeze({ id: ++sequence, text: text.trim() });
      prompts = Object.freeze(first ? [prompt, ...prompts] : [...prompts, prompt]);
      return prompt;
    },
    next(target: PromptQueueContext): QueuedAgentPrompt | null {
      const validated = validateContext(target);
      if (paused || !prompts.length) return null;
      if (!matches(validated)) { paused = true; throw new Error("The SSH connection or agent changed. Review and resume this queue explicitly."); }
      return prompts[0];
    },
    pause() { paused = true; },
    resume(target: PromptQueueContext) {
      const validated = validateContext(target);
      if (!matches(validated, false)) throw new Error("Queued prompts can only resume in their original SSH session and agent.");
      if (prompts.length) context = validated;
      paused = false;
    },
    remove(id: number) {
      requireId(id);
      prompts = Object.freeze(prompts.filter(prompt => prompt.id !== id)); clearIfEmpty();
    },
    moveEarlier(id: number) {
      requireId(id);
      const index = prompts.findIndex(prompt => prompt.id === id);
      if (index < 1) return;
      prompts = Object.freeze([...prompts.slice(0, index - 1), prompts[index], prompts[index - 1], ...prompts.slice(index + 1)]);
    },
    prioritize(id: number) {
      requireId(id);
      const prompt = prompts.find(candidate => candidate.id === id);
      if (prompt) prompts = Object.freeze([prompt, ...prompts.filter(candidate => candidate.id !== id)]);
    },
  });
}

export function renderAutomationPromptQueue(options: Readonly<{
  root: HTMLElement;
  prompts: readonly QueuedAgentPrompt[];
  pendingId: number | null;
  paused: boolean;
  canSteer: boolean;
  toggleDisabled: boolean;
  remove: (id: number) => void;
  moveEarlier: (id: number) => void;
  steer: (id: number) => void;
  togglePause: () => void;
}>): void {
  const document_ = options.root.ownerDocument;
  const icon = (path: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const icons = {
    queue: icon('<path d="M5 5v14M9 6h10M9 12h7M9 18h10"/>'),
    steer: icon('<path d="M4 5v5a4 4 0 0 0 4 4h11m-5-5 5 5-5 5"/>'),
    remove: icon('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/>'),
    more: icon('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  };
  options.root.replaceChildren(...options.prompts.map((prompt, index) => {
    const row = document_.createElement("li"); row.className = "automation-queue-item";
    const leading = document_.createElement("span"); leading.className = "automation-queue-icon"; leading.innerHTML = icons.queue;
    const text = document_.createElement("span"); text.className = "automation-queue-prompt";
    text.textContent = prompt.text; text.title = prompt.text;
    const button = (label: string, content: string, action: () => void, svg = "") => {
      const control = document_.createElement("button"); control.type = "button";
      control.className = "automation-queue-action"; control.innerHTML = svg;
      if (content) control.append(document_.createTextNode(content));
      control.setAttribute("aria-label", label); control.title = label;
      control.disabled = options.pendingId === prompt.id;
      control.addEventListener("click", action); return control;
    };
    const steer = button(`Steer with queued prompt ${index + 1}`, "Steer", () => options.steer(prompt.id), icons.steer);
    steer.classList.add("automation-queue-steer"); steer.disabled ||= !options.canSteer;
    const remove = button(`Remove queued prompt ${index + 1}`, "", () => options.remove(prompt.id), icons.remove);
    const more = document_.createElement("details"); more.className = "automation-queue-more";
    const summary = document_.createElement("summary"); summary.innerHTML = icons.more;
    summary.setAttribute("aria-label", `More options for queued prompt ${index + 1}`); summary.title = `More options for queued prompt ${index + 1}`;
    const menu = document_.createElement("div"); menu.className = "automation-queue-menu";
    const up = button(`Move queued prompt ${index + 1} earlier`, "Move earlier", () => options.moveEarlier(prompt.id));
    up.disabled ||= index === 0 || options.pendingId !== null;
    menu.append(up);
    if (index === 0) {
      const label = options.paused ? "Resume queue" : "Pause queue";
      const toggle = button(label, label, options.togglePause);
      toggle.dataset.automationControl = "automation-queue-resume"; toggle.disabled = options.toggleDisabled;
      menu.append(toggle);
    }
    menu.addEventListener("click", event => { if ((event.target as Element).closest("button")) more.open = false; });
    more.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); more.open = false; summary.focus(); } });
    more.append(summary, menu);
    if (options.paused && index === 0) {
      const paused = document_.createElement("span"); paused.className = "automation-queue-paused"; paused.textContent = "Paused";
      text.prepend(paused);
    }
    row.replaceChildren(leading, text, steer, remove, more); return row;
  }));
}

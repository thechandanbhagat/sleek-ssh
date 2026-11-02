import type { NamedSnippet } from "./named-snippets.ts";
import { snippetAvailableInFolder, type SnippetFolder } from "./named-snippet-scope.ts";

type ListOptions = Readonly<{
  list: HTMLUListElement;
  snippets: readonly NamedSnippet[];
  folder: SnippetFolder | null;
  use: (snippet: NamedSnippet) => void;
  edit: (snippet: NamedSnippet) => void;
  remove: (snippet: NamedSnippet) => void;
  toggleScope: (snippet: NamedSnippet) => void;
}>;

const SHELL_LABELS = Object.freeze({ posix: "Bash / Zsh", powershell: "PowerShell", cmd: "Command Prompt" });
const ICONS = Object.freeze({
  edit: '<path d="M16 3a2.1 2.1 0 0 1 3 3L8 17H4v-4zM13 6l3 3"/>',
  remove: '<path d="M4 6h16M9 6V3h6v3M6 6l1 14h10l1-14M10 10v6M14 10v6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9H3z"/>',
  shared: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18"/>',
});

export function renderNamedSnippetList(options: ListOptions): void {
  const { list } = options;
  const document = list.ownerDocument;
  const icon = (name: keyof typeof ICONS) => {
    const span = document.createElement("span");
    span.className = "named-snippet-icon"; span.setAttribute("aria-hidden", "true");
    span.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;
    return span;
  };
  const button = (className: string, label: string, onClick: () => void) => {
    const element = document.createElement("button");
    element.type = "button"; element.className = className;
    element.setAttribute("aria-label", label); element.addEventListener("click", onClick);
    return element;
  };
  list.replaceChildren(...options.snippets.map(snippet => {
    const item = document.createElement("li");
    item.className = "named-snippet-item"; item.dataset.snippetId = snippet.id;
    const use = button("named-snippet-use", `Use ${snippet.name}`, () => options.use(snippet));
    use.dataset.unavailable = String(!snippetAvailableInFolder(snippet, options.folder));
    use.disabled = use.dataset.unavailable === "true";
    use.title = snippet.folder && use.dataset.unavailable === "true"
      ? `Use in ${snippet.folder.username}@${snippet.folder.host}:${snippet.folder.path} and its subfolders` : snippet.template;
    const name = document.createElement("span");
    name.className = "named-snippet-name"; name.textContent = snippet.name;
    use.append(name);
    const actions = document.createElement("div");
    actions.className = "named-snippet-row-actions";
    const edit = button("named-snippet-icon-button", `Edit ${snippet.name}`, () => options.edit(snippet));
    edit.title = "Edit snippet"; edit.append(icon("edit"));
    const remove = button("named-snippet-icon-button", `Remove ${snippet.name}`, () => options.remove(snippet));
    remove.title = "Remove snippet"; remove.append(icon("remove"));
    actions.append(edit, remove);
    const meta = document.createElement("div");
    meta.className = "named-snippet-meta";
    const scope = button("named-snippet-scope", snippet.folder ? `Make ${snippet.name} shared` : `Make ${snippet.name} folder-specific`, () => options.toggleScope(snippet));
    scope.dataset.unavailable = String(!snippet.folder && !options.folder);
    scope.disabled = scope.dataset.unavailable === "true";
    scope.dataset.scope = snippet.folder ? "folder" : "shared";
    scope.title = snippet.folder ? `Make available everywhere. Currently ${snippet.folder.username}@${snippet.folder.host}:${snippet.folder.port}${snippet.folder.path}`
      : options.folder ? `Limit to ${options.folder.username}@${options.folder.host}:${options.folder.port}${options.folder.path} and subfolders`
        : "Connect to an SSH session with a known working folder to make this folder-specific";
    scope.append(icon(snippet.folder ? "folder" : "shared"), document.createTextNode(snippet.folder ? "Folder" : "Shared"));
    meta.append(scope);
    if (snippet.folder) {
      const path = document.createElement("span");
      path.className = "named-snippet-folder-path"; path.textContent = snippet.folder.path; path.title = scope.title;
      meta.append(path);
    }
    const shell = document.createElement("span");
    shell.className = "named-snippet-shell-label"; shell.textContent = SHELL_LABELS[snippet.shell];
    meta.append(shell);
    item.append(use, actions, meta);
    return item;
  }));
}

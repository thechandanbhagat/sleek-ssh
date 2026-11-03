const MAX_NAME_LENGTH = 120;
const MAX_TEMPLATE_LENGTH = 16_000;

export function createNamedSnippetControls(root: HTMLElement) {
  if (!root?.ownerDocument) throw new Error("The snippets panel is unavailable.");
  const document = root.ownerDocument;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = "") => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  };
  const button = (text: string, primary = false) => {
    const node = element("button", `btn ${primary ? "btn-primary" : "btn-secondary"}`, text);
    node.type = "button";
    return node;
  };
  const label = (text: string, id: string) => {
    const node = element("label", "named-snippet-label", text);
    node.setAttribute("for", id);
    return node;
  };
  const library = element("section", "named-snippet-library");
  const search = element("input", "named-snippet-search");
  search.id = "named-snippet-search";
  search.type = "search";
  search.autocomplete = "off";
  search.placeholder = "Search snippets";
  const list = element("ul", "named-snippet-list");
  list.setAttribute("aria-label", "Saved snippets");
  const empty = element("p", "small-text", "Use Save as snippet on a history command to add it here.");
  const searchLabel = label("Search snippets", search.id);
  searchLabel.classList.add("sr-only");
  library.append(searchLabel, search, empty, list);

  const editor = element("form", "named-snippet-editor");
  const editorTitle = element("h3", "section-label", "Save snippet");
  const name = element("input", "");
  name.type = "text";
  name.id = "named-snippet-name";
  name.autocomplete = "off";
  name.required = true;
  name.maxLength = MAX_NAME_LENGTH;
  const template = element("textarea", "named-snippet-template");
  template.id = "named-snippet-template";
  template.required = true;
  template.maxLength = MAX_TEMPLATE_LENGTH;
  template.rows = 3;
  template.spellcheck = false;
  const shell = element("select", "");
  shell.id = "named-snippet-shell";
  for (const [value, text] of [["posix", "Bash / Zsh"], ["powershell", "PowerShell"], ["cmd", "Command Prompt"]]) {
    const option = element("option", "", text);
    option.value = value;
    shell.appendChild(option);
  }
  const help = element("p", "small-text", "Use single-line commands and separate, unquoted parameter arguments: systemctl status {{service}}. Select the shell running in your terminal.");
  help.id = "named-snippet-template-help";
  template.setAttribute("aria-describedby", help.id);
  const save = button("Save snippet", true);
  save.type = "submit";
  const cancel = button("Cancel");
  const editorActions = element("div", "named-snippet-actions");
  editorActions.append(save, cancel);
  editor.append(editorTitle, label("Snippet name", name.id), name, label("Command template", template.id), template,
    label("Shell mode", shell.id), shell, help, editorActions);

  const runner = element("form", "named-snippet-runner");
  const runnerTitle = element("h3", "section-label");
  const runnerShell = element("p", "small-text");
  const fields = element("div", "named-snippet-fields");
  const valueHelp = element("p", "small-text", "Parameter values are not saved with the snippet. Executed commands may appear in terminal history.");
  const cmdHelp = element("p", "small-text", "Command Prompt parameters accept simple values without spaces or shell operators. Use PowerShell for complex values.");
  const review = button("Review command", true);
  review.type = "submit";
  const back = button("Back to snippets");
  const runnerActions = element("div", "named-snippet-actions");
  runnerActions.append(review, back);
  const preview = element("section", "named-snippet-preview");
  preview.setAttribute("aria-label", "Command preview");
  const target = element("p", "named-snippet-target");
  const previewShell = element("p", "small-text");
  const output = element("pre", "named-snippet-output");
  const insert = button("Insert");
  const run = button("Run", true);
  const executionActions = element("div", "named-snippet-actions");
  executionActions.append(insert, run);
  preview.append(target, previewShell, output, executionActions);
  runner.append(runnerTitle, runnerShell, fields, valueHelp, cmdHelp, runnerActions, preview);

  const status = element("p", "named-snippet-status");
  status.setAttribute("role", "status");
  const error = element("p", "named-snippet-error");
  error.setAttribute("role", "alert");
  for (const node of [editor, runner, preview, status, error]) node.hidden = true;
  root.classList.add("named-snippets");
  root.replaceChildren(status, error, library, editor, runner);
  return { element, button, label, library, search, list, empty, editor, editorTitle, name, template, shell, save, cancel,
    runner, runnerTitle, runnerShell, fields, cmdHelp, review, back, preview, target, previewShell, output, insert, run, status, error };
}

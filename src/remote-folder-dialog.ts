import { loadRemoteFolders, saveRemoteFolders, remoteFolderCommand } from "./remote-folders.ts";

export function initRemoteFolderDialog(options: Readonly<{
  root: HTMLDialogElement;
  storage: Pick<Storage, "getItem" | "setItem">;
  onSaved: () => void;
}>) {
  const { root, storage } = options;
  const control = <T extends HTMLElement>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Remote folder dialog control is missing: ${selector}`);
    return element;
  };
  const form = control<HTMLFormElement>("form");
  const name = control<HTMLInputElement>("#remote-folder-name");
  const path = control<HTMLInputElement>("#remote-folder-path");
  const start = control<HTMLInputElement>("#remote-folder-start");
  const host = control<HTMLElement>("#remote-folder-host");
  const error = control<HTMLElement>("#remote-folder-error");
  const cancel = [...root.querySelectorAll<HTMLButtonElement>("[data-remote-folder-cancel]")];
  let profileId: string | null = null;
  let disposed = false;
  const close = () => root.close();
  const submit = (event: Event) => {
    event.preventDefault();
    if (!profileId || disposed) return;
    try {
      remoteFolderCommand(path.value);
      const saved = loadRemoteFolders(storage, profileId);
      saveRemoteFolders(storage, profileId, {
        startPath: start.checked ? path.value : saved.startPath,
        folders: [...saved.folders, { name: name.value, path: path.value }],
      });
      root.close(); options.onSaved();
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : String(cause); error.hidden = false;
    }
  };
  form.addEventListener("submit", submit);
  cancel.forEach(button => button.addEventListener("click", close));
  return Object.freeze({
    open(id: string, hostName: string, initialPath = "") {
      if (disposed) throw new Error("Remote folder dialog is no longer available.");
      loadRemoteFolders(storage, id);
      profileId = id; host.textContent = hostName;
      name.value = initialPath.split("/").filter(Boolean).at(-1) ?? "";
      path.value = initialPath; start.checked = false; error.hidden = true; error.textContent = "";
      root.showModal(); name.focus();
    },
    dispose() {
      disposed = true; profileId = null; if (root.open) root.close();
      form.removeEventListener("submit", submit);
      cancel.forEach(button => button.removeEventListener("click", close));
    },
  });
}

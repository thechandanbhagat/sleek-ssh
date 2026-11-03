import { loadRemoteFolders, saveRemoteFolders, validateRemoteFolders, REMOTE_FOLDER_LIMITS, type RemoteFolders } from "./remote-folders.ts";

export function initRemoteFoldersForm(root: HTMLElement, storage: Pick<Storage, "getItem" | "setItem">) {
  const document = root.ownerDocument;
  const start = root.querySelector<HTMLInputElement>("#prof-start-path");
  const list = root.querySelector<HTMLElement>("#prof-remote-folders");
  const add = root.querySelector<HTMLButtonElement>("#prof-add-remote-folder");
  if (!start || !list || !add) throw new Error("Remote folder controls are missing.");
  const rows = new Set<Readonly<{ element: HTMLElement; name: HTMLInputElement; path: HTMLInputElement }>>();
  let readable = false;
  let sequence = 0;

  function append(name = "", path = "") {
    if (rows.size >= REMOTE_FOLDER_LIMITS.folders) return;
    const element = document.createElement("div");
    element.className = "remote-folder-row";
    const field = (labelText: string, value: string, maximum: number, placeholder: string) => {
      const group = document.createElement("div");
      group.className = "form-group";
      const input = document.createElement("input");
      input.id = `prof-remote-folder-${++sequence}`;
      input.type = "text"; input.value = value; input.maxLength = maximum;
      input.required = true; input.autocomplete = "off"; input.spellcheck = false; input.placeholder = placeholder;
      const label = document.createElement("label");
      label.setAttribute("for", input.id); label.textContent = labelText;
      group.append(label, input); element.append(group);
      return input;
    };
    const nameInput = field("Name", name, REMOTE_FOLDER_LIMITS.name, "App");
    const pathInput = field("Remote path", path, REMOTE_FOLDER_LIMITS.path, "/srv/app");
    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "btn btn-secondary btn-small"; remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${name || "remote folder shortcut"}`);
    const row = Object.freeze({ element, name: nameInput, path: pathInput });
    remove.addEventListener("click", () => {
      rows.delete(row); element.remove(); add!.disabled = false;
      ([...rows].at(-1)?.name ?? add!).focus();
    });
    element.append(remove); rows.add(row); list!.append(element);
    add!.disabled = rows.size >= REMOTE_FOLDER_LIMITS.folders;
    return nameInput;
  }

  const onAdd = () => { if (readable) append()?.focus(); };
  add.addEventListener("click", onAdd);
  return Object.freeze({
    load(profileId: string | null) {
      readable = false; rows.clear(); list.replaceChildren(); start.value = ""; add.disabled = true;
      const saved = profileId ? loadRemoteFolders(storage, profileId) : { startPath: "", folders: [] };
      start.value = saved.startPath;
      saved.folders.forEach(folder => append(folder.name, folder.path));
      readable = true; add.disabled = rows.size >= REMOTE_FOLDER_LIMITS.folders;
    },
    read(): RemoteFolders {
      if (!readable) throw new Error("Remote folders could not be loaded. Reopen this host before saving.");
      return validateRemoteFolders({
        startPath: start.value, folders: [...rows].map(row => ({ name: row.name.value, path: row.path.value })),
      });
    },
    save(profileId: string, value: RemoteFolders) { saveRemoteFolders(storage, profileId, value); },
    dispose() { readable = false; add.removeEventListener("click", onAdd); rows.clear(); list.replaceChildren(); },
  });
}

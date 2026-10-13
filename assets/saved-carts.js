/*
 * Saved carts page: lists carts from the saved-carts app proxy and lets the
 * customer save, edit, delete, restore, or check out a saved cart.
 */
const root = document.querySelector("[data-saved-carts]");

if (root) {
  const { apiUrl, cartUrl, cartAddUrl, cartClearUrl } = root.dataset;
  const list = root.querySelector("[data-list]");
  const status = root.querySelector("[data-status]");
  const loading = root.querySelector("[data-loading]");
  const empty = root.querySelector("[data-empty]");
  const rowTemplate = root.querySelector("[data-row-template]");
  const editItemTemplate = root.querySelector("[data-edit-item-template]");
  const messages = root.querySelector("[data-messages]").content;
  const toastTemplate = root.querySelector("[data-toast-template]");
  const confirmDialog = root.querySelector("[data-confirm]");
  const confirmButton = confirmDialog.querySelector("[data-confirm-button]");
  const currentCartData = root.querySelector("[data-current-cart]");
  const currentCart = currentCartData ? JSON.parse(currentCartData.textContent) : [];

  const message = (key) => messages.querySelector(`[data-msg="${key}"]`).textContent.trim();
  const errorKeys = new Set(["error", "conflict", "restore-error", "empty-items"]);

  // Errors stay until dismissed so the buyer has time to read them.
  function announce(key) {
    const toast = toastTemplate.content.firstElementChild.cloneNode(true);
    const isError = errorKeys.has(key);
    const dismiss = () => {
      clearTimeout(timer);
      toast.remove();
    };
    const timer = isError ? null : setTimeout(dismiss, 4000);

    toast.classList.toggle("toast--error", isError);
    toast.querySelector("[data-toast-text]").textContent = message(key);
    toast.querySelector("button").addEventListener("click", dismiss);
    status.append(toast);
  }

  // Resolves to true when the buyer confirms; Escape, Cancel, and a backdrop click resolve to false.
  function ask(key, confirmLabel, danger = false) {
    confirmDialog.querySelector("[data-confirm-text]").textContent = message(key);
    confirmButton.textContent = confirmLabel;
    confirmButton.classList.toggle("confirm-dialog__danger", danger);
    confirmDialog.returnValue = "";
    confirmDialog.showModal();
    return new Promise((resolve) =>
      confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "confirm"), { once: true }),
    );
  }

  confirmDialog.addEventListener("click", (event) => {
    if (event.target === confirmDialog) confirmDialog.close();
  });

  async function api(method, body) {
    const response = await fetch(apiUrl, {
      method,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
    });
    if (response.status === 409) throw new Error("conflict");
    if (!response.ok) throw new Error("error");
    return (await response.json()).carts;
  }

  async function mutate(body, successKey) {
    root.setAttribute("aria-busy", "true");
    try {
      render(await api("POST", body));
      announce(successKey);
      return true;
    } catch (error) {
      announce(error.message === "conflict" ? "conflict" : "error");
      if (error.message === "conflict") load();
      return false;
    } finally {
      root.removeAttribute("aria-busy");
    }
  }

  const fetchCartLines = async () => (await (await fetch(`${cartUrl}.js`)).json()).items;

  const addLines = (items) =>
    fetch(`${cartAddUrl}.js`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: items.map(({ id, quantity, properties }) => ({ id, quantity, properties: properties ?? {} })),
      }),
    });

  // Shopify caps quantities to availability (and B2B quantity rules) and answers 422,
  // so compare what landed in the cart with what was requested.
  function shortfalls(requested, lines) {
    const added = new Map();
    lines.forEach((line) => added.set(line.variant_id, (added.get(line.variant_id) ?? 0) + line.quantity));
    return requested
      .filter((item) => (added.get(item.id) ?? 0) < item.quantity)
      .map((item) =>
        message("restore-adjusted-line")
          .replace("__title__", item.title)
          .replace("__requested__", item.quantity)
          .replace("__added__", added.get(item.id) ?? 0),
      );
  }

  // Replaces the storefront cart with the saved items, then opens cart or checkout.
  // Opens the cart instead of checkout when quantities were reduced, so the buyer sees why.
  async function restore(cart, toCheckout, confirmLabel) {
    if (!(await ask("restore-confirm", confirmLabel))) return;

    root.setAttribute("aria-busy", "true");
    let previous = [];
    try {
      previous = (await fetchCartLines()).map((line) => ({ ...line, id: line.variant_id }));
      await fetch(`${cartClearUrl}.js`, { method: "POST" });
      await addLines(cart.items);
      const lines = await fetchCartLines();

      if (lines.length === 0) {
        if (previous.length) await addLines(previous);
        throw new Error("nothing added");
      }

      const adjusted = shortfalls(cart.items, lines);
      if (adjusted.length) {
        try {
          sessionStorage.setItem("saved-carts:notice", [message("restore-adjusted"), ...adjusted].join("\n"));
        } catch {}
        window.location.href = cartUrl;
      } else if (toCheckout) {
        root.querySelector("[data-checkout-form]").submit();
      } else {
        window.location.href = cartUrl;
      }
    } catch {
      announce("restore-error");
      root.removeAttribute("aria-busy");
    }
  }

  function renderEditItems(container, items) {
    container.replaceChildren(
      ...items.map((item) => {
        const row = editItemTemplate.content.firstElementChild.cloneNode(true);
        row.querySelector("[data-title]").textContent = item.title;
        row.querySelector("[name=quantity]").value = item.quantity;
        row.item = item;
        row.querySelector("[data-action=remove-item]").addEventListener("click", () => row.remove());
        return row;
      }),
    );
  }

  function renderRow(cart) {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    const view = row.querySelector("[data-view]");
    const editForm = row.querySelector("[data-edit]");
    const editItems = row.querySelector("[data-edit-items]");
    const updatedAt = new Date(cart.updatedAt).toLocaleString(document.documentElement.lang);

    row.querySelector("[data-name]").textContent = cart.name;
    row.querySelector("[data-updated]").textContent = message("updated-at").replace("__date__", updatedAt);
    row.querySelector("[data-items]").replaceChildren(
      ...cart.items.map((item) => {
        const li = document.createElement("li");
        li.textContent = `${item.quantity} × ${item.title}`;
        return li;
      }),
    );

    const toggleEdit = (editing) => {
      view.hidden = editing;
      editForm.hidden = !editing;
      if (editing) {
        editForm.elements.name.value = cart.name;
        renderEditItems(editItems, cart.items);
        editForm.elements.name.focus();
      } else {
        row.querySelector("[data-action=edit]").focus();
      }
    };

    const actions = {
      checkout: (label) => restore(cart, true, label),
      restore: (label) => restore(cart, false, label),
      edit: () => toggleEdit(true),
      cancel: () => toggleEdit(false),
      delete: async (label) =>
        (await ask("delete-confirm", label, true)) && mutate({ action: "delete", id: cart.id }, "deleted"),
    };

    row.querySelectorAll(":scope [data-action]").forEach((button) => {
      const action = actions[button.dataset.action];
      if (action) button.addEventListener("click", () => action(button.textContent.trim()));
    });

    editForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const items = [...editItems.children].map((itemRow) => ({
        ...itemRow.item,
        quantity: Number(itemRow.querySelector("[name=quantity]").value),
      }));
      if (items.length === 0) {
        announce("empty-items");
        return;
      }
      mutate({ action: "update", id: cart.id, name: editForm.elements.name.value, items }, "updated");
    });

    return row;
  }

  function render(carts) {
    loading.hidden = true;
    empty.hidden = carts.length > 0;
    list.replaceChildren(...carts.map(renderRow));
  }

  async function load() {
    try {
      render(await api("GET"));
    } catch {
      loading.hidden = true;
      announce("error");
    }
  }

  root.querySelector("[data-save-cart]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const saved = await mutate(
      { action: "create", name: form.elements.name.value, items: currentCart },
      "saved",
    );
    if (saved) form.reset();
  });

  load();
}

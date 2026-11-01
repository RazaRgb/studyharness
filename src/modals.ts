import { App, Modal } from "obsidian";

export class ConfirmModal extends Modal {
  private readonly titleText: string;
  private readonly message: string;
  private readonly confirmLabel: string;
  private readonly onConfirm: () => void | Promise<void>;
  private readonly danger: boolean;

  constructor(
    app: App,
    options: {
      title: string;
      message: string;
      confirmLabel?: string;
      danger?: boolean;
      onConfirm: () => void | Promise<void>;
    },
  ) {
    super(app);
    this.titleText = options.title;
    this.message = options.message;
    this.confirmLabel = options.confirmLabel ?? "Confirm";
    this.onConfirm = options.onConfirm;
    this.danger = options.danger ?? false;
  }

  onOpen(): void {
    this.titleEl.setText(this.titleText);
    const body = this.contentEl.createDiv({ cls: "sh-confirm-body" });
    body.createEl("p", { text: this.message });
    const actions = this.contentEl.createDiv({ cls: "sh-confirm-actions" });
    const cancel = actions.createEl("button", { text: "Cancel", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", {
      cls: this.danger ? "mod-warning" : "mod-cta",
      text: this.confirmLabel,
      attr: { type: "button" },
    });
    confirm.addEventListener("click", () => {
      this.close();
      void this.onConfirm();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class RenameSessionModal extends Modal {
  private readonly initial: string;
  private readonly onSave: (value: string) => void;
  private input!: HTMLInputElement;

  constructor(app: App, initial: string, onSave: (value: string) => void) {
    super(app);
    this.initial = initial;
    this.onSave = onSave;
  }

  onOpen(): void {
    this.titleEl.setText("Rename session");
    const body = this.contentEl.createDiv({ cls: "sh-rename-body" });
    this.input = body.createEl("input", {
      cls: "sh-topic-input",
      attr: { type: "text", value: this.initial, "aria-label": "Session title" },
    });
    const actions = this.contentEl.createDiv({ cls: "sh-confirm-actions" });
    const cancel = actions.createEl("button", { text: "Cancel", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const save = actions.createEl("button", { cls: "mod-cta", text: "Save", attr: { type: "button" } });
    save.addEventListener("click", () => {
      this.close();
      this.onSave(this.input.value);
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        save.click();
      }
    });
    window.setTimeout(() => {
      this.input.focus();
      this.input.select();
    }, 20);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

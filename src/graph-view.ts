import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type StudyHarnessPlugin from "./main";
import type { GraphEdge, KnowledgeNode } from "./types";
import { kindLabel } from "./types";

export const VIEW_TYPE_GRAPH = "study-harness-graph";

interface Point { x: number; y: number; }
interface Transform { x: number; y: number; k: number; }
interface LayoutNode extends Point { node: KnowledgeNode; radius: number; degree: number; }

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function layout(nodes: KnowledgeNode[], edges: GraphEdge[]): LayoutNode[] {
  if (nodes.length === 0) return [];
  const n = nodes.length;
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const positions = new Map<string, Point>();
  const radius = Math.max(160, n * 28);
  nodes.forEach((node, i) => {
    const angle = (i / n) * Math.PI * 2;
    positions.set(node.id, {
      x: Math.cos(angle) * radius + (hash(node.id) % 20) - 10,
      y: Math.sin(angle) * radius + (hash(node.id + "y") % 20) - 10,
    });
  });
  const k = Math.max(70, Math.sqrt((900 * 900) / Math.max(1, n)));
  for (let iteration = 0; iteration < 180; iteration++) {
    const forces = new Map<string, Point>();
    for (const node of nodes) forces.set(node.id, { x: 0, y: 0 });
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = positions.get(nodes[i].id)!;
        const b = positions.get(nodes[j].id)!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        if (dist < 0.01) {
          dx = (hash(nodes[i].id) % 100) / 100 - 0.5;
          dy = (hash(nodes[j].id) % 100) / 100 - 0.5;
          dist = 0.1;
        }
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        const fa = forces.get(nodes[i].id)!;
        const fb = forces.get(nodes[j].id)!;
        fa.x += fx; fa.y += fy;
        fb.x -= fx; fb.y -= fy;
      }
    }
    for (const edge of edges) {
      const a = positions.get(edge.from);
      const b = positions.get(edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      const fa = forces.get(edge.from)!;
      const fb = forces.get(edge.to)!;
      fa.x += fx; fa.y += fy;
      fb.x -= fx; fb.y -= fy;
    }
    for (const node of nodes) {
      const p = positions.get(node.id)!;
      const f = forces.get(node.id)!;
      const cooling = 1 - iteration / 220;
      p.x += f.x * 0.001 * cooling;
      p.y += f.y * 0.001 * cooling;
      p.x += (0 - p.x) * 0.0008;
      p.y += (0 - p.y) * 0.0008;
    }
  }
  return nodes.map((node) => {
    const p = positions.get(node.id)!;
    const d = degree.get(node.id) ?? 0;
    return {
      ...p,
      node,
      degree: d,
      radius: 7 + Math.min(16, Math.sqrt(d) * 4),
    };
  });
}

function resolveColor(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return fallback;
  ctx.fillStyle = trimmed;
  ctx.fillRect(0, 0, 1, 1);
  const data = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${data[0]}, ${data[1]}, ${data[2]})`;
}

export class GraphView extends ItemView {
  private readonly plugin: StudyHarnessPlugin;
  private canvasEl!: HTMLCanvasElement;
  private wrapEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private statsEl!: HTMLElement;
  private nodes: LayoutNode[] = [];
  private edges: GraphEdge[] = [];
  private selectedId: string | null = null;
  private transform: Transform = { x: 0, y: 0, k: 1 };
  private fitOnce = true;
  private dragging = false;
  private dragStart: Point | null = null;
  private dragOrigin: Transform | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private query = "";

  constructor(leaf: WorkspaceLeaf, plugin: StudyHarnessPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_GRAPH; }
  getDisplayText(): string { return "Knowledge graph"; }
  getIcon(): string { return "network"; }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("sh-graph-view");
    this.build();
    this.fitOnce = true;
    this.refresh();
    this.resizeObserver = new ResizeObserver(() => {
      this.fitOnce = true;
      this.draw();
    });
    this.resizeObserver.observe(this.wrapEl);
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
  }

  private build(): void {
    const header = this.contentEl.createDiv({ cls: "sh-graph-header" });
    const titleWrap = header.createDiv({ cls: "sh-graph-title-wrap" });
    titleWrap.createDiv({ cls: "sh-graph-title", text: "Knowledge graph" });
    this.statsEl = titleWrap.createDiv({ cls: "sh-graph-stats" });

    const searchWrap = header.createDiv({ cls: "sh-graph-search" });
    setIcon(searchWrap.createSpan({ cls: "sh-search-icon" }), "search");
    this.searchEl = searchWrap.createEl("input", {
      attr: { type: "search", placeholder: "Search nodes…", "aria-label": "Search knowledge nodes" },
    });
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value.trim().toLowerCase();
      this.draw();
    });

    const importBtn = header.createEl("button", {
      cls: "clickable-icon",
      attr: { type: "button", "aria-label": "Import notes into knowledge graph" },
    });
    setIcon(importBtn, "upload");
    importBtn.addEventListener("click", () => this.plugin.openNotesImport());

    const fit = header.createEl("button", {
      cls: "clickable-icon",
      attr: { type: "button", "aria-label": "Fit graph to view" },
    });
    setIcon(fit, "maximize");
    fit.addEventListener("click", () => {
      this.fitOnce = true;
      this.draw();
    });

    const refresh = header.createEl("button", {
      cls: "clickable-icon",
      attr: { type: "button", "aria-label": "Refresh graph" },
    });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => this.refresh());

    const body = this.contentEl.createDiv({ cls: "sh-graph-body" });
    this.wrapEl = body.createDiv({ cls: "sh-graph-canvas-wrap" });
    this.canvasEl = this.wrapEl.createEl("canvas", { cls: "sh-graph-canvas" });
    this.detailEl = body.createDiv({ cls: "sh-graph-detail" });

    this.canvasEl.addEventListener("mousedown", (event) => {
      this.dragging = true;
      this.dragStart = { x: event.clientX, y: event.clientY };
      this.dragOrigin = { ...this.transform };
      this.canvasEl.addClass("is-dragging");
    });
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
    this.canvasEl.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = this.canvasEl.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const old = this.transform;
      const worldX = (mx - old.x) / old.k;
      const worldY = (my - old.y) / old.k;
      const nextK = Math.min(3.2, Math.max(0.2, old.k * (event.deltaY < 0 ? 1.12 : 0.89)));
      this.transform = { k: nextK, x: mx - worldX * nextK, y: my - worldY * nextK };
      this.draw();
    }, { passive: false });
    this.canvasEl.addEventListener("click", (event) => {
      if (this.dragStart && (Math.abs(event.clientX - this.dragStart.x) > 4 || Math.abs(event.clientY - this.dragStart.y) > 4)) return;
      const hit = this.hitTest(event);
      this.selectedId = hit?.node.id ?? null;
      this.renderDetail();
      this.draw();
    });
    this.registerDomEvent(this.canvasEl, "dblclick", () => {
      this.fitOnce = true;
      this.draw();
    });
  }

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.dragging || !this.dragStart || !this.dragOrigin) return;
    this.transform = {
      k: this.dragOrigin.k,
      x: this.dragOrigin.x + (event.clientX - this.dragStart.x),
      y: this.dragOrigin.y + (event.clientY - this.dragStart.y),
    };
    this.draw();
  };

  private onMouseUp = (): void => {
    this.dragging = false;
    this.canvasEl.removeClass("is-dragging");
    window.setTimeout(() => { this.dragStart = null; this.dragOrigin = null; }, 0);
  };

  selectNode(nodeId: string): void {
    this.selectedId = nodeId;
    this.renderDetail();
    this.draw();
  }

  refresh(): void {
    const nodes = this.plugin.store.nodes();
    const edges = this.plugin.store.edges();
    this.nodes = layout(nodes, edges);
    this.edges = edges;
    this.statsEl.setText(`${nodes.length} propositions · ${edges.length} links · ${this.plugin.store.data.evidence.length} evidence · ${this.plugin.store.data.noteSources.length} note imports`);
    if (!this.selectedId && nodes.length > 0) this.selectedId = nodes[0].id;
    this.renderDetail();
    this.draw();
  }

  private resizeCanvas(): { width: number; height: number; dpr: number } {
    const rect = this.wrapEl.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);
    if (this.canvasEl.width !== targetW || this.canvasEl.height !== targetH) {
      this.canvasEl.width = targetW;
      this.canvasEl.height = targetH;
      this.canvasEl.style.width = `${width}px`;
      this.canvasEl.style.height = `${height}px`;
    }
    return { width, height, dpr };
  }

  private fit(width: number, height: number): void {
    if (this.nodes.length === 0) {
      this.transform = { x: width / 2, y: height / 2, k: 1 };
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x - n.radius - 50);
      minY = Math.min(minY, n.y - n.radius - 30);
      maxX = Math.max(maxX, n.x + n.radius + 50);
      maxY = Math.max(maxY, n.y + n.radius + 30);
    }
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const k = Math.min(1.6, Math.max(0.2, Math.min((width - 60) / w, (height - 60) / h)));
    this.transform = {
      k,
      x: width / 2 - ((minX + maxX) / 2) * k,
      y: height / 2 - ((minY + maxY) / 2) * k,
    };
  }

  private draw(): void {
    if (!this.canvasEl) return;
    const { width, height, dpr } = this.resizeCanvas();
    if (this.fitOnce) {
      this.fit(width, height);
      this.fitOnce = false;
    }
    const ctx = this.canvasEl.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = resolveColor(getComputedStyle(document.body).getPropertyValue("--background-primary"), "#1e1e1e");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.translate(this.transform.x, this.transform.y);
    ctx.scale(this.transform.k, this.transform.k);
    const edgeColor = resolveColor(getComputedStyle(document.body).getPropertyValue("--background-modifier-border"), "#444");
    const textColor = resolveColor(getComputedStyle(document.body).getPropertyValue("--text-normal"), "#ddd");
    const accent = resolveColor(getComputedStyle(document.body).getPropertyValue("--interactive-accent"), "#7c9cff");
    const nodeById = new Map(this.nodes.map((n) => [n.node.id, n]));

    for (const edge of this.edges) {
      const a = nodeById.get(edge.from);
      const b = nodeById.get(edge.to);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.strokeStyle = edgeColor;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.2 / this.transform.k;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const ex = b.x - Math.cos(angle) * (b.radius + 2);
      const ey = b.y - Math.sin(angle) * (b.radius + 2);
      const size = 5 / this.transform.k;
      ctx.beginPath();
      ctx.fillStyle = edgeColor;
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - Math.cos(angle - 0.45) * size, ey - Math.sin(angle - 0.45) * size);
      ctx.lineTo(ex - Math.cos(angle + 0.45) * size, ey - Math.sin(angle + 0.45) * size);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    for (const item of this.nodes) {
      const { node } = item;
      const strength = this.plugin.store.strength(node.id);
      const hue = hash(node.domain) % 360;
      const lightness = 38 + strength.overall * 28;
      const matches = !this.query || node.name.toLowerCase().includes(this.query) || node.statement.toLowerCase().includes(this.query);
      ctx.globalAlpha = matches ? 1 : 0.16;
      ctx.beginPath();
      ctx.arc(item.x, item.y, item.radius, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${hue} 55% ${lightness}%)`;
      ctx.fill();
      if (this.selectedId === node.id) {
        ctx.lineWidth = 3 / this.transform.k;
        ctx.strokeStyle = accent;
        ctx.stroke();
      } else {
        ctx.lineWidth = 1.2 / this.transform.k;
        ctx.strokeStyle = bg;
        ctx.stroke();
      }
      const label = node.name.length > 34 ? `${node.name.slice(0, 32)}…` : node.name;
      ctx.font = `${Math.max(9, 11 / this.transform.k)}px ${getComputedStyle(document.body).fontFamily || "sans-serif"}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = textColor;
      ctx.fillText(label, item.x, item.y + item.radius + 5 / this.transform.k);
    }
    ctx.restore();
  }

  private hitTest(event: MouseEvent): LayoutNode | null {
    const rect = this.canvasEl.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const wx = (mx - this.transform.x) / this.transform.k;
    const wy = (my - this.transform.y) / this.transform.k;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      const dx = wx - n.x;
      const dy = wy - n.y;
      if (dx * dx + dy * dy <= (n.radius + 5) * (n.radius + 5)) return n;
    }
    return null;
  }

  private renderDetail(): void {
    this.detailEl.empty();
    const node = this.selectedId ? this.plugin.store.data.nodes[this.selectedId] : undefined;
    if (!node) {
      this.detailEl.createDiv({ cls: "sh-empty", text: "Select a node to inspect it." });
      return;
    }
    const strength = this.plugin.store.strength(node.id);
    const header = this.detailEl.createDiv({ cls: "sh-detail-header" });
    header.createDiv({ cls: "sh-detail-title", text: node.name });
    header.createDiv({ cls: "sh-detail-kind", text: kindLabel(node.kind) });
    this.detailEl.createEl("p", { cls: "sh-detail-statement", text: node.statement });
    const bars = this.detailEl.createDiv({ cls: "sh-strength-bars" });
    for (const [label, value] of [
      ["Overall", strength.overall],
      ["Recall", strength.recall],
      ["Explanation", strength.explanation],
      ["Application", strength.application],
    ] as Array<[string, number]>) {
      const row = bars.createDiv({ cls: "sh-strength-row" });
      row.createSpan({ cls: "sh-strength-label", text: label });
      const track = row.createDiv({ cls: "sh-strength-track" });
      const fill = track.createDiv({ cls: "sh-strength-fill" });
      fill.style.width = `${Math.round(value * 100)}%`;
      row.createSpan({ cls: "sh-strength-value", text: `${Math.round(value * 100)}%` });
    }
    if (strength.calibration !== null) {
      const row = bars.createDiv({ cls: "sh-strength-row" });
      row.createSpan({ cls: "sh-strength-label", text: "Calibration" });
      const track = row.createDiv({ cls: "sh-strength-track" });
      const fill = track.createDiv({ cls: "sh-strength-fill sh-calibration" });
      fill.style.width = `${Math.round(strength.calibration * 100)}%`;
      row.createSpan({ cls: "sh-strength-value", text: `${Math.round(strength.calibration * 100)}%` });
    }
    const meta = this.detailEl.createDiv({ cls: "sh-detail-meta" });
    meta.createDiv({ text: `Evidence: ${strength.count}` });
    meta.createDiv({ text: `Domain: ${node.domain}` });
    meta.createDiv({ text: `Sessions: ${node.sessionIds.length}` });
    if (strength.lastAt) meta.createDiv({ text: `Last tested: ${new Date(strength.lastAt).toLocaleDateString()}` });

    const actions = this.detailEl.createDiv({ cls: "sh-detail-actions" });
    const study = actions.createEl("button", { cls: "mod-cta", text: "Study this", attr: { type: "button" } });
    study.addEventListener("click", () => {
      void this.plugin.startSessionForNode(node.id, "conceptual", "study");
    });
    const practice = actions.createEl("button", { text: "Practice this", attr: { type: "button" } });
    practice.addEventListener("click", () => {
      void this.plugin.startSessionForNode(node.id, "application", "practice");
    });

    const evidence = this.plugin.store.evidenceFor(node.id).slice(0, 8);
    if (evidence.length > 0) {
      this.detailEl.createDiv({ cls: "sh-detail-section-title", text: "Recent evidence" });
      const list = this.detailEl.createDiv({ cls: "sh-evidence-list" });
      for (const e of evidence) {
        const row = list.createDiv({ cls: "sh-evidence-row" });
        row.createSpan({ cls: `sh-evidence-result is-${e.result}`, text: e.result });
        row.createSpan({ cls: "sh-evidence-type", text: e.type });
        if (typeof e.confidence === "number") row.createSpan({ cls: "sh-evidence-confidence", text: `${e.confidence}%` });
        if (e.note) row.createSpan({ cls: "sh-evidence-note", text: e.note });
        row.createSpan({ cls: "sh-evidence-date", text: new Date(e.at).toLocaleDateString() });
      }
    }
    const sources = node.sessionIds
      .map((id) => this.plugin.store.getSession(id))
      .filter((s) => s !== null)
      .slice(0, 5);
    if (sources.length > 0) {
      this.detailEl.createDiv({ cls: "sh-detail-section-title", text: "Source sessions" });
      const list = this.detailEl.createDiv({ cls: "sh-source-list" });
      for (const s of sources) {
        const link = list.createEl("a", { cls: "sh-source-link", text: s.title });
        link.addEventListener("click", (event) => {
          event.preventDefault();
          void this.plugin.openSession(s.id);
        });
      }
    }
    const sourcePaths = node.sourcePaths ?? [];
    if (sourcePaths.length > 0) {
      this.detailEl.createDiv({ cls: "sh-detail-section-title", text: "Source notes" });
      const list = this.detailEl.createDiv({ cls: "sh-source-list" });
      for (const path of sourcePaths.slice(0, 8)) {
        const link = list.createEl("a", { cls: "sh-source-link", text: path });
        link.addEventListener("click", (event) => {
          event.preventDefault();
          void this.app.workspace.openLinkText(path, "", false);
        });
      }
    }
  }
}

const managerIcon = `<svg class="tree-kind-icon" data-icon="manager" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 6v3m-2.5 4.5-4 3m9-3 4 3"></path><circle cx="12" cy="12" r="3" fill="currentColor"></circle><circle cx="12" cy="3.5" r="2" fill="currentColor"></circle><circle cx="4" cy="18" r="2" fill="currentColor"></circle><circle cx="20" cy="18" r="2" fill="currentColor"></circle><circle cx="12" cy="12" r="0.75" stroke="none" fill="var(--canvas)"></circle></svg>`;
const robotIcon = `<svg class="tree-kind-icon" data-icon="robot" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3v4M1 12v4m22-4v4"></path><rect x="3" y="7" width="18" height="13" rx="3" fill="currentColor"></rect><circle cx="8" cy="12" r="1" stroke="var(--canvas)"></circle><circle cx="16" cy="12" r="1" stroke="var(--canvas)"></circle><path d="M9 17h6" stroke="var(--canvas)"></path></svg>`;

function row(node, depth) {
  const item = document.createElement("li");
  item.className = "tree-item";
  const group = document.createElement("div");
  group.className = "tree-row";
  group.tabIndex = 0;
  group.role = "group";
  group.dataset.kind = node.kind;
  group.dataset.activity = node.activity;
  group.dataset.depth = String(depth);
  group.style.setProperty("--depth", String(Math.min(depth, 12)));
  group.setAttribute("aria-label", `${node.label}; ${node.activity}`);
  group.title = node.label;
  const status = document.createElement("span");
  status.className = `tree-status tree-status--${node.activity}`;
  status.innerHTML = node.kind === "manager" ? managerIcon : robotIcon;
  const heading = document.createElement("span");
  heading.className = "tree-heading";
  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = node.label;
  heading.append(label);
  const settings = document.createElement("span");
  settings.className = "tree-settings";
  settings.dataset.agent = "true";
  settings.setAttribute("role", "note");
  if (node.detail) {
    group.dataset.hasMetadata = "true";
    const detail = document.createElement("span");
    detail.className = "tree-agent-settings";
    detail.textContent = node.detail;
    settings.append(detail);
    group.append(status, heading, settings);
  } else {
    group.append(status, heading);
  }
  item.append(group);
  if (node.children?.length) {
    const list = document.createElement("ul");
    list.className = "tree-children";
    for (const child of node.children) list.append(row(child, depth + 1));
    item.append(list);
  }
  return item;
}

function tree(nodes) {
  const list = document.createElement("ul");
  list.className = "active-tree";
  list.setAttribute("aria-label", "Agents");
  for (const node of nodes) list.append(row(node, 0));
  list.addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const rows = [...list.querySelectorAll(".tree-row")];
    const index = rows.indexOf(document.activeElement);
    const target = event.key === "Home" ? rows[0] : event.key === "End" ? rows.at(-1) : rows[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (target) {
      event.preventDefault();
      target.focus();
    }
  });
  return list;
}

async function paint() {
  const main = document.querySelector("main");
  try {
    const response = await fetch("data", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const nodes = window.agentstackTree(await response.json());
    main.replaceChildren(nodes.length ? tree(nodes) : status("No running agents"));
  } catch {
    main.replaceChildren(status("Unavailable"));
  }
}

function status(text) {
  const node = document.createElement("p");
  node.role = "status";
  node.textContent = text;
  return node;
}

paint();
setInterval(paint, 1000);

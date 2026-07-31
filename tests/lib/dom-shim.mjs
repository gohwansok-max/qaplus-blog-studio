/**
 * Minimal DOMParser shim for Node characterization tests.
 * Supports only the APIs used by sanitizePostHtml / appendExpansionHtml / visibleTextLength.
 */

function parseAttrs(raw) {
  const attrs = [];
  const re = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = re.exec(raw || ""))) {
    attrs.push({
      name: match[1],
      value: match[2] ?? match[3] ?? match[4] ?? ""
    });
  }
  return attrs;
}

class ShimNode {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
  }

  get textContent() {
    if (this.nodeType === 3) return this.nodeValue || "";
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this.childNodes = [];
    if (value) this.appendChild(new ShimText(String(value)));
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      node.parentNode = null;
    }
    return node;
  }

  insertBefore(node, reference) {
    if (!reference) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = this.childNodes.indexOf(reference);
    node.parentNode = this;
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node);
    return node;
  }
}

class ShimText extends ShimNode {
  constructor(value) {
    super();
    this.nodeType = 3;
    this.nodeValue = value;
  }

  get innerHTML() {
    return this.nodeValue;
  }
}

class ShimElement extends ShimNode {
  constructor(tagName) {
    super();
    this.nodeType = 1;
    this.tagName = String(tagName || "").toUpperCase();
    this.attributes = [];
  }

  getAttribute(name) {
    const found = this.attributes.find((item) => item.name.toLowerCase() === String(name).toLowerCase());
    return found ? found.value : null;
  }

  setAttribute(name, value) {
    const key = String(name);
    const existing = this.attributes.find((item) => item.name.toLowerCase() === key.toLowerCase());
    if (existing) existing.value = String(value);
    else this.attributes.push({ name: key, value: String(value) });
  }

  removeAttribute(name) {
    const key = String(name).toLowerCase();
    this.attributes = this.attributes.filter((item) => item.name.toLowerCase() !== key);
  }

  matches(selector) {
    const parts = String(selector).split(",").map((item) => item.trim().toLowerCase());
    return parts.some((part) => {
      if (part === "*") return true;
      if (part.startsWith("#")) return this.getAttribute("id") === part.slice(1);
      return this.tagName.toLowerCase() === part;
    });
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = (node) => {
      if (node.nodeType === 1 && node.matches(selector)) results.push(node);
      node.childNodes.forEach(walk);
    };
    this.childNodes.forEach(walk);
    return results;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  insertAdjacentHTML(position, html) {
    const nodes = parseFragment(html);
    if (position === "beforebegin") {
      nodes.forEach((node) => this.parentNode.insertBefore(node, this));
      return;
    }
    if (position === "beforeend") {
      nodes.forEach((node) => this.appendChild(node));
      return;
    }
    if (position === "afterend") {
      const parent = this.parentNode;
      let anchor = this;
      nodes.forEach((node) => {
        const index = parent.childNodes.indexOf(anchor);
        parent.insertBefore(node, parent.childNodes[index + 1] || null);
        anchor = node;
      });
      return;
    }
    if (position === "afterbegin") {
      nodes.reverse().forEach((node) => this.insertBefore(node, this.childNodes[0] || null));
      return;
    }
    throw new Error("unsupported insertAdjacentHTML position: " + position);
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  get lastElementChild() {
    const elements = this.children;
    return elements[elements.length - 1] || null;
  }

  get innerHTML() {
    return this.childNodes.map((child) => serialize(child)).join("");
  }

  set innerHTML(html) {
    this.childNodes = [];
    parseFragment(html).forEach((node) => this.appendChild(node));
  }
}

class ShimDocument {
  constructor(root) {
    this._root = root;
    this.body = root;
  }

  getElementById(id) {
    if (this._root.getAttribute("id") === id) return this._root;
    return this._root.querySelector("#" + id);
  }

  createElement(tagName) {
    return new ShimElement(tagName);
  }
}

function serialize(node) {
  if (node.nodeType === 3) {
    return String(node.nodeValue || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  const tag = node.tagName.toLowerCase();
  const attrs = node.attributes
    .map((attr) => ` ${attr.name}="${String(attr.value).replace(/"/g, "&quot;")}"`)
    .join("");
  const voidTags = new Set(["img", "br", "hr", "meta", "link", "input"]);
  if (voidTags.has(tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${node.childNodes.map((child) => serialize(child)).join("")}</${tag}>`;
}

function parseFragment(html) {
  const source = String(html || "");
  const nodes = [];
  const stack = [];
  const voidTags = new Set(["img", "br", "hr", "meta", "link", "input"]);
  const tokenRe = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)([^>]*)\/?>|([^<]+)/g;
  let match;
  while ((match = tokenRe.exec(source))) {
    if (match[0].startsWith("<!--")) continue;
    if (match[1]) {
      const closing = match[1].toUpperCase();
      while (stack.length) {
        const current = stack.pop();
        if (current.tagName === closing) break;
      }
      continue;
    }
    if (match[2]) {
      const element = new ShimElement(match[2]);
      parseAttrs(match[3]).forEach((attr) => element.setAttribute(attr.name, attr.value));
      const parent = stack[stack.length - 1];
      if (parent) parent.appendChild(element);
      else nodes.push(element);
      const selfClosing = /\/\s*$/.test(match[3] || "") || voidTags.has(element.tagName.toLowerCase());
      if (!selfClosing) stack.push(element);
      continue;
    }
    if (match[4] != null) {
      const text = new ShimText(match[4]);
      const parent = stack[stack.length - 1];
      if (parent) parent.appendChild(text);
      else nodes.push(text);
    }
  }
  return nodes;
}

export function createDomShim() {
  return class DOMParser {
    parseFromString(html) {
      const wrapped = String(html || "");
      const idMatch = /id\s*=\s*["']([^"']+)["']/i.exec(wrapped);
      const rootId = idMatch ? idMatch[1] : "body";
      const inner = wrapped
        .replace(/^[\s\S]*?<div\b[^>]*>/i, "")
        .replace(/<\/div>\s*$/i, "");
      const root = new ShimElement("div");
      root.setAttribute("id", rootId);
      parseFragment(inner).forEach((node) => root.appendChild(node));
      if (!/<div\b/i.test(wrapped)) {
        const body = new ShimElement("body");
        parseFragment(wrapped).forEach((node) => body.appendChild(node));
        return new ShimDocument(body);
      }
      return new ShimDocument(root);
    }
  };
}

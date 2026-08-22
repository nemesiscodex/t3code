import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  chatMarkdownClipboardPayload,
  serializeRenderedMarkdownFragment,
} from "./markdown-clipboard";

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

class FakeText {
  readonly nodeType = TEXT_NODE;
  readonly childNodes: ReadonlyArray<never> = [];

  constructor(readonly textContent: string) {}
}

class FakeElement {
  readonly nodeType = ELEMENT_NODE;
  readonly childNodes: Array<FakeElement | FakeText> = [];
  readonly classList = {
    contains: (name: string) => this.classNames.includes(name),
  };

  constructor(
    readonly tagName: string,
    private readonly classNames: ReadonlyArray<string> = [],
  ) {}

  get localName(): string {
    return this.tagName.toLowerCase();
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  append(...children: Array<FakeElement | FakeText>): this {
    this.childNodes.push(...children);
    return this;
  }

  appendChild(child: FakeElement | FakeText): FakeElement | FakeText {
    this.append(child);
    return child;
  }

  getAttribute(): string | null {
    return null;
  }

  hasAttribute(): boolean {
    return false;
  }

  closest(): FakeElement | null {
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    for (const child of this.childNodes) {
      if (!(child instanceof FakeElement)) continue;
      if (child.tagName.toLowerCase() === selector.toLowerCase()) return child;
      const descendant = child.querySelector(selector);
      if (descendant) return descendant;
    }
    return null;
  }

  querySelectorAll(): FakeElement[] {
    return [];
  }

  get className(): string {
    return this.classNames.join(" ");
  }

  get innerHTML(): string {
    return this.textContent;
  }
}

function asNode(element: FakeElement): Node {
  return element as unknown as Node;
}

function shikiCodeLine(text: string): FakeElement {
  const token = new FakeElement("SPAN").append(new FakeText(text));
  return new FakeElement("SPAN", ["line"]).append(token);
}

function clipboardTextFor(selectedFragment: FakeElement): string | undefined {
  const range = {
    collapsed: false,
    cloneContents: () => selectedFragment,
    commonAncestorContainer: new FakeElement("DIV"),
    toString: () => selectedFragment.textContent,
  };
  const selection = {
    rangeCount: 1,
    getRangeAt: () => range,
  };
  return chatMarkdownClipboardPayload(selection as unknown as Selection)?.text;
}

describe("markdown clipboard", () => {
  beforeEach(() => {
    vi.stubGlobal("Node", { TEXT_NODE, ELEMENT_NODE });
    vi.stubGlobal("document", {
      createElement: (tagName: string) => new FakeElement(tagName.toUpperCase()),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wraps inline code in backticks", () => {
    const paragraph = new FakeElement("P").append(
      new FakeText("run "),
      new FakeElement("CODE").append(new FakeText("git status")),
      new FakeText(" first"),
    );
    const container = new FakeElement("DIV").append(paragraph);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("run `git status` first");
  });

  it("keeps a highlighted block code selection plain when its pre wrapper is outside the range", () => {
    const code = new FakeElement("CODE").append(
      shikiCodeLine("git show-ref --verify refs/remotes/origin/opt/deploy/dev"),
    );
    const container = new FakeElement("DIV").append(code);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "git show-ref --verify refs/remotes/origin/opt/deploy/dev",
    );
  });

  it("keeps a multi-line code selection plain instead of inline-wrapping it", () => {
    const code = new FakeElement("CODE").append(new FakeText("first line\nsecond line"));
    const container = new FakeElement("DIV").append(code);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("first line\nsecond line");
  });

  it("copies a selected whole code block as plain code", () => {
    const pre = new FakeElement("PRE").append(
      new FakeElement("CODE", ["language-bash"]).append(new FakeText("ls -lah")),
    );
    const selectedFragment = new FakeElement("DIV", ["chat-markdown-codeblock"]).append(
      new FakeElement("DIV", ["select-none"]).append(new FakeText("bash")),
      new FakeElement("DIV").append(pre),
    );

    expect(clipboardTextFor(selectedFragment)).toBe("ls -lah");
  });

  it("copies an empty selected code block as an empty string", () => {
    const selectedFragment = new FakeElement("DIV", ["chat-markdown-codeblock"]).append(
      new FakeElement("PRE").append(new FakeElement("CODE", ["language-bash"])),
    );

    expect(clipboardTextFor(selectedFragment)).toBe("");
  });

  it("keeps fences when a selection contains prose and a code block", () => {
    const selectedFragment = new FakeElement("DIV").append(
      new FakeElement("P").append(new FakeText("Run this:")),
      new FakeElement("DIV", ["chat-markdown-codeblock"]).append(
        new FakeElement("DIV", ["select-none"]).append(new FakeText("bash")),
        new FakeElement("PRE").append(
          new FakeElement("CODE", ["language-bash"]).append(new FakeText("ls -lah")),
        ),
      ),
    );

    expect(clipboardTextFor(selectedFragment)).toBe("Run this:\n\n```bash\nls -lah\n```");
  });
});

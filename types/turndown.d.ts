// turndown ships no type declarations of its own, and there is no `@types/turndown`
// in this tree — installing one is not something this sandbox can do (see the
// `assert_native_node_modules()` guard in oglimmer.sh), and it would be a
// dependency for four call sites in one module. So the surface `renderer/markdown.ts`
// actually uses is declared here instead, beside `ipc.d.ts`.
//
// Deliberately narrower than the real API: what is declared is what the fold needs
// — the constructor, `addRule`/`keep`/`remove`, the `escape` hook the narrow escape
// table replaces, and `turndown()` itself. Anything else turndown can do would be a
// compile error rather than an `any`, which is the point.

declare module 'turndown' {
  /**
   * The node a rule is asked about. turndown hands over a real DOM element with a
   * few flags of its own hung on it; `isBlock`/`isCode` are the two that decide how
   * the surrounding whitespace is written.
   */
  export type Node = HTMLElement & {
    isBlock?: boolean;
    isCode?: boolean;
    isBlank?: boolean;
  };

  export interface Options {
    headingStyle?: 'setext' | 'atx';
    hr?: string;
    bulletListMarker?: '-' | '*' | '+';
    codeBlockStyle?: 'indented' | 'fenced';
    fence?: '```' | '~~~';
    emDelimiter?: '_' | '*';
    strongDelimiter?: '__' | '**';
    linkStyle?: 'inlined' | 'referenced';
    linkReferenceStyle?: 'full' | 'collapsed' | 'shortcut';
  }

  /** A tag name, several of them, or a predicate over the node. */
  export type Filter =
    | string
    | string[]
    | ((node: Node, options: Options) => boolean);

  export interface Rule {
    filter: Filter;
    /** `content` is the node's children, already turned down. */
    replacement: (content: string, node: Node, options: Options) => string;
  }

  export default class TurndownService {
    constructor(options?: Options);
    turndown(html: string | HTMLElement): string;
    addRule(key: string, rule: Rule): this;
    /** Emit these nodes as the HTML they already are. */
    keep(filter: Filter): this;
    /** Drop these nodes entirely — neither their markup nor their text. */
    remove(filter: Filter): this;
    /**
     * How a text node's Markdown-significant characters are escaped. Assignable,
     * which is what lets `narrowEscape` replace turndown's blanket table.
     */
    escape: (text: string) => string;
  }
}

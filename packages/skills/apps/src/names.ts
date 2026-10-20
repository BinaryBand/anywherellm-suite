// The names a page's scripts use without declaring them, found by reading the scripts, never by
// running them: page.html is the model's own, and a model can be steered by what it reads, so its
// code runs only in the user's browser. Each script is parsed (acorn) and every name it reads is
// looked up through the scopes around it, out to what all the page's scripts declare at their top
// level, the names they give the window, and the browser's own globals.
//
// Reading is lenient where running would have been: a name assigned without being declared
// (`x = 1` makes a global in a classic script), or given to window, globalThis or self, counts as
// declared everywhere, and nothing inside `with` is judged. `typeof x` reads nothing.
import { parse } from "acorn";

type Node = { type: string; [key: string]: any };
type Scope = { names: Set<string>; parent: Scope | null; open?: boolean };

/** JavaScript's own globals that start with a small letter (one starting with a capital, $ or _ is
 *  taken as the browser's or the language's: Math, IntersectionObserver). */
const LANGUAGE = new Set(
  "undefined NaN Infinity globalThis eval isFinite isNaN parseFloat parseInt decodeURI decodeURIComponent encodeURI encodeURIComponent escape unescape console arguments".split(" "),
);

const isNode = (v: unknown): v is Node => !!v && typeof (v as Node).type === "string";

/** Each node directly under `node`. */
function* children(node: Node): Generator<Node> {
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (isNode(c)) yield c;
    } else if (isNode(v)) yield v;
  }
}

/** The names a pattern (a declaration's or a parameter's) binds. */
function bound(pattern: Node | null, into: Set<string>): void {
  if (!pattern) return;
  if (pattern.type === "Identifier") into.add(pattern.name);
  else if (pattern.type === "ObjectPattern") for (const p of pattern.properties) bound(p.type === "RestElement" ? p.argument : p.value, into);
  else if (pattern.type === "ArrayPattern") for (const e of pattern.elements) bound(e, into);
  else if (pattern.type === "AssignmentPattern") bound(pattern.left, into);
  else if (pattern.type === "RestElement") bound(pattern.argument, into);
}

const isFunction = (n: Node) => n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression";

/** What `var` and function declarations under `node` give the function (or script) they're in:
 *  every block is entered, no function or class is. */
function hoisted(node: Node, into: Set<string>): void {
  for (const c of children(node)) {
    if (c.type === "VariableDeclaration" && c.kind === "var") for (const d of c.declarations) bound(d.id, into);
    else if (c.type === "FunctionDeclaration") c.id && into.add(c.id.name);
    if (isFunction(c) || c.type === "ClassDeclaration" || c.type === "ClassExpression") continue;
    hoisted(c, into);
  }
}

/** What `let`, `const`, class and function declarations directly in a block's statements bind. */
function lexical(statements: Node[], into: Set<string>): void {
  for (const s of statements) {
    if (s.type === "VariableDeclaration" && s.kind !== "var") for (const d of s.declarations) bound(d.id, into);
    else if ((s.type === "ClassDeclaration" || s.type === "FunctionDeclaration") && s.id) into.add(s.id.name);
  }
}

/** The names `node` gives the page as a whole: assigned without a declaration, or to window,
 *  globalThis or self. Taken from everywhere, which can only make a name count as declared. */
function given(node: Node, into: Set<string>): void {
  const target = (t: Node) => {
    if (t.type === "MemberExpression" && t.object.type === "Identifier" && ["window", "globalThis", "self"].includes(t.object.name)) {
      if (!t.computed && t.property.type === "Identifier") into.add(t.property.name);
      else if (t.property.type === "Literal" && typeof t.property.value === "string") into.add(t.property.value);
    } else bound(t, into);
  };
  if (node.type === "AssignmentExpression" && node.operator === "=") target(node.left);
  else if ((node.type === "ForInStatement" || node.type === "ForOfStatement") && node.left.type !== "VariableDeclaration") target(node.left);
  for (const c of children(node)) given(c, into);
}

/** A name read where `scope` is, with where it's read. */
type Read = { name: string; line: number; inFunction: boolean };

/** Each name read in `node` that no scope out from `scope` declares, in source order. */
function reads(node: Node, scope: Scope, inFunction: boolean, out: Read[]): void {
  const visit = (n: Node | null, s: Scope = scope, f: boolean = inFunction) => n && reads(n, s, f, out);
  const inner = (names: Set<string>, open = scope.open): Scope => ({ names, parent: scope, open });
  /** A pattern's default values and computed keys, which are read; its names are bound, not read. */
  const pattern = (p: Node | null, s: Scope = scope, f: boolean = inFunction) => {
    if (!p) return;
    if (p.type === "ObjectPattern")
      for (const q of p.properties) q.type === "RestElement" ? pattern(q.argument, s, f) : (q.computed && visit(q.key, s, f), pattern(q.value, s, f));
    else if (p.type === "ArrayPattern") for (const e of p.elements) pattern(e, s, f);
    else if (p.type === "AssignmentPattern") pattern(p.left, s, f), visit(p.right, s, f);
    else if (p.type === "RestElement") pattern(p.argument, s, f);
    else if (p.type === "MemberExpression") visit(p, s, f);
  };
  switch (node.type) {
    case "Identifier": {
      for (let s: Scope | null = scope; s; s = s.parent) if (s.open || s.names.has(node.name)) return;
      out.push({ name: node.name, line: node.loc.start.line, inFunction });
      return;
    }
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression": {
      const names = new Set<string>(["arguments"]);
      if (node.type === "FunctionExpression" && node.id) names.add(node.id.name);
      for (const p of node.params) bound(p, names);
      if (node.body.type === "BlockStatement") hoisted(node.body, names);
      const s = inner(names);
      for (const p of node.params) pattern(p, s, true);
      visit(node.body, s, true);
      return;
    }
    case "ClassDeclaration":
    case "ClassExpression": {
      const names = new Set<string>(node.id ? [node.id.name] : []);
      const s = inner(names);
      visit(node.superClass, s);
      for (const m of node.body.body) {
        if (m.type === "StaticBlock") visit({ type: "BlockStatement", body: m.body }, s, true);
        else (m.computed && visit(m.key, s), visit(m.value, s, true));
      }
      return;
    }
    case "Program":
    case "BlockStatement":
    case "StaticBlock": {
      const names = new Set<string>();
      lexical(node.body, names);
      for (const c of node.body) visit(c, node.type === "Program" ? scope : inner(names));
      return;
    }
    case "SwitchStatement": {
      visit(node.discriminant);
      const names = new Set<string>();
      for (const c of node.cases) lexical(c.consequent, names);
      const s = inner(names);
      for (const c of node.cases) (visit(c.test, s), c.consequent.forEach((x: Node) => visit(x, s)));
      return;
    }
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement": {
      const head = node.type === "ForStatement" ? node.init : node.left;
      const names = new Set<string>();
      if (head?.type === "VariableDeclaration" && head.kind !== "var") for (const d of head.declarations) bound(d.id, names);
      const s = inner(names);
      if (node.type === "ForStatement") (visit(node.init, s), visit(node.test, s), visit(node.update, s));
      else (head.type === "VariableDeclaration" ? visit(head, s) : pattern(head, s), visit(node.right, s));
      visit(node.body, s);
      return;
    }
    case "CatchClause": {
      const names = new Set<string>();
      bound(node.param, names);
      const s = inner(names);
      pattern(node.param, s);
      visit(node.body, s);
      return;
    }
    case "VariableDeclaration":
      for (const d of node.declarations) (pattern(d.id), visit(d.init));
      return;
    case "AssignmentExpression":
      if (node.operator === "=") pattern(node.left);
      else visit(node.left);
      visit(node.right);
      return;
    case "MemberExpression":
      visit(node.object);
      if (node.computed) visit(node.property);
      return;
    case "Property":
    case "PropertyDefinition":
    case "MethodDefinition":
      if (node.computed) visit(node.key);
      visit(node.value);
      return;
    case "UnaryExpression":
      if (node.operator === "typeof" && node.argument.type === "Identifier") return;
      visit(node.argument);
      return;
    case "WithStatement":
      visit(node.object);
      visit(node.body, inner(new Set(), true));
      return;
    case "LabeledStatement":
      visit(node.body);
      return;
    case "BreakStatement":
    case "ContinueStatement":
    case "MetaProperty":
      return;
    default:
      for (const c of children(node)) visit(c);
  }
}

/** Each name `scripts` read that none of them declares and the browser doesn't have (`browser`, or
 *  a name starting with a capital, $ or _), once, where it's first read: "page.html uses x, ...".
 *  A script that doesn't parse is left to the parse check; a page too deeply nested to read is
 *  not judged. */
export function undeclared(scripts: string[], browser: readonly string[]): string[] {
  try {
    const programs = scripts.map((code) => {
      try {
        return parse(code, { ecmaVersion: "latest", sourceType: "script", locations: true }) as unknown as Node;
      } catch {
        return null;
      }
    });
    const page = new Set<string>([...browser, ...LANGUAGE]);
    for (const p of programs) {
      if (!p) continue;
      hoisted(p, page);
      lexical(p.body, page);
      given(p, page);
    }
    const global: Scope = { names: page, parent: null };
    const found: string[] = [];
    const said = new Set<string>();
    programs.forEach((p, i) => {
      if (!p) return;
      const out: Read[] = [];
      reads(p, global, false, out);
      for (const r of out) {
        if (/^[A-Z$_]/.test(r.name) || said.has(r.name)) continue;
        said.add(r.name);
        found.push(`page.html uses ${r.name}, which no script declares${r.inFunction ? " when that code runs" : ""} (script ${i + 1}, line ${r.line}): the page stops there`);
      }
    });
    return found;
  } catch (e) {
    if (e instanceof RangeError) return []; // nested deeper than the stack: not judged
    throw e;
  }
}

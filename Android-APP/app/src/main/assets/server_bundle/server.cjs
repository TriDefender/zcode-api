"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS({
  "node_modules/yaml/dist/nodes/identity.js"(exports2) {
    "use strict";
    var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias");
    var DOC = /* @__PURE__ */ Symbol.for("yaml.document");
    var MAP = /* @__PURE__ */ Symbol.for("yaml.map");
    var PAIR = /* @__PURE__ */ Symbol.for("yaml.pair");
    var SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar");
    var SEQ = /* @__PURE__ */ Symbol.for("yaml.seq");
    var NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type");
    var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
    var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
    var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
    var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
    var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
    var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
    function isCollection(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case MAP:
          case SEQ:
            return true;
        }
      return false;
    }
    function isNode(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case ALIAS:
          case MAP:
          case SCALAR:
          case SEQ:
            return true;
        }
      return false;
    }
    var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
    exports2.ALIAS = ALIAS;
    exports2.DOC = DOC;
    exports2.MAP = MAP;
    exports2.NODE_TYPE = NODE_TYPE;
    exports2.PAIR = PAIR;
    exports2.SCALAR = SCALAR;
    exports2.SEQ = SEQ;
    exports2.hasAnchor = hasAnchor;
    exports2.isAlias = isAlias;
    exports2.isCollection = isCollection;
    exports2.isDocument = isDocument;
    exports2.isMap = isMap;
    exports2.isNode = isNode;
    exports2.isPair = isPair;
    exports2.isScalar = isScalar;
    exports2.isSeq = isSeq;
  }
});

// node_modules/yaml/dist/visit.js
var require_visit = __commonJS({
  "node_modules/yaml/dist/visit.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove node");
    function visit(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        visit_(null, node, visitor_, Object.freeze([]));
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    function visit_(key, node, visitor, path) {
      const ctrl = callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visit_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = visit_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = visit_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = visit_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    async function visitAsync(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        await visitAsync_(null, node, visitor_, Object.freeze([]));
    }
    visitAsync.BREAK = BREAK;
    visitAsync.SKIP = SKIP;
    visitAsync.REMOVE = REMOVE;
    async function visitAsync_(key, node, visitor, path) {
      const ctrl = await callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visitAsync_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = await visitAsync_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = await visitAsync_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = await visitAsync_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    function initVisitor(visitor) {
      if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
        return Object.assign({
          Alias: visitor.Node,
          Map: visitor.Node,
          Scalar: visitor.Node,
          Seq: visitor.Node
        }, visitor.Value && {
          Map: visitor.Value,
          Scalar: visitor.Value,
          Seq: visitor.Value
        }, visitor.Collection && {
          Map: visitor.Collection,
          Seq: visitor.Collection
        }, visitor);
      }
      return visitor;
    }
    function callVisitor(key, node, visitor, path) {
      if (typeof visitor === "function")
        return visitor(key, node, path);
      if (identity.isMap(node))
        return visitor.Map?.(key, node, path);
      if (identity.isSeq(node))
        return visitor.Seq?.(key, node, path);
      if (identity.isPair(node))
        return visitor.Pair?.(key, node, path);
      if (identity.isScalar(node))
        return visitor.Scalar?.(key, node, path);
      if (identity.isAlias(node))
        return visitor.Alias?.(key, node, path);
      return void 0;
    }
    function replaceNode(key, path, node) {
      const parent = path[path.length - 1];
      if (identity.isCollection(parent)) {
        parent.items[key] = node;
      } else if (identity.isPair(parent)) {
        if (key === "key")
          parent.key = node;
        else
          parent.value = node;
      } else if (identity.isDocument(parent)) {
        parent.contents = node;
      } else {
        const pt = identity.isAlias(parent) ? "alias" : "scalar";
        throw new Error(`Cannot replace node with ${pt} parent`);
      }
    }
    exports2.visit = visit;
    exports2.visitAsync = visitAsync;
  }
});

// node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "node_modules/yaml/dist/doc/directives.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    var escapeChars = {
      "!": "%21",
      ",": "%2C",
      "[": "%5B",
      "]": "%5D",
      "{": "%7B",
      "}": "%7D"
    };
    var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
    var Directives = class _Directives {
      constructor(yaml, tags) {
        this.docStart = null;
        this.docEnd = false;
        this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
        this.tags = Object.assign({}, _Directives.defaultTags, tags);
      }
      clone() {
        const copy = new _Directives(this.yaml, this.tags);
        copy.docStart = this.docStart;
        return copy;
      }
      /**
       * During parsing, get a Directives instance for the current document and
       * update the stream state according to the current version's spec.
       */
      atDocument() {
        const res = new _Directives(this.yaml, this.tags);
        switch (this.yaml.version) {
          case "1.1":
            this.atNextDocument = true;
            break;
          case "1.2":
            this.atNextDocument = false;
            this.yaml = {
              explicit: _Directives.defaultYaml.explicit,
              version: "1.2"
            };
            this.tags = Object.assign({}, _Directives.defaultTags);
            break;
        }
        return res;
      }
      /**
       * @param onError - May be called even if the action was successful
       * @returns `true` on success
       */
      add(line, onError) {
        if (this.atNextDocument) {
          this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
          this.tags = Object.assign({}, _Directives.defaultTags);
          this.atNextDocument = false;
        }
        const parts = line.trim().split(/[ \t]+/);
        const name = parts.shift();
        switch (name) {
          case "%TAG": {
            if (parts.length !== 2) {
              onError(0, "%TAG directive should contain exactly two parts");
              if (parts.length < 2)
                return false;
            }
            const [handle, prefix] = parts;
            this.tags[handle] = prefix;
            return true;
          }
          case "%YAML": {
            this.yaml.explicit = true;
            if (parts.length !== 1) {
              onError(0, "%YAML directive should contain exactly one part");
              return false;
            }
            const [version] = parts;
            if (version === "1.1" || version === "1.2") {
              this.yaml.version = version;
              return true;
            } else {
              const isValid = /^\d+\.\d+$/.test(version);
              onError(6, `Unsupported YAML version ${version}`, isValid);
              return false;
            }
          }
          default:
            onError(0, `Unknown directive ${name}`, true);
            return false;
        }
      }
      /**
       * Resolves a tag, matching handles to those defined in %TAG directives.
       *
       * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
       *   `'!local'` tag, or `null` if unresolvable.
       */
      tagName(source, onError) {
        if (source === "!")
          return "!";
        if (source[0] !== "!") {
          onError(`Not a valid tag: ${source}`);
          return null;
        }
        if (source[1] === "<") {
          const verbatim = source.slice(2, -1);
          if (verbatim === "!" || verbatim === "!!") {
            onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
            return null;
          }
          if (source[source.length - 1] !== ">")
            onError("Verbatim tags must end with a >");
          return verbatim;
        }
        const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
        if (!suffix)
          onError(`The ${source} tag has no suffix`);
        const prefix = this.tags[handle];
        if (prefix) {
          try {
            return prefix + decodeURIComponent(suffix);
          } catch (error) {
            onError(String(error));
            return null;
          }
        }
        if (handle === "!")
          return source;
        onError(`Could not resolve tag: ${source}`);
        return null;
      }
      /**
       * Given a fully resolved tag, returns its printable string form,
       * taking into account current tag prefixes and defaults.
       */
      tagString(tag) {
        for (const [handle, prefix] of Object.entries(this.tags)) {
          if (tag.startsWith(prefix))
            return handle + escapeTagName(tag.substring(prefix.length));
        }
        return tag[0] === "!" ? tag : `!<${tag}>`;
      }
      toString(doc) {
        const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
        const tagEntries = Object.entries(this.tags);
        let tagNames;
        if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
          const tags = {};
          visit.visit(doc.contents, (_key, node) => {
            if (identity.isNode(node) && node.tag)
              tags[node.tag] = true;
          });
          tagNames = Object.keys(tags);
        } else
          tagNames = [];
        for (const [handle, prefix] of tagEntries) {
          if (handle === "!!" && prefix === "tag:yaml.org,2002:")
            continue;
          if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
            lines.push(`%TAG ${handle} ${prefix}`);
        }
        return lines.join("\n");
      }
    };
    Directives.defaultYaml = { explicit: false, version: "1.2" };
    Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
    exports2.Directives = Directives;
  }
});

// node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS({
  "node_modules/yaml/dist/doc/anchors.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    function anchorIsValid(anchor) {
      if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
        const sa = JSON.stringify(anchor);
        const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
        throw new Error(msg);
      }
      return true;
    }
    function anchorNames(root) {
      const anchors = /* @__PURE__ */ new Set();
      visit.visit(root, {
        Value(_key, node) {
          if (node.anchor)
            anchors.add(node.anchor);
        }
      });
      return anchors;
    }
    function findNewAnchor(prefix, exclude) {
      for (let i = 1; true; ++i) {
        const name = `${prefix}${i}`;
        if (!exclude.has(name))
          return name;
      }
    }
    function createNodeAnchors(doc, prefix) {
      const aliasObjects = [];
      const sourceObjects = /* @__PURE__ */ new Map();
      let prevAnchors = null;
      return {
        onAnchor: (source) => {
          aliasObjects.push(source);
          prevAnchors ?? (prevAnchors = anchorNames(doc));
          const anchor = findNewAnchor(prefix, prevAnchors);
          prevAnchors.add(anchor);
          return anchor;
        },
        /**
         * With circular references, the source node is only resolved after all
         * of its child nodes are. This is why anchors are set only after all of
         * the nodes have been created.
         */
        setAnchors: () => {
          for (const source of aliasObjects) {
            const ref = sourceObjects.get(source);
            if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
              ref.node.anchor = ref.anchor;
            } else {
              const error = new Error("Failed to resolve repeated object (this should not happen)");
              error.source = source;
              throw error;
            }
          }
        },
        sourceObjects
      };
    }
    exports2.anchorIsValid = anchorIsValid;
    exports2.anchorNames = anchorNames;
    exports2.createNodeAnchors = createNodeAnchors;
    exports2.findNewAnchor = findNewAnchor;
  }
});

// node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS({
  "node_modules/yaml/dist/doc/applyReviver.js"(exports2) {
    "use strict";
    function applyReviver(reviver, obj, key, val) {
      if (val && typeof val === "object") {
        if (Array.isArray(val)) {
          for (let i = 0, len = val.length; i < len; ++i) {
            const v0 = val[i];
            const v1 = applyReviver(reviver, val, String(i), v0);
            if (v1 === void 0)
              delete val[i];
            else if (v1 !== v0)
              val[i] = v1;
          }
        } else if (val instanceof Map) {
          for (const k of Array.from(val.keys())) {
            const v0 = val.get(k);
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              val.delete(k);
            else if (v1 !== v0)
              val.set(k, v1);
          }
        } else if (val instanceof Set) {
          for (const v0 of Array.from(val)) {
            const v1 = applyReviver(reviver, val, v0, v0);
            if (v1 === void 0)
              val.delete(v0);
            else if (v1 !== v0) {
              val.delete(v0);
              val.add(v1);
            }
          }
        } else {
          for (const [k, v0] of Object.entries(val)) {
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              delete val[k];
            else if (v1 !== v0)
              val[k] = v1;
          }
        }
      }
      return reviver.call(obj, key, val);
    }
    exports2.applyReviver = applyReviver;
  }
});

// node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS({
  "node_modules/yaml/dist/nodes/toJS.js"(exports2) {
    "use strict";
    var identity = require_identity();
    function toJS(value, arg, ctx) {
      if (Array.isArray(value))
        return value.map((v, i) => toJS(v, String(i), ctx));
      if (value && typeof value.toJSON === "function") {
        if (!ctx || !identity.hasAnchor(value))
          return value.toJSON(arg, ctx);
        const data = { aliasCount: 0, count: 1, res: void 0 };
        ctx.anchors.set(value, data);
        ctx.onCreate = (res2) => {
          data.res = res2;
          delete ctx.onCreate;
        };
        const res = value.toJSON(arg, ctx);
        if (ctx.onCreate)
          ctx.onCreate(res);
        return res;
      }
      if (typeof value === "bigint" && !ctx?.keep)
        return Number(value);
      return value;
    }
    exports2.toJS = toJS;
  }
});

// node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS({
  "node_modules/yaml/dist/nodes/Node.js"(exports2) {
    "use strict";
    var applyReviver = require_applyReviver();
    var identity = require_identity();
    var toJS = require_toJS();
    var NodeBase = class {
      constructor(type) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: type });
      }
      /** Create a copy of this node.  */
      clone() {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** A plain JavaScript representation of this node. */
      toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        if (!identity.isDocument(doc))
          throw new TypeError("A document argument is required");
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc,
          keep: true,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this, "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
    };
    exports2.NodeBase = NodeBase;
  }
});

// node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS({
  "node_modules/yaml/dist/nodes/Alias.js"(exports2) {
    "use strict";
    var anchors = require_anchors();
    var visit = require_visit();
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var Alias = class extends Node.NodeBase {
      constructor(source) {
        super(identity.ALIAS);
        this.source = source;
        Object.defineProperty(this, "tag", {
          set() {
            throw new Error("Alias nodes cannot have tags");
          }
        });
      }
      /**
       * Resolve the value of this alias within `doc`, finding the last
       * instance of the `source` anchor before this node.
       */
      resolve(doc, ctx) {
        if (ctx?.maxAliasCount === 0)
          throw new ReferenceError("Alias resolution is disabled");
        let nodes;
        if (ctx?.aliasResolveCache) {
          nodes = ctx.aliasResolveCache;
        } else {
          nodes = [];
          visit.visit(doc, {
            Node: (_key, node) => {
              if (identity.isAlias(node) || identity.hasAnchor(node))
                nodes.push(node);
            }
          });
          if (ctx)
            ctx.aliasResolveCache = nodes;
        }
        let found = void 0;
        for (const node of nodes) {
          if (node === this)
            break;
          if (node.anchor === this.source)
            found = node;
        }
        return found;
      }
      toJSON(_arg, ctx) {
        if (!ctx)
          return { source: this.source };
        const { anchors: anchors2, doc, maxAliasCount } = ctx;
        const source = this.resolve(doc, ctx);
        if (!source) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg);
        }
        let data = anchors2.get(source);
        if (!data) {
          toJS.toJS(source, null, ctx);
          data = anchors2.get(source);
        }
        if (data?.res === void 0) {
          const msg = "This should not happen: Alias anchor was not resolved?";
          throw new ReferenceError(msg);
        }
        if (maxAliasCount >= 0) {
          data.count += 1;
          if (data.aliasCount === 0)
            data.aliasCount = getAliasCount(doc, source, anchors2);
          if (data.count * data.aliasCount > maxAliasCount) {
            const msg = "Excessive alias count indicates a resource exhaustion attack";
            throw new ReferenceError(msg);
          }
        }
        return data.res;
      }
      toString(ctx, _onComment, _onChompKeep) {
        const src = `*${this.source}`;
        if (ctx) {
          anchors.anchorIsValid(this.source);
          if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
            const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
            throw new Error(msg);
          }
          if (ctx.implicitKey)
            return `${src} `;
        }
        return src;
      }
    };
    function getAliasCount(doc, node, anchors2) {
      if (identity.isAlias(node)) {
        const source = node.resolve(doc);
        const anchor = anchors2 && source && anchors2.get(source);
        return anchor ? anchor.count * anchor.aliasCount : 0;
      } else if (identity.isCollection(node)) {
        let count = 0;
        for (const item of node.items) {
          const c = getAliasCount(doc, item, anchors2);
          if (c > count)
            count = c;
        }
        return count;
      } else if (identity.isPair(node)) {
        const kc = getAliasCount(doc, node.key, anchors2);
        const vc = getAliasCount(doc, node.value, anchors2);
        return Math.max(kc, vc);
      }
      return 1;
    }
    exports2.Alias = Alias;
  }
});

// node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS({
  "node_modules/yaml/dist/nodes/Scalar.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
    var Scalar = class extends Node.NodeBase {
      constructor(value) {
        super(identity.SCALAR);
        this.value = value;
      }
      toJSON(arg, ctx) {
        return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
      }
      toString() {
        return String(this.value);
      }
    };
    Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
    Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
    Scalar.PLAIN = "PLAIN";
    Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
    Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
    exports2.Scalar = Scalar;
    exports2.isScalarValue = isScalarValue;
  }
});

// node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS({
  "node_modules/yaml/dist/doc/createNode.js"(exports2) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var defaultTagPrefix = "tag:yaml.org,2002:";
    function findTagObject(value, tagName, tags) {
      if (tagName) {
        const match = tags.filter((t) => t.tag === tagName);
        const tagObj = match.find((t) => !t.format) ?? match[0];
        if (!tagObj)
          throw new Error(`Tag ${tagName} not found`);
        return tagObj;
      }
      return tags.find((t) => t.identify?.(value) && !t.format);
    }
    function createNode(value, tagName, ctx) {
      if (identity.isDocument(value))
        value = value.contents;
      if (identity.isNode(value))
        return value;
      if (identity.isPair(value)) {
        const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
        map.items.push(value);
        return map;
      }
      if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
        value = value.valueOf();
      }
      const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
      let ref = void 0;
      if (aliasDuplicateObjects && value && typeof value === "object") {
        ref = sourceObjects.get(value);
        if (ref) {
          ref.anchor ?? (ref.anchor = onAnchor(value));
          return new Alias.Alias(ref.anchor);
        } else {
          ref = { anchor: null, node: null };
          sourceObjects.set(value, ref);
        }
      }
      if (tagName?.startsWith("!!"))
        tagName = defaultTagPrefix + tagName.slice(2);
      let tagObj = findTagObject(value, tagName, schema.tags);
      if (!tagObj) {
        if (value && typeof value.toJSON === "function") {
          value = value.toJSON();
        }
        if (!value || typeof value !== "object") {
          const node2 = new Scalar.Scalar(value);
          if (ref)
            ref.node = node2;
          return node2;
        }
        tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
      }
      if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
      }
      const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
      if (tagName)
        node.tag = tagName;
      else if (!tagObj.default)
        node.tag = tagObj.tag;
      if (ref)
        ref.node = node;
      return node;
    }
    exports2.createNode = createNode;
  }
});

// node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS({
  "node_modules/yaml/dist/nodes/Collection.js"(exports2) {
    "use strict";
    var createNode = require_createNode();
    var identity = require_identity();
    var Node = require_Node();
    function collectionFromPath(schema, path, value) {
      let v = value;
      for (let i = path.length - 1; i >= 0; --i) {
        const k = path[i];
        if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
          const a = [];
          a[k] = v;
          v = a;
        } else {
          v = /* @__PURE__ */ new Map([[k, v]]);
        }
      }
      return createNode.createNode(v, void 0, {
        aliasDuplicateObjects: false,
        keepUndefined: false,
        onAnchor: () => {
          throw new Error("This should not happen, please report a bug.");
        },
        schema,
        sourceObjects: /* @__PURE__ */ new Map()
      });
    }
    var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
    var Collection = class extends Node.NodeBase {
      constructor(type, schema) {
        super(type);
        Object.defineProperty(this, "schema", {
          value: schema,
          configurable: true,
          enumerable: false,
          writable: true
        });
      }
      /**
       * Create a copy of this collection.
       *
       * @param schema - If defined, overwrites the original's schema
       */
      clone(schema) {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (schema)
          copy.schema = schema;
        copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /**
       * Adds a value to the collection. For `!!map` and `!!omap` the value must
       * be a Pair instance or a `{ key, value }` object, which may not have a key
       * that already exists in the map.
       */
      addIn(path, value) {
        if (isEmptyPath(path))
          this.add(value);
        else {
          const [key, ...rest] = path;
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.addIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
      /**
       * Removes a value from the collection.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.delete(key);
        const node = this.get(key, true);
        if (identity.isCollection(node))
          return node.deleteIn(rest);
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (rest.length === 0)
          return !keepScalar && identity.isScalar(node) ? node.value : node;
        else
          return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
      }
      hasAllNullValues(allowScalar) {
        return this.items.every((node) => {
          if (!identity.isPair(node))
            return false;
          const n = node.value;
          return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
        });
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       */
      hasIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.has(key);
        const node = this.get(key, true);
        return identity.isCollection(node) ? node.hasIn(rest) : false;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        const [key, ...rest] = path;
        if (rest.length === 0) {
          this.set(key, value);
        } else {
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.setIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
    };
    exports2.Collection = Collection;
    exports2.collectionFromPath = collectionFromPath;
    exports2.isEmptyPath = isEmptyPath;
  }
});

// node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyComment.js"(exports2) {
    "use strict";
    var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
    function indentComment(comment, indent) {
      if (/^\n+$/.test(comment))
        return comment.substring(1);
      return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
    }
    var lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
    exports2.indentComment = indentComment;
    exports2.lineComment = lineComment;
    exports2.stringifyComment = stringifyComment;
  }
});

// node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS({
  "node_modules/yaml/dist/stringify/foldFlowLines.js"(exports2) {
    "use strict";
    var FOLD_FLOW = "flow";
    var FOLD_BLOCK = "block";
    var FOLD_QUOTED = "quoted";
    function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
      if (text.length <= endStep)
        return text;
      const folds = [];
      const escapedFolds = {};
      let end = lineWidth - indent.length;
      if (typeof indentAtStart === "number") {
        if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
          folds.push(0);
        else
          end = lineWidth - indentAtStart;
      }
      let split = void 0;
      let prev = void 0;
      let overflow = false;
      let i = -1;
      let escStart = -1;
      let escEnd = -1;
      if (mode === FOLD_BLOCK) {
        i = consumeMoreIndentedLines(text, i, indent.length);
        if (i !== -1)
          end = i + endStep;
      }
      for (let ch; ch = text[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text[i + 1]) {
            case "x":
              i += 3;
              break;
            case "u":
              i += 5;
              break;
            case "U":
              i += 9;
              break;
            default:
              i += 1;
          }
          escEnd = i;
        }
        if (ch === "\n") {
          if (mode === FOLD_BLOCK)
            i = consumeMoreIndentedLines(text, i, indent.length);
          end = i + indent.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text[i + 1];
            if (next && next !== " " && next !== "\n" && next !== "	")
              split = i;
          }
          if (i >= end) {
            if (split) {
              folds.push(split);
              end = split + endStep;
              split = void 0;
            } else if (mode === FOLD_QUOTED) {
              while (prev === " " || prev === "	") {
                prev = ch;
                ch = text[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text;
              folds.push(j);
              escapedFolds[j] = true;
              end = j + endStep;
              split = void 0;
            } else {
              overflow = true;
            }
          }
        }
        prev = ch;
      }
      if (overflow && onOverflow)
        onOverflow();
      if (folds.length === 0)
        return text;
      if (onFold)
        onFold();
      let res = text.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end2 = folds[i2 + 1] || text.length;
        if (fold === 0)
          res = `
${indent}${text.slice(0, end2)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text[fold]}\\`;
          res += `
${indent}${text.slice(fold + 1, end2)}`;
        }
      }
      return res;
    }
    function consumeMoreIndentedLines(text, i, indent) {
      let end = i;
      let start = i + 1;
      let ch = text[start];
      while (ch === " " || ch === "	") {
        if (i < start + indent) {
          ch = text[++i];
        } else {
          do {
            ch = text[++i];
          } while (ch && ch !== "\n");
          end = i;
          start = i + 1;
          ch = text[start];
        }
      }
      return end;
    }
    exports2.FOLD_BLOCK = FOLD_BLOCK;
    exports2.FOLD_FLOW = FOLD_FLOW;
    exports2.FOLD_QUOTED = FOLD_QUOTED;
    exports2.foldFlowLines = foldFlowLines;
  }
});

// node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyString.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var foldFlowLines = require_foldFlowLines();
    var getFoldOptions = (ctx, isBlock) => ({
      indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
      lineWidth: ctx.options.lineWidth,
      minContentWidth: ctx.options.minContentWidth
    });
    var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
    function lineLengthOverLimit(str, lineWidth, indentLength) {
      if (!lineWidth || lineWidth < 0)
        return false;
      const limit = lineWidth - indentLength;
      const strLen = str.length;
      if (strLen <= limit)
        return false;
      for (let i = 0, start = 0; i < strLen; ++i) {
        if (str[i] === "\n") {
          if (i - start > limit)
            return true;
          start = i + 1;
          if (strLen - start <= limit)
            return false;
        }
      }
      return true;
    }
    function doubleQuotedString(value, ctx) {
      const json = JSON.stringify(value);
      if (ctx.options.doubleQuotedAsJSON)
        return json;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      let str = "";
      let start = 0;
      for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
        if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
          str += json.slice(start, i) + "\\ ";
          i += 1;
          start = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json[i + 1]) {
            case "u":
              {
                str += json.slice(start, i);
                const code = json.substr(i + 2, 4);
                switch (code) {
                  case "0000":
                    str += "\\0";
                    break;
                  case "0007":
                    str += "\\a";
                    break;
                  case "000b":
                    str += "\\v";
                    break;
                  case "001b":
                    str += "\\e";
                    break;
                  case "0085":
                    str += "\\N";
                    break;
                  case "00a0":
                    str += "\\_";
                    break;
                  case "2028":
                    str += "\\L";
                    break;
                  case "2029":
                    str += "\\P";
                    break;
                  default:
                    if (code.substr(0, 2) === "00")
                      str += "\\x" + code.substr(2);
                    else
                      str += json.substr(i, 6);
                }
                i += 5;
                start = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
                i += 1;
              } else {
                str += json.slice(start, i) + "\n\n";
                while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                  str += "\n";
                  i += 2;
                }
                str += indent;
                if (json[i + 2] === " ")
                  str += "\\";
                i += 1;
                start = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str = start ? str + json.slice(start) : json;
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
    }
    function singleQuotedString(value, ctx) {
      if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
        return doubleQuotedString(value, ctx);
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
      return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function quotedString(value, ctx) {
      const { singleQuote } = ctx.options;
      let qs;
      if (singleQuote === false)
        qs = doubleQuotedString;
      else {
        const hasDouble = value.includes('"');
        const hasSingle = value.includes("'");
        if (hasDouble && !hasSingle)
          qs = singleQuotedString;
        else if (hasSingle && !hasDouble)
          qs = doubleQuotedString;
        else
          qs = singleQuote ? singleQuotedString : doubleQuotedString;
      }
      return qs(value, ctx);
    }
    var blockEndNewlines;
    try {
      blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
    } catch {
      blockEndNewlines = /\n+(?!\n|$)/g;
    }
    function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
      const { blockQuote, commentString, lineWidth } = ctx.options;
      if (!blockQuote || /\n[\t ]+$/.test(value)) {
        return quotedString(value, ctx);
      }
      const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
      const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
      if (!value)
        return literal ? "|\n" : ">\n";
      let chomp;
      let endStart;
      for (endStart = value.length; endStart > 0; --endStart) {
        const ch = value[endStart - 1];
        if (ch !== "\n" && ch !== "	" && ch !== " ")
          break;
      }
      let end = value.substring(endStart);
      const endNlPos = end.indexOf("\n");
      if (endNlPos === -1) {
        chomp = "-";
      } else if (value === end || endNlPos !== end.length - 1) {
        chomp = "+";
        if (onChompKeep)
          onChompKeep();
      } else {
        chomp = "";
      }
      if (end) {
        value = value.slice(0, -end.length);
        if (end[end.length - 1] === "\n")
          end = end.slice(0, -1);
        end = end.replace(blockEndNewlines, `$&${indent}`);
      }
      let startWithSpace = false;
      let startEnd;
      let startNlPos = -1;
      for (startEnd = 0; startEnd < value.length; ++startEnd) {
        const ch = value[startEnd];
        if (ch === " ")
          startWithSpace = true;
        else if (ch === "\n")
          startNlPos = startEnd;
        else
          break;
      }
      let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
      if (start) {
        value = value.substring(start.length);
        start = start.replace(/\n+/g, `$&${indent}`);
      }
      const indentSize = indent ? "2" : "1";
      let header = (startWithSpace ? indentSize : "") + chomp;
      if (comment) {
        header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
        if (onComment)
          onComment();
      }
      if (!literal) {
        const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
        let literalFallback = false;
        const foldOptions = getFoldOptions(ctx, true);
        if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
          foldOptions.onOverflow = () => {
            literalFallback = true;
          };
        }
        const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
        if (!literalFallback)
          return `>${header}
${indent}${body}`;
      }
      value = value.replace(/\n+/g, `$&${indent}`);
      return `|${header}
${indent}${start}${value}${end}`;
    }
    function plainString(item, ctx, onComment, onChompKeep) {
      const { type, value } = item;
      const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
      if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
        return quotedString(value, ctx);
      }
      if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
        return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
      }
      if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes("\n")) {
        return blockString(item, ctx, onComment, onChompKeep);
      }
      if (containsDocumentMarker(value)) {
        if (indent === "") {
          ctx.forceBlockIndent = true;
          return blockString(item, ctx, onComment, onChompKeep);
        } else if (implicitKey && indent === indentStep) {
          return quotedString(value, ctx);
        }
      }
      const str = value.replace(/\n+/g, `$&
${indent}`);
      if (actualString) {
        const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
        const { compat, tags } = ctx.doc.schema;
        if (tags.some(test) || compat?.some(test))
          return quotedString(value, ctx);
      }
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function stringifyString(item, ctx, onComment, onChompKeep) {
      const { implicitKey, inFlow } = ctx;
      const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
      let { type } = item;
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
          type = Scalar.Scalar.QUOTE_DOUBLE;
      }
      const _stringify = (_type) => {
        switch (_type) {
          case Scalar.Scalar.BLOCK_FOLDED:
          case Scalar.Scalar.BLOCK_LITERAL:
            return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
          case Scalar.Scalar.QUOTE_DOUBLE:
            return doubleQuotedString(ss.value, ctx);
          case Scalar.Scalar.QUOTE_SINGLE:
            return singleQuotedString(ss.value, ctx);
          case Scalar.Scalar.PLAIN:
            return plainString(ss, ctx, onComment, onChompKeep);
          default:
            return null;
        }
      };
      let res = _stringify(type);
      if (res === null) {
        const { defaultKeyType, defaultStringType } = ctx.options;
        const t = implicitKey && defaultKeyType || defaultStringType;
        res = _stringify(t);
        if (res === null)
          throw new Error(`Unsupported default string type ${t}`);
      }
      return res;
    }
    exports2.stringifyString = stringifyString;
  }
});

// node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS({
  "node_modules/yaml/dist/stringify/stringify.js"(exports2) {
    "use strict";
    var anchors = require_anchors();
    var identity = require_identity();
    var stringifyComment = require_stringifyComment();
    var stringifyString = require_stringifyString();
    function createStringifyContext(doc, options) {
      const opt = Object.assign({
        blockQuote: true,
        commentString: stringifyComment.stringifyComment,
        defaultKeyType: null,
        defaultStringType: "PLAIN",
        directives: null,
        doubleQuotedAsJSON: false,
        doubleQuotedMinMultiLineLength: 40,
        falseStr: "false",
        flowCollectionPadding: true,
        indentSeq: true,
        lineWidth: 80,
        minContentWidth: 20,
        nullStr: "null",
        simpleKeys: false,
        singleQuote: null,
        trailingComma: false,
        trueStr: "true",
        verifyAliasOrder: true
      }, doc.schema.toStringOptions, options);
      let inFlow;
      switch (opt.collectionStyle) {
        case "block":
          inFlow = false;
          break;
        case "flow":
          inFlow = true;
          break;
        default:
          inFlow = null;
      }
      return {
        anchors: /* @__PURE__ */ new Set(),
        doc,
        flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
        indent: "",
        indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
        inFlow,
        options: opt
      };
    }
    function getTagObject(tags, item) {
      if (item.tag) {
        const match = tags.filter((t) => t.tag === item.tag);
        if (match.length > 0)
          return match.find((t) => t.format === item.format) ?? match[0];
      }
      let tagObj = void 0;
      let obj;
      if (identity.isScalar(item)) {
        obj = item.value;
        let match = tags.filter((t) => t.identify?.(obj));
        if (match.length > 1) {
          const testMatch = match.filter((t) => t.test);
          if (testMatch.length > 0)
            match = testMatch;
        }
        tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
      } else {
        obj = item;
        tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
      }
      if (!tagObj) {
        const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
        throw new Error(`Tag not resolved for ${name} value`);
      }
      return tagObj;
    }
    function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
      if (!doc.directives)
        return "";
      const props = [];
      const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
      if (anchor && anchors.anchorIsValid(anchor)) {
        anchors$1.add(anchor);
        props.push(`&${anchor}`);
      }
      const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
      if (tag)
        props.push(doc.directives.tagString(tag));
      return props.join(" ");
    }
    function stringify2(item, ctx, onComment, onChompKeep) {
      if (identity.isPair(item))
        return item.toString(ctx, onComment, onChompKeep);
      if (identity.isAlias(item)) {
        if (ctx.doc.directives)
          return item.toString(ctx);
        if (ctx.resolvedAliases?.has(item)) {
          throw new TypeError(`Cannot stringify circular structure without alias nodes`);
        } else {
          if (ctx.resolvedAliases)
            ctx.resolvedAliases.add(item);
          else
            ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
          item = item.resolve(ctx.doc);
        }
      }
      let tagObj = void 0;
      const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
      tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
      const props = stringifyProps(node, tagObj, ctx);
      if (props.length > 0)
        ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
      const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
      if (!props)
        return str;
      return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
    }
    exports2.createStringifyContext = createStringifyContext;
    exports2.stringify = stringify2;
  }
});

// node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyPair.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var stringify2 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
      const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
      let keyComment = identity.isNode(key) && key.comment || null;
      if (simpleKeys) {
        if (keyComment) {
          throw new Error("With simple keys, key nodes cannot have comments");
        }
        if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
          const msg = "With simple keys, collection cannot be used as a key value";
          throw new Error(msg);
        }
      }
      let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
      ctx = Object.assign({}, ctx, {
        allNullValues: false,
        implicitKey: !explicitKey && (simpleKeys || !allNullValues),
        indent: indent + indentStep
      });
      let keyCommentDone = false;
      let chompKeep = false;
      let str = stringify2.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
      if (!explicitKey && !ctx.inFlow && str.length > 1024) {
        if (simpleKeys)
          throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
        explicitKey = true;
      }
      if (ctx.inFlow) {
        if (allNullValues || value == null) {
          if (keyCommentDone && onComment)
            onComment();
          return str === "" ? "?" : explicitKey ? `? ${str}` : str;
        }
      } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
        str = `? ${str}`;
        if (keyComment && !keyCommentDone) {
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        } else if (chompKeep && onChompKeep)
          onChompKeep();
        return str;
      }
      if (keyCommentDone)
        keyComment = null;
      if (explicitKey) {
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        str = `? ${str}
${indent}:`;
      } else {
        str = `${str}:`;
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      }
      let vsb, vcb, valueComment;
      if (identity.isNode(value)) {
        vsb = !!value.spaceBefore;
        vcb = value.commentBefore;
        valueComment = value.comment;
      } else {
        vsb = false;
        vcb = null;
        valueComment = null;
        if (value && typeof value === "object")
          value = doc.createNode(value);
      }
      ctx.implicitKey = false;
      if (!explicitKey && !keyComment && identity.isScalar(value))
        ctx.indentAtStart = str.length + 1;
      chompKeep = false;
      if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
        ctx.indent = ctx.indent.substring(2);
      }
      let valueCommentDone = false;
      const valueStr = stringify2.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
      let ws = " ";
      if (keyComment || vsb || vcb) {
        ws = vsb ? "\n" : "";
        if (vcb) {
          const cs = commentString(vcb);
          ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
        }
        if (valueStr === "" && !ctx.inFlow) {
          if (ws === "\n" && valueComment)
            ws = "\n\n";
        } else {
          ws += `
${ctx.indent}`;
        }
      } else if (!explicitKey && identity.isCollection(value)) {
        const vs0 = valueStr[0];
        const nl0 = valueStr.indexOf("\n");
        const hasNewline = nl0 !== -1;
        const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
        if (hasNewline || !flow) {
          let hasPropsLine = false;
          if (hasNewline && (vs0 === "&" || vs0 === "!")) {
            let sp0 = valueStr.indexOf(" ");
            if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
              sp0 = valueStr.indexOf(" ", sp0 + 1);
            }
            if (sp0 === -1 || nl0 < sp0)
              hasPropsLine = true;
          }
          if (!hasPropsLine)
            ws = `
${ctx.indent}`;
        }
      } else if (valueStr === "" || valueStr[0] === "\n") {
        ws = "";
      }
      str += ws + valueStr;
      if (ctx.inFlow) {
        if (valueCommentDone && onComment)
          onComment();
      } else if (valueComment && !valueCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
      } else if (chompKeep && onChompKeep) {
        onChompKeep();
      }
      return str;
    }
    exports2.stringifyPair = stringifyPair;
  }
});

// node_modules/yaml/dist/log.js
var require_log = __commonJS({
  "node_modules/yaml/dist/log.js"(exports2) {
    "use strict";
    var node_process = require("process");
    function debug(logLevel, ...messages) {
      if (logLevel === "debug")
        console.log(...messages);
    }
    function warn(logLevel, warning) {
      if (logLevel === "debug" || logLevel === "warn") {
        if (typeof node_process.emitWarning === "function")
          node_process.emitWarning(warning);
        else
          console.warn(warning);
      }
    }
    exports2.debug = debug;
    exports2.warn = warn;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/merge.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var MERGE_KEY = "<<";
    var merge = {
      identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
      default: "key",
      tag: "tag:yaml.org,2002:merge",
      test: /^<<$/,
      resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
        addToJSMap: addMergeToJSMap
      }),
      stringify: () => MERGE_KEY
    };
    var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
    function addMergeToJSMap(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (identity.isSeq(source))
        for (const it of source.items)
          mergeValue(ctx, map, it);
      else if (Array.isArray(source))
        for (const it of source)
          mergeValue(ctx, map, it);
      else
        mergeValue(ctx, map, source);
    }
    function mergeValue(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (!identity.isMap(source))
        throw new Error("Merge sources must be maps or map aliases");
      const srcMap = source.toJSON(null, ctx, Map);
      for (const [key, value2] of srcMap) {
        if (map instanceof Map) {
          if (!map.has(key))
            map.set(key, value2);
        } else if (map instanceof Set) {
          map.add(key);
        } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
          Object.defineProperty(map, key, {
            value: value2,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return map;
    }
    function resolveAliasValue(ctx, value) {
      return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
    }
    exports2.addMergeToJSMap = addMergeToJSMap;
    exports2.isMergeKey = isMergeKey;
    exports2.merge = merge;
  }
});

// node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS({
  "node_modules/yaml/dist/nodes/addPairToJSMap.js"(exports2) {
    "use strict";
    var log = require_log();
    var merge = require_merge();
    var stringify2 = require_stringify();
    var identity = require_identity();
    var toJS = require_toJS();
    function addPairToJSMap(ctx, map, { key, value }) {
      if (identity.isNode(key) && key.addToJSMap)
        key.addToJSMap(ctx, map, value);
      else if (merge.isMergeKey(ctx, key))
        merge.addMergeToJSMap(ctx, map, value);
      else {
        const jsKey = toJS.toJS(key, "", ctx);
        if (map instanceof Map) {
          map.set(jsKey, toJS.toJS(value, jsKey, ctx));
        } else if (map instanceof Set) {
          map.add(jsKey);
        } else {
          const stringKey = stringifyKey(key, jsKey, ctx);
          const jsValue = toJS.toJS(value, stringKey, ctx);
          if (stringKey in map)
            Object.defineProperty(map, stringKey, {
              value: jsValue,
              writable: true,
              enumerable: true,
              configurable: true
            });
          else
            map[stringKey] = jsValue;
        }
      }
      return map;
    }
    function stringifyKey(key, jsKey, ctx) {
      if (jsKey === null)
        return "";
      if (typeof jsKey !== "object")
        return String(jsKey);
      if (identity.isNode(key) && ctx?.doc) {
        const strCtx = stringify2.createStringifyContext(ctx.doc, {});
        strCtx.anchors = /* @__PURE__ */ new Set();
        for (const node of ctx.anchors.keys())
          strCtx.anchors.add(node.anchor);
        strCtx.inFlow = true;
        strCtx.inStringifyKey = true;
        const strKey = key.toString(strCtx);
        if (!ctx.mapKeyWarned) {
          let jsonStr = JSON.stringify(strKey);
          if (jsonStr.length > 40)
            jsonStr = jsonStr.substring(0, 36) + '..."';
          log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
          ctx.mapKeyWarned = true;
        }
        return strKey;
      }
      return JSON.stringify(jsKey);
    }
    exports2.addPairToJSMap = addPairToJSMap;
  }
});

// node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS({
  "node_modules/yaml/dist/nodes/Pair.js"(exports2) {
    "use strict";
    var createNode = require_createNode();
    var stringifyPair = require_stringifyPair();
    var addPairToJSMap = require_addPairToJSMap();
    var identity = require_identity();
    function createPair(key, value, ctx) {
      const k = createNode.createNode(key, void 0, ctx);
      const v = createNode.createNode(value, void 0, ctx);
      return new Pair(k, v);
    }
    var Pair = class _Pair {
      constructor(key, value = null) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
        this.key = key;
        this.value = value;
      }
      clone(schema) {
        let { key, value } = this;
        if (identity.isNode(key))
          key = key.clone(schema);
        if (identity.isNode(value))
          value = value.clone(schema);
        return new _Pair(key, value);
      }
      toJSON(_, ctx) {
        const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        return addPairToJSMap.addPairToJSMap(ctx, pair, this);
      }
      toString(ctx, onComment, onChompKeep) {
        return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
      }
    };
    exports2.Pair = Pair;
    exports2.createPair = createPair;
  }
});

// node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyCollection.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var stringify2 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options) {
      const flow = ctx.inFlow ?? collection.flow;
      const stringify3 = flow ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify3(collection, ctx, options);
    }
    function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
      const { indent, options: { commentString } } = ctx;
      const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
      let chompKeep = false;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment2 = null;
        if (identity.isNode(item)) {
          if (!chompKeep && item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
          if (item.comment)
            comment2 = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (!chompKeep && ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
          }
        }
        chompKeep = false;
        let str2 = stringify2.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
        if (comment2)
          str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
        if (chompKeep && comment2)
          chompKeep = false;
        lines.push(blockItemPrefix + str2);
      }
      let str;
      if (lines.length === 0) {
        str = flowChars.start + flowChars.end;
      } else {
        str = lines[0];
        for (let i = 1; i < lines.length; ++i) {
          const line = lines[i];
          str += line ? `
${indent}${line}` : "\n";
        }
      }
      if (comment) {
        str += "\n" + stringifyComment.indentComment(commentString(comment), indent);
        if (onComment)
          onComment();
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
      const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
      itemIndent += indentStep;
      const itemCtx = Object.assign({}, ctx, {
        indent: itemIndent,
        inFlow: true,
        type: null
      });
      let reqNewline = false;
      let linesAtValue = 0;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment = null;
        if (identity.isNode(item)) {
          if (item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, false);
          if (item.comment)
            comment = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, false);
            if (ik.comment)
              reqNewline = true;
          }
          const iv = identity.isNode(item.value) ? item.value : null;
          if (iv) {
            if (iv.comment)
              comment = iv.comment;
            if (iv.commentBefore)
              reqNewline = true;
          } else if (item.value == null && ik?.comment) {
            comment = ik.comment;
          }
        }
        if (comment)
          reqNewline = true;
        let str = stringify2.stringify(item, itemCtx, () => comment = null);
        reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
        if (i < items.length - 1) {
          str += ",";
        } else if (ctx.options.trailingComma) {
          if (ctx.options.lineWidth > 0) {
            reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
          }
          if (reqNewline) {
            str += ",";
          }
        }
        if (comment)
          str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
        lines.push(str);
        linesAtValue = lines.length;
      }
      const { start, end } = flowChars;
      if (lines.length === 0) {
        return start + end;
      } else {
        if (!reqNewline) {
          const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
          reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
        }
        if (reqNewline) {
          let str = start;
          for (const line of lines)
            str += line ? `
${indentStep}${indent}${line}` : "\n";
          return `${str}
${indent}${end}`;
        } else {
          return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
        }
      }
    }
    function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
      if (comment && chompKeep)
        comment = comment.replace(/^\n+/, "");
      if (comment) {
        const ic = stringifyComment.indentComment(commentString(comment), indent);
        lines.push(ic.trimStart());
      }
    }
    exports2.stringifyCollection = stringifyCollection;
  }
});

// node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLMap.js"(exports2) {
    "use strict";
    var stringifyCollection = require_stringifyCollection();
    var addPairToJSMap = require_addPairToJSMap();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    function findPair(items, key) {
      const k = identity.isScalar(key) ? key.value : key;
      for (const it of items) {
        if (identity.isPair(it)) {
          if (it.key === key || it.key === k)
            return it;
          if (identity.isScalar(it.key) && it.key.value === k)
            return it;
        }
      }
      return void 0;
    }
    var YAMLMap = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:map";
      }
      constructor(schema) {
        super(identity.MAP, schema);
        this.items = [];
      }
      /**
       * A generic collection parsing method that can be extended
       * to other node classes that inherit from YAMLMap
       */
      static from(schema, obj, ctx) {
        const { keepUndefined, replacer } = ctx;
        const map = new this(schema);
        const add = (key, value) => {
          if (typeof replacer === "function")
            value = replacer.call(obj, key, value);
          else if (Array.isArray(replacer) && !replacer.includes(key))
            return;
          if (value !== void 0 || keepUndefined)
            map.items.push(Pair.createPair(key, value, ctx));
        };
        if (obj instanceof Map) {
          for (const [key, value] of obj)
            add(key, value);
        } else if (obj && typeof obj === "object") {
          for (const key of Object.keys(obj))
            add(key, obj[key]);
        }
        if (typeof schema.sortMapEntries === "function") {
          map.items.sort(schema.sortMapEntries);
        }
        return map;
      }
      /**
       * Adds a value to the collection.
       *
       * @param overwrite - If not set `true`, using a key that is already in the
       *   collection will throw. Otherwise, overwrites the previous value.
       */
      add(pair, overwrite) {
        let _pair;
        if (identity.isPair(pair))
          _pair = pair;
        else if (!pair || typeof pair !== "object" || !("key" in pair)) {
          _pair = new Pair.Pair(pair, pair?.value);
        } else
          _pair = new Pair.Pair(pair.key, pair.value);
        const prev = findPair(this.items, _pair.key);
        const sortEntries = this.schema?.sortMapEntries;
        if (prev) {
          if (!overwrite)
            throw new Error(`Key ${_pair.key} already set`);
          if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
            prev.value.value = _pair.value;
          else
            prev.value = _pair.value;
        } else if (sortEntries) {
          const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
          if (i === -1)
            this.items.push(_pair);
          else
            this.items.splice(i, 0, _pair);
        } else {
          this.items.push(_pair);
        }
      }
      delete(key) {
        const it = findPair(this.items, key);
        if (!it)
          return false;
        const del = this.items.splice(this.items.indexOf(it), 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const it = findPair(this.items, key);
        const node = it?.value;
        return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
      }
      has(key) {
        return !!findPair(this.items, key);
      }
      set(key, value) {
        this.add(new Pair.Pair(key, value), true);
      }
      /**
       * @param ctx - Conversion context, originally set in Document#toJS()
       * @param {Class} Type - If set, forces the returned collection type
       * @returns Instance of Type, Map, or Object
       */
      toJSON(_, ctx, Type) {
        const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const item of this.items)
          addPairToJSMap.addPairToJSMap(ctx, map, item);
        return map;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        for (const item of this.items) {
          if (!identity.isPair(item))
            throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
        }
        if (!ctx.allNullValues && this.hasAllNullValues(false))
          ctx = Object.assign({}, ctx, { allNullValues: true });
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "",
          flowChars: { start: "{", end: "}" },
          itemIndent: ctx.indent || "",
          onChompKeep,
          onComment
        });
      }
    };
    exports2.YAMLMap = YAMLMap;
    exports2.findPair = findPair;
  }
});

// node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS({
  "node_modules/yaml/dist/schema/common/map.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var YAMLMap = require_YAMLMap();
    var map = {
      collection: "map",
      default: true,
      nodeClass: YAMLMap.YAMLMap,
      tag: "tag:yaml.org,2002:map",
      resolve(map2, onError) {
        if (!identity.isMap(map2))
          onError("Expected a mapping for this tag");
        return map2;
      },
      createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
    };
    exports2.map = map;
  }
});

// node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLSeq.js"(exports2) {
    "use strict";
    var createNode = require_createNode();
    var stringifyCollection = require_stringifyCollection();
    var Collection = require_Collection();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var toJS = require_toJS();
    var YAMLSeq = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:seq";
      }
      constructor(schema) {
        super(identity.SEQ, schema);
        this.items = [];
      }
      add(value) {
        this.items.push(value);
      }
      /**
       * Removes a value from the collection.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       *
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return false;
        const del = this.items.splice(idx, 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return void 0;
        const it = this.items[idx];
        return !keepScalar && identity.isScalar(it) ? it.value : it;
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       */
      has(key) {
        const idx = asItemIndex(key);
        return typeof idx === "number" && idx < this.items.length;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       *
       * If `key` does not contain a representation of an integer, this will throw.
       * It may be wrapped in a `Scalar`.
       */
      set(key, value) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          throw new Error(`Expected a valid index, not ${key}.`);
        const prev = this.items[idx];
        if (identity.isScalar(prev) && Scalar.isScalarValue(value))
          prev.value = value;
        else
          this.items[idx] = value;
      }
      toJSON(_, ctx) {
        const seq2 = [];
        if (ctx?.onCreate)
          ctx.onCreate(seq2);
        let i = 0;
        for (const item of this.items)
          seq2.push(toJS.toJS(item, String(i++), ctx));
        return seq2;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "- ",
          flowChars: { start: "[", end: "]" },
          itemIndent: (ctx.indent || "") + "  ",
          onChompKeep,
          onComment
        });
      }
      static from(schema, obj, ctx) {
        const { replacer } = ctx;
        const seq2 = new this(schema);
        if (obj && Symbol.iterator in Object(obj)) {
          let i = 0;
          for (let it of obj) {
            if (typeof replacer === "function") {
              const key = obj instanceof Set ? it : String(i++);
              it = replacer.call(obj, key, it);
            }
            seq2.items.push(createNode.createNode(it, void 0, ctx));
          }
        }
        return seq2;
      }
    };
    function asItemIndex(key) {
      let idx = identity.isScalar(key) ? key.value : key;
      if (idx && typeof idx === "string")
        idx = Number(idx);
      return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
    }
    exports2.YAMLSeq = YAMLSeq;
  }
});

// node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS({
  "node_modules/yaml/dist/schema/common/seq.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var YAMLSeq = require_YAMLSeq();
    var seq2 = {
      collection: "seq",
      default: true,
      nodeClass: YAMLSeq.YAMLSeq,
      tag: "tag:yaml.org,2002:seq",
      resolve(seq3, onError) {
        if (!identity.isSeq(seq3))
          onError("Expected a sequence for this tag");
        return seq3;
      },
      createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
    };
    exports2.seq = seq2;
  }
});

// node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS({
  "node_modules/yaml/dist/schema/common/string.js"(exports2) {
    "use strict";
    var stringifyString = require_stringifyString();
    var string = {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify(item, ctx, onComment, onChompKeep) {
        ctx = Object.assign({ actualString: true }, ctx);
        return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
      }
    };
    exports2.string = string;
  }
});

// node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS({
  "node_modules/yaml/dist/schema/common/null.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var nullTag = {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^(?:~|[Nn]ull|NULL)?$/,
      resolve: () => new Scalar.Scalar(null),
      stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
    };
    exports2.nullTag = nullTag;
  }
});

// node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS({
  "node_modules/yaml/dist/schema/core/bool.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var boolTag = {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
      resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
      stringify({ source, value }, ctx) {
        if (source && boolTag.test.test(source)) {
          const sv = source[0] === "t" || source[0] === "T";
          if (value === sv)
            return source;
        }
        return value ? ctx.options.trueStr : ctx.options.falseStr;
      }
    };
    exports2.boolTag = boolTag;
  }
});

// node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyNumber.js"(exports2) {
    "use strict";
    function stringifyNumber({ format, minFractionDigits, tag, value }) {
      if (typeof value === "bigint")
        return String(value);
      const num = typeof value === "number" ? value : Number(value);
      if (!isFinite(num))
        return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
      let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
      if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
        let i = n.indexOf(".");
        if (i < 0) {
          i = n.length;
          n += ".";
        }
        let d = minFractionDigits - (n.length - i - 1);
        while (d-- > 0)
          n += "0";
      }
      return n;
    }
    exports2.stringifyNumber = stringifyNumber;
  }
});

// node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS({
  "node_modules/yaml/dist/schema/core/float.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str));
        const dot = str.indexOf(".");
        if (dot !== -1 && str[str.length - 1] === "0")
          node.minFractionDigits = str.length - dot - 1;
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports2.float = float;
    exports2.floatExp = floatExp;
    exports2.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS({
  "node_modules/yaml/dist/schema/core/int.js"(exports2) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value) && value >= 0)
        return prefix + value.toString(radix);
      return stringifyNumber.stringifyNumber(node);
    }
    var intOct = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^0o[0-7]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
      stringify: (node) => intStringify(node, 8, "0o")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^0x[0-9a-fA-F]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports2.int = int;
    exports2.intHex = intHex;
    exports2.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS({
  "node_modules/yaml/dist/schema/core/schema.js"(exports2) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq2 = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = [
      map.map,
      seq2.seq,
      string.string,
      _null.nullTag,
      bool.boolTag,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float
    ];
    exports2.schema = schema;
  }
});

// node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS({
  "node_modules/yaml/dist/schema/json/schema.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var map = require_map();
    var seq2 = require_seq();
    function intIdentify(value) {
      return typeof value === "bigint" || Number.isInteger(value);
    }
    var stringifyJSON = ({ value }) => JSON.stringify(value);
    var jsonScalars = [
      {
        identify: (value) => typeof value === "string",
        default: true,
        tag: "tag:yaml.org,2002:str",
        resolve: (str) => str,
        stringify: stringifyJSON
      },
      {
        identify: (value) => value == null,
        createNode: () => new Scalar.Scalar(null),
        default: true,
        tag: "tag:yaml.org,2002:null",
        test: /^null$/,
        resolve: () => null,
        stringify: stringifyJSON
      },
      {
        identify: (value) => typeof value === "boolean",
        default: true,
        tag: "tag:yaml.org,2002:bool",
        test: /^true$|^false$/,
        resolve: (str) => str === "true",
        stringify: stringifyJSON
      },
      {
        identify: intIdentify,
        default: true,
        tag: "tag:yaml.org,2002:int",
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
        stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
      },
      {
        identify: (value) => typeof value === "number",
        default: true,
        tag: "tag:yaml.org,2002:float",
        test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
        resolve: (str) => parseFloat(str),
        stringify: stringifyJSON
      }
    ];
    var jsonError = {
      default: true,
      tag: "",
      test: /^/,
      resolve(str, onError) {
        onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
        return str;
      }
    };
    var schema = [map.map, seq2.seq].concat(jsonScalars, jsonError);
    exports2.schema = schema;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/binary.js"(exports2) {
    "use strict";
    var node_buffer = require("buffer");
    var Scalar = require_Scalar();
    var stringifyString = require_stringifyString();
    var binary = {
      identify: (value) => value instanceof Uint8Array,
      // Buffer inherits from Uint8Array
      default: false,
      tag: "tag:yaml.org,2002:binary",
      /**
       * Returns a Buffer in node and an Uint8Array in browsers
       *
       * To use the resulting buffer as an image, you'll want to do something like:
       *
       *   const blob = new Blob([buffer], { type: 'image/jpeg' })
       *   document.querySelector('#photo').src = URL.createObjectURL(blob)
       */
      resolve(src, onError) {
        if (typeof node_buffer.Buffer === "function") {
          return node_buffer.Buffer.from(src, "base64");
        } else if (typeof atob === "function") {
          const str = atob(src.replace(/[\n\r]/g, ""));
          const buffer = new Uint8Array(str.length);
          for (let i = 0; i < str.length; ++i)
            buffer[i] = str.charCodeAt(i);
          return buffer;
        } else {
          onError("This environment does not support reading binary tags; either Buffer or atob is required");
          return src;
        }
      },
      stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
        if (!value)
          return "";
        const buf = value;
        let str;
        if (typeof node_buffer.Buffer === "function") {
          str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
        } else if (typeof btoa === "function") {
          let s = "";
          for (let i = 0; i < buf.length; ++i)
            s += String.fromCharCode(buf[i]);
          str = btoa(s);
        } else {
          throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
        }
        type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
        if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
          const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
          const n = Math.ceil(str.length / lineWidth);
          const lines = new Array(n);
          for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
            lines[i] = str.substr(o, lineWidth);
          }
          str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
        }
        return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
      }
    };
    exports2.binary = binary;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/pairs.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLSeq = require_YAMLSeq();
    function resolvePairs(seq2, onError) {
      if (identity.isSeq(seq2)) {
        for (let i = 0; i < seq2.items.length; ++i) {
          let item = seq2.items[i];
          if (identity.isPair(item))
            continue;
          else if (identity.isMap(item)) {
            if (item.items.length > 1)
              onError("Each pair must have its own sequence indicator");
            const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
            if (item.commentBefore)
              pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
            if (item.comment) {
              const cn = pair.value ?? pair.key;
              cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
            }
            item = pair;
          }
          seq2.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
        }
      } else
        onError("Expected a sequence for this tag");
      return seq2;
    }
    function createPairs(schema, iterable, ctx) {
      const { replacer } = ctx;
      const pairs2 = new YAMLSeq.YAMLSeq(schema);
      pairs2.tag = "tag:yaml.org,2002:pairs";
      let i = 0;
      if (iterable && Symbol.iterator in Object(iterable))
        for (let it of iterable) {
          if (typeof replacer === "function")
            it = replacer.call(iterable, String(i++), it);
          let key, value;
          if (Array.isArray(it)) {
            if (it.length === 2) {
              key = it[0];
              value = it[1];
            } else
              throw new TypeError(`Expected [key, value] tuple: ${it}`);
          } else if (it && it instanceof Object) {
            const keys = Object.keys(it);
            if (keys.length === 1) {
              key = keys[0];
              value = it[key];
            } else {
              throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
            }
          } else {
            key = it;
          }
          pairs2.items.push(Pair.createPair(key, value, ctx));
        }
      return pairs2;
    }
    var pairs = {
      collection: "seq",
      default: false,
      tag: "tag:yaml.org,2002:pairs",
      resolve: resolvePairs,
      createNode: createPairs
    };
    exports2.createPairs = createPairs;
    exports2.pairs = pairs;
    exports2.resolvePairs = resolvePairs;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/omap.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var toJS = require_toJS();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var pairs = require_pairs();
    var YAMLOMap = class _YAMLOMap extends YAMLSeq.YAMLSeq {
      constructor() {
        super();
        this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
        this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
        this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
        this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
        this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
        this.tag = _YAMLOMap.tag;
      }
      /**
       * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
       * but TypeScript won't allow widening the signature of a child method.
       */
      toJSON(_, ctx) {
        if (!ctx)
          return super.toJSON(_);
        const map = /* @__PURE__ */ new Map();
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const pair of this.items) {
          let key, value;
          if (identity.isPair(pair)) {
            key = toJS.toJS(pair.key, "", ctx);
            value = toJS.toJS(pair.value, key, ctx);
          } else {
            key = toJS.toJS(pair, "", ctx);
          }
          if (map.has(key))
            throw new Error("Ordered maps must not include duplicate keys");
          map.set(key, value);
        }
        return map;
      }
      static from(schema, iterable, ctx) {
        const pairs$1 = pairs.createPairs(schema, iterable, ctx);
        const omap2 = new this();
        omap2.items = pairs$1.items;
        return omap2;
      }
    };
    YAMLOMap.tag = "tag:yaml.org,2002:omap";
    var omap = {
      collection: "seq",
      identify: (value) => value instanceof Map,
      nodeClass: YAMLOMap,
      default: false,
      tag: "tag:yaml.org,2002:omap",
      resolve(seq2, onError) {
        const pairs$1 = pairs.resolvePairs(seq2, onError);
        const seenKeys = [];
        for (const { key } of pairs$1.items) {
          if (identity.isScalar(key)) {
            if (seenKeys.includes(key.value)) {
              onError(`Ordered maps must not include duplicate keys: ${key.value}`);
            } else {
              seenKeys.push(key.value);
            }
          }
        }
        return Object.assign(new YAMLOMap(), pairs$1);
      },
      createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
    };
    exports2.YAMLOMap = YAMLOMap;
    exports2.omap = omap;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/bool.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    function boolStringify({ value, source }, ctx) {
      const boolObj = value ? trueTag : falseTag;
      if (source && boolObj.test.test(source))
        return source;
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
    var trueTag = {
      identify: (value) => value === true,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
      resolve: () => new Scalar.Scalar(true),
      stringify: boolStringify
    };
    var falseTag = {
      identify: (value) => value === false,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
      resolve: () => new Scalar.Scalar(false),
      stringify: boolStringify
    };
    exports2.falseTag = falseTag;
    exports2.trueTag = trueTag;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/float.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str.replace(/_/g, "")),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
        const dot = str.indexOf(".");
        if (dot !== -1) {
          const f = str.substring(dot + 1).replace(/_/g, "");
          if (f[f.length - 1] === "0")
            node.minFractionDigits = f.length;
        }
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports2.float = float;
    exports2.floatExp = floatExp;
    exports2.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/int.js"(exports2) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    function intResolve(str, offset, radix, { intAsBigInt }) {
      const sign = str[0];
      if (sign === "-" || sign === "+")
        offset += 1;
      str = str.substring(offset).replace(/_/g, "");
      if (intAsBigInt) {
        switch (radix) {
          case 2:
            str = `0b${str}`;
            break;
          case 8:
            str = `0o${str}`;
            break;
          case 16:
            str = `0x${str}`;
            break;
        }
        const n2 = BigInt(str);
        return sign === "-" ? BigInt(-1) * n2 : n2;
      }
      const n = parseInt(str, radix);
      return sign === "-" ? -1 * n : n;
    }
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value)) {
        const str = value.toString(radix);
        return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
      }
      return stringifyNumber.stringifyNumber(node);
    }
    var intBin = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "BIN",
      test: /^[-+]?0b[0-1_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
      stringify: (node) => intStringify(node, 2, "0b")
    };
    var intOct = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^[-+]?0[0-7_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
      stringify: (node) => intStringify(node, 8, "0")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9][0-9_]*$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^[-+]?0x[0-9a-fA-F_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports2.int = int;
    exports2.intBin = intBin;
    exports2.intHex = intHex;
    exports2.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/set.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSet = class _YAMLSet extends YAMLMap.YAMLMap {
      constructor(schema) {
        super(schema);
        this.tag = _YAMLSet.tag;
      }
      add(key) {
        let pair;
        if (identity.isPair(key))
          pair = key;
        else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
          pair = new Pair.Pair(key.key, null);
        else
          pair = new Pair.Pair(key, null);
        const prev = YAMLMap.findPair(this.items, pair.key);
        if (!prev)
          this.items.push(pair);
      }
      /**
       * If `keepPair` is `true`, returns the Pair matching `key`.
       * Otherwise, returns the value of that Pair's key.
       */
      get(key, keepPair) {
        const pair = YAMLMap.findPair(this.items, key);
        return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
      }
      set(key, value) {
        if (typeof value !== "boolean")
          throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
        const prev = YAMLMap.findPair(this.items, key);
        if (prev && !value) {
          this.items.splice(this.items.indexOf(prev), 1);
        } else if (!prev && value) {
          this.items.push(new Pair.Pair(key));
        }
      }
      toJSON(_, ctx) {
        return super.toJSON(_, ctx, Set);
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        if (this.hasAllNullValues(true))
          return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
        else
          throw new Error("Set items must all have null values");
      }
      static from(schema, iterable, ctx) {
        const { replacer } = ctx;
        const set2 = new this(schema);
        if (iterable && Symbol.iterator in Object(iterable))
          for (let value of iterable) {
            if (typeof replacer === "function")
              value = replacer.call(iterable, value, value);
            set2.items.push(Pair.createPair(value, null, ctx));
          }
        return set2;
      }
    };
    YAMLSet.tag = "tag:yaml.org,2002:set";
    var set = {
      collection: "map",
      identify: (value) => value instanceof Set,
      nodeClass: YAMLSet,
      default: false,
      tag: "tag:yaml.org,2002:set",
      createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
      resolve(map, onError) {
        if (identity.isMap(map)) {
          if (map.hasAllNullValues(true))
            return Object.assign(new YAMLSet(), map);
          else
            onError("Set items must all have null values");
        } else
          onError("Expected a mapping for this tag");
        return map;
      }
    };
    exports2.YAMLSet = YAMLSet;
    exports2.set = set;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/timestamp.js"(exports2) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    function parseSexagesimal(str, asBigInt) {
      const sign = str[0];
      const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
      const num = (n) => asBigInt ? BigInt(n) : Number(n);
      const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
      return sign === "-" ? num(-1) * res : res;
    }
    function stringifySexagesimal(node) {
      let { value } = node;
      let num = (n) => n;
      if (typeof value === "bigint")
        num = (n) => BigInt(n);
      else if (isNaN(value) || !isFinite(value))
        return stringifyNumber.stringifyNumber(node);
      let sign = "";
      if (value < 0) {
        sign = "-";
        value *= num(-1);
      }
      const _60 = num(60);
      const parts = [value % _60];
      if (value < 60) {
        parts.unshift(0);
      } else {
        value = (value - parts[0]) / _60;
        parts.unshift(value % _60);
        if (value >= 60) {
          value = (value - parts[0]) / _60;
          parts.unshift(value);
        }
      }
      return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
    }
    var intTime = {
      identify: (value) => typeof value === "bigint" || Number.isInteger(value),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
      resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
      stringify: stringifySexagesimal
    };
    var floatTime = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
      resolve: (str) => parseSexagesimal(str, false),
      stringify: stringifySexagesimal
    };
    var timestamp = {
      identify: (value) => value instanceof Date,
      default: true,
      tag: "tag:yaml.org,2002:timestamp",
      // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
      // may be omitted altogether, resulting in a date format. In such a case, the time part is
      // assumed to be 00:00:00Z (start of day, UTC).
      test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
      resolve(str) {
        const match = str.match(timestamp.test);
        if (!match)
          throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
        const [, year, month, day, hour, minute, second] = match.map(Number);
        const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
        let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
        const tz = match[8];
        if (tz && tz !== "Z") {
          let d = parseSexagesimal(tz, false);
          if (Math.abs(d) < 30)
            d *= 60;
          date -= 6e4 * d;
        }
        return new Date(date);
      },
      stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
    };
    exports2.floatTime = floatTime;
    exports2.intTime = intTime;
    exports2.timestamp = timestamp;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/schema.js"(exports2) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq2 = require_seq();
    var string = require_string();
    var binary = require_binary();
    var bool = require_bool2();
    var float = require_float2();
    var int = require_int2();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var set = require_set();
    var timestamp = require_timestamp();
    var schema = [
      map.map,
      seq2.seq,
      string.string,
      _null.nullTag,
      bool.trueTag,
      bool.falseTag,
      int.intBin,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float,
      binary.binary,
      merge.merge,
      omap.omap,
      pairs.pairs,
      set.set,
      timestamp.intTime,
      timestamp.floatTime,
      timestamp.timestamp
    ];
    exports2.schema = schema;
  }
});

// node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS({
  "node_modules/yaml/dist/schema/tags.js"(exports2) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq2 = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = require_schema();
    var schema$1 = require_schema2();
    var binary = require_binary();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var schema$2 = require_schema3();
    var set = require_set();
    var timestamp = require_timestamp();
    var schemas = /* @__PURE__ */ new Map([
      ["core", schema.schema],
      ["failsafe", [map.map, seq2.seq, string.string]],
      ["json", schema$1.schema],
      ["yaml11", schema$2.schema],
      ["yaml-1.1", schema$2.schema]
    ]);
    var tagsByName = {
      binary: binary.binary,
      bool: bool.boolTag,
      float: float.float,
      floatExp: float.floatExp,
      floatNaN: float.floatNaN,
      floatTime: timestamp.floatTime,
      int: int.int,
      intHex: int.intHex,
      intOct: int.intOct,
      intTime: timestamp.intTime,
      map: map.map,
      merge: merge.merge,
      null: _null.nullTag,
      omap: omap.omap,
      pairs: pairs.pairs,
      seq: seq2.seq,
      set: set.set,
      timestamp: timestamp.timestamp
    };
    var coreKnownTags = {
      "tag:yaml.org,2002:binary": binary.binary,
      "tag:yaml.org,2002:merge": merge.merge,
      "tag:yaml.org,2002:omap": omap.omap,
      "tag:yaml.org,2002:pairs": pairs.pairs,
      "tag:yaml.org,2002:set": set.set,
      "tag:yaml.org,2002:timestamp": timestamp.timestamp
    };
    function getTags(customTags, schemaName, addMergeTag) {
      const schemaTags = schemas.get(schemaName);
      if (schemaTags && !customTags) {
        return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
      }
      let tags = schemaTags;
      if (!tags) {
        if (Array.isArray(customTags))
          tags = [];
        else {
          const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
        }
      }
      if (Array.isArray(customTags)) {
        for (const tag of customTags)
          tags = tags.concat(tag);
      } else if (typeof customTags === "function") {
        tags = customTags(tags.slice());
      }
      if (addMergeTag)
        tags = tags.concat(merge.merge);
      return tags.reduce((tags2, tag) => {
        const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
        if (!tagObj) {
          const tagName = JSON.stringify(tag);
          const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
        }
        if (!tags2.includes(tagObj))
          tags2.push(tagObj);
        return tags2;
      }, []);
    }
    exports2.coreKnownTags = coreKnownTags;
    exports2.getTags = getTags;
  }
});

// node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS({
  "node_modules/yaml/dist/schema/Schema.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var map = require_map();
    var seq2 = require_seq();
    var string = require_string();
    var tags = require_tags();
    var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    var Schema = class _Schema {
      constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
        this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
        this.name = typeof schema === "string" && schema || "core";
        this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
        this.tags = tags.getTags(customTags, this.name, merge);
        this.toStringOptions = toStringDefaults ?? null;
        Object.defineProperty(this, identity.MAP, { value: map.map });
        Object.defineProperty(this, identity.SCALAR, { value: string.string });
        Object.defineProperty(this, identity.SEQ, { value: seq2.seq });
        this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
      }
      clone() {
        const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
        copy.tags = this.tags.slice();
        return copy;
      }
    };
    exports2.Schema = Schema;
  }
});

// node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyDocument.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var stringify2 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyDocument(doc, options) {
      const lines = [];
      let hasDirectives = options.directives === true;
      if (options.directives !== false && doc.directives) {
        const dir = doc.directives.toString(doc);
        if (dir) {
          lines.push(dir);
          hasDirectives = true;
        } else if (doc.directives.docStart)
          hasDirectives = true;
      }
      if (hasDirectives)
        lines.push("---");
      const ctx = stringify2.createStringifyContext(doc, options);
      const { commentString } = ctx.options;
      if (doc.commentBefore) {
        if (lines.length !== 1)
          lines.unshift("");
        const cs = commentString(doc.commentBefore);
        lines.unshift(stringifyComment.indentComment(cs, ""));
      }
      let chompKeep = false;
      let contentComment = null;
      if (doc.contents) {
        if (identity.isNode(doc.contents)) {
          if (doc.contents.spaceBefore && hasDirectives)
            lines.push("");
          if (doc.contents.commentBefore) {
            const cs = commentString(doc.contents.commentBefore);
            lines.push(stringifyComment.indentComment(cs, ""));
          }
          ctx.forceBlockIndent = !!doc.comment;
          contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
        let body = stringify2.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body += stringifyComment.lineComment(body, "", commentString(contentComment));
        if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
          lines[lines.length - 1] = `--- ${body}`;
        } else
          lines.push(body);
      } else {
        lines.push(stringify2.stringify(doc.contents, ctx));
      }
      if (doc.directives?.docEnd) {
        if (doc.comment) {
          const cs = commentString(doc.comment);
          if (cs.includes("\n")) {
            lines.push("...");
            lines.push(stringifyComment.indentComment(cs, ""));
          } else {
            lines.push(`... ${cs}`);
          }
        } else {
          lines.push("...");
        }
      } else {
        let dc = doc.comment;
        if (dc && chompKeep)
          dc = dc.replace(/^\n+/, "");
        if (dc) {
          if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
            lines.push("");
          lines.push(stringifyComment.indentComment(commentString(dc), ""));
        }
      }
      return lines.join("\n") + "\n";
    }
    exports2.stringifyDocument = stringifyDocument;
  }
});

// node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS({
  "node_modules/yaml/dist/doc/Document.js"(exports2) {
    "use strict";
    var Alias = require_Alias();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var toJS = require_toJS();
    var Schema = require_Schema();
    var stringifyDocument = require_stringifyDocument();
    var anchors = require_anchors();
    var applyReviver = require_applyReviver();
    var createNode = require_createNode();
    var directives = require_directives();
    var Document = class _Document {
      constructor(value, replacer, options) {
        this.commentBefore = null;
        this.comment = null;
        this.errors = [];
        this.warnings = [];
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
        let _replacer = null;
        if (typeof replacer === "function" || Array.isArray(replacer)) {
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const opt = Object.assign({
          intAsBigInt: false,
          keepSourceTokens: false,
          logLevel: "warn",
          prettyErrors: true,
          strict: true,
          stringKeys: false,
          uniqueKeys: true,
          version: "1.2"
        }, options);
        this.options = opt;
        let { version } = opt;
        if (options?._directives) {
          this.directives = options._directives.atDocument();
          if (this.directives.yaml.explicit)
            version = this.directives.yaml.version;
        } else
          this.directives = new directives.Directives({ version });
        this.setSchema(version, options);
        this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
      }
      /**
       * Create a deep copy of this Document and its contents.
       *
       * Custom Node values that inherit from `Object` still refer to their original instances.
       */
      clone() {
        const copy = Object.create(_Document.prototype, {
          [identity.NODE_TYPE]: { value: identity.DOC }
        });
        copy.commentBefore = this.commentBefore;
        copy.comment = this.comment;
        copy.errors = this.errors.slice();
        copy.warnings = this.warnings.slice();
        copy.options = Object.assign({}, this.options);
        if (this.directives)
          copy.directives = this.directives.clone();
        copy.schema = this.schema.clone();
        copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** Adds a value to the document. */
      add(value) {
        if (assertCollection(this.contents))
          this.contents.add(value);
      }
      /** Adds a value to the document. */
      addIn(path, value) {
        if (assertCollection(this.contents))
          this.contents.addIn(path, value);
      }
      /**
       * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
       *
       * If `node` already has an anchor, `name` is ignored.
       * Otherwise, the `node.anchor` value will be set to `name`,
       * or if an anchor with that name is already present in the document,
       * `name` will be used as a prefix for a new unique anchor.
       * If `name` is undefined, the generated anchor will use 'a' as a prefix.
       */
      createAlias(node, name) {
        if (!node.anchor) {
          const prev = anchors.anchorNames(this);
          node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
        }
        return new Alias.Alias(node.anchor);
      }
      createNode(value, replacer, options) {
        let _replacer = void 0;
        if (typeof replacer === "function") {
          value = replacer.call({ "": value }, "", value);
          _replacer = replacer;
        } else if (Array.isArray(replacer)) {
          const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
          const asStr = replacer.filter(keyToStr).map(String);
          if (asStr.length > 0)
            replacer = replacer.concat(asStr);
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
        const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(
          this,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          anchorPrefix || "a"
        );
        const ctx = {
          aliasDuplicateObjects: aliasDuplicateObjects ?? true,
          keepUndefined: keepUndefined ?? false,
          onAnchor,
          onTagObj,
          replacer: _replacer,
          schema: this.schema,
          sourceObjects
        };
        const node = createNode.createNode(value, tag, ctx);
        if (flow && identity.isCollection(node))
          node.flow = true;
        setAnchors();
        return node;
      }
      /**
       * Convert a key and a value into a `Pair` using the current schema,
       * recursively wrapping all values as `Scalar` or `Collection` nodes.
       */
      createPair(key, value, options = {}) {
        const k = this.createNode(key, null, options);
        const v = this.createNode(value, null, options);
        return new Pair.Pair(k, v);
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        return assertCollection(this.contents) ? this.contents.delete(key) : false;
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        if (Collection.isEmptyPath(path)) {
          if (this.contents == null)
            return false;
          this.contents = null;
          return true;
        }
        return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      get(key, keepScalar) {
        return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
      }
      /**
       * Returns item at `path`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        if (Collection.isEmptyPath(path))
          return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
        return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
      }
      /**
       * Checks if the document includes a value with the key `key`.
       */
      has(key) {
        return identity.isCollection(this.contents) ? this.contents.has(key) : false;
      }
      /**
       * Checks if the document includes a value at `path`.
       */
      hasIn(path) {
        if (Collection.isEmptyPath(path))
          return this.contents !== void 0;
        return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      set(key, value) {
        if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, [key], value);
        } else if (assertCollection(this.contents)) {
          this.contents.set(key, value);
        }
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        if (Collection.isEmptyPath(path)) {
          this.contents = value;
        } else if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
        } else if (assertCollection(this.contents)) {
          this.contents.setIn(path, value);
        }
      }
      /**
       * Change the YAML version and schema used by the document.
       * A `null` version disables support for directives, explicit tags, anchors, and aliases.
       * It also requires the `schema` option to be given as a `Schema` instance value.
       *
       * Overrides all previously set schema options.
       */
      setSchema(version, options = {}) {
        if (typeof version === "number")
          version = String(version);
        let opt;
        switch (version) {
          case "1.1":
            if (this.directives)
              this.directives.yaml.version = "1.1";
            else
              this.directives = new directives.Directives({ version: "1.1" });
            opt = { resolveKnownTags: false, schema: "yaml-1.1" };
            break;
          case "1.2":
          case "next":
            if (this.directives)
              this.directives.yaml.version = version;
            else
              this.directives = new directives.Directives({ version });
            opt = { resolveKnownTags: true, schema: "core" };
            break;
          case null:
            if (this.directives)
              delete this.directives;
            opt = null;
            break;
          default: {
            const sv = JSON.stringify(version);
            throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
          }
        }
        if (options.schema instanceof Object)
          this.schema = options.schema;
        else if (opt)
          this.schema = new Schema.Schema(Object.assign(opt, options));
        else
          throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
      }
      // json & jsonArg are only used from toJSON()
      toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
      /**
       * A JSON representation of the document `contents`.
       *
       * @param jsonArg Used by `JSON.stringify` to indicate the array index or
       *   property name.
       */
      toJSON(jsonArg, onAnchor) {
        return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
      }
      /** A YAML representation of the document. */
      toString(options = {}) {
        if (this.errors.length > 0)
          throw new Error("Document with errors cannot be stringified");
        if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
          const s = JSON.stringify(options.indent);
          throw new Error(`"indent" option must be a positive integer, not ${s}`);
        }
        return stringifyDocument.stringifyDocument(this, options);
      }
    };
    function assertCollection(contents) {
      if (identity.isCollection(contents))
        return true;
      throw new Error("Expected a YAML collection as document contents");
    }
    exports2.Document = Document;
  }
});

// node_modules/yaml/dist/errors.js
var require_errors = __commonJS({
  "node_modules/yaml/dist/errors.js"(exports2) {
    "use strict";
    var YAMLError = class extends Error {
      constructor(name, pos, code, message) {
        super();
        this.name = name;
        this.code = code;
        this.message = message;
        this.pos = pos;
      }
    };
    var YAMLParseError = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLParseError", pos, code, message);
      }
    };
    var YAMLWarning = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLWarning", pos, code, message);
      }
    };
    var prettifyError = (src, lc) => (error) => {
      if (error.pos[0] === -1)
        return;
      error.linePos = error.pos.map((pos) => lc.linePos(pos));
      const { line, col } = error.linePos[0];
      error.message += ` at line ${line}, column ${col}`;
      let ci = col - 1;
      let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
      if (ci >= 60 && lineStr.length > 80) {
        const trimStart = Math.min(ci - 39, lineStr.length - 79);
        lineStr = "\u2026" + lineStr.substring(trimStart);
        ci -= trimStart - 1;
      }
      if (lineStr.length > 80)
        lineStr = lineStr.substring(0, 79) + "\u2026";
      if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
        let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
        if (prev.length > 80)
          prev = prev.substring(0, 79) + "\u2026\n";
        lineStr = prev + lineStr;
      }
      if (/[^ ]/.test(lineStr)) {
        let count = 1;
        const end = error.linePos[1];
        if (end?.line === line && end.col > col) {
          count = Math.max(1, Math.min(end.col - col, 80 - ci));
        }
        const pointer = " ".repeat(ci) + "^".repeat(count);
        error.message += `:

${lineStr}
${pointer}
`;
      }
    };
    exports2.YAMLError = YAMLError;
    exports2.YAMLParseError = YAMLParseError;
    exports2.YAMLWarning = YAMLWarning;
    exports2.prettifyError = prettifyError;
  }
});

// node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS({
  "node_modules/yaml/dist/compose/resolve-props.js"(exports2) {
    "use strict";
    function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
      let spaceBefore = false;
      let atNewline = startOnNewline;
      let hasSpace = startOnNewline;
      let comment = "";
      let commentSep = "";
      let hasNewline = false;
      let reqSpace = false;
      let tab = null;
      let anchor = null;
      let tag = null;
      let newlineAfterProp = null;
      let comma = null;
      let found = null;
      let start = null;
      for (const token of tokens) {
        if (reqSpace) {
          if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
            onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
          reqSpace = false;
        }
        if (tab) {
          if (atNewline && token.type !== "comment" && token.type !== "newline") {
            onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
          }
          tab = null;
        }
        switch (token.type) {
          case "space":
            if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
              tab = token;
            }
            hasSpace = true;
            break;
          case "comment": {
            if (!hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = token.source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += commentSep + cb;
            commentSep = "";
            atNewline = false;
            break;
          }
          case "newline":
            if (atNewline) {
              if (comment)
                comment += token.source;
              else if (!found || indicator !== "seq-item-ind")
                spaceBefore = true;
            } else
              commentSep += token.source;
            atNewline = true;
            hasNewline = true;
            if (anchor || tag)
              newlineAfterProp = token;
            hasSpace = true;
            break;
          case "anchor":
            if (anchor)
              onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
            if (token.source.endsWith(":"))
              onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
            anchor = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          case "tag": {
            if (tag)
              onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
            tag = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          }
          case indicator:
            if (anchor || tag)
              onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
            if (found)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
            found = token;
            atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
            hasSpace = false;
            break;
          case "comma":
            if (flow) {
              if (comma)
                onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
              comma = token;
              atNewline = false;
              hasSpace = false;
              break;
            }
          // else fallthrough
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
            atNewline = false;
            hasSpace = false;
        }
      }
      const last = tokens[tokens.length - 1];
      const end = last ? last.offset + last.source.length : offset;
      if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
        onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      }
      if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      return {
        comma,
        found,
        spaceBefore,
        comment,
        hasNewline,
        anchor,
        tag,
        newlineAfterProp,
        end,
        start: start ?? end
      };
    }
    exports2.resolveProps = resolveProps;
  }
});

// node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS({
  "node_modules/yaml/dist/compose/util-contains-newline.js"(exports2) {
    "use strict";
    function containsNewline(key) {
      if (!key)
        return null;
      switch (key.type) {
        case "alias":
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          if (key.source.includes("\n"))
            return true;
          if (key.end) {
            for (const st of key.end)
              if (st.type === "newline")
                return true;
          }
          return false;
        case "flow-collection":
          for (const it of key.items) {
            for (const st of it.start)
              if (st.type === "newline")
                return true;
            if (it.sep) {
              for (const st of it.sep)
                if (st.type === "newline")
                  return true;
            }
            if (containsNewline(it.key) || containsNewline(it.value))
              return true;
          }
          return false;
        default:
          return true;
      }
    }
    exports2.containsNewline = containsNewline;
  }
});

// node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS({
  "node_modules/yaml/dist/compose/util-flow-indent-check.js"(exports2) {
    "use strict";
    var utilContainsNewline = require_util_contains_newline();
    function flowIndentCheck(indent, fc, onError) {
      if (fc?.type === "flow-collection") {
        const end = fc.end[0];
        if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
          const msg = "Flow end indicator should be more indented than parent";
          onError(end, "BAD_INDENT", msg, true);
        }
      }
    }
    exports2.flowIndentCheck = flowIndentCheck;
  }
});

// node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS({
  "node_modules/yaml/dist/compose/util-map-includes.js"(exports2) {
    "use strict";
    var identity = require_identity();
    function mapIncludes(ctx, items, search) {
      const { uniqueKeys } = ctx.options;
      if (uniqueKeys === false)
        return false;
      const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
      return items.some((pair) => isEqual(pair.key, search));
    }
    exports2.mapIncludes = mapIncludes;
  }
});

// node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-map.js"(exports2) {
    "use strict";
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    var utilMapIncludes = require_util_map_includes();
    var startColMsg = "All mapping items must start at the same column";
    function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
      const map = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      let offset = bm.offset;
      let commentEnd = null;
      for (const collItem of bm.items) {
        const { start, key, sep, value } = collItem;
        const keyProps = resolveProps.resolveProps(start, {
          indicator: "explicit-key-ind",
          next: key ?? sep?.[0],
          offset,
          onError,
          parentIndent: bm.indent,
          startOnNewline: true
        });
        const implicitKey = !keyProps.found;
        if (implicitKey) {
          if (key) {
            if (key.type === "block-seq")
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
            else if ("indent" in key && key.indent !== bm.indent)
              onError(offset, "BAD_INDENT", startColMsg);
          }
          if (!keyProps.anchor && !keyProps.tag && !sep) {
            commentEnd = keyProps.end;
            if (keyProps.comment) {
              if (map.comment)
                map.comment += "\n" + keyProps.comment;
              else
                map.comment = keyProps.comment;
            }
            continue;
          }
          if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
            onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
          }
        } else if (keyProps.found?.indent !== bm.indent) {
          onError(offset, "BAD_INDENT", startColMsg);
        }
        ctx.atKey = true;
        const keyStart = keyProps.end;
        const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
        ctx.atKey = false;
        if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        const valueProps = resolveProps.resolveProps(sep ?? [], {
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: bm.indent,
          startOnNewline: !key || key.type === "block-scalar"
        });
        offset = valueProps.end;
        if (valueProps.found) {
          if (implicitKey) {
            if (value?.type === "block-map" && !valueProps.hasNewline)
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
            if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
              onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep, null, valueProps, onError);
          if (ctx.schema.compat)
            utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
          offset = valueNode.range[2];
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        } else {
          if (implicitKey)
            onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
          if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        }
      }
      if (commentEnd && commentEnd < offset)
        onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
      map.range = [bm.offset, offset, commentEnd ?? offset];
      return map;
    }
    exports2.resolveBlockMap = resolveBlockMap;
  }
});

// node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-seq.js"(exports2) {
    "use strict";
    var YAMLSeq = require_YAMLSeq();
    var resolveProps = require_resolve_props();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
      const seq2 = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = bs.offset;
      let commentEnd = null;
      for (const { start, value } of bs.items) {
        const props = resolveProps.resolveProps(start, {
          indicator: "seq-item-ind",
          next: value,
          offset,
          onError,
          parentIndent: bs.indent,
          startOnNewline: true
        });
        if (!props.found) {
          if (props.anchor || props.tag || value) {
            if (value?.type === "block-seq")
              onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
            else
              onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
          } else {
            commentEnd = props.end;
            if (props.comment)
              seq2.comment = props.comment;
            continue;
          }
        }
        const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
        offset = node.range[2];
        seq2.items.push(node);
      }
      seq2.range = [bs.offset, offset, commentEnd ?? offset];
      return seq2;
    }
    exports2.resolveBlockSeq = resolveBlockSeq;
  }
});

// node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS({
  "node_modules/yaml/dist/compose/resolve-end.js"(exports2) {
    "use strict";
    function resolveEnd(end, offset, reqSpace, onError) {
      let comment = "";
      if (end) {
        let hasSpace = false;
        let sep = "";
        for (const token of end) {
          const { source, type } = token;
          switch (type) {
            case "space":
              hasSpace = true;
              break;
            case "comment": {
              if (reqSpace && !hasSpace)
                onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
              const cb = source.substring(1) || " ";
              if (!comment)
                comment = cb;
              else
                comment += sep + cb;
              sep = "";
              break;
            }
            case "newline":
              if (comment)
                sep += source;
              hasSpace = true;
              break;
            default:
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
          }
          offset += source.length;
        }
      }
      return { comment, offset };
    }
    exports2.resolveEnd = resolveEnd;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-collection.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilMapIncludes = require_util_map_includes();
    var blockMsg = "Block collections are not allowed within flow collections";
    var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
    function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
      const isMap = fc.start.source === "{";
      const fcName = isMap ? "flow map" : "flow sequence";
      const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
      const coll = new NodeClass(ctx.schema);
      coll.flow = true;
      const atRoot = ctx.atRoot;
      if (atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = fc.offset + fc.start.source.length;
      for (let i = 0; i < fc.items.length; ++i) {
        const collItem = fc.items[i];
        const { start, key, sep, value } = collItem;
        const props = resolveProps.resolveProps(start, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep && !value) {
            if (i === 0 && props.comma)
              onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
            else if (i < fc.items.length - 1)
              onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
            if (props.comment) {
              if (coll.comment)
                coll.comment += "\n" + props.comment;
              else
                coll.comment = props.comment;
            }
            offset = props.end;
            continue;
          }
          if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
            onError(
              key,
              // checked by containsNewline()
              "MULTILINE_IMPLICIT_KEY",
              "Implicit keys of flow sequence pairs need to be on a single line"
            );
        }
        if (i === 0) {
          if (props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        } else {
          if (!props.comma)
            onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
          if (props.comment) {
            let prevItemComment = "";
            loop: for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
            if (prevItemComment) {
              let prev = coll.items[coll.items.length - 1];
              if (identity.isPair(prev))
                prev = prev.value ?? prev.key;
              if (prev.comment)
                prev.comment += "\n" + prevItemComment;
              else
                prev.comment = prevItemComment;
              props.comment = props.comment.substring(prevItemComment.length + 1);
            }
          }
        }
        if (!isMap && !sep && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep, null, props, onError);
          coll.items.push(valueNode);
          offset = valueNode.range[2];
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else {
          ctx.atKey = true;
          const keyStart = props.end;
          const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
          if (isBlock(key))
            onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
          ctx.atKey = false;
          const valueProps = resolveProps.resolveProps(sep ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap && !props.found && ctx.options.strict) {
              if (sep)
                for (const st of sep) {
                  if (st === valueProps.found)
                    break;
                  if (st.type === "newline") {
                    onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                    break;
                  }
                }
              if (props.start < valueProps.found.offset - 1024)
                onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
            }
          } else if (value) {
            if ("source" in value && value.source?.[0] === ":")
              onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
            else
              onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep, null, valueProps, onError) : null;
          if (valueNode) {
            if (isBlock(value))
              onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
          } else if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          if (isMap) {
            const map = coll;
            if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
              onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
            map.items.push(pair);
          } else {
            const map = new YAMLMap.YAMLMap(ctx.schema);
            map.flow = true;
            map.items.push(pair);
            const endRange = (valueNode ?? keyNode).range;
            map.range = [keyNode.range[0], endRange[1], endRange[2]];
            coll.items.push(map);
          }
          offset = valueNode ? valueNode.range[2] : valueProps.end;
        }
      }
      const expectedEnd = isMap ? "}" : "]";
      const [ce, ...ee] = fc.end;
      let cePos = offset;
      if (ce?.source === expectedEnd)
        cePos = ce.offset + ce.source.length;
      else {
        const name = fcName[0].toUpperCase() + fcName.substring(1);
        const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
        onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
        if (ce && ce.source.length !== 1)
          ee.unshift(ce);
      }
      if (ee.length > 0) {
        const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
        if (end.comment) {
          if (coll.comment)
            coll.comment += "\n" + end.comment;
          else
            coll.comment = end.comment;
        }
        coll.range = [fc.offset, cePos, end.offset];
      } else {
        coll.range = [fc.offset, cePos, cePos];
      }
      return coll;
    }
    exports2.resolveFlowCollection = resolveFlowCollection;
  }
});

// node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS({
  "node_modules/yaml/dist/compose/compose-collection.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveBlockMap = require_resolve_block_map();
    var resolveBlockSeq = require_resolve_block_seq();
    var resolveFlowCollection = require_resolve_flow_collection();
    function resolveCollection(CN, ctx, token, onError, tagName, tag) {
      const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
      const Coll = coll.constructor;
      if (tagName === "!" || tagName === Coll.tagName) {
        coll.tag = Coll.tagName;
        return coll;
      }
      if (tagName)
        coll.tag = tagName;
      return coll;
    }
    function composeCollection(CN, ctx, token, props, onError) {
      const tagToken = props.tag;
      const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
      if (token.type === "block-seq") {
        const { anchor, newlineAfterProp: nl } = props;
        const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
        if (lastProp && (!nl || nl.offset < lastProp.offset)) {
          const message = "Missing newline after block sequence props";
          onError(lastProp, "MISSING_CHAR", message);
        }
      }
      const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
      if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
      let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
      if (!tag) {
        const kt = ctx.schema.knownTags[tagName];
        if (kt?.collection === expType) {
          ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
          tag = kt;
        } else {
          if (kt) {
            onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
          } else {
            onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
          }
          return resolveCollection(CN, ctx, token, onError, tagName);
        }
      }
      const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
      const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
      const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
      node.range = coll.range;
      node.tag = tagName;
      if (tag?.format)
        node.format = tag.format;
      return node;
    }
    exports2.composeCollection = composeCollection;
  }
});

// node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-scalar.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    function resolveBlockScalar(ctx, scalar, onError) {
      const start = scalar.offset;
      const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
      if (!header)
        return { value: "", type: null, comment: "", range: [start, start, start] };
      const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
      const lines = scalar.source ? splitLines(scalar.source) : [];
      let chompStart = lines.length;
      for (let i = lines.length - 1; i >= 0; --i) {
        const content = lines[i][1];
        if (content === "" || content === "\r")
          chompStart = i;
        else
          break;
      }
      if (chompStart === 0) {
        const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
        let end2 = start + header.length;
        if (scalar.source)
          end2 += scalar.source.length;
        return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
      }
      let trimIndent = scalar.indent + header.indent;
      let offset = scalar.offset + header.length;
      let contentStart = 0;
      for (let i = 0; i < chompStart; ++i) {
        const [indent, content] = lines[i];
        if (content === "" || content === "\r") {
          if (header.indent === 0 && indent.length > trimIndent)
            trimIndent = indent.length;
        } else {
          if (indent.length < trimIndent) {
            const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
            onError(offset + indent.length, "MISSING_CHAR", message);
          }
          if (header.indent === 0)
            trimIndent = indent.length;
          contentStart = i;
          if (trimIndent === 0 && !ctx.atRoot) {
            const message = "Block scalar values in collections must be indented";
            onError(offset, "BAD_INDENT", message);
          }
          break;
        }
        offset += indent.length + content.length + 1;
      }
      for (let i = lines.length - 1; i >= chompStart; --i) {
        if (lines[i][0].length > trimIndent)
          chompStart = i + 1;
      }
      let value = "";
      let sep = "";
      let prevMoreIndented = false;
      for (let i = 0; i < contentStart; ++i)
        value += lines[i][0].slice(trimIndent) + "\n";
      for (let i = contentStart; i < chompStart; ++i) {
        let [indent, content] = lines[i];
        offset += indent.length + content.length + 1;
        const crlf = content[content.length - 1] === "\r";
        if (crlf)
          content = content.slice(0, -1);
        if (content && indent.length < trimIndent) {
          const src = header.indent ? "explicit indentation indicator" : "first line";
          const message = `Block scalar lines must not be less indented than their ${src}`;
          onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
          indent = "";
        }
        if (type === Scalar.Scalar.BLOCK_LITERAL) {
          value += sep + indent.slice(trimIndent) + content;
          sep = "\n";
        } else if (indent.length > trimIndent || content[0] === "	") {
          if (sep === " ")
            sep = "\n";
          else if (!prevMoreIndented && sep === "\n")
            sep = "\n\n";
          value += sep + indent.slice(trimIndent) + content;
          sep = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep === "\n")
            value += "\n";
          else
            sep = "\n";
        } else {
          value += sep + content;
          sep = " ";
          prevMoreIndented = false;
        }
      }
      switch (header.chomp) {
        case "-":
          break;
        case "+":
          for (let i = chompStart; i < lines.length; ++i)
            value += "\n" + lines[i][0].slice(trimIndent);
          if (value[value.length - 1] !== "\n")
            value += "\n";
          break;
        default:
          value += "\n";
      }
      const end = start + header.length + scalar.source.length;
      return { value, type, comment: header.comment, range: [start, end, end] };
    }
    function parseBlockScalarHeader({ offset, props }, strict, onError) {
      if (props[0].type !== "block-scalar-header") {
        onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
        return null;
      }
      const { source } = props[0];
      const mode = source[0];
      let indent = 0;
      let chomp = "";
      let error = -1;
      for (let i = 1; i < source.length; ++i) {
        const ch = source[i];
        if (!chomp && (ch === "-" || ch === "+"))
          chomp = ch;
        else {
          const n = Number(ch);
          if (!indent && n)
            indent = n;
          else if (error === -1)
            error = offset + i;
        }
      }
      if (error !== -1)
        onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
      let hasSpace = false;
      let comment = "";
      let length = source.length;
      for (let i = 1; i < props.length; ++i) {
        const token = props[i];
        switch (token.type) {
          case "space":
            hasSpace = true;
          // fallthrough
          case "newline":
            length += token.source.length;
            break;
          case "comment":
            if (strict && !hasSpace) {
              const message = "Comments must be separated from other tokens by white space characters";
              onError(token, "MISSING_CHAR", message);
            }
            length += token.source.length;
            comment = token.source.substring(1);
            break;
          case "error":
            onError(token, "UNEXPECTED_TOKEN", token.message);
            length += token.source.length;
            break;
          /* istanbul ignore next should not happen */
          default: {
            const message = `Unexpected token in block scalar header: ${token.type}`;
            onError(token, "UNEXPECTED_TOKEN", message);
            const ts = token.source;
            if (ts && typeof ts === "string")
              length += ts.length;
          }
        }
      }
      return { mode, indent, chomp, comment, length };
    }
    function splitLines(source) {
      const split = source.split(/\n( *)/);
      const first = split[0];
      const m = first.match(/^( *)/);
      const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
      const lines = [line0];
      for (let i = 1; i < split.length; i += 2)
        lines.push([split[i], split[i + 1]]);
      return lines;
    }
    exports2.resolveBlockScalar = resolveBlockScalar;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-scalar.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var resolveEnd = require_resolve_end();
    function resolveFlowScalar(scalar, strict, onError) {
      const { offset, type, source, end } = scalar;
      let _type;
      let value;
      const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
      switch (type) {
        case "scalar":
          _type = Scalar.Scalar.PLAIN;
          value = plainValue(source, _onError);
          break;
        case "single-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_SINGLE;
          value = singleQuotedValue(source, _onError);
          break;
        case "double-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_DOUBLE;
          value = doubleQuotedValue(source, _onError);
          break;
        /* istanbul ignore next should not happen */
        default:
          onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
          return {
            value: "",
            type: null,
            comment: "",
            range: [offset, offset + source.length, offset + source.length]
          };
      }
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
      return {
        value,
        type: _type,
        comment: re.comment,
        range: [offset, valueEnd, re.offset]
      };
    }
    function plainValue(source, onError) {
      let badChar = "";
      switch (source[0]) {
        /* istanbul ignore next should not happen */
        case "	":
          badChar = "a tab character";
          break;
        case ",":
          badChar = "flow indicator character ,";
          break;
        case "%":
          badChar = "directive indicator character %";
          break;
        case "|":
        case ">": {
          badChar = `block scalar indicator ${source[0]}`;
          break;
        }
        case "@":
        case "`": {
          badChar = `reserved character ${source[0]}`;
          break;
        }
      }
      if (badChar)
        onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
      return foldLines(source);
    }
    function singleQuotedValue(source, onError) {
      if (source[source.length - 1] !== "'" || source.length === 1)
        onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
      return foldLines(source.slice(1, -1)).replace(/''/g, "'");
    }
    function foldLines(source) {
      let first, line;
      try {
        first = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
        line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
      } catch {
        first = /(.*?)[ \t]*\r?\n/sy;
        line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
      }
      let match = first.exec(source);
      if (!match)
        return source;
      let res = match[1];
      let sep = " ";
      let pos = first.lastIndex;
      line.lastIndex = pos;
      while (match = line.exec(source)) {
        if (match[1] === "") {
          if (sep === "\n")
            res += sep;
          else
            sep = "\n";
        } else {
          res += sep + match[1];
          sep = " ";
        }
        pos = line.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match = last.exec(source);
      return res + sep + (match?.[1] ?? "");
    }
    function doubleQuotedValue(source, onError) {
      let res = "";
      for (let i = 1; i < source.length - 1; ++i) {
        const ch = source[i];
        if (ch === "\r" && source[i + 1] === "\n")
          continue;
        if (ch === "\n") {
          const { fold, offset } = foldNewline(source, i);
          res += fold;
          i = offset;
        } else if (ch === "\\") {
          let next = source[++i];
          const cc = escapeCodes[next];
          if (cc)
            res += cc;
          else if (next === "\n") {
            next = source[i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "\r" && source[i + 1] === "\n") {
            next = source[++i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "x" || next === "u" || next === "U") {
            const length = next === "x" ? 2 : next === "u" ? 4 : 8;
            res += parseCharCode(source, i + 1, length, onError);
            i += length;
          } else {
            const raw = source.substr(i - 1, 2);
            onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
            res += raw;
          }
        } else if (ch === " " || ch === "	") {
          const wsStart = i;
          let next = source[i + 1];
          while (next === " " || next === "	")
            next = source[++i + 1];
          if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
            res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
        } else {
          res += ch;
        }
      }
      if (source[source.length - 1] !== '"' || source.length === 1)
        onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
      return res;
    }
    function foldNewline(source, offset) {
      let fold = "";
      let ch = source[offset + 1];
      while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[offset + 2] !== "\n")
          break;
        if (ch === "\n")
          fold += "\n";
        offset += 1;
        ch = source[offset + 1];
      }
      if (!fold)
        fold = " ";
      return { fold, offset };
    }
    var escapeCodes = {
      "0": "\0",
      // null character
      a: "\x07",
      // bell character
      b: "\b",
      // backspace
      e: "\x1B",
      // escape character
      f: "\f",
      // form feed
      n: "\n",
      // line feed
      r: "\r",
      // carriage return
      t: "	",
      // horizontal tab
      v: "\v",
      // vertical tab
      N: "\x85",
      // Unicode next line
      _: "\xA0",
      // Unicode non-breaking space
      L: "\u2028",
      // Unicode line separator
      P: "\u2029",
      // Unicode paragraph separator
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      "	": "	"
    };
    function parseCharCode(source, offset, length, onError) {
      const cc = source.substr(offset, length);
      const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
      const code = ok ? parseInt(cc, 16) : NaN;
      try {
        return String.fromCodePoint(code);
      } catch {
        const raw = source.substr(offset - 2, length + 2);
        onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        return raw;
      }
    }
    exports2.resolveFlowScalar = resolveFlowScalar;
  }
});

// node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS({
  "node_modules/yaml/dist/compose/compose-scalar.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    function composeScalar(ctx, token, tagToken, onError) {
      const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
      const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
      let tag;
      if (ctx.options.stringKeys && ctx.atKey) {
        tag = ctx.schema[identity.SCALAR];
      } else if (tagName)
        tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
      else if (token.type === "scalar")
        tag = findScalarTagByTest(ctx, value, token, onError);
      else
        tag = ctx.schema[identity.SCALAR];
      let scalar;
      try {
        const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
        scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
        scalar = new Scalar.Scalar(value);
      }
      scalar.range = range;
      scalar.source = value;
      if (type)
        scalar.type = type;
      if (tagName)
        scalar.tag = tagName;
      if (tag.format)
        scalar.format = tag.format;
      if (comment)
        scalar.comment = comment;
      return scalar;
    }
    function findScalarTagByName(schema, value, tagName, tagToken, onError) {
      if (tagName === "!")
        return schema[identity.SCALAR];
      const matchWithTest = [];
      for (const tag of schema.tags) {
        if (!tag.collection && tag.tag === tagName) {
          if (tag.default && tag.test)
            matchWithTest.push(tag);
          else
            return tag;
        }
      }
      for (const tag of matchWithTest)
        if (tag.test?.test(value))
          return tag;
      const kt = schema.knownTags[tagName];
      if (kt && !kt.collection) {
        schema.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
        return kt;
      }
      onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
      return schema[identity.SCALAR];
    }
    function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
      const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
      if (schema.compat) {
        const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
        if (tag.tag !== compat.tag) {
          const ts = directives.tagString(tag.tag);
          const cs = directives.tagString(compat.tag);
          const msg = `Value may be parsed as either ${ts} or ${cs}`;
          onError(token, "TAG_RESOLVE_FAILED", msg, true);
        }
      }
      return tag;
    }
    exports2.composeScalar = composeScalar;
  }
});

// node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS({
  "node_modules/yaml/dist/compose/util-empty-scalar-position.js"(exports2) {
    "use strict";
    function emptyScalarPosition(offset, before, pos) {
      if (before) {
        pos ?? (pos = before.length);
        for (let i = pos - 1; i >= 0; --i) {
          let st = before[i];
          switch (st.type) {
            case "space":
            case "comment":
            case "newline":
              offset -= st.source.length;
              continue;
          }
          st = before[++i];
          while (st?.type === "space") {
            offset += st.source.length;
            st = before[++i];
          }
          break;
        }
      }
      return offset;
    }
    exports2.emptyScalarPosition = emptyScalarPosition;
  }
});

// node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS({
  "node_modules/yaml/dist/compose/compose-node.js"(exports2) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var composeCollection = require_compose_collection();
    var composeScalar = require_compose_scalar();
    var resolveEnd = require_resolve_end();
    var utilEmptyScalarPosition = require_util_empty_scalar_position();
    var CN = { composeNode, composeEmptyNode };
    function composeNode(ctx, token, props, onError) {
      const atKey = ctx.atKey;
      const { spaceBefore, comment, anchor, tag } = props;
      let node;
      let isSrcToken = true;
      switch (token.type) {
        case "alias":
          node = composeAlias(ctx, token, onError);
          if (anchor || tag)
            onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
          break;
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "block-scalar":
          node = composeScalar.composeScalar(ctx, token, tag, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
          break;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          try {
            node = composeCollection.composeCollection(CN, ctx, token, props, onError);
            if (anchor)
              node.anchor = anchor.source.substring(1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onError(token, "RESOURCE_EXHAUSTION", message);
          }
          break;
        default: {
          const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
          onError(token, "UNEXPECTED_TOKEN", message);
          isSrcToken = false;
        }
      }
      node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
      if (anchor && node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
        const msg = "With stringKeys, all keys must be strings";
        onError(tag ?? token, "NON_STRING_KEY", msg);
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        if (token.type === "scalar" && token.source === "")
          node.comment = comment;
        else
          node.commentBefore = comment;
      }
      if (ctx.options.keepSourceTokens && isSrcToken)
        node.srcToken = token;
      return node;
    }
    function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
      const token = {
        type: "scalar",
        offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
        indent: -1,
        source: ""
      };
      const node = composeScalar.composeScalar(ctx, token, tag, onError);
      if (anchor) {
        node.anchor = anchor.source.substring(1);
        if (node.anchor === "")
          onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        node.comment = comment;
        node.range[2] = end;
      }
      return node;
    }
    function composeAlias({ options }, { offset, source, end }, onError) {
      const alias = new Alias.Alias(source.substring(1));
      if (alias.source === "")
        onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
      if (alias.source.endsWith(":"))
        onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
      alias.range = [offset, valueEnd, re.offset];
      if (re.comment)
        alias.comment = re.comment;
      return alias;
    }
    exports2.composeEmptyNode = composeEmptyNode;
    exports2.composeNode = composeNode;
  }
});

// node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS({
  "node_modules/yaml/dist/compose/compose-doc.js"(exports2) {
    "use strict";
    var Document = require_Document();
    var composeNode = require_compose_node();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    function composeDoc(options, directives, { offset, start, value, end }, onError) {
      const opts = Object.assign({ _directives: directives }, options);
      const doc = new Document.Document(void 0, opts);
      const ctx = {
        atKey: false,
        atRoot: true,
        directives: doc.directives,
        options: doc.options,
        schema: doc.schema
      };
      const props = resolveProps.resolveProps(start, {
        indicator: "doc-start",
        next: value ?? end?.[0],
        offset,
        onError,
        parentIndent: 0,
        startOnNewline: true
      });
      if (props.found) {
        doc.directives.docStart = true;
        if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
          onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
      }
      doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
      const contentEnd = doc.contents.range[2];
      const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
      if (re.comment)
        doc.comment = re.comment;
      doc.range = [offset, contentEnd, re.offset];
      return doc;
    }
    exports2.composeDoc = composeDoc;
  }
});

// node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS({
  "node_modules/yaml/dist/compose/composer.js"(exports2) {
    "use strict";
    var node_process = require("process");
    var directives = require_directives();
    var Document = require_Document();
    var errors = require_errors();
    var identity = require_identity();
    var composeDoc = require_compose_doc();
    var resolveEnd = require_resolve_end();
    function getErrorPos(src) {
      if (typeof src === "number")
        return [src, src + 1];
      if (Array.isArray(src))
        return src.length === 2 ? src : [src[0], src[1]];
      const { offset, source } = src;
      return [offset, offset + (typeof source === "string" ? source.length : 1)];
    }
    function parsePrelude(prelude) {
      let comment = "";
      let atComment = false;
      let afterEmptyLine = false;
      for (let i = 0; i < prelude.length; ++i) {
        const source = prelude[i];
        switch (source[0]) {
          case "#":
            comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
            atComment = true;
            afterEmptyLine = false;
            break;
          case "%":
            if (prelude[i + 1]?.[0] !== "#")
              i += 1;
            atComment = false;
            break;
          default:
            if (!atComment)
              afterEmptyLine = true;
            atComment = false;
        }
      }
      return { comment, afterEmptyLine };
    }
    var Composer = class {
      constructor(options = {}) {
        this.doc = null;
        this.atDirectives = false;
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
        this.onError = (source, code, message, warning) => {
          const pos = getErrorPos(source);
          if (warning)
            this.warnings.push(new errors.YAMLWarning(pos, code, message));
          else
            this.errors.push(new errors.YAMLParseError(pos, code, message));
        };
        this.directives = new directives.Directives({ version: options.version || "1.2" });
        this.options = options;
      }
      decorate(doc, afterDoc) {
        const { comment, afterEmptyLine } = parsePrelude(this.prelude);
        if (comment) {
          const dc = doc.contents;
          if (afterDoc) {
            doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
          } else if (afterEmptyLine || doc.directives.docStart || !dc) {
            doc.commentBefore = comment;
          } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
            let it = dc.items[0];
            if (identity.isPair(it))
              it = it.key;
            const cb = it.commentBefore;
            it.commentBefore = cb ? `${comment}
${cb}` : comment;
          } else {
            const cb = dc.commentBefore;
            dc.commentBefore = cb ? `${comment}
${cb}` : comment;
          }
        }
        if (afterDoc) {
          for (let i = 0; i < this.errors.length; ++i)
            doc.errors.push(this.errors[i]);
          for (let i = 0; i < this.warnings.length; ++i)
            doc.warnings.push(this.warnings[i]);
        } else {
          doc.errors = this.errors;
          doc.warnings = this.warnings;
        }
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
      }
      /**
       * Current stream status information.
       *
       * Mostly useful at the end of input for an empty stream.
       */
      streamInfo() {
        return {
          comment: parsePrelude(this.prelude).comment,
          directives: this.directives,
          errors: this.errors,
          warnings: this.warnings
        };
      }
      /**
       * Compose tokens into documents.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *compose(tokens, forceDoc = false, endOffset = -1) {
        for (const token of tokens)
          yield* this.next(token);
        yield* this.end(forceDoc, endOffset);
      }
      /** Advance the composer by one CST token. */
      *next(token) {
        if (node_process.env.LOG_STREAM)
          console.dir(token, { depth: null });
        switch (token.type) {
          case "directive":
            this.directives.add(token.source, (offset, message, warning) => {
              const pos = getErrorPos(token);
              pos[0] += offset;
              this.onError(pos, "BAD_DIRECTIVE", message, warning);
            });
            this.prelude.push(token.source);
            this.atDirectives = true;
            break;
          case "document": {
            const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
            if (this.atDirectives && !doc.directives.docStart)
              this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
            this.decorate(doc, false);
            if (this.doc)
              yield this.doc;
            this.doc = doc;
            this.atDirectives = false;
            break;
          }
          case "byte-order-mark":
          case "space":
            break;
          case "comment":
          case "newline":
            this.prelude.push(token.source);
            break;
          case "error": {
            const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
            const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
            if (this.atDirectives || !this.doc)
              this.errors.push(error);
            else
              this.doc.errors.push(error);
            break;
          }
          case "doc-end": {
            if (!this.doc) {
              const msg = "Unexpected doc-end without preceding document";
              this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
              break;
            }
            this.doc.directives.docEnd = true;
            const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
            this.decorate(this.doc, true);
            if (end.comment) {
              const dc = this.doc.comment;
              this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
            }
            this.doc.range[2] = end.offset;
            break;
          }
          default:
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
        }
      }
      /**
       * Call at end of input to yield any remaining document.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *end(forceDoc = false, endOffset = -1) {
        if (this.doc) {
          this.decorate(this.doc, true);
          yield this.doc;
          this.doc = null;
        } else if (forceDoc) {
          const opts = Object.assign({ _directives: this.directives }, this.options);
          const doc = new Document.Document(void 0, opts);
          if (this.atDirectives)
            this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
          doc.range = [0, endOffset, endOffset];
          this.decorate(doc, false);
          yield doc;
        }
      }
    };
    exports2.Composer = Composer;
  }
});

// node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS({
  "node_modules/yaml/dist/parse/cst-scalar.js"(exports2) {
    "use strict";
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    var errors = require_errors();
    var stringifyString = require_stringifyString();
    function resolveAsScalar(token, strict = true, onError) {
      if (token) {
        const _onError = (pos, code, message) => {
          const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
          if (onError)
            onError(offset, code, message);
          else
            throw new errors.YAMLParseError([offset, offset + 1], code, message);
        };
        switch (token.type) {
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
          case "block-scalar":
            return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
        }
      }
      return null;
    }
    function createScalarToken(value, context) {
      const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey,
        indent: indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      const end = context.end ?? [
        { type: "newline", offset: -1, indent, source: "\n" }
      ];
      switch (source[0]) {
        case "|":
        case ">": {
          const he = source.indexOf("\n");
          const head = source.substring(0, he);
          const body = source.substring(he + 1) + "\n";
          const props = [
            { type: "block-scalar-header", offset, indent, source: head }
          ];
          if (!addEndtoBlockProps(props, end))
            props.push({ type: "newline", offset: -1, indent, source: "\n" });
          return { type: "block-scalar", offset, indent, props, source: body };
        }
        case '"':
          return { type: "double-quoted-scalar", offset, indent, source, end };
        case "'":
          return { type: "single-quoted-scalar", offset, indent, source, end };
        default:
          return { type: "scalar", offset, indent, source, end };
      }
    }
    function setScalarValue(token, value, context = {}) {
      let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
      let indent = "indent" in token ? token.indent : null;
      if (afterKey && typeof indent === "number")
        indent += 2;
      if (!type)
        switch (token.type) {
          case "single-quoted-scalar":
            type = "QUOTE_SINGLE";
            break;
          case "double-quoted-scalar":
            type = "QUOTE_DOUBLE";
            break;
          case "block-scalar": {
            const header = token.props[0];
            if (header.type !== "block-scalar-header")
              throw new Error("Invalid block scalar header");
            type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
            break;
          }
          default:
            type = "PLAIN";
        }
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey: implicitKey || indent === null,
        indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      switch (source[0]) {
        case "|":
        case ">":
          setBlockScalarValue(token, source);
          break;
        case '"':
          setFlowScalarValue(token, source, "double-quoted-scalar");
          break;
        case "'":
          setFlowScalarValue(token, source, "single-quoted-scalar");
          break;
        default:
          setFlowScalarValue(token, source, "scalar");
      }
    }
    function setBlockScalarValue(token, source) {
      const he = source.indexOf("\n");
      const head = source.substring(0, he);
      const body = source.substring(he + 1) + "\n";
      if (token.type === "block-scalar") {
        const header = token.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        header.source = head;
        token.source = body;
      } else {
        const { offset } = token;
        const indent = "indent" in token ? token.indent : -1;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0))
          props.push({ type: "newline", offset: -1, indent, source: "\n" });
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type: "block-scalar", indent, props, source: body });
      }
    }
    function addEndtoBlockProps(props, end) {
      if (end)
        for (const st of end)
          switch (st.type) {
            case "space":
            case "comment":
              props.push(st);
              break;
            case "newline":
              props.push(st);
              return true;
          }
      return false;
    }
    function setFlowScalarValue(token, source, type) {
      switch (token.type) {
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          token.type = type;
          token.source = source;
          break;
        case "block-scalar": {
          const end = token.props.slice(1);
          let oa = source.length;
          if (token.props[0].type === "block-scalar-header")
            oa -= token.props[0].source.length;
          for (const tok of end)
            tok.offset += oa;
          delete token.props;
          Object.assign(token, { type, source, end });
          break;
        }
        case "block-map":
        case "block-seq": {
          const offset = token.offset + source.length;
          const nl = { type: "newline", offset, indent: token.indent, source: "\n" };
          delete token.items;
          Object.assign(token, { type, source, end: [nl] });
          break;
        }
        default: {
          const indent = "indent" in token ? token.indent : -1;
          const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
          for (const key of Object.keys(token))
            if (key !== "type" && key !== "offset")
              delete token[key];
          Object.assign(token, { type, indent, source, end });
        }
      }
    }
    exports2.createScalarToken = createScalarToken;
    exports2.resolveAsScalar = resolveAsScalar;
    exports2.setScalarValue = setScalarValue;
  }
});

// node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS({
  "node_modules/yaml/dist/parse/cst-stringify.js"(exports2) {
    "use strict";
    var stringify2 = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
    function stringifyToken(token) {
      switch (token.type) {
        case "block-scalar": {
          let res = "";
          for (const tok of token.props)
            res += stringifyToken(tok);
          return res + token.source;
        }
        case "block-map":
        case "block-seq": {
          let res = "";
          for (const item of token.items)
            res += stringifyItem(item);
          return res;
        }
        case "flow-collection": {
          let res = token.start.source;
          for (const item of token.items)
            res += stringifyItem(item);
          for (const st of token.end)
            res += st.source;
          return res;
        }
        case "document": {
          let res = stringifyItem(token);
          if (token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
        default: {
          let res = token.source;
          if ("end" in token && token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
      }
    }
    function stringifyItem({ start, key, sep, value }) {
      let res = "";
      for (const st of start)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep)
        for (const st of sep)
          res += st.source;
      if (value)
        res += stringifyToken(value);
      return res;
    }
    exports2.stringify = stringify2;
  }
});

// node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "node_modules/yaml/dist/parse/cst-visit.js"(exports2) {
    "use strict";
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove item");
    function visit(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    visit.itemAtPath = (cst, path) => {
      let item = cst;
      for (const [field, index] of path) {
        const tok = item?.[field];
        if (tok && "items" in tok) {
          item = tok.items[index];
        } else
          return void 0;
      }
      return item;
    };
    visit.parentCollection = (cst, path) => {
      const parent = visit.itemAtPath(cst, path.slice(0, -1));
      const field = path[path.length - 1][0];
      const coll = parent?.[field];
      if (coll && "items" in coll)
        return coll;
      throw new Error("Parent collection not found");
    };
    function _visit(path, item, visitor) {
      let ctrl = visitor(item, path);
      if (typeof ctrl === "symbol")
        return ctrl;
      for (const field of ["key", "value"]) {
        const token = item[field];
        if (token && "items" in token) {
          for (let i = 0; i < token.items.length; ++i) {
            const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              token.items.splice(i, 1);
              i -= 1;
            }
          }
          if (typeof ctrl === "function" && field === "key")
            ctrl = ctrl(item, path);
        }
      }
      return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
    }
    exports2.visit = visit;
  }
});

// node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS({
  "node_modules/yaml/dist/parse/cst.js"(exports2) {
    "use strict";
    var cstScalar = require_cst_scalar();
    var cstStringify = require_cst_stringify();
    var cstVisit = require_cst_visit();
    var BOM = "\uFEFF";
    var DOCUMENT = "";
    var FLOW_END = "";
    var SCALAR = "";
    var isCollection = (token) => !!token && "items" in token;
    var isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
    function prettyToken(token) {
      switch (token) {
        case BOM:
          return "<BOM>";
        case DOCUMENT:
          return "<DOC>";
        case FLOW_END:
          return "<FLOW_END>";
        case SCALAR:
          return "<SCALAR>";
        default:
          return JSON.stringify(token);
      }
    }
    function tokenType(source) {
      switch (source) {
        case BOM:
          return "byte-order-mark";
        case DOCUMENT:
          return "doc-mode";
        case FLOW_END:
          return "flow-error-end";
        case SCALAR:
          return "scalar";
        case "---":
          return "doc-start";
        case "...":
          return "doc-end";
        case "":
        case "\n":
        case "\r\n":
          return "newline";
        case "-":
          return "seq-item-ind";
        case "?":
          return "explicit-key-ind";
        case ":":
          return "map-value-ind";
        case "{":
          return "flow-map-start";
        case "}":
          return "flow-map-end";
        case "[":
          return "flow-seq-start";
        case "]":
          return "flow-seq-end";
        case ",":
          return "comma";
      }
      switch (source[0]) {
        case " ":
        case "	":
          return "space";
        case "#":
          return "comment";
        case "%":
          return "directive-line";
        case "*":
          return "alias";
        case "&":
          return "anchor";
        case "!":
          return "tag";
        case "'":
          return "single-quoted-scalar";
        case '"':
          return "double-quoted-scalar";
        case "|":
        case ">":
          return "block-scalar-header";
      }
      return null;
    }
    exports2.createScalarToken = cstScalar.createScalarToken;
    exports2.resolveAsScalar = cstScalar.resolveAsScalar;
    exports2.setScalarValue = cstScalar.setScalarValue;
    exports2.stringify = cstStringify.stringify;
    exports2.visit = cstVisit.visit;
    exports2.BOM = BOM;
    exports2.DOCUMENT = DOCUMENT;
    exports2.FLOW_END = FLOW_END;
    exports2.SCALAR = SCALAR;
    exports2.isCollection = isCollection;
    exports2.isScalar = isScalar;
    exports2.prettyToken = prettyToken;
    exports2.tokenType = tokenType;
  }
});

// node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS({
  "node_modules/yaml/dist/parse/lexer.js"(exports2) {
    "use strict";
    var cst = require_cst();
    function isEmpty(ch) {
      switch (ch) {
        case void 0:
        case " ":
        case "\n":
        case "\r":
        case "	":
          return true;
        default:
          return false;
      }
    }
    var hexDigits = new Set("0123456789ABCDEFabcdef");
    var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
    var flowIndicatorChars = new Set(",[]{}");
    var invalidAnchorChars = new Set(" ,[]{}\n\r	");
    var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
    var Lexer = class {
      constructor() {
        this.atEnd = false;
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        this.buffer = "";
        this.flowKey = false;
        this.flowLevel = 0;
        this.indentNext = 0;
        this.indentValue = 0;
        this.lineEndPos = null;
        this.next = null;
        this.pos = 0;
      }
      /**
       * Generate YAML tokens from the `source` string. If `incomplete`,
       * a part of the last line may be left as a buffer for the next call.
       *
       * @returns A generator of lexical tokens
       */
      *lex(source, incomplete = false) {
        if (source) {
          if (typeof source !== "string")
            throw TypeError("source is not a string");
          this.buffer = this.buffer ? this.buffer + source : source;
          this.lineEndPos = null;
        }
        this.atEnd = !incomplete;
        let next = this.next ?? "stream";
        while (next && (incomplete || this.hasChars(1)))
          next = yield* this.parseNext(next);
      }
      atLineEnd() {
        let i = this.pos;
        let ch = this.buffer[i];
        while (ch === " " || ch === "	")
          ch = this.buffer[++i];
        if (!ch || ch === "#" || ch === "\n")
          return true;
        if (ch === "\r")
          return this.buffer[i + 1] === "\n";
        return false;
      }
      charAt(n) {
        return this.buffer[this.pos + n];
      }
      continueScalar(offset) {
        let ch = this.buffer[offset];
        if (this.indentNext > 0) {
          let indent = 0;
          while (ch === " ")
            ch = this.buffer[++indent + offset];
          if (ch === "\r") {
            const next = this.buffer[indent + offset + 1];
            if (next === "\n" || !next && !this.atEnd)
              return offset + indent + 1;
          }
          return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
        }
        if (ch === "-" || ch === ".") {
          const dt = this.buffer.substr(offset, 3);
          if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
            return -1;
        }
        return offset;
      }
      getLine() {
        let end = this.lineEndPos;
        if (typeof end !== "number" || end !== -1 && end < this.pos) {
          end = this.buffer.indexOf("\n", this.pos);
          this.lineEndPos = end;
        }
        if (end === -1)
          return this.atEnd ? this.buffer.substring(this.pos) : null;
        if (this.buffer[end - 1] === "\r")
          end -= 1;
        return this.buffer.substring(this.pos, end);
      }
      hasChars(n) {
        return this.pos + n <= this.buffer.length;
      }
      setNext(state) {
        this.buffer = this.buffer.substring(this.pos);
        this.pos = 0;
        this.lineEndPos = null;
        this.next = state;
        return null;
      }
      peek(n) {
        return this.buffer.substr(this.pos, n);
      }
      *parseNext(next) {
        switch (next) {
          case "stream":
            return yield* this.parseStream();
          case "line-start":
            return yield* this.parseLineStart();
          case "block-start":
            return yield* this.parseBlockStart();
          case "doc":
            return yield* this.parseDocument();
          case "flow":
            return yield* this.parseFlowCollection();
          case "quoted-scalar":
            return yield* this.parseQuotedScalar();
          case "block-scalar":
            return yield* this.parseBlockScalar();
          case "plain-scalar":
            return yield* this.parsePlainScalar();
        }
      }
      *parseStream() {
        let line = this.getLine();
        if (line === null)
          return this.setNext("stream");
        if (line[0] === cst.BOM) {
          yield* this.pushCount(1);
          line = line.substring(1);
        }
        if (line[0] === "%") {
          let dirEnd = line.length;
          let cs = line.indexOf("#");
          while (cs !== -1) {
            const ch = line[cs - 1];
            if (ch === " " || ch === "	") {
              dirEnd = cs - 1;
              break;
            } else {
              cs = line.indexOf("#", cs + 1);
            }
          }
          while (true) {
            const ch = line[dirEnd - 1];
            if (ch === " " || ch === "	")
              dirEnd -= 1;
            else
              break;
          }
          const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
          yield* this.pushCount(line.length - n);
          this.pushNewline();
          return "stream";
        }
        if (this.atLineEnd()) {
          const sp = yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - sp);
          yield* this.pushNewline();
          return "stream";
        }
        yield cst.DOCUMENT;
        return yield* this.parseLineStart();
      }
      *parseLineStart() {
        const ch = this.charAt(0);
        if (!ch && !this.atEnd)
          return this.setNext("line-start");
        if (ch === "-" || ch === ".") {
          if (!this.atEnd && !this.hasChars(4))
            return this.setNext("line-start");
          const s = this.peek(3);
          if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
            yield* this.pushCount(3);
            this.indentValue = 0;
            this.indentNext = 0;
            return s === "---" ? "doc" : "stream";
          }
        }
        this.indentValue = yield* this.pushSpaces(false);
        if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
          this.indentNext = this.indentValue;
        return yield* this.parseBlockStart();
      }
      *parseBlockStart() {
        const [ch0, ch1] = this.peek(2);
        if (!ch1 && !this.atEnd)
          return this.setNext("block-start");
        if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
          const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
          this.indentNext = this.indentValue + 1;
          this.indentValue += n;
          return "block-start";
        }
        return "doc";
      }
      *parseDocument() {
        yield* this.pushSpaces(true);
        const line = this.getLine();
        if (line === null)
          return this.setNext("doc");
        let n = yield* this.pushIndicators();
        switch (line[n]) {
          case "#":
            yield* this.pushCount(line.length - n);
          // fallthrough
          case void 0:
            yield* this.pushNewline();
            return yield* this.parseLineStart();
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel = 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            return "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "doc";
          case '"':
          case "'":
            return yield* this.parseQuotedScalar();
          case "|":
          case ">":
            n += yield* this.parseBlockScalarHeader();
            n += yield* this.pushSpaces(true);
            yield* this.pushCount(line.length - n);
            yield* this.pushNewline();
            return yield* this.parseBlockScalar();
          default:
            return yield* this.parsePlainScalar();
        }
      }
      *parseFlowCollection() {
        let nl, sp;
        let indent = -1;
        do {
          nl = yield* this.pushNewline();
          if (nl > 0) {
            sp = yield* this.pushSpaces(false);
            this.indentValue = indent = sp;
          } else {
            sp = 0;
          }
          sp += yield* this.pushSpaces(true);
        } while (nl + sp > 0);
        const line = this.getLine();
        if (line === null)
          return this.setNext("flow");
        if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
          const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
          if (!atFlowEndMarker) {
            this.flowLevel = 0;
            yield cst.FLOW_END;
            return yield* this.parseLineStart();
          }
        }
        let n = 0;
        while (line[n] === ",") {
          n += yield* this.pushCount(1);
          n += yield* this.pushSpaces(true);
          this.flowKey = false;
        }
        n += yield* this.pushIndicators();
        switch (line[n]) {
          case void 0:
            return "flow";
          case "#":
            yield* this.pushCount(line.length - n);
            return "flow";
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel += 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            this.flowKey = true;
            this.flowLevel -= 1;
            return this.flowLevel ? "flow" : "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "flow";
          case '"':
          case "'":
            this.flowKey = true;
            return yield* this.parseQuotedScalar();
          case ":": {
            const next = this.charAt(1);
            if (this.flowKey || isEmpty(next) || next === ",") {
              this.flowKey = false;
              yield* this.pushCount(1);
              yield* this.pushSpaces(true);
              return "flow";
            }
          }
          // fallthrough
          default:
            this.flowKey = false;
            return yield* this.parsePlainScalar();
        }
      }
      *parseQuotedScalar() {
        const quote = this.charAt(0);
        let end = this.buffer.indexOf(quote, this.pos + 1);
        if (quote === "'") {
          while (end !== -1 && this.buffer[end + 1] === "'")
            end = this.buffer.indexOf("'", end + 2);
        } else {
          while (end !== -1) {
            let n = 0;
            while (this.buffer[end - 1 - n] === "\\")
              n += 1;
            if (n % 2 === 0)
              break;
            end = this.buffer.indexOf('"', end + 1);
          }
        }
        const qb = this.buffer.substring(0, end);
        let nl = qb.indexOf("\n", this.pos);
        if (nl !== -1) {
          while (nl !== -1) {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = qb.indexOf("\n", cs);
          }
          if (nl !== -1) {
            end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
          }
        }
        if (end === -1) {
          if (!this.atEnd)
            return this.setNext("quoted-scalar");
          end = this.buffer.length;
        }
        yield* this.pushToIndex(end + 1, false);
        return this.flowLevel ? "flow" : "doc";
      }
      *parseBlockScalarHeader() {
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        let i = this.pos;
        while (true) {
          const ch = this.buffer[++i];
          if (ch === "+")
            this.blockScalarKeep = true;
          else if (ch > "0" && ch <= "9")
            this.blockScalarIndent = Number(ch) - 1;
          else if (ch !== "-")
            break;
        }
        return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
      }
      *parseBlockScalar() {
        let nl = this.pos - 1;
        let indent = 0;
        let ch;
        loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case "\n":
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === "\n")
                break;
            }
            // fallthrough
            default:
              break loop;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("block-scalar");
        if (indent >= this.indentNext) {
          if (this.blockScalarIndent === -1)
            this.indentNext = indent;
          else {
            this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
          }
          do {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = this.buffer.indexOf("\n", cs);
          } while (nl !== -1);
          if (nl === -1) {
            if (!this.atEnd)
              return this.setNext("block-scalar");
            nl = this.buffer.length;
          }
        }
        let i = nl + 1;
        ch = this.buffer[i];
        while (ch === " ")
          ch = this.buffer[++i];
        if (ch === "	") {
          while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
            ch = this.buffer[++i];
          nl = i - 1;
        } else if (!this.blockScalarKeep) {
          do {
            let i2 = nl - 1;
            let ch2 = this.buffer[i2];
            if (ch2 === "\r")
              ch2 = this.buffer[--i2];
            const lastChar = i2;
            while (ch2 === " ")
              ch2 = this.buffer[--i2];
            if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
              nl = i2;
            else
              break;
          } while (true);
        }
        yield cst.SCALAR;
        yield* this.pushToIndex(nl + 1, true);
        return yield* this.parseLineStart();
      }
      *parsePlainScalar() {
        const inFlow = this.flowLevel > 0;
        let end = this.pos - 1;
        let i = this.pos - 1;
        let ch;
        while (ch = this.buffer[++i]) {
          if (ch === ":") {
            const next = this.buffer[i + 1];
            if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
              break;
            end = i;
          } else if (isEmpty(ch)) {
            let next = this.buffer[i + 1];
            if (ch === "\r") {
              if (next === "\n") {
                i += 1;
                ch = "\n";
                next = this.buffer[i + 1];
              } else
                end = i;
            }
            if (next === "#" || inFlow && flowIndicatorChars.has(next))
              break;
            if (ch === "\n") {
              const cs = this.continueScalar(i + 1);
              if (cs === -1)
                break;
              i = Math.max(i, cs - 2);
            }
          } else {
            if (inFlow && flowIndicatorChars.has(ch))
              break;
            end = i;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("plain-scalar");
        yield cst.SCALAR;
        yield* this.pushToIndex(end + 1, true);
        return inFlow ? "flow" : "doc";
      }
      *pushCount(n) {
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos += n;
          return n;
        }
        return 0;
      }
      *pushToIndex(i, allowEmpty) {
        const s = this.buffer.slice(this.pos, i);
        if (s) {
          yield s;
          this.pos += s.length;
          return s.length;
        } else if (allowEmpty)
          yield "";
        return 0;
      }
      *pushIndicators() {
        let n = 0;
        loop: while (true) {
          switch (this.charAt(0)) {
            case "!":
              n += yield* this.pushTag();
              n += yield* this.pushSpaces(true);
              continue loop;
            case "&":
              n += yield* this.pushUntil(isNotAnchorChar);
              n += yield* this.pushSpaces(true);
              continue loop;
            case "-":
            // this is an error
            case "?":
            // this is an error outside flow collections
            case ":": {
              const inFlow = this.flowLevel > 0;
              const ch1 = this.charAt(1);
              if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
                if (!inFlow)
                  this.indentNext = this.indentValue + 1;
                else if (this.flowKey)
                  this.flowKey = false;
                n += yield* this.pushCount(1);
                n += yield* this.pushSpaces(true);
                continue loop;
              }
            }
          }
          break loop;
        }
        return n;
      }
      *pushTag() {
        if (this.charAt(1) === "<") {
          let i = this.pos + 2;
          let ch = this.buffer[i];
          while (!isEmpty(ch) && ch !== ">")
            ch = this.buffer[++i];
          return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
        } else {
          let i = this.pos + 1;
          let ch = this.buffer[i];
          while (ch) {
            if (tagChars.has(ch))
              ch = this.buffer[++i];
            else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
              ch = this.buffer[i += 3];
            } else
              break;
          }
          return yield* this.pushToIndex(i, false);
        }
      }
      *pushNewline() {
        const ch = this.buffer[this.pos];
        if (ch === "\n")
          return yield* this.pushCount(1);
        else if (ch === "\r" && this.charAt(1) === "\n")
          return yield* this.pushCount(2);
        else
          return 0;
      }
      *pushSpaces(allowTabs) {
        let i = this.pos - 1;
        let ch;
        do {
          ch = this.buffer[++i];
        } while (ch === " " || allowTabs && ch === "	");
        const n = i - this.pos;
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos = i;
        }
        return n;
      }
      *pushUntil(test) {
        let i = this.pos;
        let ch = this.buffer[i];
        while (!test(ch))
          ch = this.buffer[++i];
        return yield* this.pushToIndex(i, false);
      }
    };
    exports2.Lexer = Lexer;
  }
});

// node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS({
  "node_modules/yaml/dist/parse/line-counter.js"(exports2) {
    "use strict";
    var LineCounter = class {
      constructor() {
        this.lineStarts = [];
        this.addNewLine = (offset) => this.lineStarts.push(offset);
        this.linePos = (offset) => {
          let low = 0;
          let high = this.lineStarts.length;
          while (low < high) {
            const mid = low + high >> 1;
            if (this.lineStarts[mid] < offset)
              low = mid + 1;
            else
              high = mid;
          }
          if (this.lineStarts[low] === offset)
            return { line: low + 1, col: 1 };
          if (low === 0)
            return { line: 0, col: offset };
          const start = this.lineStarts[low - 1];
          return { line: low, col: offset - start + 1 };
        };
      }
    };
    exports2.LineCounter = LineCounter;
  }
});

// node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS({
  "node_modules/yaml/dist/parse/parser.js"(exports2) {
    "use strict";
    var node_process = require("process");
    var cst = require_cst();
    var lexer = require_lexer();
    function includesToken(list, type) {
      for (let i = 0; i < list.length; ++i)
        if (list[i].type === type)
          return true;
      return false;
    }
    function findNonEmptyIndex(list) {
      for (let i = 0; i < list.length; ++i) {
        switch (list[i].type) {
          case "space":
          case "comment":
          case "newline":
            break;
          default:
            return i;
        }
      }
      return -1;
    }
    function isFlowToken(token) {
      switch (token?.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "flow-collection":
          return true;
        default:
          return false;
      }
    }
    function getPrevProps(parent) {
      switch (parent.type) {
        case "document":
          return parent.start;
        case "block-map": {
          const it = parent.items[parent.items.length - 1];
          return it.sep ?? it.start;
        }
        case "block-seq":
          return parent.items[parent.items.length - 1].start;
        /* istanbul ignore next should not happen */
        default:
          return [];
      }
    }
    function getFirstKeyStartProps(prev) {
      if (prev.length === 0)
        return [];
      let i = prev.length;
      loop: while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
      while (prev[++i]?.type === "space") {
      }
      return prev.splice(i, prev.length);
    }
    function arrayPushArray(target, source) {
      if (source.length < 1e5)
        Array.prototype.push.apply(target, source);
      else
        for (let i = 0; i < source.length; ++i)
          target.push(source[i]);
    }
    function fixFlowSeqItems(fc) {
      if (fc.start.type === "flow-seq-start") {
        for (const it of fc.items) {
          if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
            if (it.key)
              it.value = it.key;
            delete it.key;
            if (isFlowToken(it.value)) {
              if (it.value.end)
                arrayPushArray(it.value.end, it.sep);
              else
                it.value.end = it.sep;
            } else
              arrayPushArray(it.start, it.sep);
            delete it.sep;
          }
        }
      }
    }
    var Parser = class {
      /**
       * @param onNewLine - If defined, called separately with the start position of
       *   each new line (in `parse()`, including the start of input).
       */
      constructor(onNewLine) {
        this.atNewLine = true;
        this.atScalar = false;
        this.indent = 0;
        this.offset = 0;
        this.onKeyLine = false;
        this.stack = [];
        this.source = "";
        this.type = "";
        this.lexer = new lexer.Lexer();
        this.onNewLine = onNewLine;
      }
      /**
       * Parse `source` as a YAML stream.
       * If `incomplete`, a part of the last line may be left as a buffer for the next call.
       *
       * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
       *
       * @returns A generator of tokens representing each directive, document, and other structure.
       */
      *parse(source, incomplete = false) {
        if (this.onNewLine && this.offset === 0)
          this.onNewLine(0);
        for (const lexeme of this.lexer.lex(source, incomplete))
          yield* this.next(lexeme);
        if (!incomplete)
          yield* this.end();
      }
      /**
       * Advance the parser by the `source` of one lexical token.
       */
      *next(source) {
        this.source = source;
        if (node_process.env.LOG_TOKENS)
          console.log("|", cst.prettyToken(source));
        if (this.atScalar) {
          this.atScalar = false;
          yield* this.step();
          this.offset += source.length;
          return;
        }
        const type = cst.tokenType(source);
        if (!type) {
          const message = `Not a YAML token: ${source}`;
          yield* this.pop({ type: "error", offset: this.offset, message, source });
          this.offset += source.length;
        } else if (type === "scalar") {
          this.atNewLine = false;
          this.atScalar = true;
          this.type = "scalar";
        } else {
          this.type = type;
          yield* this.step();
          switch (type) {
            case "newline":
              this.atNewLine = true;
              this.indent = 0;
              if (this.onNewLine)
                this.onNewLine(this.offset + source.length);
              break;
            case "space":
              if (this.atNewLine && source[0] === " ")
                this.indent += source.length;
              break;
            case "explicit-key-ind":
            case "map-value-ind":
            case "seq-item-ind":
              if (this.atNewLine)
                this.indent += source.length;
              break;
            case "doc-mode":
            case "flow-error-end":
              return;
            default:
              this.atNewLine = false;
          }
          this.offset += source.length;
        }
      }
      /** Call at end of input to push out any remaining constructions */
      *end() {
        while (this.stack.length > 0)
          yield* this.pop();
      }
      get sourceToken() {
        const st = {
          type: this.type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
        return st;
      }
      *step() {
        const top = this.peek(1);
        if (this.type === "doc-end" && top?.type !== "doc-end") {
          while (this.stack.length > 0)
            yield* this.pop();
          this.stack.push({
            type: "doc-end",
            offset: this.offset,
            source: this.source
          });
          return;
        }
        if (!top)
          return yield* this.stream();
        switch (top.type) {
          case "document":
            return yield* this.document(top);
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return yield* this.scalar(top);
          case "block-scalar":
            return yield* this.blockScalar(top);
          case "block-map":
            return yield* this.blockMap(top);
          case "block-seq":
            return yield* this.blockSequence(top);
          case "flow-collection":
            return yield* this.flowCollection(top);
          case "doc-end":
            return yield* this.documentEnd(top);
        }
        yield* this.pop();
      }
      peek(n) {
        return this.stack[this.stack.length - n];
      }
      *pop(error) {
        const token = error ?? this.stack.pop();
        if (!token) {
          const message = "Tried to pop an empty stack";
          yield { type: "error", offset: this.offset, source: "", message };
        } else if (this.stack.length === 0) {
          yield token;
        } else {
          const top = this.peek(1);
          if (token.type === "block-scalar") {
            token.indent = "indent" in top ? top.indent : 0;
          } else if (token.type === "flow-collection" && top.type === "document") {
            token.indent = 0;
          }
          if (token.type === "flow-collection")
            fixFlowSeqItems(token);
          switch (top.type) {
            case "document":
              top.value = token;
              break;
            case "block-scalar":
              top.props.push(token);
              break;
            case "block-map": {
              const it = top.items[top.items.length - 1];
              if (it.value) {
                top.items.push({ start: [], key: token, sep: [] });
                this.onKeyLine = true;
                return;
              } else if (it.sep) {
                it.value = token;
              } else {
                Object.assign(it, { key: token, sep: [] });
                this.onKeyLine = !it.explicitKey;
                return;
              }
              break;
            }
            case "block-seq": {
              const it = top.items[top.items.length - 1];
              if (it.value)
                top.items.push({ start: [], value: token });
              else
                it.value = token;
              break;
            }
            case "flow-collection": {
              const it = top.items[top.items.length - 1];
              if (!it || it.value)
                top.items.push({ start: [], key: token, sep: [] });
              else if (it.sep)
                it.value = token;
              else
                Object.assign(it, { key: token, sep: [] });
              return;
            }
            /* istanbul ignore next should not happen */
            default:
              yield* this.pop();
              yield* this.pop(token);
          }
          if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
            const last = token.items[token.items.length - 1];
            if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
              if (top.type === "document")
                top.end = last.start;
              else
                top.items.push({ start: last.start });
              token.items.splice(-1, 1);
            }
          }
        }
      }
      *stream() {
        switch (this.type) {
          case "directive-line":
            yield { type: "directive", offset: this.offset, source: this.source };
            return;
          case "byte-order-mark":
          case "space":
          case "comment":
          case "newline":
            yield this.sourceToken;
            return;
          case "doc-mode":
          case "doc-start": {
            const doc = {
              type: "document",
              offset: this.offset,
              start: []
            };
            if (this.type === "doc-start")
              doc.start.push(this.sourceToken);
            this.stack.push(doc);
            return;
          }
        }
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML stream`,
          source: this.source
        };
      }
      *document(doc) {
        if (doc.value)
          return yield* this.lineEnd(doc);
        switch (this.type) {
          case "doc-start": {
            if (findNonEmptyIndex(doc.start) !== -1) {
              yield* this.pop();
              yield* this.step();
            } else
              doc.start.push(this.sourceToken);
            return;
          }
          case "anchor":
          case "tag":
          case "space":
          case "comment":
          case "newline":
            doc.start.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(doc);
        if (bv)
          this.stack.push(bv);
        else {
          yield {
            type: "error",
            offset: this.offset,
            message: `Unexpected ${this.type} token in YAML document`,
            source: this.source
          };
        }
      }
      *scalar(scalar) {
        if (this.type === "map-value-ind") {
          const prev = getPrevProps(this.peek(2));
          const start = getFirstKeyStartProps(prev);
          let sep;
          if (scalar.end) {
            sep = scalar.end;
            sep.push(this.sourceToken);
            delete scalar.end;
          } else
            sep = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start, key: scalar, sep }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else
          yield* this.lineEnd(scalar);
      }
      *blockScalar(scalar) {
        switch (this.type) {
          case "space":
          case "comment":
          case "newline":
            scalar.props.push(this.sourceToken);
            return;
          case "scalar":
            scalar.source = this.source;
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine) {
              let nl = this.source.indexOf("\n") + 1;
              while (nl !== 0) {
                this.onNewLine(this.offset + nl);
                nl = this.source.indexOf("\n", nl) + 1;
              }
            }
            yield* this.pop();
            break;
          /* istanbul ignore next should not happen */
          default:
            yield* this.pop();
            yield* this.step();
        }
      }
      *blockMap(map) {
        const it = map.items[map.items.length - 1];
        switch (this.type) {
          case "newline":
            this.onKeyLine = false;
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "space":
          case "comment":
            if (it.value) {
              map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              if (this.atIndentedComment(it.start, map.indent)) {
                const prev = map.items[map.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  map.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
        }
        if (this.indent >= map.indent) {
          const atMapIndent = !this.onKeyLine && this.indent === map.indent;
          const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
          let start = [];
          if (atNextItem && it.sep && !it.value) {
            const nl = [];
            for (let i = 0; i < it.sep.length; ++i) {
              const st = it.sep[i];
              switch (st.type) {
                case "newline":
                  nl.push(i);
                  break;
                case "space":
                  break;
                case "comment":
                  if (st.indent > map.indent)
                    nl.length = 0;
                  break;
                default:
                  nl.length = 0;
              }
            }
            if (nl.length >= 2)
              start = it.sep.splice(nl[1]);
          }
          switch (this.type) {
            case "anchor":
            case "tag":
              if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start });
                this.onKeyLine = true;
              } else if (it.sep) {
                it.sep.push(this.sourceToken);
              } else {
                it.start.push(this.sourceToken);
              }
              return;
            case "explicit-key-ind":
              if (!it.sep && !it.explicitKey) {
                it.start.push(this.sourceToken);
                it.explicitKey = true;
              } else if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start, explicitKey: true });
              } else {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [this.sourceToken], explicitKey: true }]
                });
              }
              this.onKeyLine = true;
              return;
            case "map-value-ind":
              if (it.explicitKey) {
                if (!it.sep) {
                  if (includesToken(it.start, "newline")) {
                    Object.assign(it, { key: null, sep: [this.sourceToken] });
                  } else {
                    const start2 = getFirstKeyStartProps(it.start);
                    this.stack.push({
                      type: "block-map",
                      offset: this.offset,
                      indent: this.indent,
                      items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                    });
                  }
                } else if (it.value) {
                  map.items.push({ start: [], key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start, key: null, sep: [this.sourceToken] }]
                  });
                } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                  const start2 = getFirstKeyStartProps(it.start);
                  const key = it.key;
                  const sep = it.sep;
                  sep.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key, sep }]
                  });
                } else if (start.length > 0) {
                  it.sep = it.sep.concat(start, this.sourceToken);
                } else {
                  it.sep.push(this.sourceToken);
                }
              } else {
                if (!it.sep) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else if (it.value || atNextItem) {
                  map.items.push({ start, key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: [], key: null, sep: [this.sourceToken] }]
                  });
                } else {
                  it.sep.push(this.sourceToken);
                }
              }
              this.onKeyLine = true;
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (atNextItem || it.value) {
                map.items.push({ start, key: fs, sep: [] });
                this.onKeyLine = true;
              } else if (it.sep) {
                this.stack.push(fs);
              } else {
                Object.assign(it, { key: fs, sep: [] });
                this.onKeyLine = true;
              }
              return;
            }
            default: {
              const bv = this.startBlockValue(map);
              if (bv) {
                if (bv.type === "block-seq") {
                  if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                    yield* this.pop({
                      type: "error",
                      offset: this.offset,
                      message: "Unexpected block-seq-ind on same line with key",
                      source: this.source
                    });
                    return;
                  }
                } else if (atMapIndent) {
                  map.items.push({ start });
                }
                this.stack.push(bv);
                return;
              }
            }
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *blockSequence(seq2) {
        const it = seq2.items[seq2.items.length - 1];
        switch (this.type) {
          case "newline":
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                seq2.items.push({ start: [this.sourceToken] });
            } else
              it.start.push(this.sourceToken);
            return;
          case "space":
          case "comment":
            if (it.value)
              seq2.items.push({ start: [this.sourceToken] });
            else {
              if (this.atIndentedComment(it.start, seq2.indent)) {
                const prev = seq2.items[seq2.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  seq2.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
          case "anchor":
          case "tag":
            if (it.value || this.indent <= seq2.indent)
              break;
            it.start.push(this.sourceToken);
            return;
          case "seq-item-ind":
            if (this.indent !== seq2.indent)
              break;
            if (it.value || includesToken(it.start, "seq-item-ind"))
              seq2.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
        }
        if (this.indent > seq2.indent) {
          const bv = this.startBlockValue(seq2);
          if (bv) {
            this.stack.push(bv);
            return;
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *flowCollection(fc) {
        const it = fc.items[fc.items.length - 1];
        if (this.type === "flow-error-end") {
          let top;
          do {
            yield* this.pop();
            top = this.peek(1);
          } while (top?.type === "flow-collection");
        } else if (fc.end.length === 0) {
          switch (this.type) {
            case "comma":
            case "explicit-key-ind":
              if (!it || it.sep)
                fc.items.push({ start: [this.sourceToken] });
              else
                it.start.push(this.sourceToken);
              return;
            case "map-value-ind":
              if (!it || it.value)
                fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              return;
            case "space":
            case "comment":
            case "newline":
            case "anchor":
            case "tag":
              if (!it || it.value)
                fc.items.push({ start: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                it.start.push(this.sourceToken);
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (!it || it.value)
                fc.items.push({ start: [], key: fs, sep: [] });
              else if (it.sep)
                this.stack.push(fs);
              else
                Object.assign(it, { key: fs, sep: [] });
              return;
            }
            case "flow-map-end":
            case "flow-seq-end":
              fc.end.push(this.sourceToken);
              return;
          }
          const bv = this.startBlockValue(fc);
          if (bv)
            this.stack.push(bv);
          else {
            yield* this.pop();
            yield* this.step();
          }
        } else {
          const parent = this.peek(2);
          if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
            yield* this.pop();
            yield* this.step();
          } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            fixFlowSeqItems(fc);
            const sep = fc.end.splice(1, fc.end.length);
            sep.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start, key: fc, sep }]
            };
            this.onKeyLine = true;
            this.stack[this.stack.length - 1] = map;
          } else {
            yield* this.lineEnd(fc);
          }
        }
      }
      flowScalar(type) {
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        return {
          type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
      }
      startBlockValue(parent) {
        switch (this.type) {
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return this.flowScalar(this.type);
          case "block-scalar-header":
            return {
              type: "block-scalar",
              offset: this.offset,
              indent: this.indent,
              props: [this.sourceToken],
              source: ""
            };
          case "flow-map-start":
          case "flow-seq-start":
            return {
              type: "flow-collection",
              offset: this.offset,
              indent: this.indent,
              start: this.sourceToken,
              items: [],
              end: []
            };
          case "seq-item-ind":
            return {
              type: "block-seq",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken] }]
            };
          case "explicit-key-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            start.push(this.sourceToken);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, explicitKey: true }]
            };
          }
          case "map-value-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, key: null, sep: [this.sourceToken] }]
            };
          }
        }
        return null;
      }
      atIndentedComment(start, indent) {
        if (this.type !== "comment")
          return false;
        if (this.indent <= indent)
          return false;
        return start.every((st) => st.type === "newline" || st.type === "space");
      }
      *documentEnd(docEnd) {
        if (this.type !== "doc-mode") {
          if (docEnd.end)
            docEnd.end.push(this.sourceToken);
          else
            docEnd.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
        }
      }
      *lineEnd(token) {
        switch (this.type) {
          case "comma":
          case "doc-start":
          case "doc-end":
          case "flow-seq-end":
          case "flow-map-end":
          case "map-value-ind":
            yield* this.pop();
            yield* this.step();
            break;
          case "newline":
            this.onKeyLine = false;
          // fallthrough
          case "space":
          case "comment":
          default:
            if (token.end)
              token.end.push(this.sourceToken);
            else
              token.end = [this.sourceToken];
            if (this.type === "newline")
              yield* this.pop();
        }
      }
    };
    exports2.Parser = Parser;
  }
});

// node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS({
  "node_modules/yaml/dist/public-api.js"(exports2) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var errors = require_errors();
    var log = require_log();
    var identity = require_identity();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    function parseOptions(options) {
      const prettyErrors = options.prettyErrors !== false;
      const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null;
      return { lineCounter: lineCounter$1, prettyErrors };
    }
    function parseAllDocuments(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      const docs = Array.from(composer$1.compose(parser$1.parse(source)));
      if (prettyErrors && lineCounter2)
        for (const doc of docs) {
          doc.errors.forEach(errors.prettifyError(source, lineCounter2));
          doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
        }
      if (docs.length > 0)
        return docs;
      return Object.assign([], { empty: true }, composer$1.streamInfo());
    }
    function parseDocument(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      let doc = null;
      for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
        if (!doc)
          doc = _doc;
        else if (doc.options.logLevel !== "silent") {
          doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
          break;
        }
      }
      if (prettyErrors && lineCounter2) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
      return doc;
    }
    function parse3(src, reviver, options) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options === void 0 && reviver && typeof reviver === "object") {
        options = reviver;
      }
      const doc = parseDocument(src, options);
      if (!doc)
        return null;
      doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
      if (doc.errors.length > 0) {
        if (doc.options.logLevel !== "silent")
          throw doc.errors[0];
        else
          doc.errors = [];
      }
      return doc.toJS(Object.assign({ reviver: _reviver }, options));
    }
    function stringify2(value, replacer, options) {
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === void 0 && replacer) {
        options = replacer;
      }
      if (typeof options === "string")
        options = options.length;
      if (typeof options === "number") {
        const indent = Math.round(options);
        options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
      }
      if (value === void 0) {
        const { keepUndefined } = options ?? replacer ?? {};
        if (!keepUndefined)
          return void 0;
      }
      if (identity.isDocument(value) && !_replacer)
        return value.toString(options);
      return new Document.Document(value, _replacer, options).toString(options);
    }
    exports2.parse = parse3;
    exports2.parseAllDocuments = parseAllDocuments;
    exports2.parseDocument = parseDocument;
    exports2.stringify = stringify2;
  }
});

// node_modules/yaml/dist/index.js
var require_dist = __commonJS({
  "node_modules/yaml/dist/index.js"(exports2) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var Schema = require_Schema();
    var errors = require_errors();
    var Alias = require_Alias();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var cst = require_cst();
    var lexer = require_lexer();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    var publicApi = require_public_api();
    var visit = require_visit();
    exports2.Composer = composer.Composer;
    exports2.Document = Document.Document;
    exports2.Schema = Schema.Schema;
    exports2.YAMLError = errors.YAMLError;
    exports2.YAMLParseError = errors.YAMLParseError;
    exports2.YAMLWarning = errors.YAMLWarning;
    exports2.Alias = Alias.Alias;
    exports2.isAlias = identity.isAlias;
    exports2.isCollection = identity.isCollection;
    exports2.isDocument = identity.isDocument;
    exports2.isMap = identity.isMap;
    exports2.isNode = identity.isNode;
    exports2.isPair = identity.isPair;
    exports2.isScalar = identity.isScalar;
    exports2.isSeq = identity.isSeq;
    exports2.Pair = Pair.Pair;
    exports2.Scalar = Scalar.Scalar;
    exports2.YAMLMap = YAMLMap.YAMLMap;
    exports2.YAMLSeq = YAMLSeq.YAMLSeq;
    exports2.CST = cst;
    exports2.Lexer = lexer.Lexer;
    exports2.LineCounter = lineCounter.LineCounter;
    exports2.Parser = parser.Parser;
    exports2.parse = publicApi.parse;
    exports2.parseAllDocuments = publicApi.parseAllDocuments;
    exports2.parseDocument = publicApi.parseDocument;
    exports2.stringify = publicApi.stringify;
    exports2.visit = visit.visit;
    exports2.visitAsync = visit.visitAsync;
  }
});

// src/proxy/AliyunCaptcha.js.txt
var AliyunCaptcha_js_default;
var init_AliyunCaptcha_js = __esm({
  "src/proxy/AliyunCaptcha.js.txt"() {
    AliyunCaptcha_js_default = `!function(){var t={477:function(){!function(){if("undefined"!=typeof document)try{var t='@font-face {font-family: "aliyun-captcha-iconfont";src: url("data:application/font-woff2;base64,d09GMgABAAAAAALkAAsAAAAABsQAAAKWAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHFQGYACCcAqBPIFbATYCJAMICwYABCAFhGcHNBsbBsguIScbXkQAFdTQssL1nfvZdRAAEA9P++M7d2Y+gEQ2KYPpNy9CW0eo1U19I5Q3v8tly9PaeNQqTnVHKyWf21zpydI0kkEJjMNhS1NgcS8c7mDGGbqsy2VfE8ZVW6+51wjbM68AJtNv0/z/v3f8G0Ab5B7Pbc1Fa+MD66RR1gdqrGURdvLQUxFvOehefkWg0ZIxTQdzKzus7ymnnPVr4TQHeWY8jQLOOmSfoiBZL9RSVxbxRQ3pbSp8jj8f/6xEPUlN5uQc38367GnumPy6ek3+5vVyNTgvoQYZc5hCnPfHDjWLNkqzRluLEVQWwU9VFRrEobVC+uuc9GYwDN4z8X3Bo7ImUOjOGubxpF7kgZ6eZ/eY8Zi2082MvV2m799Z8I5rGtvt0OS+ofE94xac7Oxu7O1s7e9t70Lz6wcxjgceOuPsxWNH7IxdbH1mvLT0DBaucVgMDophbHjsqLMYxOFGLX/o3cuQE7AhFo/fDobqdaH85gf/xuoXr20b/+ubCvjeT4aA5qD+DmzB75RfEZHF9JNKG19OJWua71DS6AapOK5Ov1NVXbedCvW6bt5RZyiHrN4IVsgzUKPJCtSqtwmNZs2ub9Kl1CxKAybcMQjtHiFp9RWyds9YIX9DjV5/UKvdPzS6jJbdmkzE9bRCTuhD/RYiUeTSU1KMdwuDy5SrpvAeKh0hCK7lVJPzmKOaY46+CjwiCVIVGcyJ52GaFlCqIkZBVkhUDtm2bHuLJYqMTVMQR5AP1N0CEaGQkyGayt+3BQUupThFxPZiihYBP3BZHAI2L8tJDQ+yj3Yl4CFEApJiiQyYk4ehVKoAyvZhMSQQSzghUhpiuyhJlVnbK7Jf2waNHHUKd1HWeJ0WGs00ypExAAA=") format("woff2");}.iconfont-aliyun-captcha {font-family: "aliyun-captcha-iconfont" !important;font-size: 16px;font-style: normal;-webkit-font-smoothing: antialiased;-moz-osx-font-smoothing: grayscale;}.aliyun-captcha .icon-close-line:before {content: "\\\\e67e";}',r=document.createElement("style");r.type="text/css",r.styleSheet?r.styleSheet.cssText=t:r.appendChild(document.createTextNode(t)),(document.head||document.getElementsByTagName("head")[0]).appendChild(r)}catch(t){}}()},955:function(t,r,e){var n;t.exports=(n=e(9021),e(754),e(4636),e(9506),e(7165),function(){var t=n,r=t.lib.BlockCipher,e=t.algo,i=[],o=[],c=[],u=[],a=[],s=[],f=[],l=[],p=[],v=[];!function(){for(var t=[],r=0;r<256;r++)t[r]=r<128?r<<1:r<<1^283;var e=0,n=0;for(r=0;r<256;r++){var h=n^n<<1^n<<2^n<<3^n<<4;h=h>>>8^255&h^99,i[e]=h,o[h]=e;var d=t[e],y=t[d],g=t[y],m=257*t[h]^16843008*h;c[e]=m<<24|m>>>8,u[e]=m<<16|m>>>16,a[e]=m<<8|m>>>24,s[e]=m,m=16843009*g^65537*y^257*d^16843008*e,f[h]=m<<24|m>>>8,l[h]=m<<16|m>>>16,p[h]=m<<8|m>>>24,v[h]=m,e?(e=d^t[t[t[g^d]]],n^=t[t[n]]):e=n=1}}();var h=[0,1,2,4,8,16,32,64,128,27,54],d=e.AES=r.extend({_doReset:function(){if(!this._nRounds||this._keyPriorReset!==this._key){for(var t=this._keyPriorReset=this._key,r=t.words,e=t.sigBytes/4,n=4*((this._nRounds=e+6)+1),o=this._keySchedule=[],c=0;c<n;c++)if(c<e)o[c]=r[c];else{var u=o[c-1];c%e?e>6&&c%e==4&&(u=i[u>>>24]<<24|i[u>>>16&255]<<16|i[u>>>8&255]<<8|i[255&u]):(u=i[(u=u<<8|u>>>24)>>>24]<<24|i[u>>>16&255]<<16|i[u>>>8&255]<<8|i[255&u],u^=h[c/e|0]<<24),o[c]=o[c-e]^u}for(var a=this._invKeySchedule=[],s=0;s<n;s++)c=n-s,u=s%4?o[c]:o[c-4],a[s]=s<4||c<=4?u:f[i[u>>>24]]^l[i[u>>>16&255]]^p[i[u>>>8&255]]^v[i[255&u]]}},encryptBlock:function(t,r){this._doCryptBlock(t,r,this._keySchedule,c,u,a,s,i)},decryptBlock:function(t,r){var e=t[r+1];t[r+1]=t[r+3],t[r+3]=e,this._doCryptBlock(t,r,this._invKeySchedule,f,l,p,v,o),e=t[r+1],t[r+1]=t[r+3],t[r+3]=e},_doCryptBlock:function(t,r,e,n,i,o,c,u){for(var a=this._nRounds,s=t[r]^e[0],f=t[r+1]^e[1],l=t[r+2]^e[2],p=t[r+3]^e[3],v=4,h=1;h<a;h++){var d=n[s>>>24]^i[f>>>16&255]^o[l>>>8&255]^c[255&p]^e[v++],y=n[f>>>24]^i[l>>>16&255]^o[p>>>8&255]^c[255&s]^e[v++],g=n[l>>>24]^i[p>>>16&255]^o[s>>>8&255]^c[255&f]^e[v++],m=n[p>>>24]^i[s>>>16&255]^o[f>>>8&255]^c[255&l]^e[v++];s=d,f=y,l=g,p=m}d=(u[s>>>24]<<24|u[f>>>16&255]<<16|u[l>>>8&255]<<8|u[255&p])^e[v++],y=(u[f>>>24]<<24|u[l>>>16&255]<<16|u[p>>>8&255]<<8|u[255&s])^e[v++],g=(u[l>>>24]<<24|u[p>>>16&255]<<16|u[s>>>8&255]<<8|u[255&f])^e[v++],m=(u[p>>>24]<<24|u[s>>>16&255]<<16|u[f>>>8&255]<<8|u[255&l])^e[v++],t[r]=d,t[r+1]=y,t[r+2]=g,t[r+3]=m},keySize:8});t.AES=r._createHelper(d)}(),n.AES)},7165:function(t,r,e){var n;t.exports=(n=e(9021),e(9506),void(n.lib.Cipher||function(t){var r=n,e=r.lib,i=e.Base,o=e.WordArray,c=e.BufferedBlockAlgorithm,u=r.enc,a=(u.Utf8,u.Base64),s=r.algo.EvpKDF,f=e.Cipher=c.extend({cfg:i.extend(),createEncryptor:function(t,r){return this.create(this._ENC_XFORM_MODE,t,r)},createDecryptor:function(t,r){return this.create(this._DEC_XFORM_MODE,t,r)},init:function(t,r,e){this.cfg=this.cfg.extend(e),this._xformMode=t,this._key=r,this.reset()},reset:function(){c.reset.call(this),this._doReset()},process:function(t){return this._append(t),this._process()},finalize:function(t){return t&&this._append(t),this._doFinalize()},keySize:4,ivSize:4,_ENC_XFORM_MODE:1,_DEC_XFORM_MODE:2,_createHelper:function(){function t(t){return"string"==typeof t?x:g}return function(r){return{encrypt:function(e,n,i){return t(n).encrypt(r,e,n,i)},decrypt:function(e,n,i){return t(n).decrypt(r,e,n,i)}}}}()}),l=(e.StreamCipher=f.extend({_doFinalize:function(){return this._process(!0)},blockSize:1}),r.mode={}),p=e.BlockCipherMode=i.extend({createEncryptor:function(t,r){return this.Encryptor.create(t,r)},createDecryptor:function(t,r){return this.Decryptor.create(t,r)},init:function(t,r){this._cipher=t,this._iv=r}}),v=l.CBC=function(){var r=p.extend();function e(r,e,n){var i=this._iv;if(i){var o=i;this._iv=t}else o=this._prevBlock;for(var c=0;c<n;c++)r[e+c]^=o[c]}return r.Encryptor=r.extend({processBlock:function(t,r){var n=this._cipher,i=n.blockSize;e.call(this,t,r,i),n.encryptBlock(t,r),this._prevBlock=t.slice(r,r+i)}}),r.Decryptor=r.extend({processBlock:function(t,r){var n=this._cipher,i=n.blockSize,o=t.slice(r,r+i);n.decryptBlock(t,r),e.call(this,t,r,i),this._prevBlock=o}}),r}(),h=(r.pad={}).Pkcs7={pad:function(t,r){for(var e=4*r,n=e-t.sigBytes%e,i=n<<24|n<<16|n<<8|n,c=[],u=0;u<n;u+=4)c.push(i);var a=o.create(c,n);t.concat(a)},unpad:function(t){var r=255&t.words[t.sigBytes-1>>>2];t.sigBytes-=r}},d=(e.BlockCipher=f.extend({cfg:f.cfg.extend({mode:v,padding:h}),reset:function(){f.reset.call(this);var t=this.cfg,r=t.iv,e=t.mode;if(this._xformMode==this._ENC_XFORM_MODE)var n=e.createEncryptor;else n=e.createDecryptor,this._minBufferSize=1;this._mode&&this._mode.__creator==n?this._mode.init(this,r&&r.words):(this._mode=n.call(e,this,r&&r.words),this._mode.__creator=n)},_doProcessBlock:function(t,r){this._mode.processBlock(t,r)},_doFinalize:function(){var t=this.cfg.padding;if(this._xformMode==this._ENC_XFORM_MODE){t.pad(this._data,this.blockSize);var r=this._process(!0)}else r=this._process(!0),t.unpad(r);return r},blockSize:4}),e.CipherParams=i.extend({init:function(t){this.mixIn(t)},toString:function(t){return(t||this.formatter).stringify(this)}})),y=(r.format={}).OpenSSL={stringify:function(t){var r=t.ciphertext,e=t.salt;if(e)var n=o.create([1398893684,1701076831]).concat(e).concat(r);else n=r;return n.toString(a)},parse:function(t){var r=a.parse(t),e=r.words;if(1398893684==e[0]&&1701076831==e[1]){var n=o.create(e.slice(2,4));e.splice(0,4),r.sigBytes-=16}return d.create({ciphertext:r,salt:n})}},g=e.SerializableCipher=i.extend({cfg:i.extend({format:y}),encrypt:function(t,r,e,n){n=this.cfg.extend(n);var i=t.createEncryptor(e,n),o=i.finalize(r),c=i.cfg;return d.create({ciphertext:o,key:e,iv:c.iv,algorithm:t,mode:c.mode,padding:c.padding,blockSize:t.blockSize,formatter:n.format})},decrypt:function(t,r,e,n){return n=this.cfg.extend(n),r=this._parse(r,n.format),t.createDecryptor(e,n).finalize(r.ciphertext)},_parse:function(t,r){return"string"==typeof t?r.parse(t,this):t}}),m=(r.kdf={}).OpenSSL={execute:function(t,r,e,n){n||(n=o.random(8));var i=s.create({keySize:r+e}).compute(t,n),c=o.create(i.words.slice(r),4*e);return i.sigBytes=4*r,d.create({key:i,iv:c,salt:n})}},x=e.PasswordBasedCipher=g.extend({cfg:g.cfg.extend({kdf:m}),encrypt:function(t,r,e,n){var i=(n=this.cfg.extend(n)).kdf.execute(e,t.keySize,t.ivSize);n.iv=i.iv;var o=g.encrypt.call(this,t,r,i.key,n);return o.mixIn(i),o},decrypt:function(t,r,e,n){n=this.cfg.extend(n),r=this._parse(r,n.format);var i=n.kdf.execute(e,t.keySize,t.ivSize,r.salt);return n.iv=i.iv,g.decrypt.call(this,t,r,i.key,n)}})}()))},9021:function(t,r){var e;t.exports=(e=e||function(t,r){var e=Object.create||function(){function t(){}return function(r){var e;return t.prototype=r,e=new t,t.prototype=null,e}}(),n={},i=n.lib={},o=i.Base={extend:function(t){var r=e(this);return t&&r.mixIn(t),r.hasOwnProperty("init")&&this.init!==r.init||(r.init=function(){r.$super.init.apply(this,arguments)}),r.init.prototype=r,r.$super=this,r},create:function(){var t=this.extend();return t.init.apply(t,arguments),t},init:function(){},mixIn:function(t){for(var r in t)t.hasOwnProperty(r)&&(this[r]=t[r]);t.hasOwnProperty("toString")&&(this.toString=t.toString)},clone:function(){return this.init.prototype.extend(this)}},c=i.WordArray=o.extend({init:function(t,e){t=this.words=t||[],this.sigBytes=e!=r?e:4*t.length},toString:function(t){return(t||a).stringify(this)},concat:function(t){var r=this.words,e=t.words,n=this.sigBytes,i=t.sigBytes;if(this.clamp(),n%4)for(var o=0;o<i;o++){var c=e[o>>>2]>>>24-o%4*8&255;r[n+o>>>2]|=c<<24-(n+o)%4*8}else for(o=0;o<i;o+=4)r[n+o>>>2]=e[o>>>2];return this.sigBytes+=i,this},clamp:function(){var r=this.words,e=this.sigBytes;r[e>>>2]&=4294967295<<32-e%4*8,r.length=t.ceil(e/4)},clone:function(){var t=o.clone.call(this);return t.words=this.words.slice(0),t},random:function(r){for(var e,n=[],i=function(r){var e=987654321,n=4294967295;return function(){var i=((e=36969*(65535&e)+(e>>16)&n)<<16)+(r=18e3*(65535&r)+(r>>16)&n)&n;return i/=4294967296,(i+=.5)*(t.random()>.5?1:-1)}},o=0;o<r;o+=4){var u=i(4294967296*(e||t.random()));e=987654071*u(),n.push(4294967296*u()|0)}return new c.init(n,r)}}),u=n.enc={},a=u.Hex={stringify:function(t){for(var r=t.words,e=t.sigBytes,n=[],i=0;i<e;i++){var o=r[i>>>2]>>>24-i%4*8&255;n.push((o>>>4).toString(16)),n.push((15&o).toString(16))}return n.join("")},parse:function(t){for(var r=t.length,e=[],n=0;n<r;n+=2)e[n>>>3]|=parseInt(t.substr(n,2),16)<<24-n%8*4;return new c.init(e,r/2)}},s=u.Latin1={stringify:function(t){for(var r=t.words,e=t.sigBytes,n=[],i=0;i<e;i++){var o=r[i>>>2]>>>24-i%4*8&255;n.push(String.fromCharCode(o))}return n.join("")},parse:function(t){for(var r=t.length,e=[],n=0;n<r;n++)e[n>>>2]|=(255&t.charCodeAt(n))<<24-n%4*8;return new c.init(e,r)}},f=u.Utf8={stringify:function(t){try{return decodeURIComponent(escape(s.stringify(t)))}catch(t){throw new Error("Malformed UTF-8 data")}},parse:function(t){return s.parse(unescape(encodeURIComponent(t)))}},l=i.BufferedBlockAlgorithm=o.extend({reset:function(){this._data=new c.init,this._nDataBytes=0},_append:function(t){"string"==typeof t&&(t=f.parse(t)),this._data.concat(t),this._nDataBytes+=t.sigBytes},_process:function(r){var e=this._data,n=e.words,i=e.sigBytes,o=this.blockSize,u=i/(4*o),a=(u=r?t.ceil(u):t.max((0|u)-this._minBufferSize,0))*o,s=t.min(4*a,i);if(a){for(var f=0;f<a;f+=o)this._doProcessBlock(n,f);var l=n.splice(0,a);e.sigBytes-=s}return new c.init(l,s)},clone:function(){var t=o.clone.call(this);return t._data=this._data.clone(),t},_minBufferSize:0}),p=(i.Hasher=l.extend({cfg:o.extend(),init:function(t){this.cfg=this.cfg.extend(t),this.reset()},reset:function(){l.reset.call(this),this._doReset()},update:function(t){return this._append(t),this._process(),this},finalize:function(t){return t&&this._append(t),this._doFinalize()},blockSize:16,_createHelper:function(t){return function(r,e){return new t.init(e).finalize(r)}},_createHmacHelper:function(t){return function(r,e){return new p.HMAC.init(t,e).finalize(r)}}}),n.algo={});return n}(Math),e)},754:function(t,r,e){var n;t.exports=(n=e(9021),function(){var t=n,r=t.lib.WordArray;function e(t,e,n){for(var i=[],o=0,c=0;c<e;c++)if(c%4){var u=n[t.charCodeAt(c-1)]<<c%4*2,a=n[t.charCodeAt(c)]>>>6-c%4*2;i[o>>>2]|=(u|a)<<24-o%4*8,o++}return r.create(i,o)}t.enc.Base64={stringify:function(t){var r=t.words,e=t.sigBytes,n=this._map;t.clamp();for(var i=[],o=0;o<e;o+=3)for(var c=(r[o>>>2]>>>24-o%4*8&255)<<16|(r[o+1>>>2]>>>24-(o+1)%4*8&255)<<8|r[o+2>>>2]>>>24-(o+2)%4*8&255,u=0;u<4&&o+.75*u<e;u++)i.push(n.charAt(c>>>6*(3-u)&63));var a=n.charAt(64);if(a)for(;i.length%4;)i.push(a);return i.join("")},parse:function(t){var r=t.length,n=this._map,i=this._reverseMap;if(!i){i=this._reverseMap=[];for(var o=0;o<n.length;o++)i[n.charCodeAt(o)]=o}var c=n.charAt(64);if(c){var u=t.indexOf(c);-1!==u&&(r=u)}return e(t,r,i)},_map:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="}}(),n.enc.Base64)},5503:function(t,r,e){var n;t.exports=(n=e(9021),function(){var t=n,r=t.lib.WordArray,e=t.enc;function i(t){return t<<8&4278255360|t>>>8&16711935}e.Utf16=e.Utf16BE={stringify:function(t){for(var r=t.words,e=t.sigBytes,n=[],i=0;i<e;i+=2){var o=r[i>>>2]>>>16-i%4*8&65535;n.push(String.fromCharCode(o))}return n.join("")},parse:function(t){for(var e=t.length,n=[],i=0;i<e;i++)n[i>>>1]|=t.charCodeAt(i)<<16-i%2*16;return r.create(n,2*e)}},e.Utf16LE={stringify:function(t){for(var r=t.words,e=t.sigBytes,n=[],o=0;o<e;o+=2){var c=i(r[o>>>2]>>>16-o%4*8&65535);n.push(String.fromCharCode(c))}return n.join("")},parse:function(t){for(var e=t.length,n=[],o=0;o<e;o++)n[o>>>1]|=i(t.charCodeAt(o)<<16-o%2*16);return r.create(n,2*e)}}}(),n.enc.Utf16)},9506:function(t,r,e){var n,i,o,c,u,a,s,f;t.exports=(f=e(9021),e(5471),e(1025),i=(n=f).lib,o=i.Base,c=i.WordArray,u=n.algo,a=u.MD5,s=u.EvpKDF=o.extend({cfg:o.extend({keySize:4,hasher:a,iterations:1}),init:function(t){this.cfg=this.cfg.extend(t)},compute:function(t,r){for(var e=this.cfg,n=e.hasher.create(),i=c.create(),o=i.words,u=e.keySize,a=e.iterations;o.length<u;){s&&n.update(s);var s=n.update(t).finalize(r);n.reset();for(var f=1;f<a;f++)s=n.finalize(s),n.reset();i.concat(s)}return i.sigBytes=4*u,i}}),n.EvpKDF=function(t,r,e){return s.create(e).compute(t,r)},f.EvpKDF)},25:function(t,r,e){var n,i,o,c;t.exports=(c=e(9021),e(7165),i=(n=c).lib.CipherParams,o=n.enc.Hex,n.format.Hex={stringify:function(t){return t.ciphertext.toString(o)},parse:function(t){var r=o.parse(t);return i.create({ciphertext:r})}},c.format.Hex)},1025:function(t,r,e){var n,i,o,c;t.exports=(n=e(9021),o=(i=n).lib.Base,c=i.enc.Utf8,void(i.algo.HMAC=o.extend({init:function(t,r){t=this._hasher=new t.init,"string"==typeof r&&(r=c.parse(r));var e=t.blockSize,n=4*e;r.sigBytes>n&&(r=t.finalize(r)),r.clamp();for(var i=this._oKey=r.clone(),o=this._iKey=r.clone(),u=i.words,a=o.words,s=0;s<e;s++)u[s]^=1549556828,a[s]^=909522486;i.sigBytes=o.sigBytes=n,this.reset()},reset:function(){var t=this._hasher;t.reset(),t.update(this._iKey)},update:function(t){return this._hasher.update(t),this},finalize:function(t){var r=this._hasher,e=r.finalize(t);return r.reset(),r.finalize(this._oKey.clone().concat(e))}})))},9015:function(t,r,e){var n;t.exports=(n=e(9021),e(3240),e(6440),e(5503),e(754),e(4636),e(5471),e(3009),e(6308),e(1380),e(9557),e(5953),e(8056),e(1025),e(19),e(9506),e(7165),e(2169),e(6939),e(6372),e(3797),e(8454),e(2073),e(4905),e(482),e(2155),e(8124),e(25),e(955),e(7628),e(7193),e(6298),e(2696),n)},6440:function(t,r,e){var n;t.exports=(n=e(9021),function(){if("function"==typeof ArrayBuffer){var t=n.lib.WordArray,r=t.init,e=t.init=function(t){if(t instanceof ArrayBuffer&&(t=new Uint8Array(t)),(t instanceof Int8Array||"undefined"!=typeof Uint8ClampedArray&&t instanceof Uint8ClampedArray||t instanceof Int16Array||t instanceof Uint16Array||t instanceof Int32Array||t instanceof Uint32Array||t instanceof Float32Array||t instanceof Float64Array)&&(t=new Uint8Array(t.buffer,t.byteOffset,t.byteLength)),t instanceof Uint8Array){for(var e=t.byteLength,n=[],i=0;i<e;i++)n[i>>>2]|=t[i]<<24-i%4*8;r.call(this,n,e)}else r.apply(this,arguments)};e.prototype=t}}(),n.lib.WordArray)},4636:function(t,r,e){var n;t.exports=(n=e(9021),function(t){var r=n,e=r.lib,i=e.WordArray,o=e.Hasher,c=r.algo,u=[];!function(){for(var r=0;r<64;r++)u[r]=4294967296*t.abs(t.sin(r+1))|0}();var a=c.MD5=o.extend({_doReset:function(){this._hash=new i.init([1732584193,4023233417,2562383102,271733878])},_doProcessBlock:function(t,r){for(var e=0;e<16;e++){var n=r+e,i=t[n];t[n]=16711935&(i<<8|i>>>24)|4278255360&(i<<24|i>>>8)}var o=this._hash.words,c=t[r+0],a=t[r+1],v=t[r+2],h=t[r+3],d=t[r+4],y=t[r+5],g=t[r+6],m=t[r+7],x=t[r+8],w=t[r+9],b=t[r+10],S=t[r+11],C=t[r+12],A=t[r+13],_=t[r+14],E=t[r+15],k=o[0],T=o[1],B=o[2],D=o[3];k=s(k,T,B,D,c,7,u[0]),D=s(D,k,T,B,a,12,u[1]),B=s(B,D,k,T,v,17,u[2]),T=s(T,B,D,k,h,22,u[3]),k=s(k,T,B,D,d,7,u[4]),D=s(D,k,T,B,y,12,u[5]),B=s(B,D,k,T,g,17,u[6]),T=s(T,B,D,k,m,22,u[7]),k=s(k,T,B,D,x,7,u[8]),D=s(D,k,T,B,w,12,u[9]),B=s(B,D,k,T,b,17,u[10]),T=s(T,B,D,k,S,22,u[11]),k=s(k,T,B,D,C,7,u[12]),D=s(D,k,T,B,A,12,u[13]),B=s(B,D,k,T,_,17,u[14]),k=f(k,T=s(T,B,D,k,E,22,u[15]),B,D,a,5,u[16]),D=f(D,k,T,B,g,9,u[17]),B=f(B,D,k,T,S,14,u[18]),T=f(T,B,D,k,c,20,u[19]),k=f(k,T,B,D,y,5,u[20]),D=f(D,k,T,B,b,9,u[21]),B=f(B,D,k,T,E,14,u[22]),T=f(T,B,D,k,d,20,u[23]),k=f(k,T,B,D,w,5,u[24]),D=f(D,k,T,B,_,9,u[25]),B=f(B,D,k,T,h,14,u[26]),T=f(T,B,D,k,x,20,u[27]),k=f(k,T,B,D,A,5,u[28]),D=f(D,k,T,B,v,9,u[29]),B=f(B,D,k,T,m,14,u[30]),k=l(k,T=f(T,B,D,k,C,20,u[31]),B,D,y,4,u[32]),D=l(D,k,T,B,x,11,u[33]),B=l(B,D,k,T,S,16,u[34]),T=l(T,B,D,k,_,23,u[35]),k=l(k,T,B,D,a,4,u[36]),D=l(D,k,T,B,d,11,u[37]),B=l(B,D,k,T,m,16,u[38]),T=l(T,B,D,k,b,23,u[39]),k=l(k,T,B,D,A,4,u[40]),D=l(D,k,T,B,c,11,u[41]),B=l(B,D,k,T,h,16,u[42]),T=l(T,B,D,k,g,23,u[43]),k=l(k,T,B,D,w,4,u[44]),D=l(D,k,T,B,C,11,u[45]),B=l(B,D,k,T,E,16,u[46]),k=p(k,T=l(T,B,D,k,v,23,u[47]),B,D,c,6,u[48]),D=p(D,k,T,B,m,10,u[49]),B=p(B,D,k,T,_,15,u[50]),T=p(T,B,D,k,y,21,u[51]),k=p(k,T,B,D,C,6,u[52]),D=p(D,k,T,B,h,10,u[53]),B=p(B,D,k,T,b,15,u[54]),T=p(T,B,D,k,a,21,u[55]),k=p(k,T,B,D,x,6,u[56]),D=p(D,k,T,B,E,10,u[57]),B=p(B,D,k,T,g,15,u[58]),T=p(T,B,D,k,A,21,u[59]),k=p(k,T,B,D,d,6,u[60]),D=p(D,k,T,B,S,10,u[61]),B=p(B,D,k,T,v,15,u[62]),T=p(T,B,D,k,w,21,u[63]),o[0]=o[0]+k|0,o[1]=o[1]+T|0,o[2]=o[2]+B|0,o[3]=o[3]+D|0},_doFinalize:function(){var r=this._data,e=r.words,n=8*this._nDataBytes,i=8*r.sigBytes;e[i>>>5]|=128<<24-i%32;var o=t.floor(n/4294967296),c=n;e[15+(i+64>>>9<<4)]=16711935&(o<<8|o>>>24)|4278255360&(o<<24|o>>>8),e[14+(i+64>>>9<<4)]=16711935&(c<<8|c>>>24)|4278255360&(c<<24|c>>>8),r.sigBytes=4*(e.length+1),this._process();for(var u=this._hash,a=u.words,s=0;s<4;s++){var f=a[s];a[s]=16711935&(f<<8|f>>>24)|4278255360&(f<<24|f>>>8)}return u},clone:function(){var t=o.clone.call(this);return t._hash=this._hash.clone(),t}});function s(t,r,e,n,i,o,c){var u=t+(r&e|~r&n)+i+c;return(u<<o|u>>>32-o)+r}function f(t,r,e,n,i,o,c){var u=t+(r&n|e&~n)+i+c;return(u<<o|u>>>32-o)+r}function l(t,r,e,n,i,o,c){var u=t+(r^e^n)+i+c;return(u<<o|u>>>32-o)+r}function p(t,r,e,n,i,o,c){var u=t+(e^(r|~n))+i+c;return(u<<o|u>>>32-o)+r}r.MD5=o._createHelper(a),r.HmacMD5=o._createHmacHelper(a)}(Math),n.MD5)},2169:function(t,r,e){var n;t.exports=(n=e(9021),e(7165),n.mode.CFB=function(){var t=n.lib.BlockCipherMode.extend();function r(t,r,e,n){var i=this._iv;if(i){var o=i.slice(0);this._iv=void 0}else o=this._prevBlock;n.encryptBlock(o,0);for(var c=0;c<e;c++)t[r+c]^=o[c]}return t.Encryptor=t.extend({processBlock:function(t,e){var n=this._cipher,i=n.blockSize;r.call(this,t,e,i,n),this._prevBlock=t.slice(e,e+i)}}),t.Decryptor=t.extend({processBlock:function(t,e){var n=this._cipher,i=n.blockSize,o=t.slice(e,e+i);r.call(this,t,e,i,n),this._prevBlock=o}}),t}(),n.mode.CFB)},6372:function(t,r,e){var n;t.exports=(n=e(9021),e(7165),n.mode.CTRGladman=function(){var t=n.lib.BlockCipherMode.extend();function r(t){if(255&~(t>>24))t+=1<<24;else{var r=t>>16&255,e=t>>8&255,n=255&t;255===r?(r=0,255===e?(e=0,255===n?n=0:++n):++e):++r,t=0,t+=r<<16,t+=e<<8,t+=n}return t}function e(t){return 0===(t[0]=r(t[0]))&&(t[1]=r(t[1])),t}var i=t.Encryptor=t.extend({processBlock:function(t,r){var n=this._cipher,i=n.blockSize,o=this._iv,c=this._counter;o&&(c=this._counter=o.slice(0),this._iv=void 0),e(c);var u=c.slice(0);n.encryptBlock(u,0);for(var a=0;a<i;a++)t[r+a]^=u[a]}});return t.Decryptor=i,t}(),n.mode.CTRGladman)},6939:function(t,r,e){var n,i,o;t.exports=(o=e(9021),e(7165),o.mode.CTR=(n=o.lib.BlockCipherMode.extend(),i=n.Encryptor=n.extend({processBlock:function(t,r){var e=this._cipher,n=e.blockSize,i=this._iv,o=this._counter;i&&(o=this._counter=i.slice(0),this._iv=void 0);var c=o.slice(0);e.encryptBlock(c,0),o[n-1]=o[n-1]+1|0;for(var u=0;u<n;u++)t[r+u]^=c[u]}}),n.Decryptor=i,n),o.mode.CTR)},8454:function(t,r,e){var n,i;t.exports=(i=e(9021),e(7165),i.mode.ECB=((n=i.lib.BlockCipherMode.extend()).Encryptor=n.extend({processBlock:function(t,r){this._cipher.encryptBlock(t,r)}}),n.Decryptor=n.extend({processBlock:function(t,r){this._cipher.decryptBlock(t,r)}}),n),i.mode.ECB)},3797:function(t,r,e){var n,i,o;t.exports=(o=e(9021),e(7165),o.mode.OFB=(n=o.lib.BlockCipherMode.extend(),i=n.Encryptor=n.extend({processBlock:function(t,r){var e=this._cipher,n=e.blockSize,i=this._iv,o=this._keystream;i&&(o=this._keystream=i.slice(0),this._iv=void 0),e.encryptBlock(o,0);for(var c=0;c<n;c++)t[r+c]^=o[c]}}),n.Decryptor=i,n),o.mode.OFB)},2073:function(t,r,e){var n;t.exports=(n=e(9021),e(7165),n.pad.AnsiX923={pad:function(t,r){var e=t.sigBytes,n=4*r,i=n-e%n,o=e+i-1;t.clamp(),t.words[o>>>2]|=i<<24-o%4*8,t.sigBytes+=i},unpad:function(t){var r=255&t.words[t.sigBytes-1>>>2];t.sigBytes-=r}},n.pad.Ansix923)},4905:function(t,r,e){var n;t.exports=(n=e(9021),e(7165),n.pad.Iso10126={pad:function(t,r){var e=4*r,i=e-t.sigBytes%e;t.concat(n.lib.WordArray.random(i-1)).concat(n.lib.WordArray.create([i<<24],1))},unpad:function(t){var r=255&t.words[t.sigBytes-1>>>2];t.sigBytes-=r}},n.pad.Iso10126)},482:function(t,r,e){var n;t.exports=(n=e(9021),e(7165),n.pad.Iso97971={pad:function(t,r){t.concat(n.lib.WordArray.create([2147483648],1)),n.pad.ZeroPadding.pad(t,r)},unpad:function(t){n.pad.ZeroPadding.unpad(t),t.sigBytes--}},n.pad.Iso97971)},8124:function(t,r,e){var n;t.exports=(n=e(9021),e(7165),n.pad.NoPadding={pad:function(){},unpad:function(){}},n.pad.NoPadding)},2155:function(t,r,e){var n;t.exports=(n=e(9021),e(7165),n.pad.ZeroPadding={pad:function(t,r){var e=4*r;t.clamp(),t.sigBytes+=e-(t.sigBytes%e||e)},unpad:function(t){for(var r=t.words,e=t.sigBytes-1;!(r[e>>>2]>>>24-e%4*8&255);)e--;t.sigBytes=e+1}},n.pad.ZeroPadding)},19:function(t,r,e){var n,i,o,c,u,a,s,f,l;t.exports=(l=e(9021),e(5471),e(1025),i=(n=l).lib,o=i.Base,c=i.WordArray,u=n.algo,a=u.SHA1,s=u.HMAC,f=u.PBKDF2=o.extend({cfg:o.extend({keySize:4,hasher:a,iterations:1}),init:function(t){this.cfg=this.cfg.extend(t)},compute:function(t,r){for(var e=this.cfg,n=s.create(e.hasher,t),i=c.create(),o=c.create([1]),u=i.words,a=o.words,f=e.keySize,l=e.iterations;u.length<f;){var p=n.update(r).finalize(o);n.reset();for(var v=p.words,h=v.length,d=p,y=1;y<l;y++){d=n.finalize(d),n.reset();for(var g=d.words,m=0;m<h;m++)v[m]^=g[m]}i.concat(p),a[0]++}return i.sigBytes=4*f,i}}),n.PBKDF2=function(t,r,e){return f.create(e).compute(t,r)},l.PBKDF2)},2696:function(t,r,e){var n;t.exports=(n=e(9021),e(754),e(4636),e(9506),e(7165),function(){var t=n,r=t.lib.StreamCipher,e=t.algo,i=[],o=[],c=[],u=e.RabbitLegacy=r.extend({_doReset:function(){var t=this._key.words,r=this.cfg.iv,e=this._X=[t[0],t[3]<<16|t[2]>>>16,t[1],t[0]<<16|t[3]>>>16,t[2],t[1]<<16|t[0]>>>16,t[3],t[2]<<16|t[1]>>>16],n=this._C=[t[2]<<16|t[2]>>>16,4294901760&t[0]|65535&t[1],t[3]<<16|t[3]>>>16,4294901760&t[1]|65535&t[2],t[0]<<16|t[0]>>>16,4294901760&t[2]|65535&t[3],t[1]<<16|t[1]>>>16,4294901760&t[3]|65535&t[0]];this._b=0;for(var i=0;i<4;i++)a.call(this);for(i=0;i<8;i++)n[i]^=e[i+4&7];if(r){var o=r.words,c=o[0],u=o[1],s=16711935&(c<<8|c>>>24)|4278255360&(c<<24|c>>>8),f=16711935&(u<<8|u>>>24)|4278255360&(u<<24|u>>>8),l=s>>>16|4294901760&f,p=f<<16|65535&s;for(n[0]^=s,n[1]^=l,n[2]^=f,n[3]^=p,n[4]^=s,n[5]^=l,n[6]^=f,n[7]^=p,i=0;i<4;i++)a.call(this)}},_doProcessBlock:function(t,r){var e=this._X;a.call(this),i[0]=e[0]^e[5]>>>16^e[3]<<16,i[1]=e[2]^e[7]>>>16^e[5]<<16,i[2]=e[4]^e[1]>>>16^e[7]<<16,i[3]=e[6]^e[3]>>>16^e[1]<<16;for(var n=0;n<4;n++)i[n]=16711935&(i[n]<<8|i[n]>>>24)|4278255360&(i[n]<<24|i[n]>>>8),t[r+n]^=i[n]},blockSize:4,ivSize:2});function a(){for(var t=this._X,r=this._C,e=0;e<8;e++)o[e]=r[e];for(r[0]=r[0]+1295307597+this._b|0,r[1]=r[1]+3545052371+(r[0]>>>0<o[0]>>>0?1:0)|0,r[2]=r[2]+886263092+(r[1]>>>0<o[1]>>>0?1:0)|0,r[3]=r[3]+1295307597+(r[2]>>>0<o[2]>>>0?1:0)|0,r[4]=r[4]+3545052371+(r[3]>>>0<o[3]>>>0?1:0)|0,r[5]=r[5]+886263092+(r[4]>>>0<o[4]>>>0?1:0)|0,r[6]=r[6]+1295307597+(r[5]>>>0<o[5]>>>0?1:0)|0,r[7]=r[7]+3545052371+(r[6]>>>0<o[6]>>>0?1:0)|0,this._b=r[7]>>>0<o[7]>>>0?1:0,e=0;e<8;e++){var n=t[e]+r[e],i=65535&n,u=n>>>16,a=((i*i>>>17)+i*u>>>15)+u*u,s=((4294901760&n)*n|0)+((65535&n)*n|0);c[e]=a^s}t[0]=c[0]+(c[7]<<16|c[7]>>>16)+(c[6]<<16|c[6]>>>16)|0,t[1]=c[1]+(c[0]<<8|c[0]>>>24)+c[7]|0,t[2]=c[2]+(c[1]<<16|c[1]>>>16)+(c[0]<<16|c[0]>>>16)|0,t[3]=c[3]+(c[2]<<8|c[2]>>>24)+c[1]|0,t[4]=c[4]+(c[3]<<16|c[3]>>>16)+(c[2]<<16|c[2]>>>16)|0,t[5]=c[5]+(c[4]<<8|c[4]>>>24)+c[3]|0,t[6]=c[6]+(c[5]<<16|c[5]>>>16)+(c[4]<<16|c[4]>>>16)|0,t[7]=c[7]+(c[6]<<8|c[6]>>>24)+c[5]|0}t.RabbitLegacy=r._createHelper(u)}(),n.RabbitLegacy)},6298:function(t,r,e){var n;t.exports=(n=e(9021),e(754),e(4636),e(9506),e(7165),function(){var t=n,r=t.lib.StreamCipher,e=t.algo,i=[],o=[],c=[],u=e.Rabbit=r.extend({_doReset:function(){for(var t=this._key.words,r=this.cfg.iv,e=0;e<4;e++)t[e]=16711935&(t[e]<<8|t[e]>>>24)|4278255360&(t[e]<<24|t[e]>>>8);var n=this._X=[t[0],t[3]<<16|t[2]>>>16,t[1],t[0]<<16|t[3]>>>16,t[2],t[1]<<16|t[0]>>>16,t[3],t[2]<<16|t[1]>>>16],i=this._C=[t[2]<<16|t[2]>>>16,4294901760&t[0]|65535&t[1],t[3]<<16|t[3]>>>16,4294901760&t[1]|65535&t[2],t[0]<<16|t[0]>>>16,4294901760&t[2]|65535&t[3],t[1]<<16|t[1]>>>16,4294901760&t[3]|65535&t[0]];for(this._b=0,e=0;e<4;e++)a.call(this);for(e=0;e<8;e++)i[e]^=n[e+4&7];if(r){var o=r.words,c=o[0],u=o[1],s=16711935&(c<<8|c>>>24)|4278255360&(c<<24|c>>>8),f=16711935&(u<<8|u>>>24)|4278255360&(u<<24|u>>>8),l=s>>>16|4294901760&f,p=f<<16|65535&s;for(i[0]^=s,i[1]^=l,i[2]^=f,i[3]^=p,i[4]^=s,i[5]^=l,i[6]^=f,i[7]^=p,e=0;e<4;e++)a.call(this)}},_doProcessBlock:function(t,r){var e=this._X;a.call(this),i[0]=e[0]^e[5]>>>16^e[3]<<16,i[1]=e[2]^e[7]>>>16^e[5]<<16,i[2]=e[4]^e[1]>>>16^e[7]<<16,i[3]=e[6]^e[3]>>>16^e[1]<<16;for(var n=0;n<4;n++)i[n]=16711935&(i[n]<<8|i[n]>>>24)|4278255360&(i[n]<<24|i[n]>>>8),t[r+n]^=i[n]},blockSize:4,ivSize:2});function a(){for(var t=this._X,r=this._C,e=0;e<8;e++)o[e]=r[e];for(r[0]=r[0]+1295307597+this._b|0,r[1]=r[1]+3545052371+(r[0]>>>0<o[0]>>>0?1:0)|0,r[2]=r[2]+886263092+(r[1]>>>0<o[1]>>>0?1:0)|0,r[3]=r[3]+1295307597+(r[2]>>>0<o[2]>>>0?1:0)|0,r[4]=r[4]+3545052371+(r[3]>>>0<o[3]>>>0?1:0)|0,r[5]=r[5]+886263092+(r[4]>>>0<o[4]>>>0?1:0)|0,r[6]=r[6]+1295307597+(r[5]>>>0<o[5]>>>0?1:0)|0,r[7]=r[7]+3545052371+(r[6]>>>0<o[6]>>>0?1:0)|0,this._b=r[7]>>>0<o[7]>>>0?1:0,e=0;e<8;e++){var n=t[e]+r[e],i=65535&n,u=n>>>16,a=((i*i>>>17)+i*u>>>15)+u*u,s=((4294901760&n)*n|0)+((65535&n)*n|0);c[e]=a^s}t[0]=c[0]+(c[7]<<16|c[7]>>>16)+(c[6]<<16|c[6]>>>16)|0,t[1]=c[1]+(c[0]<<8|c[0]>>>24)+c[7]|0,t[2]=c[2]+(c[1]<<16|c[1]>>>16)+(c[0]<<16|c[0]>>>16)|0,t[3]=c[3]+(c[2]<<8|c[2]>>>24)+c[1]|0,t[4]=c[4]+(c[3]<<16|c[3]>>>16)+(c[2]<<16|c[2]>>>16)|0,t[5]=c[5]+(c[4]<<8|c[4]>>>24)+c[3]|0,t[6]=c[6]+(c[5]<<16|c[5]>>>16)+(c[4]<<16|c[4]>>>16)|0,t[7]=c[7]+(c[6]<<8|c[6]>>>24)+c[5]|0}t.Rabbit=r._createHelper(u)}(),n.Rabbit)},7193:function(t,r,e){var n;t.exports=(n=e(9021),e(754),e(4636),e(9506),e(7165),function(){var t=n,r=t.lib.StreamCipher,e=t.algo,i=e.RC4=r.extend({_doReset:function(){for(var t=this._key,r=t.words,e=t.sigBytes,n=this._S=[],i=0;i<256;i++)n[i]=i;i=0;for(var o=0;i<256;i++){var c=i%e,u=r[c>>>2]>>>24-c%4*8&255;o=(o+n[i]+u)%256;var a=n[i];n[i]=n[o],n[o]=a}this._i=this._j=0},_doProcessBlock:function(t,r){t[r]^=o.call(this)},keySize:8,ivSize:0});function o(){for(var t=this._S,r=this._i,e=this._j,n=0,i=0;i<4;i++){e=(e+t[r=(r+1)%256])%256;var o=t[r];t[r]=t[e],t[e]=o,n|=t[(t[r]+t[e])%256]<<24-8*i}return this._i=r,this._j=e,n}t.RC4=r._createHelper(i);var c=e.RC4Drop=i.extend({cfg:i.cfg.extend({drop:192}),_doReset:function(){i._doReset.call(this);for(var t=this.cfg.drop;t>0;t--)o.call(this)}});t.RC4Drop=r._createHelper(c)}(),n.RC4)},8056:function(t,r,e){var n;t.exports=(n=e(9021),function(){var t=n,r=t.lib,e=r.WordArray,i=r.Hasher,o=t.algo,c=e.create([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13]),u=e.create([5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11]),a=e.create([11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6]),s=e.create([8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11]),f=e.create([0,1518500249,1859775393,2400959708,2840853838]),l=e.create([1352829926,1548603684,1836072691,2053994217,0]),p=o.RIPEMD160=i.extend({_doReset:function(){this._hash=e.create([1732584193,4023233417,2562383102,271733878,3285377520])},_doProcessBlock:function(t,r){for(var e=0;e<16;e++){var n=r+e,i=t[n];t[n]=16711935&(i<<8|i>>>24)|4278255360&(i<<24|i>>>8)}var o,p,x,w,b,S,C,A,_,E,k,T=this._hash.words,B=f.words,D=l.words,I=c.words,z=u.words,M=a.words,O=s.words;for(S=o=T[0],C=p=T[1],A=x=T[2],_=w=T[3],E=b=T[4],e=0;e<80;e+=1)k=o+t[r+I[e]]|0,k+=e<16?v(p,x,w)+B[0]:e<32?h(p,x,w)+B[1]:e<48?d(p,x,w)+B[2]:e<64?y(p,x,w)+B[3]:g(p,x,w)+B[4],k=(k=m(k|=0,M[e]))+b|0,o=b,b=w,w=m(x,10),x=p,p=k,k=S+t[r+z[e]]|0,k+=e<16?g(C,A,_)+D[0]:e<32?y(C,A,_)+D[1]:e<48?d(C,A,_)+D[2]:e<64?h(C,A,_)+D[3]:v(C,A,_)+D[4],k=(k=m(k|=0,O[e]))+E|0,S=E,E=_,_=m(A,10),A=C,C=k;k=T[1]+x+_|0,T[1]=T[2]+w+E|0,T[2]=T[3]+b+S|0,T[3]=T[4]+o+C|0,T[4]=T[0]+p+A|0,T[0]=k},_doFinalize:function(){var t=this._data,r=t.words,e=8*this._nDataBytes,n=8*t.sigBytes;r[n>>>5]|=128<<24-n%32,r[14+(n+64>>>9<<4)]=16711935&(e<<8|e>>>24)|4278255360&(e<<24|e>>>8),t.sigBytes=4*(r.length+1),this._process();for(var i=this._hash,o=i.words,c=0;c<5;c++){var u=o[c];o[c]=16711935&(u<<8|u>>>24)|4278255360&(u<<24|u>>>8)}return i},clone:function(){var t=i.clone.call(this);return t._hash=this._hash.clone(),t}});function v(t,r,e){return t^r^e}function h(t,r,e){return t&r|~t&e}function d(t,r,e){return(t|~r)^e}function y(t,r,e){return t&e|r&~e}function g(t,r,e){return t^(r|~e)}function m(t,r){return t<<r|t>>>32-r}t.RIPEMD160=i._createHelper(p),t.HmacRIPEMD160=i._createHmacHelper(p)}(Math),n.RIPEMD160)},5471:function(t,r,e){var n,i,o,c,u,a,s,f;t.exports=(f=e(9021),i=(n=f).lib,o=i.WordArray,c=i.Hasher,u=n.algo,a=[],s=u.SHA1=c.extend({_doReset:function(){this._hash=new o.init([1732584193,4023233417,2562383102,271733878,3285377520])},_doProcessBlock:function(t,r){for(var e=this._hash.words,n=e[0],i=e[1],o=e[2],c=e[3],u=e[4],s=0;s<80;s++){if(s<16)a[s]=0|t[r+s];else{var f=a[s-3]^a[s-8]^a[s-14]^a[s-16];a[s]=f<<1|f>>>31}var l=(n<<5|n>>>27)+u+a[s];l+=s<20?1518500249+(i&o|~i&c):s<40?1859775393+(i^o^c):s<60?(i&o|i&c|o&c)-1894007588:(i^o^c)-899497514,u=c,c=o,o=i<<30|i>>>2,i=n,n=l}e[0]=e[0]+n|0,e[1]=e[1]+i|0,e[2]=e[2]+o|0,e[3]=e[3]+c|0,e[4]=e[4]+u|0},_doFinalize:function(){var t=this._data,r=t.words,e=8*this._nDataBytes,n=8*t.sigBytes;return r[n>>>5]|=128<<24-n%32,r[14+(n+64>>>9<<4)]=Math.floor(e/4294967296),r[15+(n+64>>>9<<4)]=e,t.sigBytes=4*r.length,this._process(),this._hash},clone:function(){var t=c.clone.call(this);return t._hash=this._hash.clone(),t}}),n.SHA1=c._createHelper(s),n.HmacSHA1=c._createHmacHelper(s),f.SHA1)},6308:function(t,r,e){var n,i,o,c,u,a;t.exports=(a=e(9021),e(3009),i=(n=a).lib.WordArray,o=n.algo,c=o.SHA256,u=o.SHA224=c.extend({_doReset:function(){this._hash=new i.init([3238371032,914150663,812702999,4144912697,4290775857,1750603025,1694076839,3204075428])},_doFinalize:function(){var t=c._doFinalize.call(this);return t.sigBytes-=4,t}}),n.SHA224=c._createHelper(u),n.HmacSHA224=c._createHmacHelper(u),a.SHA224)},3009:function(t,r,e){var n;t.exports=(n=e(9021),function(t){var r=n,e=r.lib,i=e.WordArray,o=e.Hasher,c=r.algo,u=[],a=[];!function(){function r(r){for(var e=t.sqrt(r),n=2;n<=e;n++)if(!(r%n))return!1;return!0}function e(t){return 4294967296*(t-(0|t))|0}for(var n=2,i=0;i<64;)r(n)&&(i<8&&(u[i]=e(t.pow(n,.5))),a[i]=e(t.pow(n,1/3)),i++),n++}();var s=[],f=c.SHA256=o.extend({_doReset:function(){this._hash=new i.init(u.slice(0))},_doProcessBlock:function(t,r){for(var e=this._hash.words,n=e[0],i=e[1],o=e[2],c=e[3],u=e[4],f=e[5],l=e[6],p=e[7],v=0;v<64;v++){if(v<16)s[v]=0|t[r+v];else{var h=s[v-15],d=(h<<25|h>>>7)^(h<<14|h>>>18)^h>>>3,y=s[v-2],g=(y<<15|y>>>17)^(y<<13|y>>>19)^y>>>10;s[v]=d+s[v-7]+g+s[v-16]}var m=n&i^n&o^i&o,x=(n<<30|n>>>2)^(n<<19|n>>>13)^(n<<10|n>>>22),w=p+((u<<26|u>>>6)^(u<<21|u>>>11)^(u<<7|u>>>25))+(u&f^~u&l)+a[v]+s[v];p=l,l=f,f=u,u=c+w|0,c=o,o=i,i=n,n=w+(x+m)|0}e[0]=e[0]+n|0,e[1]=e[1]+i|0,e[2]=e[2]+o|0,e[3]=e[3]+c|0,e[4]=e[4]+u|0,e[5]=e[5]+f|0,e[6]=e[6]+l|0,e[7]=e[7]+p|0},_doFinalize:function(){var r=this._data,e=r.words,n=8*this._nDataBytes,i=8*r.sigBytes;return e[i>>>5]|=128<<24-i%32,e[14+(i+64>>>9<<4)]=t.floor(n/4294967296),e[15+(i+64>>>9<<4)]=n,r.sigBytes=4*e.length,this._process(),this._hash},clone:function(){var t=o.clone.call(this);return t._hash=this._hash.clone(),t}});r.SHA256=o._createHelper(f),r.HmacSHA256=o._createHmacHelper(f)}(Math),n.SHA256)},5953:function(t,r,e){var n;t.exports=(n=e(9021),e(3240),function(t){var r=n,e=r.lib,i=e.WordArray,o=e.Hasher,c=r.x64.Word,u=r.algo,a=[],s=[],f=[];!function(){for(var t=1,r=0,e=0;e<24;e++){a[t+5*r]=(e+1)*(e+2)/2%64;var n=(2*t+3*r)%5;t=r%5,r=n}for(t=0;t<5;t++)for(r=0;r<5;r++)s[t+5*r]=r+(2*t+3*r)%5*5;for(var i=1,o=0;o<24;o++){for(var u=0,l=0,p=0;p<7;p++){if(1&i){var v=(1<<p)-1;v<32?l^=1<<v:u^=1<<v-32}128&i?i=i<<1^113:i<<=1}f[o]=c.create(u,l)}}();var l=[];!function(){for(var t=0;t<25;t++)l[t]=c.create()}();var p=u.SHA3=o.extend({cfg:o.cfg.extend({outputLength:512}),_doReset:function(){for(var t=this._state=[],r=0;r<25;r++)t[r]=new c.init;this.blockSize=(1600-2*this.cfg.outputLength)/32},_doProcessBlock:function(t,r){for(var e=this._state,n=this.blockSize/2,i=0;i<n;i++){var o=t[r+2*i],c=t[r+2*i+1];o=16711935&(o<<8|o>>>24)|4278255360&(o<<24|o>>>8),c=16711935&(c<<8|c>>>24)|4278255360&(c<<24|c>>>8),(T=e[i]).high^=c,T.low^=o}for(var u=0;u<24;u++){for(var p=0;p<5;p++){for(var v=0,h=0,d=0;d<5;d++)v^=(T=e[p+5*d]).high,h^=T.low;var y=l[p];y.high=v,y.low=h}for(p=0;p<5;p++){var g=l[(p+4)%5],m=l[(p+1)%5],x=m.high,w=m.low;for(v=g.high^(x<<1|w>>>31),h=g.low^(w<<1|x>>>31),d=0;d<5;d++)(T=e[p+5*d]).high^=v,T.low^=h}for(var b=1;b<25;b++){var S=(T=e[b]).high,C=T.low,A=a[b];A<32?(v=S<<A|C>>>32-A,h=C<<A|S>>>32-A):(v=C<<A-32|S>>>64-A,h=S<<A-32|C>>>64-A);var _=l[s[b]];_.high=v,_.low=h}var E=l[0],k=e[0];for(E.high=k.high,E.low=k.low,p=0;p<5;p++)for(d=0;d<5;d++){var T=e[b=p+5*d],B=l[b],D=l[(p+1)%5+5*d],I=l[(p+2)%5+5*d];T.high=B.high^~D.high&I.high,T.low=B.low^~D.low&I.low}T=e[0];var z=f[u];T.high^=z.high,T.low^=z.low}},_doFinalize:function(){var r=this._data,e=r.words,n=(this._nDataBytes,8*r.sigBytes),o=32*this.blockSize;e[n>>>5]|=1<<24-n%32,e[(t.ceil((n+1)/o)*o>>>5)-1]|=128,r.sigBytes=4*e.length,this._process();for(var c=this._state,u=this.cfg.outputLength/8,a=u/8,s=[],f=0;f<a;f++){var l=c[f],p=l.high,v=l.low;p=16711935&(p<<8|p>>>24)|4278255360&(p<<24|p>>>8),v=16711935&(v<<8|v>>>24)|4278255360&(v<<24|v>>>8),s.push(v),s.push(p)}return new i.init(s,u)},clone:function(){for(var t=o.clone.call(this),r=t._state=this._state.slice(0),e=0;e<25;e++)r[e]=r[e].clone();return t}});r.SHA3=o._createHelper(p),r.HmacSHA3=o._createHmacHelper(p)}(Math),n.SHA3)},9557:function(t,r,e){var n,i,o,c,u,a,s,f;t.exports=(f=e(9021),e(3240),e(1380),i=(n=f).x64,o=i.Word,c=i.WordArray,u=n.algo,a=u.SHA512,s=u.SHA384=a.extend({_doReset:function(){this._hash=new c.init([new o.init(3418070365,3238371032),new o.init(1654270250,914150663),new o.init(2438529370,812702999),new o.init(355462360,4144912697),new o.init(1731405415,4290775857),new o.init(2394180231,1750603025),new o.init(3675008525,1694076839),new o.init(1203062813,3204075428)])},_doFinalize:function(){var t=a._doFinalize.call(this);return t.sigBytes-=16,t}}),n.SHA384=a._createHelper(s),n.HmacSHA384=a._createHmacHelper(s),f.SHA384)},1380:function(t,r,e){var n;t.exports=(n=e(9021),e(3240),function(){var t=n,r=t.lib.Hasher,e=t.x64,i=e.Word,o=e.WordArray,c=t.algo;function u(){return i.create.apply(i,arguments)}var a=[u(1116352408,3609767458),u(1899447441,602891725),u(3049323471,3964484399),u(3921009573,2173295548),u(961987163,4081628472),u(1508970993,3053834265),u(2453635748,2937671579),u(2870763221,3664609560),u(3624381080,2734883394),u(310598401,1164996542),u(607225278,1323610764),u(1426881987,3590304994),u(1925078388,4068182383),u(2162078206,991336113),u(2614888103,633803317),u(3248222580,3479774868),u(3835390401,2666613458),u(4022224774,944711139),u(264347078,2341262773),u(604807628,2007800933),u(770255983,1495990901),u(1249150122,1856431235),u(1555081692,3175218132),u(1996064986,2198950837),u(2554220882,3999719339),u(2821834349,766784016),u(2952996808,2566594879),u(3210313671,3203337956),u(3336571891,1034457026),u(3584528711,2466948901),u(113926993,3758326383),u(338241895,168717936),u(666307205,1188179964),u(773529912,1546045734),u(1294757372,1522805485),u(1396182291,2643833823),u(1695183700,2343527390),u(1986661051,1014477480),u(2177026350,1206759142),u(2456956037,344077627),u(2730485921,1290863460),u(2820302411,3158454273),u(3259730800,3505952657),u(3345764771,106217008),u(3516065817,3606008344),u(3600352804,1432725776),u(4094571909,1467031594),u(275423344,851169720),u(430227734,3100823752),u(506948616,1363258195),u(659060556,3750685593),u(883997877,3785050280),u(958139571,3318307427),u(1322822218,3812723403),u(1537002063,2003034995),u(1747873779,3602036899),u(1955562222,1575990012),u(2024104815,1125592928),u(2227730452,2716904306),u(2361852424,442776044),u(2428436474,593698344),u(2756734187,3733110249),u(3204031479,2999351573),u(3329325298,3815920427),u(3391569614,3928383900),u(3515267271,566280711),u(3940187606,3454069534),u(4118630271,4000239992),u(116418474,1914138554),u(174292421,2731055270),u(289380356,3203993006),u(460393269,320620315),u(685471733,587496836),u(852142971,1086792851),u(1017036298,365543100),u(1126000580,2618297676),u(1288033470,3409855158),u(1501505948,4234509866),u(1607167915,987167468),u(1816402316,1246189591)],s=[];!function(){for(var t=0;t<80;t++)s[t]=u()}();var f=c.SHA512=r.extend({_doReset:function(){this._hash=new o.init([new i.init(1779033703,4089235720),new i.init(3144134277,2227873595),new i.init(1013904242,4271175723),new i.init(2773480762,1595750129),new i.init(1359893119,2917565137),new i.init(2600822924,725511199),new i.init(528734635,4215389547),new i.init(1541459225,327033209)])},_doProcessBlock:function(t,r){for(var e=this._hash.words,n=e[0],i=e[1],o=e[2],c=e[3],u=e[4],f=e[5],l=e[6],p=e[7],v=n.high,h=n.low,d=i.high,y=i.low,g=o.high,m=o.low,x=c.high,w=c.low,b=u.high,S=u.low,C=f.high,A=f.low,_=l.high,E=l.low,k=p.high,T=p.low,B=v,D=h,I=d,z=y,M=g,O=m,L=x,P=w,N=b,j=S,H=C,W=A,F=_,K=E,R=k,U=T,q=0;q<80;q++){var G=s[q];if(q<16)var Y=G.high=0|t[r+2*q],J=G.low=0|t[r+2*q+1];else{var V=s[q-15],Z=V.high,X=V.low,Q=(Z>>>1|X<<31)^(Z>>>8|X<<24)^Z>>>7,$=(X>>>1|Z<<31)^(X>>>8|Z<<24)^(X>>>7|Z<<25),tt=s[q-2],rt=tt.high,et=tt.low,nt=(rt>>>19|et<<13)^(rt<<3|et>>>29)^rt>>>6,it=(et>>>19|rt<<13)^(et<<3|rt>>>29)^(et>>>6|rt<<26),ot=s[q-7],ct=ot.high,ut=ot.low,at=s[q-16],st=at.high,ft=at.low;Y=(Y=(Y=Q+ct+((J=$+ut)>>>0<$>>>0?1:0))+nt+((J+=it)>>>0<it>>>0?1:0))+st+((J+=ft)>>>0<ft>>>0?1:0),G.high=Y,G.low=J}var lt,pt=N&H^~N&F,vt=j&W^~j&K,ht=B&I^B&M^I&M,dt=D&z^D&O^z&O,yt=(B>>>28|D<<4)^(B<<30|D>>>2)^(B<<25|D>>>7),gt=(D>>>28|B<<4)^(D<<30|B>>>2)^(D<<25|B>>>7),mt=(N>>>14|j<<18)^(N>>>18|j<<14)^(N<<23|j>>>9),xt=(j>>>14|N<<18)^(j>>>18|N<<14)^(j<<23|N>>>9),wt=a[q],bt=wt.high,St=wt.low,Ct=R+mt+((lt=U+xt)>>>0<U>>>0?1:0),At=gt+dt;R=F,U=K,F=H,K=W,H=N,W=j,N=L+(Ct=(Ct=(Ct=Ct+pt+((lt+=vt)>>>0<vt>>>0?1:0))+bt+((lt+=St)>>>0<St>>>0?1:0))+Y+((lt+=J)>>>0<J>>>0?1:0))+((j=P+lt|0)>>>0<P>>>0?1:0)|0,L=M,P=O,M=I,O=z,I=B,z=D,B=Ct+(yt+ht+(At>>>0<gt>>>0?1:0))+((D=lt+At|0)>>>0<lt>>>0?1:0)|0}h=n.low=h+D,n.high=v+B+(h>>>0<D>>>0?1:0),y=i.low=y+z,i.high=d+I+(y>>>0<z>>>0?1:0),m=o.low=m+O,o.high=g+M+(m>>>0<O>>>0?1:0),w=c.low=w+P,c.high=x+L+(w>>>0<P>>>0?1:0),S=u.low=S+j,u.high=b+N+(S>>>0<j>>>0?1:0),A=f.low=A+W,f.high=C+H+(A>>>0<W>>>0?1:0),E=l.low=E+K,l.high=_+F+(E>>>0<K>>>0?1:0),T=p.low=T+U,p.high=k+R+(T>>>0<U>>>0?1:0)},_doFinalize:function(){var t=this._data,r=t.words,e=8*this._nDataBytes,n=8*t.sigBytes;return r[n>>>5]|=128<<24-n%32,r[30+(n+128>>>10<<5)]=Math.floor(e/4294967296),r[31+(n+128>>>10<<5)]=e,t.sigBytes=4*r.length,this._process(),this._hash.toX32()},clone:function(){var t=r.clone.call(this);return t._hash=this._hash.clone(),t},blockSize:32});t.SHA512=r._createHelper(f),t.HmacSHA512=r._createHmacHelper(f)}(),n.SHA512)},7628:function(t,r,e){var n;t.exports=(n=e(9021),e(754),e(4636),e(9506),e(7165),function(){var t=n,r=t.lib,e=r.WordArray,i=r.BlockCipher,o=t.algo,c=[57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4],u=[14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32],a=[1,2,4,6,8,10,12,14,15,17,19,21,23,25,27,28],s=[{0:8421888,268435456:32768,536870912:8421378,805306368:2,1073741824:512,1342177280:8421890,1610612736:8389122,1879048192:8388608,2147483648:514,2415919104:8389120,2684354560:33280,2952790016:8421376,3221225472:32770,3489660928:8388610,3758096384:0,4026531840:33282,134217728:0,402653184:8421890,671088640:33282,939524096:32768,1207959552:8421888,1476395008:512,1744830464:8421378,2013265920:2,2281701376:8389120,2550136832:33280,2818572288:8421376,3087007744:8389122,3355443200:8388610,3623878656:32770,3892314112:514,4160749568:8388608,1:32768,268435457:2,536870913:8421888,805306369:8388608,1073741825:8421378,1342177281:33280,1610612737:512,1879048193:8389122,2147483649:8421890,2415919105:8421376,2684354561:8388610,2952790017:33282,3221225473:514,3489660929:8389120,3758096385:32770,4026531841:0,134217729:8421890,402653185:8421376,671088641:8388608,939524097:512,1207959553:32768,1476395009:8388610,1744830465:2,2013265921:33282,2281701377:32770,2550136833:8389122,2818572289:514,3087007745:8421888,3355443201:8389120,3623878657:0,3892314113:33280,4160749569:8421378},{0:1074282512,16777216:16384,33554432:524288,50331648:1074266128,67108864:1073741840,83886080:1074282496,100663296:1073758208,117440512:16,134217728:540672,150994944:1073758224,167772160:1073741824,184549376:540688,201326592:524304,218103808:0,234881024:16400,251658240:1074266112,8388608:1073758208,25165824:540688,41943040:16,58720256:1073758224,75497472:1074282512,92274688:1073741824,109051904:524288,125829120:1074266128,142606336:524304,159383552:0,176160768:16384,192937984:1074266112,209715200:1073741840,226492416:540672,243269632:1074282496,260046848:16400,268435456:0,285212672:1074266128,301989888:1073758224,318767104:1074282496,335544320:1074266112,352321536:16,369098752:540688,385875968:16384,402653184:16400,419430400:524288,436207616:524304,452984832:1073741840,469762048:540672,486539264:1073758208,503316480:1073741824,520093696:1074282512,276824064:540688,293601280:524288,310378496:1074266112,327155712:16384,343932928:1073758208,360710144:1074282512,377487360:16,394264576:1073741824,411041792:1074282496,427819008:1073741840,444596224:1073758224,461373440:524304,478150656:0,494927872:16400,511705088:1074266128,528482304:540672},{0:260,1048576:0,2097152:67109120,3145728:65796,4194304:65540,5242880:67108868,6291456:67174660,7340032:67174400,8388608:67108864,9437184:67174656,10485760:65792,11534336:67174404,12582912:67109124,13631488:65536,14680064:4,15728640:256,524288:67174656,1572864:67174404,2621440:0,3670016:67109120,4718592:67108868,5767168:65536,6815744:65540,7864320:260,8912896:4,9961472:256,11010048:67174400,12058624:65796,13107200:65792,14155776:67109124,15204352:67174660,16252928:67108864,16777216:67174656,17825792:65540,18874368:65536,19922944:67109120,20971520:256,22020096:67174660,23068672:67108868,24117248:0,25165824:67109124,26214400:67108864,27262976:4,28311552:65792,29360128:67174400,30408704:260,31457280:65796,32505856:67174404,17301504:67108864,18350080:260,19398656:67174656,20447232:0,21495808:65540,22544384:67109120,23592960:256,24641536:67174404,25690112:65536,26738688:67174660,27787264:65796,28835840:67108868,29884416:67109124,30932992:67174400,31981568:4,33030144:65792},{0:2151682048,65536:2147487808,131072:4198464,196608:2151677952,262144:0,327680:4198400,393216:2147483712,458752:4194368,524288:2147483648,589824:4194304,655360:64,720896:2147487744,786432:2151678016,851968:4160,917504:4096,983040:2151682112,32768:2147487808,98304:64,163840:2151678016,229376:2147487744,294912:4198400,360448:2151682112,425984:0,491520:2151677952,557056:4096,622592:2151682048,688128:4194304,753664:4160,819200:2147483648,884736:4194368,950272:4198464,1015808:2147483712,1048576:4194368,1114112:4198400,1179648:2147483712,1245184:0,1310720:4160,1376256:2151678016,1441792:2151682048,1507328:2147487808,1572864:2151682112,1638400:2147483648,1703936:2151677952,1769472:4198464,1835008:2147487744,1900544:4194304,1966080:64,2031616:4096,1081344:2151677952,1146880:2151682112,1212416:0,1277952:4198400,1343488:4194368,1409024:2147483648,1474560:2147487808,1540096:64,1605632:2147483712,1671168:4096,1736704:2147487744,1802240:2151678016,1867776:4160,1933312:2151682048,1998848:4194304,2064384:4198464},{0:128,4096:17039360,8192:262144,12288:536870912,16384:537133184,20480:16777344,24576:553648256,28672:262272,32768:16777216,36864:537133056,40960:536871040,45056:553910400,49152:553910272,53248:0,57344:17039488,61440:553648128,2048:17039488,6144:553648256,10240:128,14336:17039360,18432:262144,22528:537133184,26624:553910272,30720:536870912,34816:537133056,38912:0,43008:553910400,47104:16777344,51200:536871040,55296:553648128,59392:16777216,63488:262272,65536:262144,69632:128,73728:536870912,77824:553648256,81920:16777344,86016:553910272,90112:537133184,94208:16777216,98304:553910400,102400:553648128,106496:17039360,110592:537133056,114688:262272,118784:536871040,122880:0,126976:17039488,67584:553648256,71680:16777216,75776:17039360,79872:537133184,83968:536870912,88064:17039488,92160:128,96256:553910272,100352:262272,104448:553910400,108544:0,112640:553648128,116736:16777344,120832:262144,124928:537133056,129024:536871040},{0:268435464,256:8192,512:270532608,768:270540808,1024:268443648,1280:2097152,1536:2097160,1792:268435456,2048:0,2304:268443656,2560:2105344,2816:8,3072:270532616,3328:2105352,3584:8200,3840:270540800,128:270532608,384:270540808,640:8,896:2097152,1152:2105352,1408:268435464,1664:268443648,1920:8200,2176:2097160,2432:8192,2688:268443656,2944:270532616,3200:0,3456:270540800,3712:2105344,3968:268435456,4096:268443648,4352:270532616,4608:270540808,4864:8200,5120:2097152,5376:268435456,5632:268435464,5888:2105344,6144:2105352,6400:0,6656:8,6912:270532608,7168:8192,7424:268443656,7680:270540800,7936:2097160,4224:8,4480:2105344,4736:2097152,4992:268435464,5248:268443648,5504:8200,5760:270540808,6016:270532608,6272:270540800,6528:270532616,6784:8192,7040:2105352,7296:2097160,7552:0,7808:268435456,8064:268443656},{0:1048576,16:33555457,32:1024,48:1049601,64:34604033,80:0,96:1,112:34603009,128:33555456,144:1048577,160:33554433,176:34604032,192:34603008,208:1025,224:1049600,240:33554432,8:34603009,24:0,40:33555457,56:34604032,72:1048576,88:33554433,104:33554432,120:1025,136:1049601,152:33555456,168:34603008,184:1048577,200:1024,216:34604033,232:1,248:1049600,256:33554432,272:1048576,288:33555457,304:34603009,320:1048577,336:33555456,352:34604032,368:1049601,384:1025,400:34604033,416:1049600,432:1,448:0,464:34603008,480:33554433,496:1024,264:1049600,280:33555457,296:34603009,312:1,328:33554432,344:1048576,360:1025,376:34604032,392:33554433,408:34603008,424:0,440:34604033,456:1049601,472:1024,488:33555456,504:1048577},{0:134219808,1:131072,2:134217728,3:32,4:131104,5:134350880,6:134350848,7:2048,8:134348800,9:134219776,10:133120,11:134348832,12:2080,13:0,14:134217760,15:133152,2147483648:2048,2147483649:134350880,2147483650:134219808,2147483651:134217728,2147483652:134348800,2147483653:133120,2147483654:133152,2147483655:32,2147483656:134217760,2147483657:2080,2147483658:131104,2147483659:134350848,2147483660:0,2147483661:134348832,2147483662:134219776,2147483663:131072,16:133152,17:134350848,18:32,19:2048,20:134219776,21:134217760,22:134348832,23:131072,24:0,25:131104,26:134348800,27:134219808,28:134350880,29:133120,30:2080,31:134217728,2147483664:131072,2147483665:2048,2147483666:134348832,2147483667:133152,2147483668:32,2147483669:134348800,2147483670:134217728,2147483671:134219808,2147483672:134350880,2147483673:134217760,2147483674:134219776,2147483675:0,2147483676:133120,2147483677:2080,2147483678:131104,2147483679:134350848}],f=[4160749569,528482304,33030144,2064384,129024,8064,504,2147483679],l=o.DES=i.extend({_doReset:function(){for(var t=this._key.words,r=[],e=0;e<56;e++){var n=c[e]-1;r[e]=t[n>>>5]>>>31-n%32&1}for(var i=this._subKeys=[],o=0;o<16;o++){var s=i[o]=[],f=a[o];for(e=0;e<24;e++)s[e/6|0]|=r[(u[e]-1+f)%28]<<31-e%6,s[4+(e/6|0)]|=r[28+(u[e+24]-1+f)%28]<<31-e%6;for(s[0]=s[0]<<1|s[0]>>>31,e=1;e<7;e++)s[e]=s[e]>>>4*(e-1)+3;s[7]=s[7]<<5|s[7]>>>27}var l=this._invSubKeys=[];for(e=0;e<16;e++)l[e]=i[15-e]},encryptBlock:function(t,r){this._doCryptBlock(t,r,this._subKeys)},decryptBlock:function(t,r){this._doCryptBlock(t,r,this._invSubKeys)},_doCryptBlock:function(t,r,e){this._lBlock=t[r],this._rBlock=t[r+1],p.call(this,4,252645135),p.call(this,16,65535),v.call(this,2,858993459),v.call(this,8,16711935),p.call(this,1,1431655765);for(var n=0;n<16;n++){for(var i=e[n],o=this._lBlock,c=this._rBlock,u=0,a=0;a<8;a++)u|=s[a][((c^i[a])&f[a])>>>0];this._lBlock=c,this._rBlock=o^u}var l=this._lBlock;this._lBlock=this._rBlock,this._rBlock=l,p.call(this,1,1431655765),v.call(this,8,16711935),v.call(this,2,858993459),p.call(this,16,65535),p.call(this,4,252645135),t[r]=this._lBlock,t[r+1]=this._rBlock},keySize:2,ivSize:2,blockSize:2});function p(t,r){var e=(this._lBlock>>>t^this._rBlock)&r;this._rBlock^=e,this._lBlock^=e<<t}function v(t,r){var e=(this._rBlock>>>t^this._lBlock)&r;this._lBlock^=e,this._rBlock^=e<<t}t.DES=i._createHelper(l);var h=o.TripleDES=i.extend({_doReset:function(){var t=this._key.words;this._des1=l.createEncryptor(e.create(t.slice(0,2))),this._des2=l.createEncryptor(e.create(t.slice(2,4))),this._des3=l.createEncryptor(e.create(t.slice(4,6)))},encryptBlock:function(t,r){this._des1.encryptBlock(t,r),this._des2.decryptBlock(t,r),this._des3.encryptBlock(t,r)},decryptBlock:function(t,r){this._des3.decryptBlock(t,r),this._des2.encryptBlock(t,r),this._des1.decryptBlock(t,r)},keySize:6,ivSize:2,blockSize:2});t.TripleDES=i._createHelper(h)}(),n.TripleDES)},3240:function(t,r,e){var n;t.exports=(n=e(9021),function(t){var r=n,e=r.lib,i=e.Base,o=e.WordArray,c=r.x64={};c.Word=i.extend({init:function(t,r){this.high=t,this.low=r}}),c.WordArray=i.extend({init:function(r,e){r=this.words=r||[],this.sigBytes=e!=t?e:8*r.length},toX32:function(){for(var t=this.words,r=t.length,e=[],n=0;n<r;n++){var i=t[n];e.push(i.high),e.push(i.low)}return o.create(e,this.sigBytes)},clone:function(){for(var t=i.clone.call(this),r=t.words=this.words.slice(0),e=r.length,n=0;n<e;n++)r[n]=r[n].clone();return t}})}(),n)},5980:function(t,r,e){t.exports=e(4152)},2612:function(t,r,e){t.exports=e(6200)},2018:function(t,r,e){t.exports=e(94)},5189:function(t,r,e){t.exports=e(41)},8866:function(t,r,e){t.exports=e(1790)},8172:function(t,r,e){t.exports=e(5976)},2068:function(t,r,e){t.exports=e(6568)},8148:function(t,r,e){t.exports=e(6624)},9972:function(t,r,e){t.exports=e(176)},9562:function(t,r,e){t.exports=e(1590)},3006:function(t,r,e){t.exports=e(6226)},5294:function(t,r,e){t.exports=e(9722)},5383:function(t,r,e){t.exports=e(2803)},3282:function(t,r,e){t.exports=e(6870)},8713:function(t,r,e){t.exports=e(7493)},2084:function(t,r,e){t.exports=e(7072)},7597:function(t,r,e){t.exports=e(7762)},4454:function(t,r,e){t.exports=e(2514)},9624:function(t,r,e){t.exports=e(5955)},6906:function(t,r,e){t.exports=e(4413)},709:function(t,r,e){t.exports=e(1689)},3683:function(t){t.exports=function(t,r){this.v=t,this.k=r},t.exports.__esModule=!0,t.exports.default=t.exports},434:function(t){t.exports=function(t,r){(null==r||r>t.length)&&(r=t.length);for(var e=0,n=Array(r);e<r;e++)n[e]=t[e];return n},t.exports.__esModule=!0,t.exports.default=t.exports},234:function(t,r,e){var n=e(6328);t.exports=function(t){if(n(t))return t},t.exports.__esModule=!0,t.exports.default=t.exports},6214:function(t,r,e){var n=e(6328),i=e(434);t.exports=function(t){if(n(t))return i(t)},t.exports.__esModule=!0,t.exports.default=t.exports},4260:function(t,r,e){var n=e(6010);function i(t,r,e,i,o,c,u){try{var a=t[c](u),s=a.value}catch(t){return void e(t)}a.done?r(s):n.resolve(s).then(i,o)}t.exports=function(t){return function(){var r=this,e=arguments;return new n(function(n,o){var c=t.apply(r,e);function u(t){i(c,n,o,u,a,"next",t)}function a(t){i(c,n,o,u,a,"throw",t)}u(void 0)})}},t.exports.__esModule=!0,t.exports.default=t.exports},6092:function(t,r,e){var n=e(1177),i=e(4963);t.exports=function(t,r,e){return(r=i(r))in t?n(t,r,{value:e,enumerable:!0,configurable:!0,writable:!0}):t[r]=e,t},t.exports.__esModule=!0,t.exports.default=t.exports},1364:function(t,r,e){var n=e(9461),i=e(1689),o=e(4803);t.exports=function(t){if(void 0!==n&&null!=i(t)||null!=t["@@iterator"])return o(t)},t.exports.__esModule=!0,t.exports.default=t.exports},7637:function(t,r,e){var n=e(9461),i=e(1689),o=e(4228);t.exports=function(t,r){var e=null==t?null:void 0!==n&&i(t)||t["@@iterator"];if(null!=e){var c,u,a,s,f=[],l=!0,p=!1;try{if(a=(e=e.call(t)).next,0===r){if(Object(e)!==e)return;l=!1}else for(;!(l=(c=a.call(e)).done)&&(o(f).call(f,c.value),f.length!==r);l=!0);}catch(t){p=!0,u=t}finally{try{if(!l&&null!=e.return&&(s=e.return(),Object(s)!==s))return}finally{if(p)throw u}}return f}},t.exports.__esModule=!0,t.exports.default=t.exports},9211:function(t){t.exports=function(){throw new TypeError("Invalid attempt to destructure non-iterable instance.\\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.")},t.exports.__esModule=!0,t.exports.default=t.exports},7070:function(t){t.exports=function(){throw new TypeError("Invalid attempt to spread non-iterable instance.\\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.")},t.exports.__esModule=!0,t.exports.default=t.exports},4918:function(t,r,e){var n=e(9461),i=e(5456),o=e(4635),c=e(843),u=e(7103),a=e(6141);function s(){var r,e,f="function"==typeof n?n:{},l=f.iterator||"@@iterator",p=f.toStringTag||"@@toStringTag";function v(t,n,c,u){var s=n&&n.prototype instanceof d?n:d,f=i(s.prototype);return a(f,"_invoke",function(t,n,i){var c,u,a,s=0,f=i||[],l=!1,p={p:0,n:0,v:r,a:v,f:o(v).call(v,r,4),d:function(t,e){return c=t,u=0,a=r,p.n=e,h}};function v(t,n){for(u=t,a=n,e=0;!l&&s&&!i&&e<f.length;e++){var i,o=f[e],c=p.p,v=o[2];t>3?(i=v===n)&&(a=o[(u=o[4])?5:(u=3,3)],o[4]=o[5]=r):o[0]<=c&&((i=t<2&&c<o[1])?(u=0,p.v=n,p.n=o[1]):c<v&&(i=t<3||o[0]>n||n>v)&&(o[4]=t,o[5]=n,p.n=v,u=0))}if(i||t>1)return h;throw l=!0,n}return function(i,o,f){if(s>1)throw TypeError("Generator is already running");for(l&&1===o&&v(o,f),u=o,a=f;(e=u<2?r:a)||!l;){c||(u?u<3?(u>1&&(p.n=-1),v(u,a)):p.n=a:p.v=a);try{if(s=2,c){if(u||(i="next"),e=c[i]){if(!(e=e.call(c,a)))throw TypeError("iterator result is not an object");if(!e.done)return e;a=e.value,u<2&&(u=0)}else 1===u&&(e=c.return)&&e.call(c),u<2&&(a=TypeError("The iterator does not provide a '"+i+"' method"),u=1);c=r}else if((e=(l=p.n<0)?a:t.call(n,p))!==h)break}catch(t){c=r,u=1,a=t}finally{s=1}}return{value:e,done:l}}}(t,c,u),!0),f}var h={};function d(){}function y(){}function g(){}e=c;var m=[][l]?e(e([][l]())):(a(e={},l,function(){return this}),e),x=g.prototype=d.prototype=i(m);function w(t){return u?u(t,g):(t.__proto__=g,a(t,p,"GeneratorFunction")),t.prototype=i(x),t}return y.prototype=g,a(x,"constructor",g),a(g,"constructor",y),y.displayName="GeneratorFunction",a(g,p,"GeneratorFunction"),a(x),a(x,p,"Generator"),a(x,l,function(){return this}),a(x,"toString",function(){return"[object Generator]"}),(t.exports=s=function(){return{w:v,m:w}},t.exports.__esModule=!0,t.exports.default=t.exports)()}t.exports=s,t.exports.__esModule=!0,t.exports.default=t.exports},780:function(t,r,e){var n=e(7328);t.exports=function(t,r,e,i,o){var c=n(t,r,e,i,o);return c.next().then(function(t){return t.done?t.value:c.next()})},t.exports.__esModule=!0,t.exports.default=t.exports},7328:function(t,r,e){var n=e(6010),i=e(4918),o=e(6182);t.exports=function(t,r,e,c,u){return new o(i().w(t,r,e,c),u||n)},t.exports.__esModule=!0,t.exports.default=t.exports},6182:function(t,r,e){var n=e(9461),i=e(7844),o=e(3683),c=e(6141);t.exports=function t(r,e){function u(t,n,i,c){try{var a=r[t](n),s=a.value;return s instanceof o?e.resolve(s.v).then(function(t){u("next",t,i,c)},function(t){u("throw",t,i,c)}):e.resolve(s).then(function(t){a.value=t,i(a)},function(t){return u("throw",t,i,c)})}catch(t){c(t)}}var a;this.next||(c(t.prototype),c(t.prototype,"function"==typeof n&&i||"@asyncIterator",function(){return this})),c(this,"_invoke",function(t,r,n){function i(){return new e(function(r,e){u(t,n,r,e)})}return a=a?a.then(i,i):i()},!0)},t.exports.__esModule=!0,t.exports.default=t.exports},6141:function(t,r,e){var n=e(1177);function i(r,e,o,c){var u=n;try{u({},"",{})}catch(r){u=0}t.exports=i=function(t,r,e,n){function o(r,e){i(t,r,function(t){return this._invoke(r,e,t)})}r?u?u(t,r,{value:e,enumerable:!n,configurable:!n,writable:!n}):t[r]=e:(o("next",0),o("throw",1),o("return",2))},t.exports.__esModule=!0,t.exports.default=t.exports,i(r,e,o,c)}t.exports=i,t.exports.__esModule=!0,t.exports.default=t.exports},9782:function(t,r,e){var n=e(1151);t.exports=function(t){var r=Object(t),e=[];for(var i in r)n(e).call(e,i);return function t(){for(;e.length;)if((i=e.pop())in r)return t.value=i,t.done=!1,t;return t.done=!0,t}},t.exports.__esModule=!0,t.exports.default=t.exports},2832:function(t,r,e){var n=e(843),i=e(3604),o=e(3683),c=e(4918),u=e(780),a=e(7328),s=e(6182),f=e(9782),l=e(6592);function p(){"use strict";var r=c(),e=r.m(p),v=(n?n(e):e.__proto__).constructor;function h(t){var r="function"==typeof t&&t.constructor;return!!r&&(r===v||"GeneratorFunction"===(r.displayName||r.name))}var d={throw:1,return:2,break:3,continue:3};function y(t){var r,e;return function(n){r||(r={stop:function(){return e(n.a,2)},catch:function(){return n.v},abrupt:function(t,r){return e(n.a,d[t],r)},delegateYield:function(t,i,o){return r.resultName=i,e(n.d,l(t),o)},finish:function(t){return e(n.f,t)}},e=function(t,e,i){n.p=r.prev,n.n=r.next;try{return t(e,i)}finally{r.next=n.n}}),r.resultName&&(r[r.resultName]=n.v,r.resultName=void 0),r.sent=n.v,r.next=n.n;try{return t.call(this,r)}finally{n.p=r.prev,n.n=r.next}}}return(t.exports=p=function(){return{wrap:function(t,e,n,o){return r.w(y(t),e,n,o&&i(o).call(o))},isGeneratorFunction:h,mark:r.m,awrap:function(t,r){return new o(t,r)},AsyncIterator:s,async:function(t,r,e,n,i){return(h(r)?a:u)(y(t),r,e,n,i)},keys:f,values:l}},t.exports.__esModule=!0,t.exports.default=t.exports)()}t.exports=p,t.exports.__esModule=!0,t.exports.default=t.exports},6592:function(t,r,e){var n=e(8951).default,i=e(9461),o=e(3355);t.exports=function(t){if(null!=t){var r=t["function"==typeof i&&o||"@@iterator"],e=0;if(r)return r.call(t);if("function"==typeof t.next)return t;if(!isNaN(t.length))return{next:function(){return t&&e>=t.length&&(t=void 0),{value:t&&t[e++],done:!t}}}}throw new TypeError(n(t)+" is not iterable")},t.exports.__esModule=!0,t.exports.default=t.exports},2280:function(t,r,e){var n=e(234),i=e(7637),o=e(6987),c=e(9211);t.exports=function(t,r){return n(t)||i(t,r)||o(t,r)||c()},t.exports.__esModule=!0,t.exports.default=t.exports},4443:function(t,r,e){var n=e(6214),i=e(1364),o=e(6987),c=e(7070);t.exports=function(t){return n(t)||i(t)||o(t)||c()},t.exports.__esModule=!0,t.exports.default=t.exports},4958:function(t,r,e){var n=e(1612),i=e(8951).default;t.exports=function(t,r){if("object"!=i(t)||!t)return t;var e=t[n];if(void 0!==e){var o=e.call(t,r||"default");if("object"!=i(o))return o;throw new TypeError("@@toPrimitive must return a primitive value.")}return("string"===r?String:Number)(t)},t.exports.__esModule=!0,t.exports.default=t.exports},4963:function(t,r,e){var n=e(8951).default,i=e(4958);t.exports=function(t){var r=i(t,"string");return"symbol"==n(r)?r:r+""},t.exports.__esModule=!0,t.exports.default=t.exports},8951:function(t,r,e){var n=e(9461),i=e(3355);function o(r){return t.exports=o="function"==typeof n&&"symbol"==typeof i?function(t){return typeof t}:function(t){return t&&"function"==typeof n&&t.constructor===n&&t!==n.prototype?"symbol":typeof t},t.exports.__esModule=!0,t.exports.default=t.exports,o(r)}t.exports=o,t.exports.__esModule=!0,t.exports.default=t.exports},6987:function(t,r,e){var n=e(6144),i=e(4803),o=e(434);t.exports=function(t,r){if(t){var e;if("string"==typeof t)return o(t,r);var c=n(e={}.toString.call(t)).call(e,8,-1);return"Object"===c&&t.constructor&&(c=t.constructor.name),"Map"===c||"Set"===c?i(t):"Arguments"===c||/^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(c)?o(t,r):void 0}},t.exports.__esModule=!0,t.exports.default=t.exports},8191:function(t,r,e){var n=e(2832)();t.exports=n;try{regeneratorRuntime=n}catch(t){"object"==typeof globalThis?globalThis.regeneratorRuntime=n:Function("r","regeneratorRuntime = r")(n)}},7419:function(t,r,e){"use strict";var n=e(4152);t.exports=n},1615:function(t,r,e){"use strict";var n=e(5904);t.exports=n},9300:function(t,r,e){"use strict";var n=e(3505);t.exports=n},2126:function(t,r,e){"use strict";var n=e(2483);t.exports=n},9657:function(t,r,e){"use strict";var n=e(8652);t.exports=n},8823:function(t,r,e){"use strict";var n=e(8748);t.exports=n},6315:function(t,r,e){"use strict";var n=e(6568);t.exports=n},996:function(t,r,e){"use strict";var n=e(871);t.exports=n},8441:function(t,r,e){"use strict";var n=e(1960);t.exports=n},1218:function(t,r,e){"use strict";var n=e(7185);t.exports=n},7210:function(t,r,e){"use strict";var n=e(8899);t.exports=n},9822:function(t,r,e){"use strict";var n=e(7767);t.exports=n},3287:function(t,r,e){"use strict";var n=e(7762);e(9439),e(7014),t.exports=n},4033:function(t,r,e){"use strict";var n=e(3004);t.exports=n},1406:function(t,r,e){"use strict";var n=e(4413);e(177),e(863),e(5078),e(2306),t.exports=n},4158:function(t,r,e){"use strict";var n=e(5811);t.exports=n},6065:function(t,r,e){"use strict";var n=e(1460);t.exports=n},337:function(t,r,e){"use strict";e(6971),e(5899);var n=e(7464);t.exports=n.Array.from},9373:function(t,r,e){"use strict";e(3247);var n=e(7464);t.exports=n.Array.isArray},1949:function(t,r,e){"use strict";e(2707);var n=e(8677);t.exports=n("Array","concat")},9267:function(t,r,e){"use strict";e(7313);var n=e(8677);t.exports=n("Array","filter")},8368:function(t,r,e){"use strict";e(1554);var n=e(8677);t.exports=n("Array","includes")},5995:function(t,r,e){"use strict";e(3789);var n=e(8677);t.exports=n("Array","indexOf")},2563:function(t,r,e){"use strict";e(781);var n=e(8677);t.exports=n("Array","map")},7421:function(t,r,e){"use strict";e(2583);var n=e(8677);t.exports=n("Array","push")},8571:function(t,r,e){"use strict";e(4125);var n=e(8677);t.exports=n("Array","reverse")},4559:function(t,r,e){"use strict";e(1121);var n=e(8677);t.exports=n("Array","slice")},1493:function(t,r,e){"use strict";e(1679);var n=e(8677);t.exports=n("Array","sort")},1141:function(t,r,e){"use strict";e(1035);var n=e(8677);t.exports=n("Array","splice")},456:function(t,r,e){"use strict";e(2662);var n=e(8677);t.exports=n("Array","unshift")},3121:function(t,r,e){"use strict";e(9965);var n=e(8677);t.exports=n("Function","bind")},6306:function(t,r,e){"use strict";e(7529),e(6971);var n=e(9277);t.exports=n},8980:function(t,r,e){"use strict";var n=e(2874),i=e(3121),o=Function.prototype;t.exports=function(t){var r=t.bind;return t===o||n(o,t)&&r===o.bind?i:r}},2015:function(t,r,e){"use strict";var n=e(2874),i=e(1949),o=Array.prototype;t.exports=function(t){var r=t.concat;return t===o||n(o,t)&&r===o.concat?i:r}},3413:function(t,r,e){"use strict";var n=e(2874),i=e(9267),o=Array.prototype;t.exports=function(t){var r=t.filter;return t===o||n(o,t)&&r===o.filter?i:r}},686:function(t,r,e){"use strict";var n=e(2874),i=e(8368),o=e(1268),c=Array.prototype,u=String.prototype;t.exports=function(t){var r=t.includes;return t===c||n(c,t)&&r===c.includes?i:"string"==typeof t||t===u||n(u,t)&&r===u.includes?o:r}},9233:function(t,r,e){"use strict";var n=e(2874),i=e(5995),o=Array.prototype;t.exports=function(t){var r=t.indexOf;return t===o||n(o,t)&&r===o.indexOf?i:r}},1153:function(t,r,e){"use strict";var n=e(2874),i=e(2563),o=Array.prototype;t.exports=function(t){var r=t.map;return t===o||n(o,t)&&r===o.map?i:r}},2115:function(t,r,e){"use strict";var n=e(2874),i=e(7421),o=Array.prototype;t.exports=function(t){var r=t.push;return t===o||n(o,t)&&r===o.push?i:r}},7593:function(t,r,e){"use strict";var n=e(2874),i=e(8571),o=Array.prototype;t.exports=function(t){var r=t.reverse;return t===o||n(o,t)&&r===o.reverse?i:r}},4493:function(t,r,e){"use strict";var n=e(2874),i=e(4559),o=Array.prototype;t.exports=function(t){var r=t.slice;return t===o||n(o,t)&&r===o.slice?i:r}},3507:function(t,r,e){"use strict";var n=e(2874),i=e(1493),o=Array.prototype;t.exports=function(t){var r=t.sort;return t===o||n(o,t)&&r===o.sort?i:r}},3887:function(t,r,e){"use strict";var n=e(2874),i=e(1141),o=Array.prototype;t.exports=function(t){var r=t.splice;return t===o||n(o,t)&&r===o.splice?i:r}},2119:function(t,r,e){"use strict";var n=e(2874),i=e(6485),o=String.prototype;t.exports=function(t){var r=t.startsWith;return"string"==typeof t||t===o||n(o,t)&&r===o.startsWith?i:r}},6706:function(t,r,e){"use strict";var n=e(2874),i=e(456),o=Array.prototype;t.exports=function(t){var r=t.unshift;return t===o||n(o,t)&&r===o.unshift?i:r}},8967:function(t,r,e){"use strict";e(3014),e(1247);var n=e(7464),i=e(5262);n.JSON||(n.JSON={stringify:JSON.stringify}),t.exports=function(t,r,e){return i(n.JSON.stringify,null,arguments)}},1676:function(t,r,e){"use strict";e(6059);var n=e(7464).Object;t.exports=function(t,r){return n.create(t,r)}},5752:function(t,r,e){"use strict";e(6604);var n=e(7464).Object,i=t.exports=function(t,r,e){return n.defineProperty(t,r,e)};n.defineProperty.sham&&(i.sham=!0)},9651:function(t,r,e){"use strict";e(5583);var n=e(7464);t.exports=n.Object.entries},7146:function(t,r,e){"use strict";e(5926);var n=e(7464).Object,i=t.exports=function(t,r){return n.getOwnPropertyDescriptor(t,r)};n.getOwnPropertyDescriptor.sham&&(i.sham=!0)},3417:function(t,r,e){"use strict";e(5037);var n=e(7464);t.exports=n.Object.getOwnPropertyDescriptors},7222:function(t,r,e){"use strict";e(6430);var n=e(7464);t.exports=n.Object.getOwnPropertySymbols},9328:function(t,r,e){"use strict";e(7460);var n=e(7464);t.exports=n.Object.getPrototypeOf},6479:function(t,r,e){"use strict";e(7771);var n=e(7464);t.exports=n.Object.keys},5100:function(t,r,e){"use strict";e(4312);var n=e(7464);t.exports=n.Object.setPrototypeOf},2173:function(t,r,e){"use strict";e(2688),e(7529),e(6542),e(9817),e(1208),e(6669),e(5922),e(897),e(5956),e(6971);var n=e(7464);t.exports=n.Promise},6084:function(t,r,e){"use strict";e(7529),e(6542),e(3276),e(9361),e(4175),e(5330),e(2991),e(4936),e(1631),e(4851),e(6971);var n=e(7464);t.exports=n.Set},1268:function(t,r,e){"use strict";e(7964);var n=e(8677);t.exports=n("String","includes")},6485:function(t,r,e){"use strict";e(9725);var n=e(8677);t.exports=n("String","startsWith")},1219:function(t,r,e){"use strict";e(767);var n=e(4386);t.exports=n.f("asyncIterator")},6368:function(t,r,e){"use strict";e(2707),e(6542),e(6430),e(8344),e(767),e(8958),e(4893),e(1298),e(1979),e(4632),e(5021),e(4099),e(1220),e(1230),e(7134),e(1652),e(9635),e(664),e(4339),e(6066),e(6390),e(3847);var n=e(7464);t.exports=n.Symbol},7532:function(t,r,e){"use strict";e(7529),e(6542),e(6971),e(4632);var n=e(4386);t.exports=n.f("iterator")},9295:function(t,r,e){"use strict";e(155),e(9635);var n=e(4386);t.exports=n.f("toPrimitive")},4803:function(t,r,e){"use strict";t.exports=e(6110)},6328:function(t,r,e){"use strict";t.exports=e(7166)},1689:function(t,r,e){"use strict";t.exports=e(7455)},4635:function(t,r,e){"use strict";t.exports=e(2649)},4228:function(t,r,e){"use strict";t.exports=e(1414)},3604:function(t,r,e){"use strict";t.exports=e(9518)},6144:function(t,r,e){"use strict";t.exports=e(2802)},1151:function(t,r,e){"use strict";t.exports=e(8701)},5456:function(t,r,e){"use strict";t.exports=e(8774)},1177:function(t,r,e){"use strict";t.exports=e(9343)},843:function(t,r,e){"use strict";t.exports=e(3857)},7103:function(t,r,e){"use strict";t.exports=e(9069)},6010:function(t,r,e){"use strict";t.exports=e(16)},7844:function(t,r,e){"use strict";t.exports=e(4822)},9461:function(t,r,e){"use strict";t.exports=e(4575)},3355:function(t,r,e){"use strict";t.exports=e(7033)},1612:function(t,r,e){"use strict";t.exports=e(9490)},6110:function(t,r,e){"use strict";var n=e(7419);t.exports=n},7166:function(t,r,e){"use strict";var n=e(1615);t.exports=n},7455:function(t,r,e){"use strict";var n=e(9300);t.exports=n},2649:function(t,r,e){"use strict";var n=e(2126);t.exports=n},1414:function(t,r,e){"use strict";var n=e(9657);t.exports=n},9518:function(t,r,e){"use strict";var n=e(8823);t.exports=n},2802:function(t,r,e){"use strict";var n=e(6315);t.exports=n},8701:function(t,r,e){"use strict";var n=e(996);t.exports=n},8774:function(t,r,e){"use strict";var n=e(8441);t.exports=n},9343:function(t,r,e){"use strict";var n=e(1218);t.exports=n},3857:function(t,r,e){"use strict";var n=e(7210);t.exports=n},9069:function(t,r,e){"use strict";var n=e(9822);t.exports=n},16:function(t,r,e){"use strict";var n=e(3287);e(1965),e(5453),e(6444),t.exports=n},4822:function(t,r,e){"use strict";var n=e(4033);t.exports=n},4575:function(t,r,e){"use strict";var n=e(1406);e(3129),e(6863),e(9131),e(5030),e(8839),e(3650),e(8409),e(8672),e(8781),e(5049),t.exports=n},7033:function(t,r,e){"use strict";var n=e(4158);t.exports=n},9490:function(t,r,e){"use strict";var n=e(6065);t.exports=n},6713:function(t,r,e){"use strict";var n=e(7764),i=e(4750),o=TypeError;t.exports=function(t){if(n(t))return t;throw new o(i(t)+" is not a function")}},6121:function(t,r,e){"use strict";var n=e(4074),i=e(4750),o=TypeError;t.exports=function(t){if(n(t))return t;throw new o(i(t)+" is not a constructor")}},7217:function(t,r,e){"use strict";var n=e(3744),i=String,o=TypeError;t.exports=function(t){if(n(t))return t;throw new o("Can't set "+i(t)+" as a prototype")}},3489:function(t,r,e){"use strict";var n=e(4750),i=TypeError;t.exports=function(t){if("object"==typeof t&&"size"in t&&"has"in t&&"add"in t&&"delete"in t&&"keys"in t)return t;throw new i(n(t)+" is not a set")}},5642:function(t){"use strict";t.exports=function(){}},8374:function(t,r,e){"use strict";var n=e(2874),i=TypeError;t.exports=function(t,r){if(n(r,t))return t;throw new i("Incorrect invocation")}},386:function(t,r,e){"use strict";var n=e(7879),i=String,o=TypeError;t.exports=function(t){if(n(t))return t;throw new o(i(t)+" is not an object")}},1333:function(t,r,e){"use strict";var n=e(4234);t.exports=n(function(){if("function"==typeof ArrayBuffer){var t=new ArrayBuffer(8);Object.isExtensible(t)&&Object.defineProperty(t,"a",{value:8})}})},3363:function(t,r,e){"use strict";var n=e(7525),i=e(5408),o=e(1108),c=e(5572),u=e(1658),a=e(4074),s=e(1797),f=e(457),l=e(680),p=e(8790),v=e(9277),h=e(7100),d=Array;t.exports=function(t){var r=a(this),e=arguments.length,y=e>1?arguments[1]:void 0,g=void 0!==y;g&&(y=n(y,e>2?arguments[2]:void 0));var m,x,w,b,S,C,A=o(t),_=v(A),E=0;if(!_||this===d&&u(_))for(m=s(A),x=r?new this(m):d(m);m>E;E++)C=g?y(A[E],E):A[E],f(x,E,C);else for(x=r?new this:[],S=(b=p(A,_)).next;!(w=i(S,b)).done;E++){C=g?c(b,y,[w.value,E],!0):w.value;try{f(x,E,C)}catch(t){h(b,"throw",t)}}return l(x,E),x}},9962:function(t,r,e){"use strict";var n=e(6420),i=e(2235),o=e(1797),c=function(t){return function(r,e,c){var u=n(r),a=o(u);if(0===a)return!t&&-1;var s,f=i(c,a);if(t&&e!=e){for(;a>f;)if((s=u[f++])!=s)return!0}else for(;a>f;f++)if((t||f in u)&&u[f]===e)return t||f||0;return!t&&-1}};t.exports={includes:c(!0),indexOf:c(!1)}},6672:function(t,r,e){"use strict";var n=e(7525),i=e(24),o=e(1108),c=e(1797),u=e(9862),a=e(457),s=function(t){var r=1===t,e=2===t,s=3===t,f=4===t,l=6===t,p=7===t,v=5===t||l;return function(h,d,y){for(var g,m,x=o(h),w=i(x),b=c(w),S=n(d,y),C=0,A=0,_=r?u(h,b):e||p?u(h,0):void 0;b>C;C++)if((v||C in w)&&(m=S(g=w[C],C,x),t))if(r)a(_,C,m);else if(m)switch(t){case 3:return!0;case 5:return g;case 6:return C;case 2:a(_,A++,g)}else switch(t){case 4:return!1;case 7:a(_,A++,g)}return l?-1:s||f?f:_}};t.exports={forEach:s(0),map:s(1),filter:s(2),some:s(3),every:s(4),find:s(5),findIndex:s(6),filterReject:s(7)}},3906:function(t,r,e){"use strict";var n=e(4234),i=e(882),o=e(8024),c=i("species");t.exports=function(t){return o>=51||!n(function(){var r=[];return(r.constructor={})[c]=function(){return{foo:1}},1!==r[t](Boolean).foo})}},1709:function(t,r,e){"use strict";var n=e(4234);t.exports=function(t,r){var e=[][t];return!!e&&n(function(){e.call(null,r||function(){return 1},1)})}},680:function(t,r,e){"use strict";var n=e(6965),i=e(7543),o=TypeError,c=Object.getOwnPropertyDescriptor,u=n&&!function(){if(void 0!==this)return!0;try{Object.defineProperty([],"length",{writable:!1}).length=1}catch(t){return t instanceof TypeError}}();t.exports=u?function(t,r){if(i(t)&&!c(t,"length").writable)throw new o("Cannot set read only .length");return t.length=r}:function(t,r){return t.length=r}},8425:function(t,r,e){"use strict";var n=e(9321);t.exports=n([].slice)},7527:function(t,r,e){"use strict";var n=e(8425),i=Math.floor,o=function(t,r){var e=t.length;if(e<8)for(var c,u,a=1;a<e;){for(u=a,c=t[a];u&&r(t[u-1],c)>0;)t[u]=t[--u];u!==a++&&(t[u]=c)}else for(var s=i(e/2),f=o(n(t,0,s),r),l=o(n(t,s),r),p=f.length,v=l.length,h=0,d=0;h<p||d<v;)t[h+d]=h<p&&d<v?r(f[h],l[d])<=0?f[h++]:l[d++]:h<p?f[h++]:l[d++];return t};t.exports=o},8420:function(t,r,e){"use strict";var n=e(7543),i=e(4074),o=e(7879),c=e(882)("species"),u=Array;t.exports=function(t){var r;return n(t)&&(r=t.constructor,(i(r)&&(r===u||n(r.prototype))||o(r)&&null===(r=r[c]))&&(r=void 0)),void 0===r?u:r}},9862:function(t,r,e){"use strict";var n=e(8420);t.exports=function(t,r){return new(n(t))(0===r?0:r)}},5572:function(t,r,e){"use strict";var n=e(386),i=e(7100);t.exports=function(t,r,e,o){try{return o?r(n(e)[0],e[1]):r(e)}catch(r){i(t,"throw",r)}}},7643:function(t){"use strict";t.exports=function(t,r){return 1===r?function(r,e){return r[t](e)}:function(r,e,n){return r[t](e,n)}}},5099:function(t,r,e){"use strict";var n=e(882)("iterator"),i=!1;try{var o=0,c={next:function(){return{done:!!o++}},return:function(){i=!0}};c[n]=function(){return this},Array.from(c,function(){throw 2})}catch(t){}t.exports=function(t,r){try{if(!r&&!i)return!1}catch(t){return!1}var e=!1;try{var o={};o[n]=function(){return{next:function(){return{done:e=!0}}}},t(o)}catch(t){}return e}},6201:function(t,r,e){"use strict";var n=e(9321),i=n({}.toString),o=n("".slice);t.exports=function(t){return o(i(t),8,-1)}},9958:function(t,r,e){"use strict";var n=e(6537),i=e(7764),o=e(6201),c=e(882)("toStringTag"),u=Object,a="Arguments"===o(function(){return arguments}());t.exports=n?o:function(t){var r,e,n;return void 0===t?"Undefined":null===t?"Null":"string"==typeof(e=function(t,r){try{return t[r]}catch(t){}}(r=u(t),c))?e:a?o(r):"Object"===(n=o(r))&&i(r.callee)?"Arguments":n}},8487:function(t,r,e){"use strict";var n=e(6305),i=e(9933),o=e(4472),c=e(7525),u=e(8374),a=e(3878),s=e(289),f=e(3209),l=e(6808),p=e(7444),v=e(6965),h=e(1006).fastKey,d=e(9430),y=d.set,g=d.getterFor;t.exports={getConstructor:function(t,r,e,f){var l=t(function(t,i){u(t,p),y(t,{type:r,index:n(null),first:null,last:null,size:0}),v||(t.size=0),a(i)||s(i,t[f],{that:t,AS_ENTRIES:e})}),p=l.prototype,d=g(r),m=function(t,r,e){var n,i,o=d(t),c=x(t,r);return c?c.value=e:(o.last=c={index:i=h(r,!0),key:r,value:e,previous:n=o.last,next:null,removed:!1},o.first||(o.first=c),n&&(n.next=c),v?o.size++:t.size++,"F"!==i&&(o.index[i]=c)),t},x=function(t,r){var e,n=d(t),i=h(r);if("F"!==i)return n.index[i];for(e=n.first;e;e=e.next)if(e.key===r)return e};return o(p,{clear:function(){for(var t=d(this),r=t.first;r;)r.removed=!0,r.previous&&(r.previous=r.previous.next=null),r=r.next;t.first=t.last=null,t.index=n(null),v?t.size=0:this.size=0},delete:function(t){var r=this,e=d(r),n=x(r,t);if(n){var i=n.next,o=n.previous;delete e.index[n.index],n.removed=!0,o&&(o.next=i),i&&(i.previous=o),e.first===n&&(e.first=i),e.last===n&&(e.last=o),v?e.size--:r.size--}return!!n},forEach:function(t){for(var r,e=d(this),n=c(t,arguments.length>1?arguments[1]:void 0);r=r?r.next:e.first;)for(n(r.value,r.key,this);r&&r.removed;)r=r.previous},has:function(t){return!!x(this,t)}}),o(p,e?{get:function(t){var r=x(this,t);return r&&r.value},set:function(t,r){return m(this,0===t?0:t,r)}}:{add:function(t){return m(this,t=0===t?0:t,t)}}),v&&i(p,"size",{configurable:!0,get:function(){return d(this).size}}),l},setStrong:function(t,r,e){var n=r+" Iterator",i=g(r),o=g(n);f(t,r,function(t,r){y(this,{type:n,target:t,state:i(t),kind:r,last:null})},function(){for(var t=o(this),r=t.kind,e=t.last;e&&e.removed;)e=e.previous;return t.target&&(t.last=e=e?e.next:t.state.first)?l("keys"===r?e.key:"values"===r?e.value:[e.key,e.value],!1):(t.target=null,l(void 0,!0))},e?"entries":"values",!e,!0),p(r)}}},6999:function(t,r,e){"use strict";var n=e(6565),i=e(8325),o=e(1006),c=e(5408),u=e(4234),a=e(6320),s=e(289),f=e(8374),l=e(7764),p=e(7879),v=e(3878),h=e(6802),d=e(6042).f,y=e(6672).forEach,g=e(6965),m=e(9430),x=m.set,w=m.getterFor;t.exports=function(t,r,e){var m,b=-1!==t.indexOf("Map"),S=-1!==t.indexOf("Weak"),C=b?"set":"add",A=i[t],_=A&&A.prototype,E={};if(g&&l(A)&&(S||_.forEach&&!u(function(){(new A).entries().next()}))){var k=(m=r(function(r,e){x(f(r,k),{type:t,collection:new A}),v(e)||s(e,r[C],{that:r,AS_ENTRIES:b})})).prototype,T=w(t);y(["add","clear","delete","forEach","get","has","set","keys","values","entries"],function(t){var r="add"===t||"set"===t;!(t in _)||S&&"clear"===t||a(k,t,function(e,n){var i=this,o=T(i).collection;if(!r&&S&&!p(e))return"get"===t&&void 0;var u=o[t]("forEach"===t?function(t,r){c(e,n,t,r,i)}:0===e?0:e,n);return r?i:u})}),S||d(k,"size",{configurable:!0,get:function(){return T(this).collection.size}})}else m=e.getConstructor(r,t,b,C),o.enable();return h(m,t,!1,!0),E[t]=m,n({global:!0,forced:!0},E),S||e.setStrong(m,t,b),m}},2585:function(t,r,e){"use strict";var n=e(9338),i=e(6648),o=e(9088),c=e(6042);t.exports=function(t,r,e){for(var u=i(r),a=c.f,s=o.f,f=0;f<u.length;f++){var l=u[f];n(t,l)||e&&n(e,l)||a(t,l,s(r,l))}}},7153:function(t,r,e){"use strict";var n=e(882)("match");t.exports=function(t){var r=/./;try{"/./"[t](r)}catch(e){try{return r[n]=!1,"/./"[t](r)}catch(t){}}return!1}},2528:function(t,r,e){"use strict";var n=e(4234);t.exports=!n(function(){function t(){}return t.prototype.constructor=null,Object.getPrototypeOf(new t)!==t.prototype})},6808:function(t){"use strict";t.exports=function(t,r){return{value:t,done:r}}},6320:function(t,r,e){"use strict";var n=e(6965),i=e(6042),o=e(2315);t.exports=n?function(t,r,e){return i.f(t,r,o(1,e))}:function(t,r,e){return t[r]=e,t}},2315:function(t){"use strict";t.exports=function(t,r){return{enumerable:!(1&t),configurable:!(2&t),writable:!(4&t),value:r}}},457:function(t,r,e){"use strict";var n=e(6965),i=e(6042),o=e(2315);t.exports=function(t,r,e){n?i.f(t,r,o(0,e)):t[r]=e}},3403:function(t,r,e){"use strict";var n=e(9321),i=e(4234),o=e(3390).start,c=RangeError,u=isFinite,a=Math.abs,s=Date.prototype,f=s.toISOString,l=n(s.getTime),p=n(s.getUTCDate),v=n(s.getUTCFullYear),h=n(s.getUTCHours),d=n(s.getUTCMilliseconds),y=n(s.getUTCMinutes),g=n(s.getUTCMonth),m=n(s.getUTCSeconds);t.exports=i(function(){return"0385-07-25T07:06:39.999Z"!==f.call(new Date(-50000000000001))})||!i(function(){f.call(new Date(NaN))})?function(){if(!u(l(this)))throw new c("Invalid time value");var t=this,r=v(t),e=d(t),n=r<0?"-":r>9999?"+":"";return n+o(a(r),n?6:4,0)+"-"+o(g(t)+1,2,0)+"-"+o(p(t),2,0)+"T"+o(h(t),2,0)+":"+o(y(t),2,0)+":"+o(m(t),2,0)+"."+o(e,3,0)+"Z"}:f},9933:function(t,r,e){"use strict";var n=e(6042);t.exports=function(t,r,e){return n.f(t,r,e)}},9757:function(t,r,e){"use strict";var n=e(6320);t.exports=function(t,r,e,i){return i&&i.enumerable?t[r]=e:n(t,r,e),t}},4472:function(t,r,e){"use strict";var n=e(9757);t.exports=function(t,r,e){for(var i in r)e&&e.unsafe&&t[i]?t[i]=r[i]:n(t,i,r[i],e);return t}},6150:function(t,r,e){"use strict";var n=e(8325),i=Object.defineProperty;t.exports=function(t,r){try{i(n,t,{value:r,configurable:!0,writable:!0})}catch(e){n[t]=r}return r}},6353:function(t,r,e){"use strict";var n=e(4750),i=TypeError;t.exports=function(t,r){if(!delete t[r])throw new i("Cannot delete property "+n(r)+" of "+n(t))}},6965:function(t,r,e){"use strict";var n=e(4234);t.exports=!n(function(){return 7!==Object.defineProperty({},1,{get:function(){return 7}})[1]})},7502:function(t,r,e){"use strict";var n=e(8325),i=e(7879),o=n.document,c=i(o)&&i(o.createElement);t.exports=function(t){return c?o.createElement(t):{}}},3722:function(t){"use strict";var r=TypeError;t.exports=function(t){if(t>9007199254740991)throw new r("Maximum allowed index exceeded");return t}},7069:function(t){"use strict";t.exports={CSSRuleList:0,CSSStyleDeclaration:0,CSSValueList:0,ClientRectList:0,DOMRectList:0,DOMStringList:0,DOMTokenList:1,DataTransferItemList:0,FileList:0,HTMLAllCollection:0,HTMLCollection:0,HTMLFormElement:0,HTMLSelectElement:0,MediaList:0,MimeTypeArray:0,NamedNodeMap:0,NodeList:1,PaintRequestList:0,Plugin:0,PluginArray:0,SVGLengthList:0,SVGNumberList:0,SVGPathSegList:0,SVGPointList:0,SVGStringList:0,SVGTransformList:0,SourceBufferList:0,StyleSheetList:0,TextTrackCueList:0,TextTrackList:0,TouchList:0}},8946:function(t){"use strict";t.exports=["constructor","hasOwnProperty","isPrototypeOf","propertyIsEnumerable","toLocaleString","toString","valueOf"]},1878:function(t,r,e){"use strict";var n=e(5796).match(/firefox\\/(\\d+)/i);t.exports=!!n&&+n[1]},7118:function(t,r,e){"use strict";var n=e(5796);t.exports=/MSIE|Trident/.test(n)},8720:function(t,r,e){"use strict";var n=e(5796);t.exports=/ipad|iphone|ipod/i.test(n)&&"undefined"!=typeof Pebble},7491:function(t,r,e){"use strict";var n=e(5796);t.exports=/ipad|iphone|ipod/i.test(n)&&/applewebkit/i.test(n)},5484:function(t,r,e){"use strict";var n=e(478);t.exports="NODE"===n},3777:function(t,r,e){"use strict";var n=e(5796);t.exports=/web0s(?!.*chrome)/i.test(n)},5796:function(t,r,e){"use strict";var n=e(8325).navigator,i=n&&n.userAgent;t.exports=i?String(i):""},8024:function(t,r,e){"use strict";var n,i,o=e(8325),c=e(5796),u=o.process,a=o.Deno,s=u&&u.versions||a&&a.version,f=s&&s.v8;f&&(i=(n=f.split("."))[0]>0&&n[0]<4?1:+(n[0]+n[1])),!i&&c&&(!(n=c.match(/Edge\\/(\\d+)/))||n[1]>=74)&&(n=c.match(/Chrome\\/(\\d+)/))&&(i=+n[1]),t.exports=i},1844:function(t,r,e){"use strict";var n=e(5796).match(/AppleWebKit\\/(\\d+)\\./);t.exports=!!n&&+n[1]},478:function(t,r,e){"use strict";var n=e(8325),i=e(5796),o=e(6201),c=function(t){return i.slice(0,t.length)===t};t.exports=c("Bun/")?"BUN":c("Cloudflare-Workers")?"CLOUDFLARE":c("Deno/")?"DENO":c("Node.js/")?"NODE":n.Bun&&"string"==typeof Bun.version?"BUN":n.Deno&&"object"==typeof Deno.version?"DENO":"process"===o(n.process)?"NODE":n.window&&n.document?"BROWSER":"REST"},212:function(t,r,e){"use strict";var n=e(9321),i=Error,o=n("".replace),c=String(new i("zxcasd").stack),u=/\\n\\s*at [^:]*:[^\\n]*/,a=u.test(c);t.exports=function(t,r){if(a&&"string"==typeof t&&!i.prepareStackTrace)for(;r--;)t=o(t,u,"");return t}},9534:function(t,r,e){"use strict";var n=e(6320),i=e(212),o=e(9006),c=Error.captureStackTrace;t.exports=function(t,r,e,u){o&&(c?c(t,r):n(t,"stack",i(e,u)))}},9006:function(t,r,e){"use strict";var n=e(4234),i=e(2315);t.exports=!n(function(){var t=new Error("a");return!("stack"in t)||(Object.defineProperty(t,"stack",i(1,7)),7!==t.stack)})},6565:function(t,r,e){"use strict";var n=e(8325),i=e(5262),o=e(8707),c=e(7764),u=e(9088).f,a=e(4849),s=e(7464),f=e(7525),l=e(6320),p=e(9338);e(5742);var v=function(t){var r=function(e,n,o){if(this instanceof r){switch(arguments.length){case 0:return new t;case 1:return new t(e);case 2:return new t(e,n)}return new t(e,n,o)}return i(t,this,arguments)};return r.prototype=t.prototype,r};t.exports=function(t,r){var e,i,h,d,y,g,m,x,w,b=t.target,S=t.global,C=t.stat,A=t.proto,_=S?n:C?n[b]:n[b]&&n[b].prototype,E=S?s:s[b]||l(s,b,{})[b],k=E.prototype;for(d in r)i=!(e=a(S?d:b+(C?".":"#")+d,t.forced))&&_&&p(_,d),g=E[d],i&&(m=t.dontCallGetSet?(w=u(_,d))&&w.value:_[d]),y=i&&m?m:r[d],(e||A||typeof g!=typeof y)&&(x=t.bind&&i?f(y,n):t.wrap&&i?v(y):A&&c(y)?o(y):y,(t.sham||y&&y.sham||g&&g.sham)&&l(x,"sham",!0),l(E,d,x),A&&(p(s,h=b+"Prototype")||l(s,h,{}),l(s[h],d,y),t.real&&k&&(e||!k[d])&&l(k,d,y)))}},4234:function(t){"use strict";t.exports=function(t){try{return!!t()}catch(t){return!0}}},855:function(t,r,e){"use strict";var n=e(4234);t.exports=!n(function(){return Object.isExtensible(Object.preventExtensions({}))})},5262:function(t,r,e){"use strict";var n=e(2663),i=Function.prototype,o=i.apply,c=i.call;t.exports="object"==typeof Reflect&&Reflect.apply||(n?c.bind(o):function(){return c.apply(o,arguments)})},7525:function(t,r,e){"use strict";var n=e(8707),i=e(6713),o=e(2663),c=n(n.bind);t.exports=function(t,r){return i(t),void 0===r?t:o?c(t,r):function(){return t.apply(r,arguments)}}},2663:function(t,r,e){"use strict";var n=e(4234);t.exports=!n(function(){var t=function(){}.bind();return"function"!=typeof t||t.hasOwnProperty("prototype")})},59:function(t,r,e){"use strict";var n=e(9321),i=e(6713),o=e(7879),c=e(9338),u=e(8425),a=e(2663),s=Function,f=n([].concat),l=n([].join),p={};t.exports=a?s.bind:function(t){var r=i(this),e=r.prototype,n=u(arguments,1),a=function(){var e=f(n,u(arguments));return this instanceof a?function(t,r,e){if(!c(p,r)){for(var n=[],i=0;i<r;i++)n[i]="a["+i+"]";p[r]=s("C,a","return new C("+l(n,",")+")")}return p[r](t,e)}(r,e.length,e):r.apply(t,e)};return o(e)&&(a.prototype=e),a}},5408:function(t,r,e){"use strict";var n=e(2663),i=Function.prototype.call;t.exports=n?i.bind(i):function(){return i.apply(i,arguments)}},679:function(t,r,e){"use strict";var n=e(6965),i=e(9338),o=Function.prototype,c=n&&Object.getOwnPropertyDescriptor,u=i(o,"name"),a=u&&"something"===function(){}.name,s=u&&(!n||n&&c(o,"name").configurable);t.exports={EXISTS:u,PROPER:a,CONFIGURABLE:s}},6185:function(t,r,e){"use strict";var n=e(9321),i=e(6713);t.exports=function(t,r,e){try{return n(i(Object.getOwnPropertyDescriptor(t,r)[e]))}catch(t){}}},8707:function(t,r,e){"use strict";var n=e(6201),i=e(9321);t.exports=function(t){if("Function"===n(t))return i(t)}},9321:function(t,r,e){"use strict";var n=e(2663),i=Function.prototype,o=i.call,c=n&&i.bind.bind(o,o);t.exports=n?c:function(t){return function(){return o.apply(t,arguments)}}},8677:function(t,r,e){"use strict";var n=e(8325),i=e(7464);t.exports=function(t,r){var e=i[t+"Prototype"],o=e&&e[r];if(o)return o;var c=n[t],u=c&&c.prototype;return u&&u[r]}},3068:function(t,r,e){"use strict";var n=e(7464),i=e(8325),o=e(7764),c=function(t){return o(t)?t:void 0};t.exports=function(t,r){return arguments.length<2?c(n[t])||c(i[t]):n[t]&&n[t][r]||i[t]&&i[t][r]}},9274:function(t){"use strict";t.exports=function(t){return{iterator:t,next:t.next,done:!1}}},9277:function(t,r,e){"use strict";var n=e(9958),i=e(8585),o=e(3878),c=e(7204),u=e(882)("iterator");t.exports=function(t){if(!o(t))return i(t,u)||i(t,"@@iterator")||c[n(t)]}},8790:function(t,r,e){"use strict";var n=e(5408),i=e(6713),o=e(386),c=e(4750),u=e(9277),a=TypeError;t.exports=function(t,r){var e=arguments.length<2?u(t):r;if(i(e))return o(n(e,t));throw new a(c(t)+" is not iterable")}},8585:function(t,r,e){"use strict";var n=e(6713),i=e(3878);t.exports=function(t,r){var e=t[r];return i(e)?void 0:n(e)}},7198:function(t,r,e){"use strict";var n=e(6713),i=e(386),o=e(5408),c=e(5568),u=e(9274),a="Invalid size",s=RangeError,f=TypeError,l=Math.max,p=function(t,r){this.set=t,this.size=l(r,0),this.has=n(t.has),this.keys=n(t.keys)};p.prototype={getIterator:function(){return u(i(o(this.keys,this.set)))},includes:function(t){return o(this.has,this.set,t)}},t.exports=function(t){i(t);var r=+t.size;if(r!=r)throw new f(a);var e=c(r);if(e<0)throw new s(a);return new p(t,e)}},8325:function(t,r,e){"use strict";var n=function(t){return t&&t.Math===Math&&t};t.exports=n("object"==typeof globalThis&&globalThis)||n("object"==typeof window&&window)||n("object"==typeof self&&self)||n("object"==typeof e.g&&e.g)||n("object"==typeof this&&this)||function(){return this}()||Function("return this")()},9338:function(t,r,e){"use strict";var n=e(9321),i=e(1108),o=n({}.hasOwnProperty);t.exports=Object.hasOwn||function(t,r){return o(i(t),r)}},5132:function(t){"use strict";t.exports={}},6018:function(t){"use strict";t.exports=function(t,r){try{1===arguments.length?console.error(t):console.error(t,r)}catch(t){}}},3978:function(t,r,e){"use strict";var n=e(3068);t.exports=n("document","documentElement")},6574:function(t,r,e){"use strict";var n=e(6965),i=e(4234),o=e(7502);t.exports=!n&&!i(function(){return 7!==Object.defineProperty(o("div"),"a",{get:function(){return 7}}).a})},24:function(t,r,e){"use strict";var n=e(9321),i=e(4234),o=e(6201),c=Object,u=n("".split);t.exports=i(function(){return!c("z").propertyIsEnumerable(0)})?function(t){return"String"===o(t)?u(t,""):c(t)}:c},3021:function(t,r,e){"use strict";var n=e(9321),i=e(7764),o=e(5742),c=n(Function.toString);i(o.inspectSource)||(o.inspectSource=function(t){return c(t)}),t.exports=o.inspectSource},8105:function(t,r,e){"use strict";var n=e(7879),i=e(6320);t.exports=function(t,r){n(r)&&"cause"in r&&i(t,"cause",r.cause)}},1006:function(t,r,e){"use strict";var n=e(6565),i=e(9321),o=e(5132),c=e(7879),u=e(9338),a=e(6042).f,s=e(4085),f=e(9245),l=e(7199),p=e(953),v=e(855),h=!1,d=p("meta"),y=0,g=function(t){a(t,d,{value:{objectID:"O"+y++,weakData:{}}})},m=t.exports={enable:function(){m.enable=function(){},h=!0;var t=s.f,r=i([].splice),e={};e[d]=1,t(e).length&&(s.f=function(e){for(var n=t(e),i=0,o=n.length;i<o;i++)if(n[i]===d){r(n,i,1);break}return n},n({target:"Object",stat:!0,forced:!0},{getOwnPropertyNames:f.f}))},fastKey:function(t,r){if(!c(t))return"symbol"==typeof t?t:("string"==typeof t?"S":"P")+t;if(!u(t,d)){if(!l(t))return"F";if(!r)return"E";g(t)}return t[d].objectID},getWeakData:function(t,r){if(!u(t,d)){if(!l(t))return!0;if(!r)return!1;g(t)}return t[d].weakData},onFreeze:function(t){return v&&h&&l(t)&&!u(t,d)&&g(t),t}};o[d]=!0},9430:function(t,r,e){"use strict";var n,i,o,c=e(4641),u=e(8325),a=e(7879),s=e(6320),f=e(9338),l=e(5742),p=e(320),v=e(5132),h="Object already initialized",d=u.TypeError,y=u.WeakMap;if(c||l.state){var g=l.state||(l.state=new y);g.get=g.get,g.has=g.has,g.set=g.set,n=function(t,r){if(g.has(t))throw new d(h);return r.facade=t,g.set(t,r),r},i=function(t){return g.get(t)||{}},o=function(t){return g.has(t)}}else{var m=p("state");v[m]=!0,n=function(t,r){if(f(t,m))throw new d(h);return r.facade=t,s(t,m,r),r},i=function(t){return f(t,m)?t[m]:{}},o=function(t){return f(t,m)}}t.exports={set:n,get:i,has:o,enforce:function(t){return o(t)?i(t):n(t,{})},getterFor:function(t){return function(r){var e;if(!a(r)||(e=i(r)).type!==t)throw new d("Incompatible receiver, "+t+" required");return e}}}},1658:function(t,r,e){"use strict";var n=e(882),i=e(7204),o=n("iterator"),c=Array.prototype;t.exports=function(t){return void 0!==t&&(i.Array===t||c[o]===t)}},7543:function(t,r,e){"use strict";var n=e(6201);t.exports=Array.isArray||function(t){return"Array"===n(t)}},7764:function(t){"use strict";var r="object"==typeof document&&document.all;t.exports=void 0===r&&void 0!==r?function(t){return"function"==typeof t||t===r}:function(t){return"function"==typeof t}},4074:function(t,r,e){"use strict";var n=e(9321),i=e(4234),o=e(7764),c=e(9958),u=e(3068),a=e(3021),s=function(){},f=u("Reflect","construct"),l=/^\\s*(?:class|function)\\b/,p=n(l.exec),v=!l.test(s),h=function(t){if(!o(t))return!1;try{return f(s,[],t),!0}catch(t){return!1}},d=function(t){if(!o(t))return!1;switch(c(t)){case"AsyncFunction":case"GeneratorFunction":case"AsyncGeneratorFunction":return!1}try{return v||!!p(l,a(t))}catch(t){return!0}};d.sham=!0,t.exports=!f||i(function(){var t;return h(h.call)||!h(Object)||!h(function(){t=!0})||t})?d:h},4849:function(t,r,e){"use strict";var n=e(4234),i=e(7764),o=/#|\\.prototype\\./,c=function(t,r){var e=a[u(t)];return e===f||e!==s&&(i(r)?n(r):!!r)},u=c.normalize=function(t){return String(t).replace(o,".").toLowerCase()},a=c.data={},s=c.NATIVE="N",f=c.POLYFILL="P";t.exports=c},3878:function(t){"use strict";t.exports=function(t){return null==t}},7879:function(t,r,e){"use strict";var n=e(7764);t.exports=function(t){return"object"==typeof t?null!==t:n(t)}},3744:function(t,r,e){"use strict";var n=e(7879);t.exports=function(t){return n(t)||null===t}},2558:function(t){"use strict";t.exports=!0},7939:function(t,r,e){"use strict";var n=e(7879),i=e(9430).get;t.exports=function(t){if(!n(t))return!1;var r=i(t);return!!r&&"RawJSON"===r.type}},9313:function(t,r,e){"use strict";var n=e(7879),i=e(6201),o=e(882)("match");t.exports=function(t){var r;return n(t)&&(void 0!==(r=t[o])?!!r:"RegExp"===i(t))}},6072:function(t,r,e){"use strict";var n=e(3068),i=e(7764),o=e(2874),c=e(8313),u=Object;t.exports=c?function(t){return"symbol"==typeof t}:function(t){var r=n("Symbol");return i(r)&&o(r.prototype,u(t))}},1779:function(t,r,e){"use strict";var n=e(5408);t.exports=function(t,r,e){for(var i,o,c=e?t:t.iterator,u=t.next;!(i=n(u,c)).done;)if(void 0!==(o=r(i.value)))return o}},289:function(t,r,e){"use strict";var n=e(7525),i=e(5408),o=e(386),c=e(4750),u=e(1658),a=e(1797),s=e(2874),f=e(8790),l=e(9277),p=e(7100),v=TypeError,h=function(t,r){this.stopped=t,this.result=r},d=h.prototype;t.exports=function(t,r,e){var y,g,m,x,w,b,S,C=e&&e.that,A=!(!e||!e.AS_ENTRIES),_=!(!e||!e.IS_RECORD),E=!(!e||!e.IS_ITERATOR),k=!(!e||!e.INTERRUPTED),T=n(r,C),B=function(t){var r=y;return y=void 0,r&&p(r,"normal"),new h(!0,t)},D=function(t){return A?(o(t),k?T(t[0],t[1],B):T(t[0],t[1])):k?T(t,B):T(t)};if(_)y=t.iterator;else if(E)y=t;else{if(!(g=l(t)))throw new v(c(t)+" is not iterable");if(u(g)){for(m=0,x=a(t);x>m;m++)if((w=D(t[m]))&&s(d,w))return w;return new h(!1)}y=f(t,g)}for(b=_?t.next:y.next;!(S=i(b,y)).done;){var I=S.value;try{w=D(I)}catch(t){if(!y)throw t;p(y,"throw",t)}if("object"==typeof w&&w&&s(d,w))return w}return new h(!1)}},7100:function(t,r,e){"use strict";var n=e(5408),i=e(386),o=e(8585);t.exports=function(t,r,e){var c,u;i(t);try{if(!(c=o(t,"return"))){if("throw"===r)throw e;return e}c=n(c,t)}catch(t){u=!0,c=t}if("throw"===r)throw e;if(u)throw c;return i(c),e}},6063:function(t,r,e){"use strict";var n=e(90).IteratorPrototype,i=e(6305),o=e(2315),c=e(6802),u=e(7204),a=function(){return this};t.exports=function(t,r,e,s){var f=r+" Iterator";return t.prototype=i(n,{next:o(+!s,e)}),c(t,f,!1,!0),u[f]=a,t}},3209:function(t,r,e){"use strict";var n=e(6565),i=e(5408),o=e(2558),c=e(679),u=e(7764),a=e(6063),s=e(3586),f=e(7190),l=e(6802),p=e(6320),v=e(9757),h=e(882),d=e(7204),y=e(90),g=c.PROPER,m=c.CONFIGURABLE,x=y.IteratorPrototype,w=y.BUGGY_SAFARI_ITERATORS,b=h("iterator"),S="keys",C="values",A="entries",_=function(){return this};t.exports=function(t,r,e,c,h,y,E){a(e,r,c);var k,T,B,D=function(t){if(t===h&&L)return L;if(!w&&t&&t in M)return M[t];switch(t){case S:case C:case A:return function(){return new e(this,t)}}return function(){return new e(this)}},I=r+" Iterator",z=!1,M=t.prototype,O=M[b]||M["@@iterator"]||h&&M[h],L=!w&&O||D(h),P="Array"===r&&M.entries||O;if(P&&(k=s(P.call(new t)))!==Object.prototype&&k.next&&(o||s(k)===x||(f?f(k,x):u(k[b])||v(k,b,_)),l(k,I,!0,!0),o&&(d[I]=_)),g&&h===C&&O&&O.name!==C&&(!o&&m?p(M,"name",C):(z=!0,L=function(){return i(O,this)})),h)if(T={values:D(C),keys:y?L:D(S),entries:D(A)},E)for(B in T)(w||z||!(B in M))&&v(M,B,T[B]);else n({target:r,proto:!0,forced:w||z},T);return o&&!E||M[b]===L||v(M,b,L,{name:h}),d[r]=L,T}},90:function(t,r,e){"use strict";var n,i,o,c=e(4234),u=e(7764),a=e(7879),s=e(6305),f=e(3586),l=e(9757),p=e(882),v=e(2558),h=p("iterator"),d=!1;[].keys&&("next"in(o=[].keys())?(i=f(f(o)))!==Object.prototype&&(n=i):d=!0),!a(n)||c(function(){var t={};return n[h].call(t)!==t})?n={}:v&&(n=s(n)),u(n[h])||l(n,h,function(){return this}),t.exports={IteratorPrototype:n,BUGGY_SAFARI_ITERATORS:d}},7204:function(t){"use strict";t.exports={}},1797:function(t,r,e){"use strict";var n=e(6147);t.exports=function(t){return n(t.length)}},6918:function(t){"use strict";var r=Math.ceil,e=Math.floor;t.exports=Math.trunc||function(t){var n=+t;return(n>0?e:r)(n)}},5126:function(t,r,e){"use strict";var n,i,o,c,u,a=e(8325),s=e(2716),f=e(7525),l=e(3882).set,p=e(4160),v=e(7491),h=e(8720),d=e(3777),y=e(5484),g=a.MutationObserver||a.WebKitMutationObserver,m=a.document,x=a.process,w=a.Promise,b=s("queueMicrotask");if(!b){var S=new p,C=function(){var t,r;for(y&&(t=x.domain)&&t.exit();r=S.get();)try{r()}catch(t){throw S.head&&n(),t}t&&t.enter()};v||y||d||!g||!m?!h&&w&&w.resolve?((c=w.resolve(void 0)).constructor=w,u=f(c.then,c),n=function(){u(C)}):y?n=function(){x.nextTick(C)}:(l=f(l,a),n=function(){l(C)}):(i=!0,o=m.createTextNode(""),new g(C).observe(o,{characterData:!0}),n=function(){o.data=i=!i}),b=function(t){S.head||n(),S.add(t)}}t.exports=b},6334:function(t,r,e){"use strict";var n=e(4234);t.exports=!n(function(){var t="9007199254740993",r=JSON.rawJSON(t);return!JSON.isRawJSON(r)||JSON.stringify(r)!==t})},2396:function(t,r,e){"use strict";var n=e(6713),i=TypeError,o=function(t){var r,e;this.promise=new t(function(t,n){if(void 0!==r||void 0!==e)throw new i("Bad Promise constructor");r=t,e=n}),this.resolve=n(r),this.reject=n(e)};t.exports.f=function(t){return new o(t)}},2322:function(t,r,e){"use strict";var n=e(2722);t.exports=function(t,r){return void 0===t?arguments.length<2?"":r:n(t)}},364:function(t,r,e){"use strict";var n=e(9313),i=TypeError;t.exports=function(t){if(n(t))throw new i("The method doesn't accept regular expressions");return t}},6305:function(t,r,e){"use strict";var n,i=e(386),o=e(774),c=e(8946),u=e(5132),a=e(3978),s=e(7502),f=e(320),l="prototype",p="script",v=f("IE_PROTO"),h=function(){},d=function(t){return"<"+p+">"+t+"</"+p+">"},y=function(t){t.write(d("")),t.close();var r=t.parentWindow.Object;return t=null,r},g=function(){try{n=new ActiveXObject("htmlfile")}catch(t){}var t,r,e;g="undefined"!=typeof document?document.domain&&n?y(n):(r=s("iframe"),e="java"+p+":",r.style.display="none",a.appendChild(r),r.src=String(e),(t=r.contentWindow.document).open(),t.write(d("document.F=Object")),t.close(),t.F):y(n);for(var i=c.length;i--;)delete g[l][c[i]];return g()};u[v]=!0,t.exports=Object.create||function(t,r){var e;return null!==t?(h[l]=i(t),e=new h,h[l]=null,e[v]=t):e=g(),void 0===r?e:o.f(e,r)}},774:function(t,r,e){"use strict";var n=e(6965),i=e(5675),o=e(6042),c=e(386),u=e(6420),a=e(7273);r.f=n&&!i?Object.defineProperties:function(t,r){c(t);for(var e,n=u(r),i=a(r),s=i.length,f=0;s>f;)o.f(t,e=i[f++],n[e]);return t}},6042:function(t,r,e){"use strict";var n=e(6965),i=e(6574),o=e(5675),c=e(386),u=e(7184),a=TypeError,s=Object.defineProperty,f=Object.getOwnPropertyDescriptor,l="enumerable",p="configurable",v="writable";r.f=n?o?function(t,r,e){if(c(t),r=u(r),c(e),"function"==typeof t&&"prototype"===r&&"value"in e&&v in e&&!e[v]){var n=f(t,r);n&&n[v]&&(t[r]=e.value,e={configurable:p in e?e[p]:n[p],enumerable:l in e?e[l]:n[l],writable:!1})}return s(t,r,e)}:s:function(t,r,e){if(c(t),r=u(r),c(e),i)try{return s(t,r,e)}catch(t){}if("get"in e||"set"in e)throw new a("Accessors not supported");return"value"in e&&(t[r]=e.value),t}},9088:function(t,r,e){"use strict";var n=e(6965),i=e(5408),o=e(3128),c=e(2315),u=e(6420),a=e(7184),s=e(9338),f=e(6574),l=Object.getOwnPropertyDescriptor;r.f=n?l:function(t,r){if(t=u(t),r=a(r),f)try{return l(t,r)}catch(t){}if(s(t,r))return c(!i(o.f,t,r),t[r])}},9245:function(t,r,e){"use strict";var n=e(6201),i=e(6420),o=e(4085).f,c=e(8425),u="object"==typeof window&&window&&Object.getOwnPropertyNames?Object.getOwnPropertyNames(window):[];t.exports.f=function(t){return u&&"Window"===n(t)?function(t){try{return o(t)}catch(t){return c(u)}}(t):o(i(t))}},4085:function(t,r,e){"use strict";var n=e(6379),i=e(8946).concat("length","prototype");r.f=Object.getOwnPropertyNames||function(t){return n(t,i)}},1620:function(t,r){"use strict";r.f=Object.getOwnPropertySymbols},3586:function(t,r,e){"use strict";var n=e(9338),i=e(7764),o=e(1108),c=e(320),u=e(2528),a=c("IE_PROTO"),s=Object,f=s.prototype;t.exports=u?s.getPrototypeOf:function(t){var r=o(t);if(n(r,a))return r[a];var e=r.constructor;return i(e)&&r instanceof e?e.prototype:r instanceof s?f:null}},7199:function(t,r,e){"use strict";var n=e(4234),i=e(7879),o=e(6201),c=e(1333),u=Object.isExtensible,a=n(function(){u(1)});t.exports=a||c?function(t){return!!i(t)&&((!c||"ArrayBuffer"!==o(t))&&(!u||u(t)))}:u},2874:function(t,r,e){"use strict";var n=e(9321);t.exports=n({}.isPrototypeOf)},6379:function(t,r,e){"use strict";var n=e(9321),i=e(9338),o=e(6420),c=e(9962).indexOf,u=e(5132),a=n([].push);t.exports=function(t,r){var e,n=o(t),s=0,f=[];for(e in n)!i(u,e)&&i(n,e)&&a(f,e);for(;r.length>s;)i(n,e=r[s++])&&(~c(f,e)||a(f,e));return f}},7273:function(t,r,e){"use strict";var n=e(6379),i=e(8946);t.exports=Object.keys||function(t){return n(t,i)}},3128:function(t,r){"use strict";var e={}.propertyIsEnumerable,n=Object.getOwnPropertyDescriptor,i=n&&!e.call({1:2},1);r.f=i?function(t){var r=n(this,t);return!!r&&r.enumerable}:e},7190:function(t,r,e){"use strict";var n=e(6185),i=e(7879),o=e(2653),c=e(7217);t.exports=Object.setPrototypeOf||("__proto__"in{}?function(){var t,r=!1,e={};try{(t=n(Object.prototype,"__proto__","set"))(e,[]),r=e instanceof Array}catch(t){}return function(e,n){return o(e),c(n),i(e)?(r?t(e,n):e.__proto__=n,e):e}}():void 0)},1988:function(t,r,e){"use strict";var n=e(6965),i=e(4234),o=e(9321),c=e(3586),u=e(7273),a=e(6420),s=o(e(3128).f),f=o([].push),l=n&&i(function(){var t=Object.create(null);return t[2]=2,!s(t,2)}),p=function(t){return function(r){for(var e,i=a(r),o=u(i),p=l&&null===c(i),v=o.length,h=0,d=[];v>h;)e=o[h++],n&&!(p?e in i:s(i,e))||f(d,t?[e,i[e]]:i[e]);return d}};t.exports={entries:p(!0),values:p(!1)}},8188:function(t,r,e){"use strict";var n=e(6537),i=e(9958);t.exports=n?{}.toString:function(){return"[object "+i(this)+"]"}},7239:function(t,r,e){"use strict";var n=e(5408),i=e(7764),o=e(7879),c=TypeError;t.exports=function(t,r){var e,u;if("string"===r&&i(e=t.toString)&&!o(u=n(e,t)))return u;if(i(e=t.valueOf)&&!o(u=n(e,t)))return u;if("string"!==r&&i(e=t.toString)&&!o(u=n(e,t)))return u;throw new c("Can't convert object to primitive value")}},6648:function(t,r,e){"use strict";var n=e(3068),i=e(9321),o=e(4085),c=e(1620),u=e(386),a=i([].concat);t.exports=n("Reflect","ownKeys")||function(t){var r=o.f(u(t)),e=c.f;return e?a(r,e(t)):r}},2137:function(t,r,e){"use strict";var n=e(9321),i=e(9338),o=SyntaxError,c=parseInt,u=String.fromCharCode,a=n("".charAt),s=n("".slice),f=n(/./.exec),l={'\\\\"':'"',"\\\\\\\\":"\\\\","\\\\/":"/","\\\\b":"\\b","\\\\f":"\\f","\\\\n":"\\n","\\\\r":"\\r","\\\\t":"\\t"},p=/^[\\da-f]{4}$/i,v=/^[\\u0000-\\u001F]$/;t.exports=function(t,r){for(var e=!0,n="";r<t.length;){var h=a(t,r);if("\\\\"===h){var d=s(t,r,r+2);if(i(l,d))n+=l[d],r+=2;else{if("\\\\u"!==d)throw new o('Unknown escape sequence: "'+d+'"');var y=s(t,r+=2,r+4);if(!f(p,y))throw new o("Bad Unicode escape at: "+r);n+=u(c(y,16)),r+=4}}else{if('"'===h){e=!1,r++;break}if(f(v,h))throw new o("Bad control character in string literal at: "+r);n+=h,r++}}if(e)throw new o("Unterminated string at: "+r);return{value:n,end:r}}},7464:function(t){"use strict";t.exports={}},2562:function(t){"use strict";t.exports=function(t){try{return{error:!1,value:t()}}catch(t){return{error:!0,value:t}}}},2541:function(t,r,e){"use strict";var n=e(8325),i=e(1117),o=e(7764),c=e(4849),u=e(3021),a=e(882),s=e(478),f=e(2558),l=e(8024),p=i&&i.prototype,v=a("species"),h=!1,d=o(n.PromiseRejectionEvent),y=c("Promise",function(){var t=u(i),r=t!==String(i);if(!r&&66===l)return!0;if(f&&(!p.catch||!p.finally))return!0;if(!l||l<51||!/native code/.test(t)){var e=new i(function(t){t(1)}),n=function(t){t(function(){},function(){})};if((e.constructor={})[v]=n,!(h=e.then(function(){})instanceof n))return!0}return!(r||"BROWSER"!==s&&"DENO"!==s||d)});t.exports={CONSTRUCTOR:y,REJECTION_EVENT:d,SUBCLASSING:h}},1117:function(t,r,e){"use strict";var n=e(8325);t.exports=n.Promise},1675:function(t,r,e){"use strict";var n=e(386),i=e(7879),o=e(2396);t.exports=function(t,r){if(n(t),i(r)&&r.constructor===t)return r;var e=o.f(t);return(0,e.resolve)(r),e.promise}},6364:function(t,r,e){"use strict";var n=e(1117),i=e(5099),o=e(2541).CONSTRUCTOR;t.exports=o||!i(function(t){n.all(t).then(void 0,function(){})})},4160:function(t){"use strict";var r=function(){this.head=null,this.tail=null};r.prototype={add:function(t){var r={item:t,next:null},e=this.tail;e?e.next=r:this.head=r,this.tail=r},get:function(){var t=this.head;if(t)return null===(this.head=t.next)&&(this.tail=null),t.item}},t.exports=r},2653:function(t,r,e){"use strict";var n=e(3878),i=TypeError;t.exports=function(t){if(n(t))throw new i("Can't call method on "+t);return t}},2716:function(t,r,e){"use strict";var n=e(8325),i=e(6965),o=Object.getOwnPropertyDescriptor;t.exports=function(t){if(!i)return n[t];var r=o(n,t);return r&&r.value}},6619:function(t,r,e){"use strict";var n,i=e(8325),o=e(5262),c=e(7764),u=e(478),a=e(5796),s=e(8425),f=e(5693),l=i.Function,p=/MSIE .\\./.test(a)||"BUN"===u&&((n=i.Bun.version.split(".")).length<3||"0"===n[0]&&(n[1]<3||"3"===n[1]&&"0"===n[2]));t.exports=function(t,r){var e=r?2:1;return p?function(n,i){var u=f(arguments.length,1)>e,a=c(n)?n:l(n),p=u?s(arguments,e):[],v=u?function(){o(a,this,p)}:a;return r?t(v,i):t(v)}:t}},8175:function(t,r,e){"use strict";var n=e(4051),i=e(8224),o=n.Set,c=n.add;t.exports=function(t){var r=new o;return i(t,function(t){c(r,t)}),r}},4923:function(t,r,e){"use strict";var n=e(3489),i=e(4051),o=e(8175),c=e(7581),u=e(7198),a=e(8224),s=e(1779),f=i.has,l=i.remove;t.exports=function(t){var r=n(this),e=u(t),i=o(r);return c(i)<=e.size?a(i,function(t){e.includes(t)&&l(i,t)}):s(e.getIterator(),function(t){f(i,t)&&l(i,t)}),i}},4051:function(t,r,e){"use strict";var n=e(3068),i=e(7643),o=n("Set"),c=o.prototype;t.exports={Set:o,add:i("add",1),has:i("has",1),remove:i("delete",1),proto:c}},2353:function(t,r,e){"use strict";var n=e(3489),i=e(4051),o=e(7581),c=e(7198),u=e(8224),a=e(1779),s=i.Set,f=i.add,l=i.has;t.exports=function(t){var r=n(this),e=c(t),i=new s;return o(r)>e.size?a(e.getIterator(),function(t){l(r,t)&&f(i,t)}):u(r,function(t){e.includes(t)&&f(i,t)}),i}},1122:function(t,r,e){"use strict";var n=e(3489),i=e(4051).has,o=e(7581),c=e(7198),u=e(8224),a=e(1779),s=e(7100);t.exports=function(t){var r=n(this),e=c(t);if(o(r)<=e.size)return!1!==u(r,function(t){if(e.includes(t))return!1},!0);var f=e.getIterator();return!1!==a(f,function(t){if(i(r,t))return s(f.iterator,"normal",!1)})}},6241:function(t,r,e){"use strict";var n=e(3489),i=e(7581),o=e(8224),c=e(7198);t.exports=function(t){var r=n(this),e=c(t);return!(i(r)>e.size)&&!1!==o(r,function(t){if(!e.includes(t))return!1},!0)}},352:function(t,r,e){"use strict";var n=e(3489),i=e(4051).has,o=e(7581),c=e(7198),u=e(1779),a=e(7100);t.exports=function(t){var r=n(this),e=c(t);if(o(r)<e.size)return!1;var s=e.getIterator();return!1!==u(s,function(t){if(!i(r,t))return a(s.iterator,"normal",!1)})}},8224:function(t,r,e){"use strict";var n=e(1779);t.exports=function(t,r,e){return e?n(t.keys(),r,!0):t.forEach(r)}},3727:function(t){"use strict";t.exports=function(){return!1}},8436:function(t){"use strict";t.exports=function(t){try{var r=new Set,e={size:0,has:function(){return!0},keys:function(){return Object.defineProperty({},"next",{get:function(){return r.clear(),r.add(4),function(){return{done:!0}}}})}},n=r[t](e);return 1===n.size&&4===n.values().next().value}catch(t){return!1}}},7581:function(t){"use strict";t.exports=function(t){return t.size}},7444:function(t,r,e){"use strict";var n=e(3068),i=e(9933),o=e(882),c=e(6965),u=o("species");t.exports=function(t){var r=n(t);c&&r&&!r[u]&&i(r,u,{configurable:!0,get:function(){return this}})}},6417:function(t,r,e){"use strict";var n=e(3489),i=e(4051),o=e(8175),c=e(7198),u=e(1779),a=i.add,s=i.has,f=i.remove;t.exports=function(t){var r=n(this),e=c(t).getIterator(),i=o(r);return u(e,function(t){s(r,t)?f(i,t):a(i,t)}),i}},6802:function(t,r,e){"use strict";var n=e(6537),i=e(6042).f,o=e(6320),c=e(9338),u=e(8188),a=e(882)("toStringTag");t.exports=function(t,r,e,s){var f=e?t:t&&t.prototype;f&&(c(f,a)||i(f,a,{configurable:!0,value:r}),s&&!n&&o(f,"toString",u))}},7885:function(t,r,e){"use strict";var n=e(3489),i=e(4051).add,o=e(8175),c=e(7198),u=e(1779);t.exports=function(t){var r=n(this),e=c(t).getIterator(),a=o(r);return u(e,function(t){i(a,t)}),a}},320:function(t,r,e){"use strict";var n=e(3234),i=e(953),o=n("keys");t.exports=function(t){return o[t]||(o[t]=i(t))}},5742:function(t,r,e){"use strict";var n=e(2558),i=e(8325),o=e(6150),c="__core-js_shared__",u=t.exports=i[c]||o(c,{});(u.versions||(u.versions=[])).push({version:"3.49.0",mode:n?"pure":"global",copyright:"\xA9 2013\u20132025 Denis Pushkarev (zloirock.ru), 2025\u20132026 CoreJS Company (core-js.io). All rights reserved.",license:"https://github.com/zloirock/core-js/blob/v3.49.0/LICENSE",source:"https://github.com/zloirock/core-js"})},3234:function(t,r,e){"use strict";var n=e(5742);t.exports=function(t,r){return n[t]||(n[t]=r||{})}},4900:function(t,r,e){"use strict";var n=e(386),i=e(6121),o=e(3878),c=e(882)("species");t.exports=function(t,r){var e,u=n(t).constructor;return void 0===u||o(e=n(u)[c])?r:i(e)}},412:function(t,r,e){"use strict";var n=e(9321),i=e(5568),o=e(2722),c=e(2653),u=n("".charAt),a=n("".charCodeAt),s=n("".slice),f=function(t){return function(r,e){var n,f,l=o(c(r)),p=i(e),v=l.length;return p<0||p>=v?t?"":void 0:(n=a(l,p))<55296||n>56319||p+1===v||(f=a(l,p+1))<56320||f>57343?t?u(l,p):n:t?s(l,p,p+2):f-56320+(n-55296<<10)+65536}};t.exports={codeAt:f(!1),charAt:f(!0)}},3390:function(t,r,e){"use strict";var n=e(9321),i=e(6147),o=e(2722),c=e(5516),u=e(2653),a=n(c),s=n("".slice),f=Math.ceil,l=function(t){return function(r,e,n){var c=o(u(r)),l=i(e),p=c.length;if(l<=p)return c;var v,h,d=void 0===n?" ":o(n);return""===d?c:((h=a(d,f((v=l-p)/d.length))).length>v&&(h=s(h,0,v)),t?c+h:h+c)}};t.exports={start:l(!1),end:l(!0)}},5516:function(t,r,e){"use strict";var n=e(5568),i=e(2722),o=e(2653),c=RangeError,u=Math.floor;t.exports=function(t){var r=i(o(this)),e="",a=n(t);if(a<0||a===1/0)throw new c("Wrong number of repetitions");for(;a>0;(a=u(a/2))&&(r+=r))a%2&&(e+=r);return e}},9592:function(t,r,e){"use strict";var n=e(8024),i=e(4234),o=e(8325).String;t.exports=!!Object.getOwnPropertySymbols&&!i(function(){var t=Symbol("symbol detection");return!o(t)||!(Object(t)instanceof Symbol)||!Symbol.sham&&n&&n<41})},6285:function(t,r,e){"use strict";var n=e(5408),i=e(3068),o=e(882),c=e(9757);t.exports=function(){var t=i("Symbol"),r=t&&t.prototype,e=r&&r.valueOf,u=o("toPrimitive");r&&!r[u]&&c(r,u,function(t){return n(e,this)},{arity:1})}},4317:function(t,r,e){"use strict";var n=e(3068),i=e(9321),o=n("Symbol"),c=o.keyFor,u=i(o.prototype.valueOf);t.exports=o.isRegisteredSymbol||function(t){try{return void 0!==c(u(t))}catch(t){return!1}}},9071:function(t,r,e){"use strict";for(var n=e(3234),i=e(3068),o=e(9321),c=e(6072),u=e(882),a=i("Symbol"),s=a.isWellKnownSymbol,f=i("Object","getOwnPropertyNames"),l=o(a.prototype.valueOf),p=n("wks"),v=0,h=f(a),d=h.length;v<d;v++)try{var y=h[v];c(a[y])&&u(y)}catch(t){}t.exports=function(t){if(s&&s(t))return!0;try{for(var r=l(t),e=0,n=f(p),i=n.length;e<i;e++)if(p[n[e]]==r)return!0}catch(t){}return!1}},1657:function(t,r,e){"use strict";var n=e(9592);t.exports=n&&!!Symbol.for&&!!Symbol.keyFor},3882:function(t,r,e){"use strict";var n,i,o,c,u=e(8325),a=e(5262),s=e(7525),f=e(7764),l=e(9338),p=e(4234),v=e(3978),h=e(8425),d=e(7502),y=e(5693),g=e(7491),m=e(5484),x=u.setImmediate,w=u.clearImmediate,b=u.process,S=u.Dispatch,C=u.Function,A=u.MessageChannel,_=u.String,E=0,k={},T="onreadystatechange";p(function(){n=u.location});var B=function(t){if(l(k,t)){var r=k[t];delete k[t],r()}},D=function(t){return function(){B(t)}},I=function(t){B(t.data)},z=function(t){u.postMessage(_(t),n.protocol+"//"+n.host)};x&&w||(x=function(t){y(arguments.length,1);var r=f(t)?t:C(t),e=h(arguments,1);return k[++E]=function(){a(r,void 0,e)},i(E),E},w=function(t){delete k[t]},m?i=function(t){b.nextTick(D(t))}:S&&S.now?i=function(t){S.now(D(t))}:A&&!g?(c=(o=new A).port2,o.port1.onmessage=I,i=s(c.postMessage,c)):u.addEventListener&&f(u.postMessage)&&!u.importScripts&&n&&"file:"!==n.protocol&&!p(z)?(i=z,u.addEventListener("message",I,!1)):i=T in d("script")?function(t){v.appendChild(d("script"))[T]=function(){v.removeChild(this),B(t)}}:function(t){setTimeout(D(t),0)}),t.exports={set:x,clear:w}},2235:function(t,r,e){"use strict";var n=e(5568),i=Math.max,o=Math.min;t.exports=function(t,r){var e=n(t);return e<0?i(e+r,0):o(e,r)}},6420:function(t,r,e){"use strict";var n=e(24),i=e(2653);t.exports=function(t){return n(i(t))}},5568:function(t,r,e){"use strict";var n=e(6918);t.exports=function(t){var r=+t;return r!=r||0===r?0:n(r)}},6147:function(t,r,e){"use strict";var n=e(5568),i=Math.min;t.exports=function(t){var r=n(t);return r>0?i(r,9007199254740991):0}},1108:function(t,r,e){"use strict";var n=e(2653),i=Object;t.exports=function(t){return i(n(t))}},5722:function(t,r,e){"use strict";var n=e(5408),i=e(7879),o=e(6072),c=e(8585),u=e(7239),a=e(882),s=TypeError,f=a("toPrimitive");t.exports=function(t,r){if(!i(t)||o(t))return t;var e,a=c(t,f);if(a){if(void 0===r&&(r="default"),e=n(a,t,r),!i(e)||o(e))return e;throw new s("Can't convert object to primitive value")}return void 0===r&&(r="number"),u(t,r)}},7184:function(t,r,e){"use strict";var n=e(5722),i=e(6072);t.exports=function(t){var r=n(t,"string");return i(r)?r:r+""}},6537:function(t,r,e){"use strict";var n={};n[e(882)("toStringTag")]="z",t.exports="[object z]"===String(n)},2722:function(t,r,e){"use strict";var n=e(9958),i=String;t.exports=function(t){if("Symbol"===n(t))throw new TypeError("Cannot convert a Symbol value to a string");return i(t)}},4750:function(t){"use strict";var r=String;t.exports=function(t){try{return r(t)}catch(t){return"Object"}}},953:function(t,r,e){"use strict";var n=e(9321),i=0,o=Math.random(),c=n(1.1.toString);t.exports=function(t){return"Symbol("+(void 0===t?"":t)+")_"+c(++i+o,36)}},8313:function(t,r,e){"use strict";var n=e(9592);t.exports=n&&!Symbol.sham&&"symbol"==typeof Symbol.iterator},5675:function(t,r,e){"use strict";var n=e(6965),i=e(4234);t.exports=n&&i(function(){return 42!==Object.defineProperty(function(){},"prototype",{value:42,writable:!1}).prototype})},5693:function(t){"use strict";var r=TypeError;t.exports=function(t,e){if(t<e)throw new r("Not enough arguments");return t}},4641:function(t,r,e){"use strict";var n=e(8325),i=e(7764),o=n.WeakMap;t.exports=i(o)&&/native code/.test(String(o))},8180:function(t,r,e){"use strict";var n=e(7464),i=e(9338),o=e(4386),c=e(6042).f;t.exports=function(t){var r=n.Symbol||(n.Symbol={});i(r,t)||c(r,t,{value:o.f(t)})}},4386:function(t,r,e){"use strict";var n=e(882);r.f=n},882:function(t,r,e){"use strict";var n=e(8325),i=e(3234),o=e(9338),c=e(953),u=e(9592),a=e(8313),s=n.Symbol,f=i("wks"),l=a?s.for||s:s&&s.withoutSetter||c;t.exports=function(t){return o(f,t)||(f[t]=u&&o(s,t)?s[t]:l("Symbol."+t)),f[t]}},6702:function(t,r,e){"use strict";var n=e(6565),i=e(2874),o=e(3586),c=e(7190),u=e(2585),a=e(6305),s=e(6320),f=e(2315),l=e(8105),p=e(9534),v=e(289),h=e(2322),d=e(882)("toStringTag"),y=Error,g=[].push,m=function(t,r){var e,n=i(x,this);c?e=c(new y,n?o(this):x):(e=n?this:a(x),s(e,d,"Error")),void 0!==r&&s(e,"message",h(r)),p(e,m,e.stack,1),arguments.length>2&&l(e,arguments[2]);var u=[];return v(t,g,{that:u}),s(e,"errors",u),e};c?c(m,y):u(m,y,{name:!0});var x=m.prototype=a(y.prototype,{constructor:f(1,m),message:f(1,""),name:f(1,"AggregateError")});n({global:!0,constructor:!0,arity:2},{AggregateError:m})},2688:function(t,r,e){"use strict";e(6702)},2707:function(t,r,e){"use strict";var n=e(6565),i=e(4234),o=e(7543),c=e(7879),u=e(1108),a=e(1797),s=e(3722),f=e(457),l=e(680),p=e(9862),v=e(3906),h=e(882),d=e(8024),y=h("isConcatSpreadable"),g=d>=51||!i(function(){var t=[];return t[y]=!1,t.concat()[0]!==t}),m=function(t){if(!c(t))return!1;var r=t[y];return void 0!==r?!!r:o(t)};n({target:"Array",proto:!0,arity:1,forced:!g||!v("concat")},{concat:function(t){var r,e,n,i,o,c=u(this),v=p(c,0),h=0;for(r=-1,n=arguments.length;r<n;r++)if(m(o=-1===r?c:arguments[r]))for(i=a(o),s(h+i),e=0;e<i;e++,h++)e in o&&f(v,h,o[e]);else s(h+1),f(v,h++,o);return l(v,h),v}})},7313:function(t,r,e){"use strict";var n=e(6565),i=e(6672).filter;n({target:"Array",proto:!0,forced:!e(3906)("filter")},{filter:function(t){return i(this,t,arguments.length>1?arguments[1]:void 0)}})},5899:function(t,r,e){"use strict";var n=e(6565),i=e(3363);n({target:"Array",stat:!0,forced:!e(5099)(function(t){Array.from(t)})},{from:i})},1554:function(t,r,e){"use strict";var n=e(6565),i=e(9962).includes,o=e(4234),c=e(5642),u=o(function(){return!Array(1).includes()}),a=o(function(){return[,1].includes(void 0,1)});n({target:"Array",proto:!0,forced:u||a},{includes:function(t){return i(this,t,arguments.length>1?arguments[1]:void 0)}}),c("includes")},3789:function(t,r,e){"use strict";var n=e(6565),i=e(8707),o=e(9962).indexOf,c=e(1709),u=i([].indexOf),a=!!u&&1/u([1],1,-0)<0;n({target:"Array",proto:!0,forced:a||!c("indexOf")},{indexOf:function(t){var r=arguments.length>1?arguments[1]:void 0;return a?u(this,t,r)||0:o(this,t,r)}})},3247:function(t,r,e){"use strict";e(6565)({target:"Array",stat:!0},{isArray:e(7543)})},7529:function(t,r,e){"use strict";var n=e(6420),i=e(5642),o=e(7204),c=e(9430),u=e(6042).f,a=e(3209),s=e(6808),f=e(2558),l=e(6965),p="Array Iterator",v=c.set,h=c.getterFor(p);t.exports=a(Array,"Array",function(t,r){v(this,{type:p,target:n(t),index:0,kind:r})},function(){var t=h(this),r=t.target,e=t.index++;if(!r||e>=r.length)return t.target=null,s(void 0,!0);switch(t.kind){case"keys":return s(e,!1);case"values":return s(r[e],!1)}return s([e,r[e]],!1)},"values");var d=o.Arguments=o.Array;if(i("keys"),i("values"),i("entries"),!f&&l&&"values"!==d.name)try{u(d,"name",{value:"values"})}catch(t){}},781:function(t,r,e){"use strict";var n=e(6565),i=e(6672).map;n({target:"Array",proto:!0,forced:!e(3906)("map")},{map:function(t){return i(this,t,arguments.length>1?arguments[1]:void 0)}})},2583:function(t,r,e){"use strict";var n=e(6565),i=e(1108),o=e(1797),c=e(680),u=e(3722);n({target:"Array",proto:!0,arity:1,forced:e(4234)(function(){return 4294967297!==[].push.call({length:4294967296},1)})||!function(){try{Object.defineProperty([],"length",{writable:!1}).push()}catch(t){return t instanceof TypeError}}()},{push:function(t){var r=i(this),e=o(r),n=arguments.length;u(e+n);for(var a=0;a<n;a++)r[e]=arguments[a],e++;return c(r,e),e}})},4125:function(t,r,e){"use strict";var n=e(6565),i=e(9321),o=e(7543),c=i([].reverse),u=[1,2];n({target:"Array",proto:!0,forced:String(u)===String(u.reverse())},{reverse:function(){return o(this)&&(this.length=this.length),c(this)}})},1121:function(t,r,e){"use strict";var n=e(6565),i=e(7543),o=e(4074),c=e(7879),u=e(2235),a=e(1797),s=e(6420),f=e(457),l=e(680),p=e(882),v=e(3906),h=e(8425),d=v("slice"),y=p("species"),g=Array,m=Math.max;n({target:"Array",proto:!0,forced:!d},{slice:function(t,r){var e,n,p,v=s(this),d=a(v),x=u(t,d),w=u(void 0===r?d:r,d);if(i(v)&&(e=v.constructor,(o(e)&&(e===g||i(e.prototype))||c(e)&&null===(e=e[y]))&&(e=void 0),e===g||void 0===e))return h(v,x,w);for(n=new(void 0===e?g:e)(m(w-x,0)),p=0;x<w;x++,p++)x in v&&f(n,p,v[x]);return l(n,p),n}})},1679:function(t,r,e){"use strict";var n=e(6565),i=e(9321),o=e(6713),c=e(1108),u=e(1797),a=e(6353),s=e(2722),f=e(4234),l=e(7527),p=e(1709),v=e(1878),h=e(7118),d=e(8024),y=e(1844),g=[],m=i(g.sort),x=i(g.push),w=f(function(){g.sort(void 0)}),b=f(function(){g.sort(null)}),S=p("sort"),C=!f(function(){if(d)return d<70;if(!(v&&v>3)){if(h)return!0;if(y)return y<603;var t,r,e,n,i="";for(t=65;t<76;t++){switch(r=String.fromCharCode(t),t){case 66:case 69:case 70:case 72:e=3;break;case 68:case 71:e=4;break;default:e=2}for(n=0;n<47;n++)g.push({k:r+n,v:e})}for(g.sort(function(t,r){return r.v-t.v}),n=0;n<g.length;n++)r=g[n].k.charAt(0),i.charAt(i.length-1)!==r&&(i+=r);return"DGBEFHACIJK"!==i}});n({target:"Array",proto:!0,forced:w||!b||!S||!C},{sort:function(t){void 0!==t&&o(t);var r=c(this);if(C)return void 0===t?m(r):m(r,t);var e,n,i=[],f=u(r);for(n=0;n<f;n++)n in r&&x(i,r[n]);for(l(i,function(t){return function(r,e){if(void 0===e)return-1;if(void 0===r)return 1;if(void 0!==t)return+t(r,e)||0;var n=s(r),i=s(e);return n===i?0:n>i?1:-1}}(t)),e=u(i),n=0;n<e;)r[n]=i[n++];for(;n<f;)a(r,n++);return r}})},1035:function(t,r,e){"use strict";var n=e(6565),i=e(1108),o=e(2235),c=e(5568),u=e(1797),a=e(680),s=e(3722),f=e(9862),l=e(457),p=e(6353),v=e(3906)("splice"),h=Math.max,d=Math.min;n({target:"Array",proto:!0,forced:!v},{splice:function(t,r){var e,n,v,y,g,m,x=i(this),w=u(x),b=o(t,w),S=arguments.length;for(0===S?e=n=0:1===S?(e=0,n=w-b):(e=S-2,n=d(h(c(r),0),w-b)),s(w+e-n),v=f(x,n),y=0;y<n;y++)(g=b+y)in x&&l(v,y,x[g]);if(a(v,n),e<n){for(y=b;y<w-n;y++)m=y+e,(g=y+n)in x?x[m]=x[g]:p(x,m);for(y=w;y>w-n+e;y--)p(x,y-1)}else if(e>n)for(y=w-n;y>b;y--)m=y+e-1,(g=y+n-1)in x?x[m]=x[g]:p(x,m);for(y=0;y<e;y++)x[y+b]=arguments[y+2];return a(x,w-n+e),v}})},2662:function(t,r,e){"use strict";var n=e(6565),i=e(1108),o=e(1797),c=e(680),u=e(6353),a=e(3722);n({target:"Array",proto:!0,arity:1,forced:1!==[].unshift(0)||!function(){try{Object.defineProperty([],"length",{writable:!1}).unshift()}catch(t){return t instanceof TypeError}}()},{unshift:function(t){var r=i(this),e=o(r),n=arguments.length;if(n){a(e+n);for(var s=e;s--;){var f=s+n;s in r?r[f]=r[s]:u(r,f)}for(var l=0;l<n;l++)r[l]=arguments[l]}return c(r,e+n)}})},3014:function(t,r,e){"use strict";var n=e(6565),i=e(5408),o=e(1108),c=e(5722),u=e(3403),a=e(6201);n({target:"Date",proto:!0,forced:e(4234)(function(){return null!==new Date(NaN).toJSON()||1!==i(Date.prototype.toJSON,{toISOString:function(){return 1}})})},{toJSON:function(t){var r=o(this),e=c(r,"number");return"number"!=typeof e||isFinite(e)?"toISOString"in r||"Date"!==a(r)?r.toISOString():i(u,r):null}})},155:function(){},9965:function(t,r,e){"use strict";var n=e(6565),i=e(59);n({target:"Function",proto:!0,forced:Function.bind!==i},{bind:i})},1247:function(t,r,e){"use strict";var n=e(6565),i=e(3068),o=e(5262),c=e(5408),u=e(9321),a=e(4234),s=e(7543),f=e(7764),l=e(7939),p=e(6072),v=e(6201),h=e(2722),d=e(8425),y=e(2137),g=e(953),m=e(9592),x=e(6334),w=String,b=i("JSON","stringify"),S=u(/./.exec),C=u("".charAt),A=u("".charCodeAt),_=u("".replace),E=u("".slice),k=u([].push),T=u(1.1.toString),B=/[\\uD800-\\uDFFF]/g,D=/^[\\uD800-\\uDBFF]$/,I=/^[\\uDC00-\\uDFFF]$/,z=g(),M=z.length,O=!m||a(function(){var t=i("Symbol")("stringify detection");return"[null]"!==b([t])||"{}"!==b({a:t})||"{}"!==b(Object(t))}),L=a(function(){return'"\\\\udf06\\\\ud834"'!==b("\\udf06\\ud834")||'"\\\\udead"'!==b("\\udead")}),P=O?function(t,r){var e=d(arguments),n=j(r);if(f(n)||void 0!==t&&!p(t))return e[1]=function(t,r){if(f(n)&&(r=c(n,this,w(t),r)),!p(r))return r},o(b,null,e)}:b,N=function(t,r,e){var n=C(e,r-1),i=C(e,r+1);return S(D,t)&&!S(I,i)||S(I,t)&&!S(D,n)?"\\\\u"+T(A(t,0),16):t},j=function(t){if(f(t))return t;if(s(t)){for(var r=t.length,e=[],n=0;n<r;n++){var i=t[n];"string"==typeof i?k(e,i):"number"!=typeof i&&"Number"!==v(i)&&"String"!==v(i)||k(e,h(i))}var o=e.length,c=!0;return function(t,r){if(c)return c=!1,r;if(s(this))return r;for(var n=0;n<o;n++)if(e[n]===t)return r}}};b&&n({target:"JSON",stat:!0,arity:3,forced:O||L||!x},{stringify:function(t,r,e){var n=j(r),i=[],o=P(t,function(t,r){var e=f(n)?c(n,this,w(t),r):r;return!x&&l(e)?z+(k(i,e.rawJSON)-1):e},e);if("string"!=typeof o)return o;if(L&&(o=_(o,B,N)),x)return o;for(var u="",a=o.length,s=0;s<a;s++){var p=C(o,s);if('"'===p){var v=y(o,++s).end-1,h=E(o,s,v);u+=E(h,0,M)===z?i[E(h,M)]:'"'+h+'"',s=v}else u+=p}return u}})},6066:function(t,r,e){"use strict";var n=e(8325);e(6802)(n.JSON,"JSON",!0)},6390:function(){},6059:function(t,r,e){"use strict";e(6565)({target:"Object",stat:!0,sham:!e(6965)},{create:e(6305)})},6604:function(t,r,e){"use strict";var n=e(6565),i=e(6965),o=e(6042).f;n({target:"Object",stat:!0,forced:Object.defineProperty!==o,sham:!i},{defineProperty:o})},5583:function(t,r,e){"use strict";var n=e(6565),i=e(1988).entries;n({target:"Object",stat:!0},{entries:function(t){return i(t)}})},5926:function(t,r,e){"use strict";var n=e(6565),i=e(4234),o=e(6420),c=e(9088).f,u=e(6965);n({target:"Object",stat:!0,forced:!u||i(function(){c(1)}),sham:!u},{getOwnPropertyDescriptor:function(t,r){return c(o(t),r)}})},5037:function(t,r,e){"use strict";var n=e(6565),i=e(6965),o=e(6648),c=e(6420),u=e(9088),a=e(457);n({target:"Object",stat:!0,sham:!i},{getOwnPropertyDescriptors:function(t){for(var r,e,n=c(t),i=u.f,s=o(n),f={},l=0;s.length>l;)void 0!==(e=i(n,r=s[l++]))&&a(f,r,e);return f}})},4706:function(t,r,e){"use strict";var n=e(6565),i=e(9592),o=e(4234),c=e(1620),u=e(1108);n({target:"Object",stat:!0,forced:!i||o(function(){c.f(1)})},{getOwnPropertySymbols:function(t){var r=c.f;return r?r(u(t)):[]}})},7460:function(t,r,e){"use strict";var n=e(6565),i=e(4234),o=e(1108),c=e(3586),u=e(2528);n({target:"Object",stat:!0,forced:i(function(){c(1)}),sham:!u},{getPrototypeOf:function(t){return c(o(t))}})},7771:function(t,r,e){"use strict";var n=e(6565),i=e(1108),o=e(7273);n({target:"Object",stat:!0,forced:e(4234)(function(){o(1)})},{keys:function(t){return o(i(t))}})},4312:function(t,r,e){"use strict";e(6565)({target:"Object",stat:!0},{setPrototypeOf:e(7190)})},6542:function(){},1208:function(t,r,e){"use strict";var n=e(6565),i=e(5408),o=e(6713),c=e(2396),u=e(2562),a=e(289);n({target:"Promise",stat:!0,forced:e(6364)},{allSettled:function(t){var r=this,e=c.f(r),n=e.resolve,s=e.reject,f=u(function(){var e=o(r.resolve),c=[],u=0,s=1;a(t,function(t){var o=u++,a=!1;s++,i(e,r,t).then(function(t){a||(a=!0,c[o]={status:"fulfilled",value:t},--s||n(c))},function(t){a||(a=!0,c[o]={status:"rejected",reason:t},--s||n(c))})}),--s||n(c)});return f.error&&s(f.value),e.promise}})},9472:function(t,r,e){"use strict";var n=e(6565),i=e(5408),o=e(6713),c=e(2396),u=e(2562),a=e(289);n({target:"Promise",stat:!0,forced:e(6364)},{all:function(t){var r=this,e=c.f(r),n=e.resolve,s=e.reject,f=u(function(){var e=o(r.resolve),c=[],u=0,f=1;a(t,function(t){var o=u++,a=!1;f++,i(e,r,t).then(function(t){a||(a=!0,c[o]=t,--f||n(c))},s)}),--f||n(c)});return f.error&&s(f.value),e.promise}})},6669:function(t,r,e){"use strict";var n=e(6565),i=e(5408),o=e(6713),c=e(3068),u=e(2396),a=e(2562),s=e(289),f=e(6364),l="No one promise resolved";n({target:"Promise",stat:!0,forced:f},{any:function(t){var r=this,e=c("AggregateError"),n=u.f(r),f=n.resolve,p=n.reject,v=a(function(){var n=o(r.resolve),c=[],u=0,a=1,v=!1;s(t,function(t){var o=u++,s=!1;a++,i(n,r,t).then(function(t){s||v||(v=!0,f(t))},function(t){s||v||(s=!0,c[o]=t,--a||p(new e(c,l)))})}),--a||p(new e(c,l))});return v.error&&p(v.value),n.promise}})},244:function(t,r,e){"use strict";var n=e(6565),i=e(2558),o=e(2541).CONSTRUCTOR,c=e(1117),u=e(3068),a=e(7764),s=e(9757),f=c&&c.prototype;if(n({target:"Promise",proto:!0,forced:o,real:!0},{catch:function(t){return this.then(void 0,t)}}),!i&&a(c)){var l=u("Promise").prototype.catch;f.catch!==l&&s(f,"catch",l,{unsafe:!0})}},4019:function(t,r,e){"use strict";var n,i,o,c,u=e(6565),a=e(2558),s=e(5484),f=e(8325),l=e(7464),p=e(5408),v=e(9757),h=e(7190),d=e(6802),y=e(7444),g=e(6713),m=e(7764),x=e(7879),w=e(8374),b=e(4900),S=e(3882).set,C=e(5126),A=e(6018),_=e(2562),E=e(4160),k=e(9430),T=e(1117),B=e(2541),D=e(2396),I="Promise",z=B.CONSTRUCTOR,M=B.REJECTION_EVENT,O=B.SUBCLASSING,L=k.getterFor(I),P=k.set,N=T&&T.prototype,j=T,H=N,W=f.TypeError,F=f.document,K=f.process,R=D.f,U=R,q=!!(F&&F.createEvent&&f.dispatchEvent),G="unhandledrejection",Y=function(t){var r;return!(!x(t)||!m(r=t.then))&&r},J=function(t,r){var e,n,i,o=r.value,c=1===r.state,u=c?t.ok:t.fail,a=t.resolve,s=t.reject,f=t.domain;try{u?(c||(2===r.rejection&&$(r),r.rejection=1),!0===u?e=o:(f&&f.enter(),e=u(o),f&&(f.exit(),i=!0)),e===t.promise?s(new W("Promise-chain cycle")):(n=Y(e))?p(n,e,a,s):a(e)):s(o)}catch(t){f&&!i&&f.exit(),s(t)}},V=function(t,r){t.notified||(t.notified=!0,C(function(){for(var e,n=t.reactions;e=n.get();)J(e,t);t.notified=!1,r&&!t.rejection&&X(t)}))},Z=function(t,r,e){var n,i;q?((n=F.createEvent("Event")).promise=r,n.reason=e,n.initEvent(t,!1,!0),f.dispatchEvent(n)):n={promise:r,reason:e},!M&&(i=f["on"+t])?i(n):t===G&&A("Unhandled promise rejection",e)},X=function(t){p(S,f,function(){var r,e=t.facade,n=t.value;if(Q(t)&&(r=_(function(){s?K.emit("unhandledRejection",n,e):Z(G,e,n)}),t.rejection=s||Q(t)?2:1,r.error))throw r.value})},Q=function(t){return 1!==t.rejection&&!t.parent},$=function(t){p(S,f,function(){var r=t.facade;s?K.emit("rejectionHandled",r):Z("rejectionhandled",r,t.value)})},tt=function(t,r,e){return function(n){t(r,n,e)}},rt=function(t,r,e){t.done||(t.done=!0,e&&(t=e),t.value=r,t.state=2,V(t,!0))},et=function(t,r,e){if(!t.done){t.done=!0,e&&(t=e);try{if(t.facade===r)throw new W("Promise can't be resolved itself");var n=Y(r);n?C(function(){var e={done:!1};try{p(n,r,tt(et,e,t),tt(rt,e,t))}catch(r){rt(e,r,t)}}):(t.value=r,t.state=1,V(t,!1))}catch(r){rt({done:!1},r,t)}}};if(z&&(H=(j=function(t){w(this,H),g(t),p(n,this);var r=L(this);try{t(tt(et,r),tt(rt,r))}catch(t){rt(r,t)}}).prototype,(n=function(t){P(this,{type:I,done:!1,notified:!1,parent:!1,reactions:new E,rejection:!1,state:0,value:null})}).prototype=v(H,"then",function(t,r){var e=L(this),n=R(b(this,j));return e.parent=!0,n.ok=!m(t)||t,n.fail=m(r)&&r,n.domain=s?K.domain:void 0,0===e.state?e.reactions.add(n):C(function(){J(n,e)}),n.promise}),i=function(){var t=new n,r=L(t);this.promise=t,this.resolve=tt(et,r),this.reject=tt(rt,r)},D.f=R=function(t){return t===j||t===o?new i(t):U(t)},!a&&m(T)&&N!==Object.prototype)){c=N.then,O||v(N,"then",function(t,r){var e=this;return new j(function(t,r){p(c,e,t,r)}).then(t,r)},{unsafe:!0});try{delete N.constructor}catch(t){}h&&h(N,H)}u({global:!0,constructor:!0,wrap:!0,forced:z},{Promise:j}),o=l.Promise,d(j,I,!1,!0),y(I)},5956:function(t,r,e){"use strict";var n=e(6565),i=e(2558),o=e(1117),c=e(4234),u=e(3068),a=e(7764),s=e(4900),f=e(1675),l=e(9757),p=o&&o.prototype;if(n({target:"Promise",proto:!0,real:!0,forced:!!o&&c(function(){p.finally.call({then:function(){}},function(){})})},{finally:function(t){var r=s(this,u("Promise")),e=a(t);return this.then(e?function(e){return f(r,t()).then(function(){return e})}:t,e?function(e){return f(r,t()).then(function(){throw e})}:t)}}),!i&&a(o)){var v=u("Promise").prototype.finally;p.finally!==v&&l(p,"finally",v,{unsafe:!0})}},9817:function(t,r,e){"use strict";e(4019),e(9472),e(244),e(6206),e(160),e(6035)},6206:function(t,r,e){"use strict";var n=e(6565),i=e(5408),o=e(6713),c=e(2396),u=e(2562),a=e(289);n({target:"Promise",stat:!0,forced:e(6364)},{race:function(t){var r=this,e=c.f(r),n=e.reject,s=u(function(){var c=o(r.resolve);a(t,function(t){i(c,r,t).then(e.resolve,n)})});return s.error&&n(s.value),e.promise}})},160:function(t,r,e){"use strict";var n=e(6565),i=e(2396);n({target:"Promise",stat:!0,forced:e(2541).CONSTRUCTOR},{reject:function(t){var r=i.f(this);return(0,r.reject)(t),r.promise}})},6035:function(t,r,e){"use strict";var n=e(6565),i=e(3068),o=e(2558),c=e(1117),u=e(2541).CONSTRUCTOR,a=e(1675),s=i("Promise"),f=o&&!u;n({target:"Promise",stat:!0,forced:o||u},{resolve:function(t){return a(f&&this===s?c:this,t)}})},5922:function(t,r,e){"use strict";var n=e(6565),i=e(8325),o=e(5262),c=e(8425),u=e(2396),a=e(6713),s=e(2562),f=i.Promise,l=!1;n({target:"Promise",stat:!0,forced:!f||!f.try||s(function(){f.try(function(t){l=8===t},8)}).error||!l},{try:function(t){var r=arguments.length>1?c(arguments,1):[],e=u.f(this),n=s(function(){return o(a(t),void 0,r)});return(n.error?e.reject:e.resolve)(n.value),e.promise}})},897:function(t,r,e){"use strict";var n=e(6565),i=e(2396);n({target:"Promise",stat:!0},{withResolvers:function(){var t=i.f(this);return{promise:t.promise,resolve:t.resolve,reject:t.reject}}})},3847:function(){},9266:function(t,r,e){"use strict";e(6999)("Set",function(t){return function(){return t(this,arguments.length?arguments[0]:void 0)}},e(8487))},9361:function(t,r,e){"use strict";var n=e(6565),i=e(4923),o=e(4234);n({target:"Set",proto:!0,real:!0,forced:!e(3727)("difference",function(t){return 0===t.size})||o(function(){var t={size:1,has:function(){return!0},keys:function(){var t=0;return{next:function(){var e=t++>1;return r.has(1)&&r.clear(),{done:e,value:2}}}}},r=new Set([1,2,3,4]);return 3!==r.difference(t).size})},{difference:i})},4175:function(t,r,e){"use strict";var n=e(6565),i=e(4234),o=e(2353);n({target:"Set",proto:!0,real:!0,forced:!e(3727)("intersection",function(t){return 2===t.size&&t.has(1)&&t.has(2)})||i(function(){return"3,2"!==String(Array.from(new Set([1,2,3]).intersection(new Set([3,2]))))})},{intersection:o})},5330:function(t,r,e){"use strict";var n=e(6565),i=e(1122);n({target:"Set",proto:!0,real:!0,forced:!e(3727)("isDisjointFrom",function(t){return!t})},{isDisjointFrom:i})},2991:function(t,r,e){"use strict";var n=e(6565),i=e(6241);n({target:"Set",proto:!0,real:!0,forced:!e(3727)("isSubsetOf",function(t){return t})},{isSubsetOf:i})},4936:function(t,r,e){"use strict";var n=e(6565),i=e(352);n({target:"Set",proto:!0,real:!0,forced:!e(3727)("isSupersetOf",function(t){return!t})},{isSupersetOf:i})},3276:function(t,r,e){"use strict";e(9266)},1631:function(t,r,e){"use strict";var n=e(6565),i=e(6417),o=e(8436);n({target:"Set",proto:!0,real:!0,forced:!e(3727)("symmetricDifference")||!o("symmetricDifference")},{symmetricDifference:i})},4851:function(t,r,e){"use strict";var n=e(6565),i=e(7885),o=e(8436);n({target:"Set",proto:!0,real:!0,forced:!e(3727)("union")||!o("union")},{union:i})},7964:function(t,r,e){"use strict";var n=e(6565),i=e(9321),o=e(364),c=e(2653),u=e(2722),a=e(7153),s=i("".indexOf);n({target:"String",proto:!0,forced:!a("includes")},{includes:function(t){return!!~s(u(c(this)),u(o(t)),arguments.length>1?arguments[1]:void 0)}})},6971:function(t,r,e){"use strict";var n=e(412).charAt,i=e(2722),o=e(9430),c=e(3209),u=e(6808),a="String Iterator",s=o.set,f=o.getterFor(a);c(String,"String",function(t){s(this,{type:a,string:i(t),index:0})},function(){var t,r=f(this),e=r.string,i=r.index;return i>=e.length?u(void 0,!0):(t=n(e,i),r.index+=t.length,u(t,!1))})},9725:function(t,r,e){"use strict";var n,i=e(6565),o=e(8707),c=e(9088).f,u=e(6147),a=e(2722),s=e(364),f=e(2653),l=e(7153),p=e(2558),v=o("".slice),h=Math.min,d=l("startsWith");i({target:"String",proto:!0,forced:!!(p||d||(n=c(String.prototype,"startsWith"),!n||n.writable))&&!d},{startsWith:function(t){var r=a(f(this));s(t);var e=a(t),n=u(h(arguments.length>1?arguments[1]:void 0,r.length));return v(r,n,n+e.length)===e}})},8344:function(t,r,e){"use strict";e(8180)("asyncDispose")},767:function(t,r,e){"use strict";e(8180)("asyncIterator")},4536:function(t,r,e){"use strict";var n=e(6565),i=e(8325),o=e(5408),c=e(9321),u=e(2558),a=e(6965),s=e(9592),f=e(4234),l=e(9338),p=e(2874),v=e(386),h=e(6420),d=e(7184),y=e(2722),g=e(2315),m=e(6305),x=e(7273),w=e(4085),b=e(9245),S=e(1620),C=e(9088),A=e(6042),_=e(774),E=e(3128),k=e(9757),T=e(9933),B=e(3234),D=e(320),I=e(5132),z=e(953),M=e(882),O=e(4386),L=e(8180),P=e(6285),N=e(6802),j=e(9430),H=e(6672).forEach,W=D("hidden"),F="Symbol",K="prototype",R=j.set,U=j.getterFor(F),q=Object[K],G=i.Symbol,Y=G&&G[K],J=i.RangeError,V=i.TypeError,Z=i.QObject,X=C.f,Q=A.f,$=b.f,tt=E.f,rt=c([].push),et=B("symbols"),nt=B("op-symbols"),it=B("wks"),ot=!Z||!Z[K]||!Z[K].findChild,ct=function(t,r,e){var n=X(q,r);return n&&delete q[r],Q(t,r,e),n&&t!==q&&Q(q,r,n),t},ut=a&&f(function(){return 7!==m(Q({},"a",{get:function(){return Q(this,"a",{value:7}).a}})).a})?ct:Q,at=function(t,r){var e=et[t]=m(Y);return R(e,{type:F,tag:t,description:r}),a||(e.description=r),e},st=function(t,r,e){t===q&&st(nt,r,e),v(t);var n=d(r);return v(e),l(et,n)?(("enumerable"in e?!e.enumerable:!l(t,n)||l(t,W)&&t[W][n])?(l(t,W)||Q(t,W,g(1,m(null))),t[W][n]=!0):(l(t,W)&&t[W][n]&&(t[W][n]=!1),e=m(e,{enumerable:g(0,!1)})),ut(t,n,e)):Q(t,n,e)},ft=function(t,r){v(t);var e=h(r),n=x(e).concat(ht(e));return H(n,function(r){a&&!o(lt,e,r)||st(t,r,e[r])}),t},lt=function(t){var r=d(t),e=o(tt,this,r);return!(this===q&&l(et,r)&&!l(nt,r))&&(!(e||!l(this,r)||!l(et,r)||l(this,W)&&this[W][r])||e)},pt=function(t,r){var e=h(t),n=d(r);if(e!==q||!l(et,n)||l(nt,n)){var i=X(e,n);return!i||!l(et,n)||l(e,W)&&e[W][n]||(i.enumerable=!0),i}},vt=function(t){var r=$(h(t)),e=[];return H(r,function(t){l(et,t)||l(I,t)||rt(e,t)}),e},ht=function(t){var r=t===q,e=$(r?nt:h(t)),n=[];return H(e,function(t){!l(et,t)||r&&!l(q,t)||rt(n,et[t])}),n};s||(G=function(){if(p(Y,this))throw new V("Symbol is not a constructor");var t=arguments.length&&void 0!==arguments[0]?y(arguments[0]):void 0,r=z(t),e=function(t){var n=void 0===this?i:this;n===q&&o(e,nt,t),l(n,W)&&l(n[W],r)&&(n[W][r]=!1);var c=g(1,t);try{ut(n,r,c)}catch(t){if(!(t instanceof J))throw t;ct(n,r,c)}};return a&&ot&&ut(q,r,{configurable:!0,set:e}),at(r,t)},k(Y=G[K],"toString",function(){return U(this).tag}),k(G,"withoutSetter",function(t){return at(z(t),t)}),E.f=lt,A.f=st,_.f=ft,C.f=pt,w.f=b.f=vt,S.f=ht,O.f=function(t){return at(M(t),t)},a&&(T(Y,"description",{configurable:!0,get:function(){return U(this).description}}),u||k(q,"propertyIsEnumerable",lt,{unsafe:!0}))),n({global:!0,constructor:!0,wrap:!0,forced:!s,sham:!s},{Symbol:G}),H(x(it),function(t){L(t)}),n({target:F,stat:!0,forced:!s},{useSetter:function(){ot=!0},useSimple:function(){ot=!1}}),n({target:"Object",stat:!0,forced:!s,sham:!a},{create:function(t,r){return void 0===r?m(t):ft(m(t),r)},defineProperty:st,defineProperties:ft,getOwnPropertyDescriptor:pt}),n({target:"Object",stat:!0,forced:!s},{getOwnPropertyNames:vt}),P(),N(G,F),I[W]=!0},8958:function(){},4893:function(t,r,e){"use strict";e(8180)("dispose")},8091:function(t,r,e){"use strict";var n=e(6565),i=e(3068),o=e(9338),c=e(2722),u=e(3234),a=e(1657),s=u("string-to-symbol-registry"),f=u("symbol-to-string-registry");n({target:"Symbol",stat:!0,forced:!a},{for:function(t){var r=c(t);if(o(s,r))return s[r];var e=i("Symbol")(r);return s[r]=e,f[e]=r,e}})},1298:function(t,r,e){"use strict";e(8180)("hasInstance")},1979:function(t,r,e){"use strict";e(8180)("isConcatSpreadable")},4632:function(t,r,e){"use strict";e(8180)("iterator")},6430:function(t,r,e){"use strict";e(4536),e(8091),e(9981),e(1247),e(4706)},9981:function(t,r,e){"use strict";var n=e(6565),i=e(9338),o=e(6072),c=e(4750),u=e(3234),a=e(1657),s=u("symbol-to-string-registry");n({target:"Symbol",stat:!0,forced:!a},{keyFor:function(t){if(!o(t))throw new TypeError(c(t)+" is not a symbol");if(i(s,t))return s[t]}})},4099:function(t,r,e){"use strict";e(8180)("matchAll")},5021:function(t,r,e){"use strict";e(8180)("match")},1220:function(t,r,e){"use strict";e(8180)("replace")},1230:function(t,r,e){"use strict";e(8180)("search")},7134:function(t,r,e){"use strict";e(8180)("species")},1652:function(t,r,e){"use strict";e(8180)("split")},9635:function(t,r,e){"use strict";var n=e(8180),i=e(6285);n("toPrimitive"),i()},664:function(t,r,e){"use strict";var n=e(3068),i=e(8180),o=e(6802);i("toStringTag"),o(n("Symbol"),"Symbol")},4339:function(t,r,e){"use strict";e(8180)("unscopables")},1965:function(t,r,e){"use strict";e(2688)},177:function(t,r,e){"use strict";var n=e(882),i=e(6042).f,o=n("metadata"),c=Function.prototype;void 0===c[o]&&i(c,o,{value:null})},5453:function(t,r,e){"use strict";e(1208)},6444:function(t,r,e){"use strict";e(6669)},9439:function(t,r,e){"use strict";e(5922)},7014:function(t,r,e){"use strict";e(897)},863:function(t,r,e){"use strict";e(8344)},9131:function(t,r,e){"use strict";e(8180)("customMatcher")},5078:function(t,r,e){"use strict";e(4893)},3129:function(t,r,e){"use strict";e(6565)({target:"Symbol",stat:!0},{isRegisteredSymbol:e(4317)})},8839:function(t,r,e){"use strict";e(6565)({target:"Symbol",stat:!0,name:"isRegisteredSymbol"},{isRegistered:e(4317)})},6863:function(t,r,e){"use strict";e(6565)({target:"Symbol",stat:!0,forced:!0},{isWellKnownSymbol:e(9071)})},3650:function(t,r,e){"use strict";e(6565)({target:"Symbol",stat:!0,name:"isWellKnownSymbol",forced:!0},{isWellKnown:e(9071)})},8409:function(t,r,e){"use strict";e(8180)("matcher")},8672:function(t,r,e){"use strict";e(8180)("metadataKey")},2306:function(t,r,e){"use strict";e(8180)("metadata")},5030:function(t,r,e){"use strict";e(8180)("observable")},8781:function(t,r,e){"use strict";e(8180)("patternMatch")},5049:function(t,r,e){"use strict";e(8180)("replaceAll")},3146:function(t,r,e){"use strict";e(7529);var n=e(7069),i=e(8325),o=e(6802),c=e(7204);for(var u in n)o(i[u],u),c[u]=c.Array},504:function(t,r,e){"use strict";var n=e(6565),i=e(8325),o=e(6619)(i.setInterval,!0);n({global:!0,bind:!0,forced:i.setInterval!==o},{setInterval:o})},9850:function(t,r,e){"use strict";var n=e(6565),i=e(8325),o=e(6619)(i.setTimeout,!0);n({global:!0,bind:!0,forced:i.setTimeout!==o},{setTimeout:o})},1396:function(t,r,e){"use strict";e(504),e(9850)},4152:function(t,r,e){"use strict";var n=e(337);t.exports=n},5904:function(t,r,e){"use strict";var n=e(9373);t.exports=n},3505:function(t,r,e){"use strict";var n=e(6306);e(3146),t.exports=n},2483:function(t,r,e){"use strict";var n=e(8980);t.exports=n},6200:function(t,r,e){"use strict";var n=e(2015);t.exports=n},94:function(t,r,e){"use strict";var n=e(3413);t.exports=n},41:function(t,r,e){"use strict";var n=e(686);t.exports=n},1790:function(t,r,e){"use strict";var n=e(9233);t.exports=n},5976:function(t,r,e){"use strict";var n=e(1153);t.exports=n},8652:function(t,r,e){"use strict";var n=e(2115);t.exports=n},8748:function(t,r,e){"use strict";var n=e(7593);t.exports=n},6568:function(t,r,e){"use strict";var n=e(4493);t.exports=n},6624:function(t,r,e){"use strict";var n=e(3507);t.exports=n},176:function(t,r,e){"use strict";var n=e(3887);t.exports=n},1590:function(t,r,e){"use strict";var n=e(2119);t.exports=n},871:function(t,r,e){"use strict";var n=e(6706);t.exports=n},6226:function(t,r,e){"use strict";var n=e(8967);t.exports=n},1960:function(t,r,e){"use strict";var n=e(1676);t.exports=n},7185:function(t,r,e){"use strict";var n=e(5752);t.exports=n},9722:function(t,r,e){"use strict";var n=e(9651);t.exports=n},2803:function(t,r,e){"use strict";var n=e(7146);t.exports=n},6870:function(t,r,e){"use strict";var n=e(3417);t.exports=n},7493:function(t,r,e){"use strict";var n=e(7222);t.exports=n},8899:function(t,r,e){"use strict";var n=e(9328);t.exports=n},7072:function(t,r,e){"use strict";var n=e(6479);t.exports=n},7767:function(t,r,e){"use strict";var n=e(5100);t.exports=n},7762:function(t,r,e){"use strict";var n=e(2173);e(3146),t.exports=n},2514:function(t,r,e){"use strict";e(1396);var n=e(7464);t.exports=n.setTimeout},5955:function(t,r,e){"use strict";var n=e(6084);e(3146),t.exports=n},3004:function(t,r,e){"use strict";var n=e(1219);t.exports=n},4413:function(t,r,e){"use strict";var n=e(6368);e(3146),t.exports=n},5811:function(t,r,e){"use strict";var n=e(7532);e(3146),t.exports=n},1460:function(t,r,e){"use strict";var n=e(9295);t.exports=n}},r={};function e(n){var i=r[n];if(void 0!==i)return i.exports;var o=r[n]={exports:{}};return t[n].call(o.exports,o,o.exports,e),o.exports}e.n=function(t){var r=t&&t.__esModule?function(){return t.default}:function(){return t};return e.d(r,{a:r}),r},e.d=function(t,r){for(var n in r)e.o(r,n)&&!e.o(t,n)&&Object.defineProperty(t,n,{enumerable:!0,get:r[n]})},e.g=function(){if("object"==typeof globalThis)return globalThis;try{return this||new Function("return this")()}catch(t){if("object"==typeof window)return window}}(),e.o=function(t,r){return Object.prototype.hasOwnProperty.call(t,r)},e.r=function(t){"undefined"!=typeof Symbol&&Symbol.toStringTag&&Object.defineProperty(t,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(t,"__esModule",{value:!0})},function(){"use strict";var t={};e.r(t),e.d(t,{UUID:function(){return dr},consoleError:function(){return vr},getDeviceToken:function(){return yr},getTimestampUTC:function(){return hr},getVerifyType:function(){return Sr},isBoolean:function(){return ar},isEmptyObj:function(){return ir},isFunction:function(){return fr},isNumber:function(){return cr},isObject:function(){return sr},isString:function(){return ur},makeURL:function(){return lr},mergeObjs:function(){return or},parseJSON:function(){return wr},processSecEndpoints:function(){return br},throwError:function(){return pr},updateLog:function(){return xr},wait:function(){return gr}});var r=e(2084),n=e.n(r),i=e(8713),o=e.n(i),c=e(2018),u=e.n(c),a=e(5383),s=e.n(a),f=e(3282),l=e.n(f),p=e(2068),v=e.n(p),h=e(5980),d=e.n(h),y=e(6906),g=e.n(y),m=e(709),x=e.n(m),w=e(2280),b=e.n(w),S=e(6092),C=e.n(S),A=e(8951),_=e.n(A),E=e(4260),k=e.n(E),T=e(5294),B=e.n(T),D=e(7597),I=e.n(D),z=e(3006),M=e.n(z),O=e(8191),L=e.n(O),P=e(2612),N=e.n(P),j=e(8172),H=e.n(j),W=e(4454),F=e.n(W),K=e(8866),R=e.n(K);function U(t){document.body.insertAdjacentHTML("beforeend",function(t){return'  <div id="aliyunCaptcha-common-errorTip" style="    color: #fff;    box-sizing: border-box;    line-height: 1.5;    font-family: aliyun-captcha-iconfont !important;    align-items: center;    background-color: rgba(0, 0, 0, 0.6);    border: 1px solid #e5e5e5;    border-radius: 5px;    display: flex;    flex-direction: column;    justify-content: center;    left: 50%;    padding: 8px 12px;    position: fixed;    top: 45%;    transform: translate(-50%, -50%);    -ms-transform: translate(-50%,-50%);    visibility: visible;    min-width: 210px;    z-index: 10000001;  ">    <div id="aliyunCaptcha-icon-error" style="      background-color: transparent;      border: none;      color: #fff;      font-family: aliyun-captcha-iconfont !important;      font-size: 30px;      outline: none;    " aria-label="\u5237\u65B0\u9A8C\u8BC1\u7801">&#xe67e;</div>    <div class="aliyunCaptcha-common-errorText" style="      color: #fff;      font-family: aliyun-captcha-iconfont !important;      font-size: 18px;    ">{0}</div>  </div>  '.format(t)}(t)),F()(function(){return _r(Ar("#aliyunCaptcha-common-errorTip"))},1500)}function q(t){this._obj=t}q.prototype={_each:function(t){var r=this._obj;for(var e in r)r.hasOwnProperty(e)&&t(e,r[e]);return this},_extend:function(t){var r=this;new q(t)._each(function(t,e){r._obj[t]=e})}},String.prototype.format=function(){var t=arguments;return this.replace(/\\{(\\d+)\\}/g,function(r,e){return t[e]})};var G=lt;function Y(t){var r=lt,e=this;new q(t)[r(477)](function(t,r){e[t]=r})}!function(t){for(var r=505,e=608,n=671,i=615,o=415,c=402,u=482,a=491,s=544,f=397,l=634,p=679,v=lt,h=t();;)try{if(610846===parseInt(v(r))/1*(parseInt(v(e))/2)+-parseInt(v(n))/3+parseInt(v(i))/4+parseInt(v(o))/5*(parseInt(v(c))/6)+-parseInt(v(u))/7*(parseInt(v(a))/8)+-parseInt(v(s))/9*(-parseInt(v(f))/10)+parseInt(v(l))/11*(parseInt(v(p))/12))break;h.push(h.shift())}catch(t){h.push(h.shift())}}(dt);var J={};J.cn=[G(486)+G(614)+G(552)+"m",G(486)+G(518)+G(463)+G(647)],J[G(625)]=[G(486)+G(413)+G(563)+G(463)+G(647),G(486)+G(413)+G(447)+G(612)+G(458)],J.ga=[G(486)+G(559)+G(649)+G(584),G(486)+G(559)+G(631)+G(403)+"om"],J[G(630)]=[G(486)+G(670)+G(645)+G(488),G(486)+G(670)+G(665)+G(584)],J[G(524)]=[G(486)+G(413)+G(668)+G(591)+G(584),G(486)+G(413)+G(668)+G(606)+G(403)+"om"];var V=J,Z={};Z.cn=[G(486)+G(554)+G(612)+G(458),G(486)+G(554)+G(567)+G(454)],Z[G(625)]=[G(486)+G(413)+G(527)+G(439)+G(454),G(486)+G(413)+G(527)+G(549)+G(552)+"m"],Z.ga=[G(486)+G(559)+G(519)+G(540)+G(542)];var X=Z,Q=[G(486)+G(413)+G(563)+G(463)+G(647),G(486)+G(413)+G(447)+G(612)+G(458)],$=[G(486)+G(413)+G(527)+G(439)+G(454),G(486)+G(413)+G(527)+G(549)+G(552)+"m"],tt={};tt.cn=[G(486)+G(476)+G(612)+G(458),G(486)+G(476)+G(567)+G(454)],tt[G(625)]=Q,tt.ga=Q;var rt={};rt[G(481)]=tt,rt[G(555)]=V,rt[G(587)]=V;var et=rt,nt={};nt.cn=[G(486)+G(476)+G(535)+G(552)+"m",G(486)+G(476)+G(588)+G(463)+G(647)],nt[G(625)]=$,nt.ga=$;var it={};it[G(481)]=nt,it[G(555)]=X,it[G(587)]=X;var ot=it,ct={};ct.cn=G(594)+G(423)+G(664)+G(463)+G(407),ct[G(625)]=G(594)+G(423)+G(520)+G(503)+G(473),ct.ga=G(594)+G(423)+G(520)+G(503)+G(473);var ut=ct,at={};at.cn=G(594)+G(423)+G(571)+G(439)+G(473),at[G(625)]=G(594)+G(423)+G(520)+G(650)+G(463)+G(407),at.ga=G(594)+G(423)+G(520)+G(650)+G(463)+G(407);var st=at,ft={};function lt(t,r){var e=dt();return lt=function(r,n){var i=e[r-=396];if(void 0===lt.Hggxtg){lt.qAaHLR=function(t){for(var r,e,n="",i="",o=0,c=0;e=t.charAt(c++);~e&&(r=o%4?64*r+e:e,o++%4)?n+=String.fromCharCode(255&r>>(-2*o&6)):0)e="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=".indexOf(e);for(var u=0,a=n.length;u<a;u++)i+="%"+("00"+n.charCodeAt(u).toString(16)).slice(-2);return decodeURIComponent(i)},t=arguments,lt.Hggxtg=!0}var o=r+e[0],c=t[o];return c?i=c:(i=lt.qAaHLR(i),t[o]=i),i},lt(t,r)}ft[G(501)+"L"]=G(501)+"L",ft[G(561)+"OW"]=G(561)+"OW",ft[G(426)+G(409)]=G(426)+G(409),ft[G(494)]=G(494),ft[G(659)+G(457)]=G(659)+G(457),ft[G(662)]=G(662),ft[G(474)+G(445)]=G(474)+G(445),ft[G(517)+G(483)]=G(517)+G(483),Y[G(675)+"e"]={apiServers:et,apiDevServers:ot,cdnServers:[G(604)+G(542)],cdnDevServers:[G(621)+G(512)],oCdnServers:[G(432)+G(542)],oCdnDevServers:[G(564)+G(512)],imgServer:ut,imgDevServer:st,https:G(594),http:G(616),initPath:"/",devicePath:function(){var t=500,r=651,e=575,n=398,i=648,o=548,c=G,u={};return u[c(t)]=c(r)+c(e)+c(n)+c(i)+c(o),u[c(t)]},captchaJsPath:function(t){var r=433,e=499,n=651,i=575,o=506,c=401,u=489,a=429,s=G,f={};f[s(r)]=function(t,r){return t+r},f[s(e)]=s(n)+s(i)+s(o)+s(c),f[s(u)]=s(a);var l=f;return l[s(r)](l[s(r)](l[s(e)],t),l[s(u)])},captchaCssPath:function(t){var r=637,e=434,n=400,i=651,o=575,c=506,u=401,a=417,s=405,f=646,l=G,p={};p[l(r)]=function(t,r){return t+r},p[l(e)]=function(t,r){return t+r},p[l(n)]=l(i)+l(o)+l(c)+l(u),p[l(a)]=l(s)+"s";var v=p;return v[l(r)](v[l(e)](v[l(n)],t[l(f)]("/")[0]),v[l(a)])},VERSION:"1.3.1",fallbackCount:2,ERR:ft,region:"cn",verifyType:G(555),showErrorTip:U,canInit:!0,logInfo:{},logUploaded:!1,_extend:function(t){var r=G,e=this;new q(t)[r(477)](function(t,r){e[t]=r})}};var pt=G(515)+"05",vt=G(543)+G(531),ht={};function dt(){var t=["DMTjn1frqLG","CMuUywXPExu","y2HHvJm","x2XFs1bmAva","AYSXuLCWy3O","zK9uDuzWAdy","zw5KCg9PBNq","quLox0zbsuW","n0PmC0iXoe0","DgHLyxn0lwi","zwfZDc0XlwC","lNnHzI5HBgK","revwsunfx1u","C291DgHLyxm","ywyUywXPExu","ndjHmte2mtK","BMnZlMnVBq","ovu2s2C2BgO","v0vc","rKfjta","CY5JB20","m2LeAtjsqwi","C2G4n2jKmtu","sff6y2K","zgrOCZaZmdu","BgL5Dw5JCY4","sw5PDenHChq","tKXbB3funKS","y2HHlxDHzG","y2HH","mdnVtgjrwfC","vKvssuzzvJm","C2C1mgm0otu","thHfCLqXC0C","zc9gzwLmAw4","BMnZlMnVBs8","revwsunfx00","ys5KzxzPy2u","ChjVlw9Wzw4","x2vHy2G","ugLwD05TtK8","Dc0XlMfSAxK","sfLWAeu","ms4W","mJH1tuDvyuu","tKLux0zbsuW","nsTmwKPbn3u","tg9NmW","y2fWDgnOys0","y2HHvJi","y3mUy29T","AgPYwwO","yZHHmgjJnte","mtmXnJu1mNnOvvjWCa","AgfUz2HHAs4","qJv6CwDOEuO","ueLdx0zbsuW","ueXpquq","C2HWBevUzha","lxbYzs5HCc0","ChrJAgfwmW","qLbwqNi","DfPiz2W","su5jvf9gquK","tg9NmG","z3aUywXPExu","tg9Nmq","mZDQC2jIq0i","zc9KEw5HBwK","vvbmt0fe","D1PHvvDhqNq","EeXmDY90mtu","AwXPBG","ufjfsuq","AwnKBI5JB20","re5Zs0TquKG","zMfPBa","mJaYmY0WmY0","mu5Muxy5nuu","revwsunfx0K","B3bLBI1IlMe","D2vIlxbYzs4","yxb0y2HHlxm","BJLQsdb5qum","x2nFv0jlrLi","mtKXmeryzty","C2DWx2r1ywW","Ac1KzxzPy2u","y24TC2HHBMC","DgHLyxn0lxa","zdm1zgi3ztm","C3vJy2vZCW","vM83mxv6v2S","vLLKruDWD2i","zgv2AwnLlNm","yxbWs2v5","ms5HBgL5Dw4","lxbYzs5HBgK","z205ugHiDLm","B2LUDhm","vMvYAwz5q2e","vNPzpq","ywXPExvUy3m","nJqZzJKXmZK","lMnVBq","rNfkqJzPuK4","ou5Ju2vAEa","mJaYmc0Xmc0","y2uUC2fMlMe","ChjLlwnUlxm","BI5QCW","CMuTyI5HBgK","lteUzgv2Awm","owC4ytbbpt0","ExvUy3mUy28","C2fMlwfSAxK","B3bLBI1WCMu","mI4W","u0DFv0vc","su5jvfyY","zI5HBgL5Dw4","B3bLBI1Nys0","zJG0ztuZzdq","teLnsvrFrKW","n2vMowu4yti","DgHLyxn0lMe","zgv2lM8UywW","mLztm3Pbpt0","C2LOANKXD0O","lwiUywXPExu","rwrhyvj0A2m","zwfZDc0XlMq","A2PNq3rtnMu","yxb0y2HHlxa","te9h","vfDKyKG","uKvjra","lwzYB250zw4","thzjB0eVrJy","su5jva","ywiWmZrLyZa","uKvt","C2fMlwnHChq","owvImZnLmdy","mKiWpq","ogzNCZe2ogi","Dw5JCY5JB20","yxbWtMfTzq","yMmYnwy3ody","mY4W","lxbYzs1IlMe","ofPWDNPhqLG","u3PHrNrgBe4","DwfSlMfSAxK","yI9RC0PdCKm","Dw1KnYTlBK8","Ahr0Chm6lY8","wwv4m1DHsgq","qY9Jm1flELq","yJqWntGWm2e","yxb0y2HHlw8","q2jVpq","CgvUlMfSAxK","uKvr","vdy4EgnwDu8","r2fZpq","zY5HBgLJzg4","ChrJAgfwmG","DwfSlwiUywW","v0vcx1bsruK","mJm4ntztEe5nB1C","q09nqKfux1u","uNjlq2TbDxG","C2GZyZq3ytG","lMfSAxL1BMm","D3D3lMfSAxK","B3bLBI5HBgK","mJGYmtaWnhbUEMr1BG","Ahr0CdOVlW","odnMnwu1nde","su5jvfyZ","zwqZodfHyZK","uYTXs1vIsMK","zgv2lMCUywW","vxbSB2fKtg8","ttb2n3u0nsS","Dw4Uy29TlW","C2DW","yxaTC291DgG","yuf6rNy","yw5NAgfPlMe","CJrXA3reDtC","y25FzhvHBa","D2vIlwiUywW","y2SUyxaTC28","DgfqsgTdk1q","mtfyqwXAqw0","yZbHzdC5odm","mdeWodmXmdu","Dfvksfu","BM93","mtjOC2iWm2m","rJb0sJnKCZq","B3v0AgvHC3q","Cgjhl2jJoxG","y2XVDwrHDxq","vZiWmJiWmJa","Bc5HBgL5Dw4","C3bSAxq","y29T","rLaVzNaUBwK","D2vIlMfSAxK","z3aTChjLlMe","l2nHChrJAge","u0DFv0vcx1a","vKjNpq","u0vduKvu","yKm2wvvHwgK","AgvHC3qTms4","y2SUy24TC2G","lwr1ywXZDge","uKvguKvtsf8","mZa3zgjLmZi","lZfZy0jIy2i","t1rirvi","zZnfpq","yxb0y2HHlMe","Bc1IlMfSAxK","lMfWlxnVDxq","ChjLlwfWlxm","DgHLyxn0lwq","owvIyMyZzda","B3bLBI1KDwe","mZm2ndy5mLLztxDRsW","DxrOzwfZDc0","Dw4Ty29T","zxzPy2uUC2e","ChjVDg90Exa","otvIyZG5nwm","mc4WlJaVzMu","z3jnpq","mti1nZy1odHXswLvzg0","m3Hmt2TWAem","AgfPlMrLDMK","uKrMr2L5Au0","qw94EJbIn3y","l2jMB3PJu3O","mtuZntG3mhHPAK1qva","zc9HBgL5Dw4","oeTTseLrC2m","qMHyuem","y0PtlW","nKD2whLAzq","AxL1BMnZlMm","BezPmJngBuq","l21HAw4Uy3m","vY4XmdaWms4","y29TlW","EJjRpq","u19gquLm","vZHzCMDpqMm","k2zsoxrzEMW","C2C2m2mWyta","B3bLBI1ZB3u","ou5OBLfrk0W","mJeYmZe1q21cAgzb","zs5ZywyUywW","B2HLBe8","zgv2AwnLlMm","wdf5nvzZDgi","BKe3r1GZzdy","Dej3BwLywhC","rKXbrW","C3rHDgLJlwm","vKvssuzz","C3mWpq","rfLoqu1jq0O","u1vdq0vtuW","mMrJn2zHzte","lMPZ","twzbpq","mZC5nwqYodi","BY5HBgLJzg4","sKvpu28","wvHMww4","owzlEcT5BxG","s0zYmdDWrwi","mZrNC2yZzJm"];return(dt=function(){return t})()}ht.ID=G(446)+G(420)+G(471)+G(602)+G(683)+G(539),ht[G(654)]=G(521)+G(410)+G(623)+G(396)+G(589)+G(663);var yt=ht,gt=(G(513),G(443),G(633),G(655),G(516),G(408),G(528)+G(669)+G(636)),mt={};mt[G(577)]=G(464)+G(467),mt[G(557)]=G(464)+G(487),mt[G(618)]=G(464)+G(440),mt[G(424)]=G(538)+G(605),mt[G(469)]=G(538)+G(498),mt[G(572)]=G(622)+"g";var xt=mt,wt={};wt[G(427)]=G(529),wt[G(457)]=G(514);var bt=wt,St=(G(594),G(613),G(624),G(412)+G(437)+G(619)+G(490)),Ct=G(431)+G(453)+G(586)+G(560),At=[G(594)+G(643)+G(525)+G(658)+G(632)+G(672)+G(534)+G(488),G(594)+G(626)+G(569)+G(674)+G(558)+G(488)],_t=[G(594)+G(626)+G(448)+G(475)+G(449)+G(552)+"m",G(594)+G(643)+G(525)+G(658)+G(632)+G(672)+G(534)+G(488)],Et=[G(594)+G(643)+G(525)+G(658)+G(657)+G(628)+G(463)+G(647),G(594)+G(526)+G(681)+G(546)+G(463)+G(647)],kt=[G(594)+G(418)+G(598)+G(600)+G(584)],Tt={};Tt.cn=G(578)+G(541)+G(581)+G(428),Tt[G(625)]=Ct,Tt.ga=Ct;var Bt=Tt,Dt={};Dt.cn=kt,Dt[G(625)]=At,Dt.ga=At;var It=Dt,zt={};zt.cn=Et,zt[G(625)]=At,zt.ga=_t;var Mt=zt,Ot={};Ot.cn=[G(594)+G(526)+G(681)+G(546)+G(463)+G(647)],Ot[G(625)]=[G(594)+G(626)+G(569)+G(674)+G(558)+G(488)],Ot.ga=[G(594)+G(626)+G(448)+G(475)+G(449)+G(552)+"m"];var Lt=Ot,Pt={};Pt[G(481)]=G(580)+G(466),Pt[G(555)]=G(580)+G(467),Pt[G(587)]=G(580)+G(467);var Nt=Pt,jt={};jt.cn=G(460)+G(639)+G(597)+G(660),jt[G(625)]=St,jt.ga=St;var Ht={};Ht[G(481)]=jt,Ht[G(555)]=Bt,Ht[G(587)]=Bt;var Wt={};Wt[G(481)]=It,Wt[G(555)]=Mt,Wt[G(587)]=Mt;var Ft={};Ft[G(481)]=It,Ft[G(555)]=Lt,Ft[G(587)]=Lt;var Kt={};Kt[G(585)]=Nt,Kt[G(533)]=Ht,Kt[G(444)+"s"]=Wt,Kt[G(496)+G(537)]=Ft;var Rt=Kt,Ut={};Ut.cn=G(611)+G(462)+G(562)+G(676),Ut[G(625)]=G(470)+G(583)+G(635)+G(617);var qt={};qt.cn=[G(594)+G(643)+G(525)+G(535)+G(552)+"m",G(594)+G(547)+G(492)+G(532)+G(452)+G(454)],qt[G(625)]=[G(594)+G(643)+G(525)+G(497)+G(451)+G(479)+G(584),G(594)+G(667)+G(641)+G(550)+G(416)+G(403)+"om"];var Gt={};Gt[G(585)]=Nt,Gt[G(533)]=Ut,Gt[G(444)+"s"]=qt;var Yt=Gt;function Jt(t){var r=G,e=this;new q(t)[r(477)](function(t,r){e[t]=r})}var Vt={};Vt[G(456)]="W";var Zt={};Zt.ID=G(421)+G(568)+G(576)+G(629)+G(404)+G(599),Zt[G(654)]=G(455)+G(536)+G(566)+G(530)+G(682)+G(653);var Xt={};Xt[G(601)]=G(399)+G(484)+G(595)+G(570)+G(642)+G(425),Xt[G(579)]=G(414)+G(610)+G(508)+G(590)+G(592)+G(678),Xt[G(422)]=G(442)+G(459)+G(596)+G(478)+G(523)+G(603),Xt[G(507)]=G(411)+G(436)+G(593)+G(680)+G(620)+G(430),Xt[G(511)]=G(509)+G(438)+G(661)+G(435)+G(640)+G(582);var Qt={};Qt[G(577)]=G(504),Qt[G(450)+G(495)]=G(502),Qt[G(609)+G(495)]=G(485);var $t={};$t[G(427)]=G(529),$t[G(457)]=G(514);var tr={};tr.CN=G(456),tr.SG=G(556);var rr={};rr.CN=G(607)+"D",rr.SG=G(652)+G(574),Jt[G(675)+"e"]={ENDPOINTS:[G(594)+G(643)+G(525)+G(612)+G(458)],CN_DEFAULT_ENDPOINTS:[G(594)+G(643)+G(525)+G(612)+G(458)],INTL_DEFAULT_ENDPOINTS:[G(594)+G(643)+G(525)+G(666)+G(656)+G(540)+G(542)],CN_ENDPOINTS:Et,INTL_ENDPOINTS:At,WAF_ENDPOINTS:[G(594)+G(418)+G(598)+G(600)+G(584)],cdnServers:[G(604)+G(542)],cdnDevServers:[G(621)+G(512)],dynamicJsPath:function(t){var r=627,e=461,n=651,i=575,o=472,c=480,u=429,a=573,s=461,f=480,l=G,p={};p[l(573)]=function(t,r){return t+r},p[l(r)]=function(t,r){return t+r},p[l(e)]=l(n)+l(i)+l(o)+"/",p[l(c)]=l(u);var v=p;return v[l(a)](v[l(r)](v[l(s)],t),v[l(f)])},fallbackVersion:G(677)+G(510),https:G(594),http:G(616),API_VERSION:G(545)+"15",APP_VERSION:G(644)+"2",PLATFORM:G(406)+"c",APP_NAME:G(553)+G(673),DEVICE_TYPE:Vt,APP_KEY:G(578)+G(541)+G(581)+G(428),ACCESS_KEY:Zt,WEB_AES_SECRET_KEY:Xt,AES_IV:G(528)+G(669)+G(636),SALT:G(465)+G(468)+G(565),SESSION_ID_SALT:G(419)+G(493)+G(551),ACCESS_SEC:G(543)+G(531),ACTION:Qt,ACTION_STATE:$t,WEB_REGION:tr,WEB_REGION_PREID:rr,UID_NAME_COOKIE:G(522)+"o",UID_NAME_LOCAL:G(441)+"s",initTime:Date[G(638)](),preCollectData:{},logs:[],_extend:function(t){var r=G,e=this;new q(t)[r(477)](function(t,r){e[t]=r})}};var er=new Y({}),nr=new Jt;function ir(t){for(var r in t)if(Object.prototype.hasOwnProperty.call(t,r))return!1;return M()(t)===M()({})}function or(t,r){var e={};for(var n in t)e[n]=t[n];for(var i in r)e[i]=r[i];return e}var cr=function(t){return"number"==typeof t},ur=function(t){return"string"==typeof t},ar=function(t){return"boolean"==typeof t},sr=function(t){return"object"===_()(t)&&null!==t},fr=function(t){return"function"==typeof t},lr=function(t,r,e,n){r=function(t){return t.replace(/^https?:\\/\\/|\\/$/g,"")}(r);var i=function(t){return t=t.replace(/\\/+/g,"/"),0!==R()(t).call(t,"/")&&(t="/"+t),t}(e)+function(t){if(!t)return"";var r="?";return new q(t)._each(function(t,e){(ur(e)||cr(e)||ar(e))&&(r=r+encodeURIComponent(t)+"="+encodeURIComponent(e)+"&")}),"?"===r&&(r=""),r.replace(/&$/,"")}(n);return r&&(i=t+r+i),i},pr=function(t){throw new Error({networkError:"Network Error"}[t])},vr=function(t){var r,e,n,i=arguments.length>1&&void 0!==arguments[1]?arguments[1]:"",o={paramsError:"".concat(i,"\u4F20\u5165\u53C2\u6570\u7C7B\u578B\u4E0D\u5408\u6CD5\uFF0C\u8BF7\u53C2\u7167\u6587\u6863\u4F20\u5165\u5BF9\u5E94\u7C7B\u578B\u7684\u503C\u3002"),languageError:"language\u53C2\u6570\u4F20\u5165\u503C\u4E0D\u5408\u6CD5\uFF0C\u8BF7\u53C2\u89C1\u9A8C\u8BC1\u78012.0\u652F\u6301\u7684\u8BED\u8A00\u3002",regionError:"region\u53C2\u6570\u4F20\u5165\u503C\u4E0D\u5408\u6CD5\uFF0C\u8BF7\u53C2\u89C1region\u53C2\u6570\u8BF4\u660E\u68C0\u67E5\u6B64\u53C2\u6570\u662F\u5426\u7B26\u5408\u8981\u6C42\u3002",modeError:"mode\u53C2\u6570\u4F20\u5165\u503C\u9519\u8BEF\uFF0C\u76EE\u524D\u652F\u6301\u5F39\u51FA\u5F0F\uFF08popup\uFF09\u548C\u5D4C\u5165\u5F0F\uFF08embed\uFF09\u3002\u8BF7\u53C2\u89C1mode\u53C2\u6570\u8BF4\u660E\u68C0\u67E5\u6B64\u53C2\u6570\u662F\u5426\u7B26\u5408\u8981\u6C42\u3002",elementError:N()(r=N()(e=N()(n="".concat(i,"\u53C2\u6570\u4F20\u5165\u503C\u4E0D\u5408\u6CD5\uFF0C\u8BF7\u786E\u4FDD")).call(n,i,"\u5143\u7D20\u5728\u9875\u9762\u4E2D\u5B58\u5728\uFF0C\u4E14")).call(e,i,"\u53C2\u6570\u548C\u9875\u9762\u4E0A\u7684")).call(r,i,"\u5143\u7D20\u7684id\u9009\u62E9\u5668\u76F8\u5339\u914D\u3002")};console.error(o[t])};function hr(){var t=new Date,r=function(t){return(t<10?"0":"")+t};return t.getUTCFullYear()+"-"+r(t.getUTCMonth()+1)+"-"+r(t.getUTCDate())+"T"+r(t.getUTCHours())+":"+r(t.getUTCMinutes())+":"+r(t.getUTCSeconds())+"Z"}function dr(){var t,r,e="";for(t=0;t<32;t++)r=16*Math.random()|0,8!==t&&12!==t&&16!==t&&20!==t||(e+="-"),e+=(12===t?4:16===t?3&r|8:r).toString(16);return e}function yr(){try{var t=window.z_um||window.um;return t&&t.getToken?t.getToken():void 0}catch(t){return}}function gr(t,r){return mr.apply(this,arguments)}function mr(){return(mr=k()(L().mark(function t(r,e){return L().wrap(function(t){for(;;)switch(t.prev=t.next){case 0:return t.abrupt("return",new(I())(function(t){return F()(t,r,e)}));case 1:case"end":return t.stop()}},t)}))).apply(this,arguments)}function xr(t,r){var e=er.logInfo;e[t]=r,er._extend({logInfo:e})}function wr(t){var r,e=arguments.length>1&&void 0!==arguments[1]?arguments[1]:{};try{r=JSON.parse(t)||e}catch(t){r=e}return r}function br(){var t,r=arguments.length>1?arguments[1]:void 0,e=arguments.length>2?arguments[2]:void 0;return"shpl"===(arguments.length>0&&void 0!==arguments[0]?arguments[0]:"pop")?Rt.shplEndpoints[r][e]:null==Rt||null===(t=Rt.endpoints)||void 0===t?void 0:t[r][e]}function Sr(t){return t.userId||t.userUserId||!t.success||"function"!=typeof t.success||"1.0"===t.verifyType?"1.0"===t.verifyType&&t.success&&"function"==typeof t.success&&t.userId&&t.userUserId?"1.0":"2.0":(er._extend({immediate:!0,UserCertifyId:t.UserCertifyId}),"3.0")}window.__ALIYUN_CAPTCHA_UTILS={isEmptyObj:ir,mergeObjs:or,isNumber:cr,isString:ur,isBoolean:ar,isObject:sr,isFunction:fr,makeURL:lr,throwError:pr,getTimestampUTC:hr,UUID:dr,consoleError:vr};var Cr=document,Ar=function(t){try{return"#"===t[0]?Cr.querySelector(t):null}catch(t){return null}},_r=function(t){var r=null==t?void 0:t.parentNode;try{r&&r.removeChild(t)}catch(t){}};function Er(){return(Er=k()(L().mark(function t(r,e,n){var i;return L().wrap(function(t){for(;;)switch(t.prev=t.next){case 0:if(Cr.body){t.next=2;break}return t.next=1,gr(n);case 1:t.next=0;break;case 2:return i=Cr.createElement("iframe"),t.prev=3,t.next=4,new(I())(function(t,r){var n=!1,o=function(){n=!0,t()};i.onload=o,i.onerror=function(t){n=!0,r(t)};var c=i.style;c.setProperty("display","block","important"),c.position="absolute",c.top="0",c.left="0",c.visibility="hidden",e&&"srcdoc"in i?i.srcdoc=e:i.src="about:blank",Cr.body.appendChild(i);var u=function(){n||("complete"===i.contentWindow.document.readyState?o():F()(u,10))};u()});case 4:if(i.contentWindow.document.body){t.next=6;break}return t.next=5,gr(n);case 5:t.next=4;break;case 6:return t.next=7,r(i,i.contentWindow);case 7:return t.abrupt("return",t.sent);case 8:t.prev=8;try{i.parentNode.removeChild(i)}catch(t){}return t.finish(8);case 9:case"end":return t.stop()}},t,null,[[3,,8,9]])}))).apply(this,arguments)}function kr(t,r){var e=void 0!==g()&&x()(t)||t["@@iterator"];if(!e){if(Array.isArray(t)||(e=function(t,r){if(t){var e;if("string"==typeof t)return Tr(t,r);var n=v()(e={}.toString.call(t)).call(e,8,-1);return"Object"===n&&t.constructor&&(n=t.constructor.name),"Map"===n||"Set"===n?d()(t):"Arguments"===n||/^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)?Tr(t,r):void 0}}(t))||r&&t&&"number"==typeof t.length){e&&(t=e);var n=0,i=function(){};return{s:i,n:function(){return n>=t.length?{done:!0}:{done:!1,value:t[n++]}},e:function(t){throw t},f:i}}throw new TypeError("Invalid attempt to iterate non-iterable instance.\\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.")}var o,c=!0,u=!1;return{s:function(){e=e.call(t)},n:function(){var t=e.next();return c=t.done,t},e:function(t){u=!0,o=t},f:function(){try{c||null==e.return||e.return()}finally{if(u)throw o}}}}function Tr(t,r){(null==r||r>t.length)&&(r=t.length);for(var e=0,n=Array(r);e<r;e++)n[e]=t[e];return n}var Br=["monospace","sans-serif","serif"],Dr=["sans-serif-thin","ARNO PRO","Agency FB","Arabic Typesetting","Arial Unicode MS","AvantGarde Bk BT","BankGothic Md BT","Batang","Bitstream Vera Sans Mono","Calibri","Century","Century Gothic","Clarendon","EUROSTILE","Franklin Gothic","Futura Bk BT","Futura Md BT","GOTHAM","Gill Sans","HELV","Haettenschweiler","Helvetica Neue","Humanst521 BT","Leelawadee","Letter Gothic","Levenim MT","Lucida Bright","Lucida Sans","Menlo","MS Mincho","MS Outlook","MS Reference Specialty","MS UI Gothic","MT Extra","MYRIAD PRO","Marlett","Meiryo UI","Microsoft Uighur","Minion Pro","Monotype Corsiva","PMingLiU","Pristina","SCRIPTINA","Segoe UI Light","Serifa","SimHei","Small Fonts","Staccato222 BT","TRAJAN PRO","Univers CE 55 Medium","Vrinda","ZWAdobeF","Abadi MT Condensed Light","Adobe Fangsong Std","Adobe Hebrew","Adobe Ming Std","Aharoni","Andalus","Angsana New","AngsanaUPC","Aparajita","Arab","Arabic Transparent","Arial Baltic","Arial Black","Arial CE","Arial CYR","Arial Greek","Arial TUR","Arial","BatangChe","Bauhaus 93","Bell MT","Bitstream Vera Serif","Bodoni MT","Bookman Old Style","Braggadocio","Broadway","Browallia New","BrowalliaUPC","Calibri Light","Californian FB","Cambria Math","Cambria","Candara","Castellar","Casual","Centaur","Chalkduster","Colonna MT","Comic Sans MS","Consolas","Constantia","Copperplate Gothic Light","Corbel","Cordia New","CordiaUPC","Courier New Baltic","Courier New CE","Courier New CYR","Courier New Greek","Courier New TUR","Courier New","DFKai-SB","DaunPenh","David","DejaVu LGC Sans Mono","Desdemona","DilleniaUPC","DokChampa","Dotum","DotumChe","Ebrima","Engravers MT","Eras Bold ITC","Estrangelo Edessa","EucrosiaUPC","Euphemia","Eurostile","FangSong","Forte","FrankRuehl","Franklin Gothic Heavy","Franklin Gothic Medium","FreesiaUPC","French Script MT","Gabriola","Gautami","Georgia","Gigi","Gisha","Goudy Old Style","Gulim","GulimChe","GungSeo","Gungsuh","GungsuhChe","Harrington","Hei S","HeiT","Heisei Kaku Gothic","Hiragino Sans GB","Impact","Informal Roman","IrisUPC","Iskoola Pota","JasmineUPC","KacstOne","KaiTi","Kalinga","Kartika","Khmer UI","Kino MT","KodchiangUPC","Kokila","Kozuka Gothic Pr6N","Lao UI","Latha","LilyUPC","Lohit Gujarati","Loma","Lucida Console","Lucida Fax","Lucida Sans Unicode","MS Gothic","MS PGothic","MS PMincho","MS Reference Sans Serif","MV Boli","Magneto","Malgun Gothic","Mangal","Matura MT Script Capitals","Meiryo","Microsoft Himalaya","Microsoft JhengHei","Microsoft New Tai Lue","Microsoft PhagsPa","Microsoft Sans Serif","Microsoft Tai Le","Microsoft YaHei","Microsoft Yi Baiti","MingLiU","MingLiU-ExtB","MingLiU_HKSCS","MingLiU_HKSCS-ExtB","Miriam Fixed","Miriam","Mongolian Baiti","MoolBoran","NSimSun","Narkisim","News Gothic MT","Niagara Solid","Nyala","PMingLiU-ExtB","Palace Script MT","Palatino Linotype","Papyrus","Perpetua","Plantagenet Cherokee","Playbill","Prelude Bold","Prelude Condensed Bold","Prelude Condensed Medium","Prelude Medium","PreludeCompressedWGL Black","PreludeCompressedWGL Bold","PreludeCompressedWGL Light","PreludeCompressedWGL Medium","PreludeCondensedWGL Black","PreludeCondensedWGL Bold","PreludeCondensedWGL Light","PreludeCondensedWGL Medium","PreludeWGL Black","PreludeWGL Bold","PreludeWGL Light","PreludeWGL Medium","Raavi","Rachana","Rockwell","Rod","Sakkal Majalla","Sawasdee","Script MT Bold","Segoe Print","Segoe Script","Segoe UI Semibold","Segoe UI Symbol","Segoe UI","Shonar Bangla","Showcard Gothic","Shruti","SimSun","SimSun-ExtB","Simplified Arabic Fixed","Simplified Arabic","Snap ITC","Sylfaen","Symbol","Tahoma","Times New Roman Baltic","Times New Roman CE","Times New Roman CYR","Times New Roman Greek","Times New Roman TUR","Times New Roman","TlwgMono","Traditional Arabic","Trebuchet MS","Tunga","Tw Cen MT Condensed Extra Bold","Ubuntu","Umpush","Univers","Utopia","Utsaah","Vani","Verdana","Vijaya","Vladimir Script","Webdings","Wide Latin","Wingdings"];function Ir(){try{return function(t,r,e){return Er.apply(this,arguments)}(function(t,r){var e=r.document,n=e.body;n.style.fontSize="48px";var i=e.createElement("div");i.style.setProperty("visibility","hidden","important");var o={},c={},a=function(t){var r=e.createElement("span"),n=r.style;return n.position="absolute",n.top="0",n.left="0",n.fontFamily=t,r.textContent="mmMwWLliI0O&1",i.appendChild(r),r},s=H()(Br).call(Br,a),f=function(){var t,r={},e=kr(Dr);try{var n=function(){var e=t.value;r[e]=H()(Br).call(Br,function(t){return function(t,r){var e;return a(N()(e="'".concat(t,"',")).call(e,r))}(e,t)})};for(e.s();!(t=e.n()).done;)n()}catch(t){e.e(t)}finally{e.f()}return r}();n.appendChild(i);for(var l=0;l<Br.length;l++)o[Br[l]]=s[l].offsetWidth,c[Br[l]]=s[l].offsetHeight;var p=u()(Dr).call(Dr,function(t){return r=f[t],Br.some(function(t,e){return r[e].offsetWidth!==o[t]||r[e].offsetHeight!==c[t]});var r});return window._FN=p.length,p})}catch(t){return[]}}function zr(){return(zr=k()(L().mark(function t(){var r;return L().wrap(function(t){for(;;)switch(t.prev=t.next){case 0:return t.next=1,Ir();case 1:return r=t.sent,t.abrupt("return",r.length);case 2:case"end":return t.stop()}},t)}))).apply(this,arguments)}var Mr={fontsNum:function(){return zr.apply(this,arguments)}};function Or(){var t=["BNrZqNLuywC","CwjMsMe","BwfYAW","DhLWzq","AwXK","y2f0y2G","yxn5BMm","DxzvwhO","zgf0ytPPBwe","Eu16Bg8","mty2nJuZnNjjDLH5ta","yMzVr28","ndGZnJi0oujAuwf3zG","Bg9HzgvK","r0vu","AxDYtwi","Dgf0zwnOyw4","r05JEfG","nhW1","uhHcwgS","z2uVCg5No2i","AMTorNK","wvfzu3e","rMnisg8","rfDxvfO","z0frEuW","mhWZFdf8mNW","C3jJ","BMv4Da","yxbWzw5Kq2G","zgr0t3O","zxLqzLa","C2nYAxb0","q29Kzq","B25LCNjVCG","wvLvD3m","AgvHza","zw1LBNq","qKLvD2i","mhWYFdn8nNW","DhDuzeu","vxLuwxa","Dgv4Dc9JC3m","mJC5nZu1nxzZAMHQvG","DMzky0i","B25SB2fK","nJq2mJDLEgHdqvG","CuzXEe8","vKjosxq","zMvY","rLrhuhu","tMfTzq","r1LsEgy","y29TCgXLDgu","C3rVCa","tLLNBuW","ywXS","tfvms0q","r0DrA1a","Aw1iB0y","zNjVBunOyxi","BvD2B0K","AxP4tKy","CeTiEfu","v3ruyxa","CKXmBeG","y3jLyxrLrwW","zw5K","neH2EhnlsW","B25YzwfKExm","uKrvtNm","wLvYt3C","uwHnB2W","B2zLzg0","nhWXFdD8nq","DMPnt1C","yNL0zuXLBMC","AwnNr20","ugzrsvu","AKL5yxi","r2DYu3G","yxjYyxLIDwy","BuTAEu0","yxbWBhK","C3r5BgvZAgu","CMvTB3zLq2G","nMrjDwTLuq","yMzVs24","AM10rw8","BvHdyM4","ywjYDxb0","BKLmwMO","n3WX","uxHLtNq","vNDKrxu","vvrgltG","B3bLBG","mZG5ndqYB1zJuNPK","rwjcv1e","r1rwtfe","CMvHzhLtDge","y2HHCNnLDa","uvzYquK","nhWWFdf8mNW","BgLUAW","qwX4EeC","CMv0DxjU","zercsLi","CMvTB3zL","AMPbu2G","uwLzCvq","uhzzCuy","Axz0wu8","A2LlqKG","q1DbDfe","tfH5B2q","u0jZwfO","DeP3EMu","ue1pv1q","C3rHDhvZ","Chvhwhe","nZy1ntqXEwD1vxzy","DMjPsgK","yxnLnJqS","nhWXFdn8mhW","vLLHqKy","tLnRyxm","EhjkwLa","y3nZ","DwvyEey","C2vUza","mtGXmZG1nKrqC09kDq","t1juq28","D3jHCa","teT4weq","ChfMBvm","q0DfBNG","BgvUz3rO","u3rlwhK","AhjLzG","vhLWzq","ELzYsKG","BNjyELy","wLPTCgW","zwHYrg8","BwfRzvvsta","BwvKAwe","CMvZCg9UC2u","m3W0Fdz8nxW","wfjjDfq","vvDSvfe","C3bSAxq","suDeEK0","ohWWFdj8oxW","z2v0rwXLBwu","ChjLDG","Bunry2u","CgfYzw50tM8","CMvS","CMvZB2X2zq","v1fvEgW","qMT1u0G","y0zIEw8","BKzZvLC"];return(Or=function(){return t})()}!function(t){for(var r=333,e=373,n=384,i=355,o=330,c=461,u=408,a=418,s=463,f=jr,l=t();;)try{if(312306===parseInt(f(r))/1*(-parseInt(f(e))/2)+-parseInt(f(n))/3+-parseInt(f(i))/4*(-parseInt(f(o))/5)+parseInt(f(c))/6+parseInt(f(u))/7+parseInt(f(a))/8+-parseInt(f(s))/9)break;l.push(l.shift())}catch(t){l.push(l.shift())}}(Or);var Lr=function(t,r,e){for(var n=440,i=379,o=464,c=340,u=326,a=361,s=332,f=483,l=382,p=415,v=390,h=329,d=371,y=343,g=391,m=487,x=398,w=438,b=328,S=380,C=407,A=466,_=447,E=413,k=436,T=339,B=337,D=376,I=481,z=342,M=429,O=423,L=424,P=357,N=487,j=441,H=451,W=338,K=335,R=424,U=396,q=438,G=369,Y=416,J=356,V=467,Z=346,X=353,Q=324,$=345,tt=388,rt=364,et=457,nt=478,it=431,ot=412,ct=325,ut=454,at=462,st=445,ft=402,lt=426,pt=433,vt=401,ht=353,dt=324,yt=448,gt=428,mt=332,xt=467,wt=480,bt=455,St=485,Ct=449,At=468,_t=482,Et=365,kt=365,Tt=444,Bt=372,Dt=455,It=332,zt=485,Mt=395,Ot=395,Lt=458,Pt=437,Nt=360,jt=422,Ht=403,Wt=344,Ft=430,Kt=392,Rt=374,Ut=374,qt=358,Gt=474,Yt=394,Jt=394,Vt=367,Zt=jr,Xt={PvYqF:Zt(435)+Zt(n)+Zt(i),UyTYp:function(t){return t()},GgrSx:function(t,r){return t(r)},dDBJR:function(t,r){return t===r},QxeNt:Zt(o),puGXq:Zt(c),FcHHo:function(t,r,e){return t(r,e)},ZUrOw:function(t,r){return t!==r},bfoKn:function(t,r){return t(r)},iwrMb:Zt(u)+Zt(a),AlxxG:function(t,r){return t<r},ZZmpl:function(t,r){return t in r},WQUxl:Zt(s),LULKD:function(t,r){return t===r},NSkas:Zt(f),XRItT:Zt(l),SBsXZ:function(t,r){return t===r},GYRxf:Zt(p),FTGPu:Zt(v)+"3",mXCbn:Zt(h),ddtOz:Zt(d)+"et",NYgmL:Zt(y),nrXzV:Zt(g),pqfmS:function(t,r){return t(r)},CGEnx:function(t,r){return t>r},RDUNs:function(t,r){return t!==r},VBNIt:Zt(m)},Qt=Xt[Zt(x)][Zt(w)]("|"),$t=0;;){switch(Qt[$t++]){case"0":var tr=!1;continue;case"1":Xt[Zt(b)](cr);continue;case"2":var rr;continue;case"3":var er={uvUXz:function(t,r){return Xt[Zt(Vt)](t,r)},QhMol:function(t,r){return Xt[Zt(Jt)](t,r)},xrJZP:Xt[Zt(S)],kiKBH:function(t,r){return Xt[Zt(Yt)](t,r)},ORTCo:Xt[Zt(C)],YYUws:function(t,r,e){return Xt[Zt(Gt)](t,r,e)},WtTap:function(t,r){return Xt[Zt(qt)](t,r)},GTVLQ:function(t,r){return Xt[Zt(Ut)](t,r)},jjASh:Xt[Zt(A)],ofedm:function(t,r){return Xt[Zt(Rt)](t,r)},UWlTQ:function(t,r){return Xt[Zt(Kt)](t,r)},mKZyM:function(t,r){return Xt[Zt(Ft)](t,r)},ueXxF:Xt[Zt(_)],imHoF:function(t,r){return Xt[Zt(Wt)](t,r)},GGQkP:Xt[Zt(E)],icgGm:Xt[Zt(k)],ehrDo:function(t,r){return Xt[Zt(Ht)](t,r)},VYaBF:Xt[Zt(T)],BIUwb:Xt[Zt(B)],bfoGo:Xt[Zt(D)],LXyod:Xt[Zt(I)],CWAtQ:Xt[Zt(z)],BkuSH:Xt[Zt(M)],zVrJH:function(t,r){return Xt[Zt(jt)](t,r)}};continue;case"4":var nr=Xt[Zt(O)](arguments[Zt(L)],3)&&Xt[Zt(P)](arguments[3],void 0)?arguments[3]:3;continue;case"5":var ir=window[Zt(N)]||document[Zt(j)+Zt(H)+Zt(W)](Xt[Zt(K)])[0];continue;case"6":var or=Xt[Zt(O)](arguments[Zt(R)],4)?arguments[4]:void 0;continue;case"7":var cr=function(){for(var n=387,i=359,o=387,c=414,u=400,a=387,s=419,f=486,l=458,p=351,v=387,h=419,d=351,y=414,g=356,m=467,x=386,w=486,b=Zt,S=er[b(U)][b(q)]("|"),C=0;;){switch(S[C++]){case"0":var A={PfQIU:function(t,r){return er[b(Nt)](t,r)},cFbyo:function(t,r){return er[b(Pt)](t,r)},GNcxX:function(t,r){return er[b(Lt)](t,r)},eyPfP:function(t,r,e){return er[b(w)](t,r,e)}};continue;case"1":!er[b(G)](er[b(Y)],ur)&&(ur[b(J)+b(V)+"ge"]=function(){var t=b;er[t(p)](ur[t(v)+"te"],er[t(h)])&&er[t(d)](ur[t(v)+"te"],er[t(y)])||(ur[t(g)+t(m)+"ge"]=null,er[t(x)](e,!1),tr=!0)});continue;case"2":ar++;continue;case"3":if(er[b(Z)](t,"js"))(ur=document[b(X)+b(Q)](er[b($)]))[b(tt)]=er[b(rt)],ur[b(et)]=!0,ur[b(nt)]=r;else{if(!er[b(it)](t,er[b(ot)]))return er[b(gt)](e,!0),void(tr=!1);for(var _=er[b(ct)][b(q)]("|"),E=0;;){switch(_[E++]){case"0":ur[b(ut)]=er[b(at)];continue;case"1":ur[b(st)]=er[b(ft)];continue;case"2":ur[b(lt)]=r;continue;case"3":ur[b(pt)]=er[b(vt)];continue;case"4":ur=document[b(ht)+b(dt)](er[b(yt)]);continue}break}}continue;case"4":ur[b(mt)]=ur[b(J)+b(xt)+"ge"]=function(){var t=473,r=b,p={YQYSq:function(t,r){return er[jr(l)](t,r)}};!tr&&(!ur[r(n)+"te"]||er[r(i)](ur[r(o)+"te"],er[r(c)])||er[r(u)](ur[r(a)+"te"],er[r(s)]))&&(tr=!0,er[r(f)](F(),function(){return p[r(t)](e,!1)},0))};continue;case"5":ir[b(wt)+b(bt)](ur);continue;case"6":var k=function(t){var r=b;A[r(kt)](clearTimeout,rr),t[r(Tt)+"de"][r(Bt)+r(Dt)](t),t[r(It)]=t[r(zt)]=null,t[r(Mt)]&&t[r(Ot)]()};continue;case"7":ur[b(St)]=function(t){var r=b;A[r(Ct)](ar,nr)?(A[r(At)](k,ur),rr=A[r(_t)](F(),cr,or)):(A[r(Et)](k,ur),A[r(_t)](e,!0,t))};continue}break}};continue;case"8":var ur;continue;case"9":var ar=0;continue}break}},Pr=function(r,e,n,i,o,c,u){var a=432,s=452,f=334,l=443,p=424,v=349,h=366,d=327,y=450,g={qFqxO:function(t,r){return t>=r},mCQce:function(t,r){return t-r},izxNF:function(t,r,e){return t(r,e)},jIyar:function(t,r){return t(r)},twTdE:function(t,r){return t+r},nFsVW:function(t,r){return t(r)},qbfJa:function(t,r,e,n,i,o){return t(r,e,n,i,o)},rLLlH:function(t,r){return t(r)}},m=function(x){var w=jr,b=t[w(a)](e,n[x],i,o);g[w(s)](Lr,r,b,function(t,r){var e=w;t?g[e(f)](x,g[e(l)](n[e(p)],1))?g[e(v)](c,!0,r):g[e(h)](m,g[e(d)](x,1)):g[e(y)](c,!1)},3,u)};g[jr(352)](m,0)};function Nr(t){for(var r=409,e=438,n=460,i=347,o=484,c=476,u=363,a=jr,s={vbiHi:a(411)+"2",yMzlo:function(t,r){return t<r},gAQyL:function(t,r){return t(r)}},f=s[a(r)][a(e)]("|"),l=0;;){switch(f[l++]){case"0":for(var p=0;s[a(n)](p,h);p++)d+=String[a(i)+a(o)](v[p]);continue;case"1":var v=new Uint8Array(t);continue;case"2":return s[a(c)](btoa,d);case"3":var h=v[a(u)+"th"];continue;case"4":var d="";continue}break}}function jr(t,r){var e=Or();return jr=function(r,n){var i=e[r-=324];if(void 0===jr.qonBxj){jr.ermccy=function(t){for(var r,e,n="",i="",o=0,c=0;e=t.charAt(c++);~e&&(r=o%4?64*r+e:e,o++%4)?n+=String.fromCharCode(255&r>>(-2*o&6)):0)e="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=".indexOf(e);for(var u=0,a=n.length;u<a;u++)i+="%"+("00"+n.charCodeAt(u).toString(16)).slice(-2);return decodeURIComponent(i)},t=arguments,jr.qonBxj=!0}var o=r+e[0],c=t[o];return c?i=c:(i=jr.ermccy(i),t[o]=i),i},jr(t,r)}function Hr(t){return Wr[jr(370)](this,arguments)}function Wr(){var t=471,r=410,e=477,n=469,i=368,o=336,c=465,u=393,a=354,s=378,f=453,l=370,p=420,v=jr,h={vfJcB:function(t,r){return t===r},nILZj:function(t,r){return t(r)},tJwze:function(t,r){return t(r)},pKHxU:function(t,r){return t+r},jkNFy:v(459)+v(t)+v(r),EbBWQ:v(e)+v(n),StKXy:v(i)+v(o),QVrAI:v(c),jmtEo:v(u),LKxXD:v(a)};return Wr=h[v(s)](k(),L()[v(f)](function t(r){var e=472,n=385,i=425,o=389,c=442,u=479,a=377,s=375,f=446,l=456,d=421,y=341,g=399,m=438,x=434,w=427,b=348,S=332,C=383,A=405,_=485,E=417,k=378,T=350,B=378,D=331,z=v;return L()[z(p)](function(t){for(var p=381,v=404,M=z,O={vjMOW:function(t,r){return h[jr(D)](t,r)},IGDzM:function(t,r){return h[jr(B)](t,r)},DWWTZ:function(t,r){return h[jr(v)](t,r)},PxBXk:function(t,r){return h[jr(T)](t,r)},QiYqT:h[M(e)],VwdEu:function(t,r){return h[M(k)](t,r)},ivtYO:h[M(n)],mWvoI:h[M(i)],PMOWT:h[M(o)]};;)switch(t[M(c)]=t[M(u)]){case 0:if(r){t[M(u)]=1;break}return t[M(a)](h[M(s)],I()[M(f)](void 0));case 1:return t[M(a)](h[M(s)],new(I())(function(t){for(var e=362,n=406,i=439,o=434,c=475,u=470,a=397,s=439,f=M,l=O[f(g)][f(m)]("|"),v=0;;){switch(l[v++]){case"0":var h=new XMLHttpRequest;continue;case"1":h[f(x)+f(w)]=O[f(b)];continue;case"2":h[f(S)]=function(){var r=f;if(O[r(e)](h[r(n)],200))try{var l=O[r(i)](Nr,h[r(o)]);O[r(c)](t,O[r(u)](O[r(a)],l))}catch(e){O[r(s)](t,void 0)}else O[r(i)](t,void 0)};continue;case"3":h[f(C)](O[f(A)],r,!0);continue;case"4":h[f(_)]=function(){O[f(p)](t,void 0)};continue;case"5":h[f(E)]();continue}break}})[M(l)](function(){}));case 2:case h[M(d)]:return t[M(y)]()}},t)})),Wr[v(l)](this,arguments)}var Fr=e(9562),Kr=e.n(Fr),Rr=e(9972),Ur=e.n(Rr),qr=e(5189),Gr=e.n(qr),Yr=e(4636),Jr=e.n(Yr),Vr=e(4443),Zr=e.n(Vr),Xr=e(8148),Qr=e.n(Xr),$r=e(9015),te=e.n($r),re=Se;function ee(t,r){for(var e=616,n=474,i=630,o=522,c=679,u=542,a=666,s=521,f=530,l=636,p=573,v=563,h=608,d=478,y=529,m=519,w=593,b=665,S=639,C=584,A=596,_=518,E=555,k=591,T=540,B=585,D=482,I=637,z=583,M=638,O=675,L=655,P=566,N=604,j=545,H=545,W=640,F=479,K=588,R=587,U=582,q=479,G=556,Y=637,J=Se,V={pXsFN:J(487)+"4",fvipU:function(t,r){return t(r)},TYHVP:function(t,r){return t&&r},NeDKK:function(t,r){return t==r},pdzKl:J(e),XQrDd:J(n)+J(i)+J(o)+J(c)+J(u)+J(a)+J(s)+J(f)+J(l)+J(p)+J(v)+J(h)+J(d)+J(y)+J(m)+J(w)+J(b),CpoYE:function(t,r){return t!=r},Bzufy:J(S)+"d",GIOll:function(t,r){return t(r)},SewGn:J(C)+"or",UuAnR:function(t,r){return t>=r},AydFE:function(t,r){return t==r}},Z=V[J(A)][J(_)]("|"),X=0;;){switch(Z[X++]){case"0":if(!tt){if(Array[J(E)](t)||(tt=V[J(k)](ne,t))||V[J(T)](r,t)&&V[J(B)](V[J(D)],typeof t[J(I)])){tt&&(t=tt);var Q=0,$=function(){};return{s:$,n:function(){var r=J,e={};return e[r(q)]=!0,it[r(G)](Q,t[r(Y)])?e:{done:!1,value:t[Q++]}},e:function(t){throw t},f:$}}throw new TypeError(V[J(z)])}continue;case"1":var tt=V[J(M)](V[J(O)],typeof g())&&V[J(L)](x(),t)||t[V[J(P)]];continue;case"2":var rt,et=!0,nt=!1;continue;case"3":var it={BNmfz:function(t,r){return V[J(U)](t,r)},vZFNx:function(t,r){return V[J(R)](t,r)}};continue;case"4":return{s:function(){tt=tt[J(K)](t)},n:function(){var t=J,r=tt[t(W)]();return et=r[t(F)],r},e:function(t){nt=!0,rt=t},f:function(){var t=J;try{et||it[t(N)](null,tt[t(j)])||tt[t(H)]()}finally{if(nt)throw rt}}}}break}}function ne(t,r){var e=535,n=600,i=617,o=580,c=513,u=653,a=486,s=586,f=628,l=588,p=588,h=475,y=646,g=552,m=614,x=552,w=614,b=497,S=673,C=502,A=472,_=494,E=586,k=484,T=526,B=615,D=Se,I={WImXw:function(t,r){return t==r},tCwZV:D(511),FzLRR:function(t,r,e){return t(r,e)},FsBdZ:function(t,r){return t(r)},kpIbr:function(t,r){return t===r},JdOKz:D(e),dWtpS:function(t,r){return t===r},hmPAc:D(n),TjYtw:function(t,r){return t===r},IbEyA:D(i),JYcWd:function(t,r){return t===r},lkddV:D(o)+"s"};if(t){var z;if(I[D(c)](I[D(u)],typeof t))return I[D(a)](ie,t,r);var M=I[D(s)](v(),z={}[D(f)][D(l)](t))[D(p)](z,8,-1);return I[D(h)](I[D(y)],M)&&t[D(g)+D(m)]&&(M=t[D(x)+D(w)][D(b)]),I[D(S)](I[D(C)],M)||I[D(A)](I[D(_)],M)?I[D(E)](d(),t):I[D(k)](I[D(T)],M)||/^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/[D(B)](M)?I[D(a)](ie,t,r):void 0}}function ie(t,r){var e=489,n=637,i=649,o=481,c=Se,u={EMqCk:function(t,r){return t==r},yOoVj:function(t,r){return t>r},mRrkt:function(t,r){return t(r)},tkIjP:function(t,r){return t<r}};(u[c(515)](null,r)||u[c(e)](r,t[c(n)]))&&(r=t[c(n)]);for(var a=0,s=u[c(i)](Array,r);u[c(o)](a,r);a++)s[a]=t[a];return s}!function(t){for(var r=551,e=574,n=620,i=622,o=523,c=567,u=557,a=634,s=592,f=607,l=619,p=503,v=Se,h=t();;)try{if(173024===parseInt(v(r))/1*(parseInt(v(e))/2)+parseInt(v(n))/3*(-parseInt(v(i))/4)+-parseInt(v(o))/5*(-parseInt(v(c))/6)+parseInt(v(u))/7+-parseInt(v(a))/8*(-parseInt(v(s))/9)+-parseInt(v(f))/10+parseInt(v(l))/11*(-parseInt(v(p))/12))break;h.push(h.shift())}catch(t){h.push(h.shift())}}(me),te()[re(589)+re(496)]=Ce,window[re(627)+re(499)]=te();var oe=te()[re(602)],ce=te()[re(613)][re(548)],ue=te()[re(613)][re(541)],ae=te()[re(613)][re(662)],se=te()[re(561)][re(677)],fe=ue[re(579)+"y"](ae[re(532)](gt)),le={iv:ce[re(532)](fe),padding:se},pe=nr[re(501)+re(520)+"EY"],ve=ye(nr[re(568)+"EC"],pe[re(644)]),he=ye(nr[re(568)+"EC"],pe[re(594)]);function de(t,r){var e=506,n=598,i=652,o=477,c=648,u=527,a=495,s=635,f=518,l=477,p=669,v=628,h=637,d=495,y=637,g=532,m=re,x={};x[m(635)]=m(e)+m(n),x[m(i)]=function(t,r){return t===r},x[m(o)]=function(t,r){return t===r},x[m(c)]=function(t,r){return t===r},x[m(u)]=function(t,r){return t!==r},x[m(a)]=function(t,r){return t<=r};for(var w=x,b=w[m(s)][m(f)]("|"),S=0;;){switch(b[S++]){case"0":if(w[m(i)](r,void 0)||w[m(l)](r,null))return null;continue;case"1":var C=r;continue;case"2":var A=oe[m(p)](C,_,le);continue;case"3":return A[m(v)]();case"4":if(w[m(c)](t,void 0)||w[m(u)](t[m(h)],16)||w[m(d)](r[m(y)],0))return null;continue;case"5":var _=ce[m(g)](t);continue}break}}function ye(t,r){var e=611,n=656,i=491,o=625,c=658,u=632,a=518,s=628,f=514,l=532,p=637,v=632,h=637,d=re,y={};y[d(e)]=d(n)+d(i),y[d(o)]=function(t,r){return t===r},y[d(c)]=function(t,r){return t!==r},y[d(u)]=function(t,r){return t<=r};for(var g=y,m=g[d(e)][d(a)]("|"),x=0;;){switch(m[x++]){case"0":var w=r;continue;case"1":if(g[d(o)](r,void 0)||g[d(o)](r,null))return null;continue;case"2":return b[d(s)](ce);case"3":var b=oe[d(f)](w,S,le);continue;case"4":var S=ce[d(l)](t);continue;case"5":if(g[d(o)](t,void 0)||g[d(c)](t[d(p)],16)||g[d(v)](r[d(h)],0))return null;continue}break}}function ge(t){for(var r=577,e=546,n=572,i=518,o=538,c=637,u=507,a=631,s=578,f=603,l=670,p=642,v=485,h=597,d=549,y=576,g=559,m=651,x=544,w=676,b=606,S=525,C=670,A=670,_=672,E=518,k=re,T={iGFQX:k(641)+"4",QwOvf:function(t,r){return t>=r},jsMrQ:k(r)+k(e)+"4",oCzId:function(t,r){return t(r)},BumGX:function(t,r){return t(r)},qWChN:function(t,r){return t(r)},wfUoy:function(t,r){return t(r)},HpGOR:function(t,r,e){return t(r,e)}},B=T[k(n)][k(i)]("|"),D=0;;){switch(B[D++]){case"0":var I={};continue;case"1":if(T[k(o)](L[k(c)],4))for(var z=T[k(u)][k(i)]("|"),M=0;;){switch(z[M++]){case"0":I[k(a)]=L[3];continue;case"1":I[k(s)+k(f)]=T[k(l)](xe,L[4]);continue;case"2":I[k(p)+k(v)]=T[k(h)](xe,L[6]);continue;case"3":I[k(d)]=T[k(y)](xe,L[0]);continue;case"4":I.ip=L[8];continue;case"5":I[k(g)+"p"]=L[7];continue;case"6":I[k(m)+k(x)]=T[k(w)](xe,L[5]);continue;case"7":I[k(b)+"d"]=L[2];continue;case"8":I[k(S)]=T[k(C)](Number,T[k(A)](xe,L[1]));continue}break}continue;case"2":var O=T[k(_)](ye,he,t);continue;case"3":var L=O[k(E)]("#");continue;case"4":return I}break}}function me(){var t=["ifTtEw1IB2W","zxiGDg8GyMu","DwTJAK0","CgfYC2u","DMfSDwu","jtDf","t2jQzwn0","t1DWtva","vuTlCxG","uxDpDMy","Ee9Xv2K","vfLivLa","qMfZzty0","DgvYywjSzsa","y2fWDgnOyuO","C291CMnL","CMv0DxjU","mxW2Fdj8nxW","yNvMzMvY","vxrMoa","A2v5","ANfbBKm","mtrisLDeqwG","y29UC3rYDwm","vefurq","q2fWDgnOyvq","AxnbCNjHEq","qK5TzNO","mtiYmZqZmMrNAgfcqq","sg1Hy1niqte","DgLTzxn0yw0","mNW0FdD8mxW","CgfK","qundrvntx0S","CNjHEsbVyMO","AeTPsLi","quXrs2m","u2v3r24","mtHJt1jpshi","qundrvntx1m","C3nqyxrO","DgjHuxC","ChDHuwK","AuDguvG","zsWGBM9Ulwe","mtG1mdH5shbTEui","ywDL","CvDdAe4","m3W4FdD8mhW","CgX1z2LUrwW","C3rYAw5NAwy","qxjNDw1LBNq","Axnezxy","vxvbBLi","wffYrgq","qebPDgvYyxq","tMves0S","rNnczfO","qxLKrKu","y2fSBa","y29TChv0zvm","CMvWBgfJzq","zNzPCfu","mtH1twXAuKW","CL0OksbTzxq","uKvt","q2vYDgLMEuK","CfHZrK4","qNvTr1G","mNWZ","u0vduKvu","twfW","mhW4FdL8m3W","quvt","zw1LBNrZ","DLPgtNG","ExbL","C2vZC2LVBKK","ndq5odyWse5rt1L2","zwn0CYbTDxm","s1bPAMq","revwsunfx1q","vu9uu3q","C1bHDgG","zw5J","Dg9Y","DgvZDa","BNvTyMvY","u2v0","rKXbrW","mtG1mdq4nNj0yMzLCW","mtqYmZu2rgjjB1LV","r1HssMC","mJrNqw5eDfG","y2fWDgnOyum","ANvJCw0","zKrswNC","nhWWFdn8mNW","x19bteLzvu4","Dg9tDhjPBMC","v3fKBeq","yxr0zw1WDca","DMvYC2LVBG","v3Dctxa","jtiW","nZeXntq0A3LfAg1e","suXRs2K","igL0zxjHyMW","BgvUz3rO","q3bVwuu","Dw5KzwzPBMu","BMv4Da","mNWZFdb8mxW","z2XVyMfSvMe","zNjVBunOyxi","uKvr","q29Kzq","sMrps3O","nhW1FdH8mxW","sxPnz1G","BvjYA3q","rLPlAMm","CgX1z2LUuMu","ALH6A1u","Den3wLy","qM1ACwu","r0LpBgW","mxW1Fdb8nhW","jtjb","CMDIBu8","y29Uy2f0","BgH4the","sMfYuhK","sgv4","AM9PBG","ue9tva","Ag9KlG","Aw5ZDgfUy2u","uhv6EMXLsw0","Aw1Nu2vYDMu","zw5JCNLWDa","B0n6swq","BMvRCLm","shbht1i","zfD0Cfm","uxvLC3rPB24","qNP1zNK","D2zvB3K","ugTJCZC","yxbWBhK","DguGBM9UlwK","vgPzDhC","y2HHCKnVzgu","sw52ywXPzca","A3bjyNi","wvbf","AgzHAeC","DcbOyxzLige","zg9Uzq","mtb8mtf8nNW","DgTjALa","Cgr6s2W","qunusu9o","sLLJv2q","CMLHyMXL","rNPmuLi","m3WXFdb8mNW","vNvfCg4","Eu9VvMO","ug93vMvYAwy","m3WY","BfDdzKe","n3W2Fdb8m3W","swjfEue","t2HKruy","AwDUyxr1CMu","BMfTzq","Evn0CMLUzW","x0nswvbu","mNW5","v0vcx0ffu18","Ag1qqwm","mtjVAg9ntLK","tfLtCe4","qunusu9ox1m","mhW0Fdf8nxW","ANnnCLe","vhrOrfm","u2LNBMf0Dxi","ywD5q1m","C3rYAw5N","u3rHDgLJuge","v0LTwhC","zgvJCNLWDa","ru1Xq2S","CMvNAw9U","sw1Hz2u","C3bSAxq","lML0zxjHDg8","u0vduKvux0S","lGPjBIbVCMq","Dg8GAxrLCMe","mZe0ntuWEvbMAK5e","x2v4DgvUza","C3DPDgnO","BgTKzfy","zvLLtMC","wfrev1y"];return(me=function(){return t})()}function xe(t){for(var r=637,e=492,n=473,i=643,o=645,c=678,u=537,a=547,s=re,f={LYSpN:function(t,r){return t(r)},lWCfA:function(t,r){return t<r},UKKqx:function(t,r){return t(r)}},l=f[s(504)](atob,t),p=new Uint8Array(l[s(r)]),v=0;f[s(e)](v,p[s(r)]);v++)p[v]=l[s(n)+"At"](v);return String[s(i)+s(o)][s(c)](String,f[s(u)](Zr(),new Uint8Array(p[s(a)])))}function we(t){var r=663,e=re;return{xOqWi:function(t,r,e){return t(r,e)}}[e(539)](de,ve,t[e(r)]("#"))}function be(t,r){for(var e=493,n=500,i=510,o=518,c=667,u=575,a=536,s=490,f=498,l=490,p=674,v=674,h=543,d=612,y=623,g=569,m=516,x=531,w=581,b=517,S=564,C=517,A=668,_=524,E=531,k=554,T=605,B=629,D=512,I=595,z=re,M={agyCS:z(647)+z(e)+z(n),OWpMP:function(t,r){return t+r},ukcjM:function(t,r){return t===r},hKiJR:function(t,r){return t+r},WqdlD:function(t,r){return t(r)}},O=M[z(i)][z(o)]("|"),L=0;;){switch(O[L++]){case"0":var P=t[z(c)+z(u)]?M[z(a)](U,t[z(c)+z(u)]):"";continue;case"1":U=U[K];continue;case"2":var N=t[z(s)+z(f)]?t[z(l)+z(f)]:"";continue;case"3":var j=t[z(p)]?t[z(v)]:"";continue;case"4":var H=r[z(h)+z(d)],W=r[z(y)+z(g)],F=r[z(m)],K=M[z(x)](F,void 0)?"cn":F,R=r[z(w)];continue;case"5":var U=ut;continue;case"6":var q=t[z(b)]?M[z(S)](U,t[z(C)]):"";continue;case"7":var G={};G[z(A)+"r"]=U,r[z(_)](G);continue;case"8":M[z(E)](R,!0)&&(U=st);continue;case"9":return{CaptchaType:t[z(k)+z(T)],Image:q,CaptchaJsPath:M[z(B)](H,t[z(D)+"th"]),CaptchaCssPath:M[z(B)](W,t[z(D)+"th"]),CertifyId:t[z(I)+"d"],Question:j,PuzzleImage:P,PowVerifyString:N}}break}}function Se(t,r){var e=me();return Se=function(r,n){var i=e[r-=472];if(void 0===Se.yqMxWi){Se.qYvFmA=function(t){for(var r,e,n="",i="",o=0,c=0;e=t.charAt(c++);~e&&(r=o%4?64*r+e:e,o++%4)?n+=String.fromCharCode(255&r>>(-2*o&6)):0)e="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=".indexOf(e);for(var u=0,a=n.length;u<a;u++)i+="%"+("00"+n.charCodeAt(u).toString(16)).slice(-2);return decodeURIComponent(i)},t=arguments,Se.yqMxWi=!0}var o=r+e[0],c=t[o];return c?i=c:(i=Se.qYvFmA(i),t[o]=i),i},Se(t,r)}function Ce(t,r){for(var e=480,i=560,o=626,c=664,u=528,a=518,s=509,f=660,l=479,p=621,v=518,h=533,d=508,y=659,g=570,m=624,x=588,w=565,b=671,S=550,C=508,A=570,_=660,E=488,k=re,T={XTDWV:k(601)+k(e)+k(i)+"5",lhxLq:function(t,r){return t(r)},GXRJg:k(o)+"1",TthDS:function(t,r){return t(r)},tbaQw:function(t,r){return t+r},jucqm:function(t,r){return t(r)},ALQKc:function(t,r){return t(r)},nekrS:k(c),jqAnC:function(t,r,e){return t(r,e)},VuEpn:function(t,r){return t(r)}},B=T[k(u)][k(a)]("|"),D=0;;){switch(B[D++]){case"0":delete t[k(s)+"e"];continue;case"1":j+=T[k(f)](Ae,R);continue;case"2":try{for(W.s();!(H=W.n())[k(l)];)for(var I=T[k(p)][k(v)]("|"),z=0;;){switch(I[z++]){case"0":var M=H[k(h)];continue;case"1":R=T[k(d)](N(),L=""[k(y)](T[k(g)](R,T[k(m)](Ae,M)),"="))[k(x)](L,T[k(w)](Ae,O));continue;case"2":var O=t[M];continue;case"3":K?K=!1:R+="&";continue;case"4":var L;continue}break}}catch(t){W.e(t)}finally{W.f()}continue;case"3":var P="&";continue;case"4":var j=T[k(b)][k(y)](P);continue;case"5":return T[k(S)](_e,T[k(g)](r,P),j);case"6":var H,W=T[k(C)](ee,F);continue;case"7":j=T[k(A)](T[k(A)](j,T[k(m)](Ae,"/")),P);continue;case"8":var F=T[k(_)](n(),t);continue;case"9":T[k(E)](Qr(),F)[k(x)](F);continue;case"10":var K=!0;continue;case"11":var R="";continue}break}}function Ae(t){var r=657,e=534,n=571,i=661,o=590,c=654,u=590,a=609,s=590,f=650,l=re,p={pwaQi:function(t,r){return t===r},JarPy:function(t,r){return t(r)},BmZqe:l(633),KPijd:l(r),FZKjc:l(e)};return p[l(n)](t,void 0)||p[l(n)](t,null)?null:p[l(i)](encodeURIComponent,t)[l(o)]("+",p[l(c)])[l(u)]("*",p[l(a)])[l(s)](p[l(f)],"~")}function _e(t,r){var e=558,n=579,i=re,o=te()[i(e)](r,t);return ue[i(n)+"y"](o)}var Ee={ACTION:xt,ACTION_STATE:bt,KEY_ID:ye(vt,yt.ID),KEY_SECRET:ye(vt,yt[re(599)])},ke={ACTION:nr[re(483)],ACTION_STATE:nr[re(505)+re(553)],DEVICE_TYPE:nr[re(610)+re(476)],WEB_AES_SECRET_KEY:nr[re(501)+re(520)+"EY"],KEY_ID:ye(nr[re(568)+"EC"],nr[re(562)+"EY"].ID),KEY_SECRET:ye(nr[re(568)+"EC"],nr[re(562)+"EY"][re(599)]),WEB_AES_FLAG_SECRET_KEY:ye(nr[re(568)+"EC"],nr[re(501)+re(520)+"EY"][re(618)])};function Te(t,r){var e=n()(t);if(o()){var i=o()(t);r&&(i=u()(i).call(i,function(r){return s()(t,r).enumerable})),e.push.apply(e,i)}return e}function Be(t){for(var r=1;r<arguments.length;r++){var e=null!=arguments[r]?arguments[r]:{};r%2?Te(Object(e),!0).forEach(function(r){C()(t,r,e[r])}):l()?Object.defineProperties(t,l()(e)):Te(Object(e)).forEach(function(r){Object.defineProperty(t,r,s()(e,r))})}return t}var De=er,Ie=nr,ze=et,Me=ot;function Oe(t,r,e,n){return Le.apply(this,arguments)}function Le(){return Le=k()(L().mark(function t(r,e,n,i){var o,c,u,a,s,f,l,p,v,h,d,y,g,m,x;return L().wrap(function(t){for(;;)switch(t.prev=t.next){case 0:return De._extend({initBeginTime:Date.now(),logUploaded:!1,logInfo:{}}),xr("sId",r.SceneId),o=e.https,c=e.initPath,u=e.isDev,a=e.verifyType,s=o,f=$e(e),l=rn(r,e),p=l.action,xr("pfx",v=l._prefix),f=H()(f).call(f,function(t){return v+"."+t}),h=H()(f).call(f,function(t){return lr(s,t,c)}),De._extend({urls:h}),d=i.deviceConfig,y=i.deviceCallback,"1.0"===a?(delete r.DeviceToken,Ie=new Jt):e.userId&&e.userUserId&&(De._extend({userId:void 0,userUserId:void 0}),Ie=new Jt),tn(d.endpoints,d.appName),g=Re(d,Ie,ke),e.isFromTraceless||void 0!==Ie.DeviceConfig||(r.DeviceData=g),t.next=1,Ne(p,r,h,e,Ee);case 1:!(m=t.sent).Success||m.LimitFlow||m.LimitedFlowToken?(m.LimitedFlowToken?m.CertifyId=m.LimitedFlowToken:m.CertifyId||(m.CertifyId=dr().substring(0,5)),xr("cId",m.CertifyId),n(Ee.ACTION_STATE.FAIL,m)):(e._extend({log:on}),xr("cId",m.CertifyId),!e.isFromTraceless&&De._extend({initialRequestTime:Date.now(),overTime:!1}),m.DeviceConfig&&void 0===Ie.DeviceConfig&&Ie._extend({DeviceConfig:m.DeviceConfig}),en(m.DeviceConfig,y,u,"captcha"),x=be(m,e),n(Ee.ACTION_STATE.SUCCESS,x));case 2:case"end":return t.stop()}},t)})),Le.apply(this,arguments)}function Pe(){return Pe=k()(L().mark(function t(r){var e,n,i,o,c;return L().wrap(function(t){for(;;)switch(t.prev=t.next){case 0:return Ie._extend(Be({},r)),tn(r.endpoints,r.appName),Ie._extend(Be({},r)),e=Ie.ENDPOINTS||Ie.endpoints,Ie.logs=[],Ie.initTime=Date.now(),n=Ie.logs,i=Ie.initTime,t.prev=1,n.push("10-0"),t.next=2,Ne(ke.ACTION.INIT,{},e,Ie,ke);case 2:o=t.sent,n.push("11-"+(Date.now()-i)),void 0===Ie.DeviceConfig&&(Ie._extend({DeviceConfig:o.DeviceConfig}),en(o.DeviceConfig,r.deviceCallback,r.dev,"device")),t.next=4;break;case 3:t.prev=3,c=t.catch(1);try{n.push("12-"+(Date.now()-i)+"-"+c.toString().substring(0,50))}catch(t){n.push("13-"+(Date.now()-i))}Ie._extend({DeviceConfig:void 0});case 4:case"end":return t.stop()}},t,null,[[1,3]])})),Pe.apply(this,arguments)}function Ne(t,r,e,n,i){return"Log1"===t?function(t,r,e,n,i){return He.apply(this,arguments)}(t,r,e,n,i):function(t,r,e,n,i){return je.apply(this,arguments)}(t,r,e,n,i)}function je(){return je=k()(L().mark(function t(r,e,n,i,o){var c,u;return L().wrap(function(t){for(;;)switch(t.prev=t.next){case 0:return(c={}).AccessKeyId=o.KEY_ID,c.SignatureMethod="HMAC-SHA1",c.SignatureVersion="1.0",c.Format="JSON",c.Timestamp=hr(),c.Version=pt,c.Action=r,ir(e)||(c=or(c,e)),u=function(){var t=k()(L().mark(function t(r){var e,a,s,f,l,p,v,h;return L().wrap(function(t){for(;;)switch(t.prev=t.next){case 0:return c.SignatureNonce=dr(),a=Ce(c,o.KEY_SECRET),c.Signature=a,s=Date.now(),t.next=1,Ue(n[r],c,i);case 1:if(f=t.sent,l=Date.now(),p=f.Code,v=f.Success,h=Gr()(e=n[r]).call(e,"-b")?"bInit":"mInit",!("Success"===p&&v||r>=n.length-1)){t.next=2;break}return"Success"===p&&v?(xr(h,{t:l,s:!0,msg:"INIT_SUCCESS",rt:l-s}),Ye(r)):xr(h,{t:l,s:!1,msg:f.err,rt:l-s}),t.abrupt("return",f);case 2:if(xr(h,{t:l,s:!1,msg:f.err||f.Message,rt:l-s}),!("403"===p&&f.LimitedFlow||"ThrottlingByStrategy"===p)){t.next=3;break}return t.abrupt("return",f);case 3:return t.next=4,u(r+1);case 4:return t.abrupt("return",t.sent);case 5:case"end":return t.stop()}},t)}));return function(r){return t.apply(this,arguments)}}(),t.next=1,u(0);case 1:return t.abrupt("return",t.sent);case 2:case"end":return t.stop()}},t)})),je.apply(this,arguments)}function He(){return He=k()(L().mark(function t(r,e,n,i,o){var c,u,a,s,f,l;return L().wrap(function(t){for(;;)switch(t.prev=t.next){case 0:return(c={}).AccessKeyId=o.KEY_ID,c.Version=i.API_VERSION,c.SignatureMethod="HMAC-SHA1",c.SignatureVersion="1.0",c.Format="JSON",u=i.appKey||i.APP_KEY,a=i.appName||i.APP_NAME,c.Action=r,s=ye(i.ACCESS_SEC,i.secretKey)||o.WEB_AES_FLAG_SECRET_KEY,f=i.PLATFORM+"#"+a+"#"+(i.sceneId||"")+"#captcha-front#"+i.prefix+"#"+i.region,f=de(s,f),c.Data=we([u,o.DEVICE_TYPE.WEB,f,i.APP_VERSION,"CLOUD",""]),l=function(){var t=k()(L().mark(function t(r){var e,u,a,s,f,p;return L().wrap(function(t){for(;;)switch(t.prev=t.next){case 0:return c.SignatureNonce=dr(),delete c.Signature,u=Ce(c,o.KEY_SECRET),c.Signature=u,t.next=1,Ue(n[r],c,i);case 1:if(a=t.sent,s=a.Code,f=a.ResultObject,!("200"===String(s)||Kr()(e=String(s)).call(e,"4")||r>=n.length-1)){t.next=2;break}return("200"===String(s)||Kr()(p=String(s)).call(p,"4"))&&Je(n,r),t.abrupt("return",f||String(s));case 2:return t.next=3,l(r+1);case 3:return t.abrupt("return",t.sent);case 4:case"end":return t.stop()}},t)}));return function(r){return t.apply(this,arguments)}}(),t.next=1,l(0);case 1:return t.abrupt("return",t.sent);case 2:case"end":return t.stop()}},t)})),He.apply(this,arguments)}function We(t,r){var e=t.match(/^(https?:\\/\\/)([^\\/]+)(\\/.*)?$/);if(!e)return t;var n=e[1],i=e[2],o=e[3]||"";return n+i.replace(/^[^.]+/,r)+o}function Fe(){return Ke.apply(this,arguments)}function Ke(){return(Ke=k()(L().mark(function t(){var r,e;return L().wrap(function(t){for(;;)switch(t.prev=t.next){case 0:return e=H()(r=De.urls).call(r,function(t){return We(t,"upload")}),t.next=1,Ne(Ee.ACTION.LOG,{log:M()(De.logInfo)},e,De,Ee);case 1:return t.abrupt("return",t.sent);case 2:case"end":return t.stop()}},t)}))).apply(this,arguments)}function Re(t,r,e){r._extend(Be({},t));var n=t.appKey||r.APP_KEY,i=t.appName||r.APP_NAME,o=ye(r.ACCESS_SEC,r.secretKey)||e.WEB_AES_FLAG_SECRET_KEY,c=r.PLATFORM+"#"+i+"#"+(r.sceneId||"")+"#captcha-normal#"+De.prefix+"#"+De.region;return c=de(o,c),we([n,e.DEVICE_TYPE.WEB,c,r.APP_VERSION,"CLOUD",""])}function Ue(){return qe.apply(this,arguments)}function qe(){return qe=k()(L().mark(function t(){var r,e,n,i,o=arguments;return L().wrap(function(t){for(;;)switch(t.prev=t.next){case 0:return r=o.length>0&&void 0!==o[0]?o[0]:"",e=o.length>1&&void 0!==o[1]?o[1]:{},n=o.length>2?o[2]:void 0,t.prev=1,t.next=2,Ge(r,e,{method:"POST",mode:"cors",headers:{"Content-Type":"application/x-www-form-urlencoded; charset=UTF-8"},body:Qe(e)},n.fallbackCount,n.timeout);case 2:return t.abrupt("return",t.sent);case 3:return t.prev=3,i=t.catch(1),De._extend({canInit:!0}),console.error(i),t.abrupt("return",{Code:"Fail",Success:!1,err:i.toString()});case 4:case"end":return t.stop()}},t,null,[[1,3]])})),qe.apply(this,arguments)}function Ge(t,r){var e=arguments.length>2&&void 0!==arguments[2]?arguments[2]:{},n=arguments.length>3&&void 0!==arguments[3]?arguments[3]:2,i=arguments.length>4&&void 0!==arguments[4]?arguments[4]:5e3;return e.timeout=i,I().race([Ze(t,e),new(I())(function(t,r){return F()(function(){return r(new Error("timeout"))},i)})]).then(function(o){var c=wr(o),u=String(null==c?void 0:c.Code);return 1===n||"403"===u||"ThrottlingByStrategy"===u?new(I())(function(t){return t(c)}):!1===c.Success||null!=u&&Kr()(u).call(u,"5")?new(I())(function(t){return F()(t,0)}).then(function(){return Ge(t,r,Ve(r,e),n-1,i)}):new(I())(function(t){return t(c)})}).catch(function(o){if(1===n)throw o;return new(I())(function(t){return F()(t,0)}).then(function(){return Ge(t,r,Ve(r,e),n-1,i)})})}function Ye(t){var r=er,e=r.apiServers,n=r.apiDevServers,i=r.isDev,o=r.https,c=r.initPath,u=e,a="apiServers";i&&(u=n,a="apiDevServers"),xr("hst",u[t]),u.unshift(Ur()(u).call(u,t,1)[0]),r._extend(C()({},a,u)),u=H()(u).call(u,function(t){return r._prefix+"."+t});var s=H()(u).call(u,function(t){return lr(o,t,c)});De._extend({urls:s})}function Je(t,r){t.unshift(Ur()(t).call(t,r,1)[0]),Ie._extend({ENDPOINTS:t})}function Ve(t,r){var e="Log1"===t.Action?ke:Ee;return delete t.Signature,t.SignatureNonce=dr(),t.Signature=Ce(t,e.KEY_SECRET),r.body=Qe(t),r}function Ze(t,r){return Xe.apply(this,arguments)}function Xe(){return(Xe=k()(L().mark(function t(r,e){return L().wrap(function(t){for(;;)switch(t.prev=t.next){case 0:return t.abrupt("return",new(I())(function(t,i){var o=new XMLHttpRequest;o.open(e.method,r,!0),e.headers&&n()(e.headers).forEach(function(t){o.setRequestHeader(t,e.headers[t])}),o.withCredentials=e.withCredentials,e.timeout>0&&(o.timeout=e.timeout),o.responseType=e.responseType||"text",o.onload=function(){if(o.status>=200&&o.status<300)t(o.response);else if(403===o.status){var r=o.getResponseHeader("x-auth-msg");r?t(M()({Code:"403",LimitedFlowToken:r,LimitedFlow:!0,err:"LimitedFlow"})):i(new Error(o.responseText))}else i(new Error(o.responseText))},o.ontimeout=function(){i(new Error("timeout"))},o.onerror=function(){i(new Error("network error"))},o.send(e.body)}));case 1:case"end":return t.stop()}},t)}))).apply(this,arguments)}function Qe(t){var r="";for(var e in t)""!==r&&(r+="&"),r+=encodeURIComponent(e)+"="+encodeURIComponent(t[e]);return r}function $e(t){var r=t.isDev,e=t.apiServers,n=t.apiDevServers,i=t.server,o=t.verifyType,c=void 0===o?"2.0":o,u=t.region,a=void 0===u?"cn":u,s=t.dualStack,f=a;!0!==(void 0!==s&&s)||"ga"===a||r||(f="".concat(a,"_dual"));var l=e;return i?(l=i,t._extend({apiServers:l,apiDevServers:l})):("object"===_()(e)&&null!==e&&(l=wr(M()(ze[c][f])),t._extend({apiServers:l})),r&&(l=n,"object"===_()(n)&&null!==n&&(l=wr(M()(Me[c][f])),t._extend({apiDevServers:l})))),l}function tn(t,r){"saf-captcha"===r?void 0===t||M()(t)===M()(Ie.CN_DEFAULT_ENDPOINTS)?Ie._extend({ENDPOINTS:Ie.CN_ENDPOINTS}):M()(t)===M()(Ie.INTL_DEFAULT_ENDPOINTS)?Ie._extend({ENDPOINTS:Ie.INTL_ENDPOINTS}):Ie._extend({ENDPOINTS:t}):Ie._extend({ENDPOINTS:t||Ie.WAF_ENDPOINTS})}function rn(t,r){var e=r.prefix,n=r.language,i=void 0===n?"cn":n,o=r.userUserId,c=r.userId,u=r.upLang,a=r.mode,s=r.extraInfo,f=r.CertifyId,l=r.isFromTraceless,p=r.UserCertifyId,v=r.verifyType,h=r.EncryptedSceneId;t.Language=i,t.Mode=a,u&&(t.UpLang=!0),h&&(t.EncryptedSceneId=h),s&&("string"==typeof s?t.ExtraInfo=s:"object"===_()(s)&&(t.ExtraInfo=M()(s)));var d=Ee.ACTION.INIT,y=e;if(o&&c&&"1.0"===v&&(void 0!==r.__AliyunPrefix&&null!==r.__AliyunPrefix||(r.__AliyunPrefix=Jr()(o).toString()),y=r.__AliyunPrefix||Jr()(o).toString(),t.UserUserId=o,t.UserId=c,d=Ee.ACTION.INITV2),"3.0"===v&&(d=Ee.ACTION.INITV3),!t.DeviceToken){var g=Ie.DeviceToken||yr();g&&(t.DeviceToken=g)}return f&&l&&(t.CertifyId=f),p&&(o?t.UserCertifyId=p:t.UserCheckString=p),De._extend({_prefix:y}),{action:d,_prefix:y}}function en(t,r,e,n){return nn.apply(this,arguments)}function nn(){return nn=k()(L().mark(function t(r,e,n,i){var o,c,u,a,s,f,l,p,v,h,d,y,g;return L().wrap(function(t){for(;;)switch(t.prev=t.next){case 0:if(c=(o=Ie).https,u=o.cdnServers,a=o.cdnDevServers,s=o.dynamicJsPath,f=o.logs,l=o.initTime,p=c,v=u,n&&(v=a,window.d=!0),r)try{h=ge(r),void 0===Ie.deviceConfig&&Ie._extend({deviceConfig:h,timestamp:h.timestamp}),xr("ip",null===(d=h)||void 0===d?void 0:d.ip),null!==(y=h)&&void 0!==y&&y.version&&!0!==Ie.feilinLoad&&(window.um={},window.z_um={},Ie._extend({feilinLoad:!0}),f.push("20-"+(Date.now()-l)),Pr("js",p,v,s(h.version),null,function(t,r){if(t){try{f.push("21-"+(Date.now()-l)+"-"+r.toString().substring(0,50))}catch(t){f.push("22-"+(Date.now()-l))}Ie._extend({feilinLoad:!1}),e&&e(ke.ACTION_STATE.FAIL,{DeviceToken:""}),pr("networkError")}else f.push("23-"+(Date.now()-l)),window.FEILIN&&window.FEILIN.initFeiLin(Ie,e)},5e3))}catch(t){console.error(t)}else void 0===Ie.deviceConfig&&(g=function(){return""},window.um={},window.z_um={},window.um.getToken=g,window.z_um.getToken=g,e&&e(ke.ACTION_STATE.FAIL,{DeviceToken:""}));case 1:case"end":return t.stop()}},t)})),nn.apply(this,arguments)}function on(t,r){return cn.apply(this,arguments)}function cn(){return cn=k()(L().mark(function t(r,e){var n,i,o=arguments;return L().wrap(function(t){for(;;)switch(t.prev=t.next){case 0:if(n=o.length>2&&void 0!==o[2]&&o[2],i=!(o.length>3&&void 0!==o[3])||o[3],r&&e&&xr(r,e),n&&M()(De.logInfo),i&&!De.logUploaded)try{Fe(),De._extend({logUploaded:!0})}catch(t){De._extend({logUploaded:!0})}case 1:case"end":return t.stop()}},t)})),cn.apply(this,arguments)}window.__AYF=Ze;var un=[{text:"\u7F51\u7EDC\u4E0D\u7ED9\u529B\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5",key:"CONGESTION",value:{cn:"\u7F51\u7EDC\u4E0D\u7ED9\u529B\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5",tw:"\u7DB2\u7D61\u4E0D\u7D66\u529B\uFF0C\u8ACB\u5237\u65B0\u91CD\u8A66",en:"Network Err. Please refresh",ar:".\u062E\u0637\u0623 \u0641\u064A \u0627\u0644\u0634\u0628\u0643\u0629.\u064A\u0631\u062C\u0649 \u0627\u0644\u062A\u062D\u062F\u064A\u062B",de:"Netzwerkfehler. Bitte aktualisieren",es:"Error de red. Actual\xEDcelo, por favor.",fr:"Err. r\xE9seauVeuillez actualiser",in:"Jaringan BermasalahMohon muat ulang",it:"Errore di Rete. Aggiorna",ja:"\u30CD\u30C3\u30C8\u30EF\u30FC\u30AF\u30A8\u30E9\u30FC\u3002\u66F4\u65B0\u3057\u3066\u304F\u3060\u3055\u3044",ko:"\uB124\uD2B8\uC6CC\uD06C \uC624\uB958\uC0C8\uB85C \uACE0\uCE68\uD558\uC2DC\uAE30 \uBC14\uB78D\uB2C8\uB2E4",pt:"Erro de rede. Por favor, atualize",ru:"\u041E\u0448\u0438\u0431\u043A\u0430 \u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u044F. \u041E\u0431\u043D\u043E\u0432\u0438\u0442\u0435 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443",ms:"Ralat Rangkaian. Sila muat semula",th:"\u0E04\u0E23\u0E37\u0E2D\u0E02\u0E48\u0E32\u0E22\u0E02\u0E31\u0E14\u0E02\u0E49\u0E2D\u0E07\u0E01\u0E23\u0E38\u0E13\u0E32\u0E25\u0E2D\u0E07\u0E43\u0E2B\u0E21\u0E48",tr:"A\u011F Hts.L\xFCtfen yenileyin",vi:"L\u1ED7i m\u1EA1ngVui l\xF2ng t\u1EA3i l\u1EA1i"}},{text:"\u8BF7\u5B8C\u6210\u5B89\u5168\u9A8C\u8BC1",key:"POPUP_TITLE",value:{cn:"\u8BF7\u5B8C\u6210\u5B89\u5168\u9A8C\u8BC1",tw:"\u8ACB\u5B8C\u6210\u5B89\u5168\u9A57\u8B49",en:"Please complete the captcha",ar:"\u064A\u0631\u062C\u0649 \u0625\u0643\u0645\u0627\u0644 \u0643\u0644\u0645\u0629 \u0627\u0644\u062A\u062D\u0642\u0642",de:"Bitte f\xFCllen Sie das Captcha aus",es:"Complete el captcha.",fr:"Veuillez compl\xE9ter le captcha",in:"Mohon selesaikan captcha",it:"Completa il captcha per favore",ja:"\u30AD\u30E3\u30D7\u30C1\u30E3\u3092\u5B8C\u4E86\u3057\u3066\u304F\u3060\u3055\u3044",ko:"captcha\uB97C \uC644\uB8CC\uD558\uC138\uC694",pt:"Por favor, complete o captcha",ru:"\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043A\u0430\u043F\u0447\u0443",ms:"Sila lengkapkan captcha",th:"\u0E01\u0E23\u0E38\u0E13\u0E32\u0E01\u0E23\u0E2D\u0E01\u0E23\u0E2B\u0E31\u0E2A\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19",tr:"L\xFCtfen captcha'y\u0131 tamamlay\u0131n",vi:"Vui l\xF2ng ho\xE0n th\xE0nh captcha."}},{text:"\u8BF7\u6309\u4F4F\u6ED1\u5757\uFF0C\u62D6\u52A8\u5230\u6700\u53F3\u8FB9",key:"SLIDE_TIP",value:{cn:"\u8BF7\u6309\u4F4F\u6ED1\u5757\uFF0C\u62D6\u52A8\u5230\u6700\u53F3\u8FB9",tw:"\u8ACB\u6309\u4F4F\u6ED1\u584A\uFF0C\u62D6\u52D5\u5230\u6700\u53F3\u908A",en:"Please slide to verify",ar:"\u064A\u0631\u062C\u0649 \u0627\u0644\u062A\u0645\u0631\u064A\u0631 \u0644\u0644\u062A\u062D\u0642\u0642",de:"Bitte schieben Sie zur Verifizierung",es:"Deslice para verificar",fr:"Veuillez faire glisser pour v\xE9rifier",in:"Geser untuk memverifikasi",it:"Scorri per verificare per favore",ja:"\u30B9\u30E9\u30A4\u30C9\u3057\u3066\u78BA\u8A8D\u304F\u3060\u3055\u3044",ko:"\uC2AC\uB77C\uC774\uB4DC\uD558\uC5EC \uD655\uC778\uD574\uC8FC\uC138\uC694",pt:"Por favor, deslize para verificar",ru:"\u0421\u0434\u0432\u0438\u043D\u044C\u0442\u0435 \u0434\u043B\u044F \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438",ms:"Sila leret untuk mengesahkan",th:"\u0E01\u0E23\u0E38\u0E13\u0E32\u0E40\u0E25\u0E37\u0E48\u0E2D\u0E19\u0E40\u0E1E\u0E37\u0E48\u0E2D\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19",tr:"Do\u011Frulamak i\xE7in l\xFCtfen kayd\u0131r\u0131n",vi:"Vui l\xF2ng tr\u01B0\u1EE3t \u0111\u1EC3 x\xE1c minh"}},{text:"\u8BF7\u5148\u5B8C\u6210\u9A8C\u8BC1\uFF01",key:"FINISH_CAPTCHA",value:{cn:"\u8BF7\u5148\u5B8C\u6210\u9A8C\u8BC1\uFF01",tw:"\u8ACB\u5148\u5B8C\u6210\u9A57\u8B49\uFF01",en:"Please complete captcha first",ar:"\u064A\u0631\u062C\u0649 \u0625\u0643\u0645\u0627\u0644 \u0627\u0644\u062A\u062D\u0642\u0642 \u0623\u0648\u0644\u0627",de:"Bitte f\xFCllen Sie zuerst das Captcha aus",es:"Complete el captcha primero",fr:"Veuillez d'abord compl\xE9ter le captcha",in:"Selesaikan captcha terlebih dahulu",it:"Completa prima il captcha",ja:"\u6700\u521D\u306B\u30AD\u30E3\u30D7\u30C1\u30E3\u3092\u5B8C\u4E86\u3057\u3066\u4E0B\u3055\u3044",ko:"\uBA3C\uC800 captcha\uB97C \uC644\uB8CC\uD558\uC138\uC694",pt:"Por favor, preencha primeiro o captcha",ru:"\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0432\u0432\u0435\u0434\u0438\u0442\u0435 \u043A\u0430\u043F\u0447\u0443",ms:"Sila lengkapkan captcha dahulu",th:"\u0E01\u0E23\u0E38\u0E13\u0E32\u0E01\u0E23\u0E2D\u0E01\u0E23\u0E2B\u0E31\u0E2A\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19\u0E01\u0E48\u0E2D\u0E19",tr:"L\xFCtfen \xF6nce captcha'y\u0131 tamamlay\u0131n",vi:"Vui l\xF2ng ho\xE0n th\xE0nh captcha tr\u01B0\u1EDBc"}},{text:"\u9A8C\u8BC1\u4E2D...",key:"VERIFYING",value:{cn:"\u9A8C\u8BC1\u4E2D...",tw:"\u9A57\u8B49\u4E2D...",en:"Verifying...",ar:"\u0627\u0644\u062A\u062D\u0642\u0642",de:"Verifizieren...",es:"Verificando...",fr:"V\xE9rification...",in:"Memverifikasi...",it:"Verificando...",ja:"\u691C\u8A3C\u4E2D\u3067\u3059",ko:"\uD655\uC778 \uC911...",pt:"Verificar...",ru:"\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0430...",ms:"Mengesahkan...",th:"\u0E01\u0E33\u0E25\u0E31\u0E07\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19...",tr:"Do\u011Frulan\u0131yor...",vi:"\u0110ang x\xE1c minh..."}},{text:"\u6ED1\u52A8\u5B8C\u6210",key:"CAPTCHA_COMPLETED",value:{cn:"\u6ED1\u52A8\u5B8C\u6210",tw:"\u6ED1\u52D5\u5B8C\u6210",en:"Sliding completed",ar:"\u0627\u0643\u062A\u0645\u0644 \u0627\u0644\u062A\u0645\u0631\u064A\u0631",de:"Schieben abgeschlossen",es:"Deslizamiento completado",fr:"Glissement termin\xE9",in:"Geser selesai",it:"Scorrimento completato",ja:"\u30B9\u30E9\u30A4\u30C9\u5B8C\u4E86",ko:"\uC2AC\uB77C\uC774\uB529 \uC644\uB8CC",pt:"Deslizamento conclu\xEDdo",ru:"\u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u043E",ms:"Leret selesai",th:"\u0E40\u0E25\u0E37\u0E48\u0E2D\u0E19\u0E40\u0E2A\u0E23\u0E47\u0E08",tr:"Kayd\u0131rma tamamland\u0131",vi:"\u0110\xE3 ho\xE0n th\xE0nh tr\u01B0\u1EE3t"}},{text:"\u9A8C\u8BC1\u901A\u8FC7!",key:"SUCCESS",value:{cn:"\u9A8C\u8BC1\u901A\u8FC7!",tw:"\u9A57\u8B49\u901A\u904E\uFF01",en:"Verified",ar:"\u0645\u062D\u0642\u0642",de:"Verifiziert",es:"Verificado",fr:"V\xE9rifi\xE9",in:"Terverifikasi",it:"Verificato",ja:"\u691C\u8A3C\u6E08\u307F",ko:"\uC778\uC99D\uB428",pt:"Verificado",ru:"\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0430",th:"\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19\u0E40\u0E2A\u0E23\u0E47\u0E08\u0E2A\u0E34\u0E49\u0E19",ms:"Disahkan",tr:"Do\u011Fruland\u0131",vi:"\u0110\xE3 x\xE1c minh"}},{text:"\u9A8C\u8BC1\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5",key:"SLIDE_FAIL",value:{cn:"\u9A8C\u8BC1\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5",tw:"\u9A57\u8B49\u5931\u6557\uFF0C\u8ACB\u5237\u65B0\u91CD\u8A66",en:"Verify failed, please refresh",ar:" \u0641\u0634\u0644 \u0627\u0644\u062A\u062D\u0642\u0642\u060C \u064A\u0631\u062C\u0649 \u0627\u0644\u062A\u062D\u062F\u064A\u062B",de:"Verifizierung fehlgeschlagen, bitte aktualisieren",es:"Error al verificar, actual\xEDcelo",fr:"La v\xE9rification a \xE9chou\xE9, veuillez actualiser",in:"Verifikasi gagal, mohon muat ulang",it:"Impossibile verificare, aggiorna per favore",ja:"\u691C\u8A3C\u306B\u5931\u6557\u3057\u307E\u3057\u305F\u3002\u66F4\u65B0\u3057\u3066\u304F\u3060\u3055\u3044",ko:"\uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uC0C8\uB85C \uACE0\uCE68\uD558\uC138\uC694",pt:"A verifica\xE7\xE3o falhou, tente novamente",ru:"\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 \u043D\u0435 \u0443\u0434\u0430\u043B\u0430\u0441\u044C, \u043E\u0431\u043D\u043E\u0432\u0438\u0442\u0435 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443.",ms:"Pengesahan gagal, sila muat semula",th:"\u0E01\u0E32\u0E23\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19\u0E25\u0E49\u0E21\u0E40\u0E2B\u0E25\u0E27 \u0E01\u0E23\u0E38\u0E13\u0E32\u0E25\u0E2D\u0E07\u0E43\u0E2B\u0E21\u0E48",tr:"Do\u011Frulama ba\u015Far\u0131s\u0131z, l\xFCtfen yenileyin",vi:"X\xE1c minh th\u1EA5t b\u1EA1i, vui l\xF2ng t\u1EA3i l\u1EA1i"}},{text:"\u9A8C\u8BC1\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\uFF01",key:"CAPTCHA_FAIL",value:{cn:"\u9A8C\u8BC1\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\uFF01",tw:"\u9A57\u8B49\u5931\u6557\uFF0C\u8ACB\u91CD\u8A66\uFF01",en:"Verify failed, please try again",ar:"\u0641\u0634\u0644 \u0627\u0644\u062A\u062D\u0642\u0642\u060C \u064A\u0631\u062C\u0649 \u0625\u0639\u0627\u062F\u0629 \u0627\u0644\u0645\u062D\u0627\u0648\u0644\u0629",de:"Verifizierung fehlgeschlagen, bitte versuchen Sie es erneut",es:"Error al verificar, vuelva a intentarlo",fr:"La v\xE9rification a \xE9chou\xE9, veuillez actualiser",in:"Verifikasi gagal, silakan coba lagi",it:"Impossibile verificare, riprova per favore",ja:"\u691C\u8A3C\u306B\u5931\u6557\u3057\u307E\u3057\u305F\u3002\u3082\u3046\u4E00\u5EA6\u304A\u8A66\u3057\u304F\u3060\u3055\u3044",ko:"\uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694",pt:"A verifica\xE7\xE3o falhou, tente novamente",ru:"\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 \u043D\u0435 \u0443\u0434\u0430\u043B\u0430\u0441\u044C, \u043F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043F\u043E\u043F\u044B\u0442\u043A\u0443",ms:"Pengesahan gagal, sila cuba lagi",th:"\u0E01\u0E32\u0E23\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19\u0E25\u0E49\u0E21\u0E40\u0E2B\u0E25\u0E27 \u0E01\u0E23\u0E38\u0E13\u0E32\u0E25\u0E2D\u0E07\u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07",tr:"Do\u011Frulama ba\u015Far\u0131s\u0131z, l\xFCtfen tekrar deneyin",vi:"X\xE1c minh th\u1EA5t b\u1EA1i, vui l\xF2ng th\u1EED l\u1EA1i"}},{text:"\u52A0\u8F7D\u4E2D...",key:"LOADING",value:{cn:"\u52A0\u8F7D\u4E2D...",tw:"\u52A0\u8F09\u4E2D...",en:"Loading...",ar:"\u062A\u062D\u0645\u064A\u0644",de:"Laden\u2026",es:"Cargando",fr:"Chargement...",in:"Memuat...",it:"Caricando...",ja:"\u8AAD\u307F\u8FBC\u307F\u4E2D\u3067\u3059",ko:"\uB85C\uB4DC \uC911...",pt:"Carregando...",ru:"\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430\u2026",ms:"Memuatkan...",th:"\u0E01\u0E33\u0E25\u0E31\u0E07\u0E42\u0E2B\u0E25\u0E14...",tr:"Y\xFCkleniyor...",vi:"\u0110ang t\u1EA3i..."}},{text:"\u8BF7\u62D6\u52A8\u6ED1\u5757\u5B8C\u6210\u62FC\u56FE",key:"PUZZLE_TIP",value:{cn:"\u8BF7\u62D6\u52A8\u6ED1\u5757\u5B8C\u6210\u62FC\u56FE",tw:"\u8ACB\u62D6\u52D5\u6ED1\u584A\u5B8C\u6210\u62FC\u5716",en:"Drag slide to fill the puzzle",ar:"\u064A\u0631\u062C\u0649 \u0633\u062D\u0628 \u0627\u0644\u0634\u0631\u064A\u062D\u0629 \u0644\u0645\u0644\u0621 \u0627\u0644\u0644\u063A\u0632",de:"Bitte ziehen Sie die Folie, um das Puzzle zu f\xFCllen",es:"Arrastre la diapositiva para completar el puzzle",fr:"Faites glisser le curseur pour compl\xE9ter le puzzle",in:"Seret geser untuk mengisi teka-teki",it:"Trascina il cursore per riempire il puzzle",ja:"\u30C9\u30E9\u30C3\u30B0\u3057\u3066\u30D1\u30BA\u30EB\u3092\u57CB\u3081\u3066\u304F\u3060\u3055\u3044",ko:"\uC2AC\uB77C\uC774\uB4DC\uB97C \uB4DC\uB798\uADF8\uD558\uC5EC \uD37C\uC990\uC744 \uB9DE\uCD94\uC138\uC694",pt:"Arraste o slide para preencher o puzzle",ru:"\u041F\u0435\u0440\u0435\u0434\u0432\u0438\u043D\u044C\u0442\u0435 \u043F\u043E\u043B\u0437\u0443\u043D\u043E\u043A, \u0447\u0442\u043E\u0431\u044B \u0441\u043E\u0432\u043C\u0435\u0441\u0442\u0438\u0442\u044C \u043F\u0430\u0437\u043B",ms:"Sila seret leretan untuk mengisi teka-teki",th:"\u0E01\u0E23\u0E38\u0E13\u0E32\u0E40\u0E25\u0E37\u0E48\u0E2D\u0E19\u0E40\u0E1E\u0E37\u0E48\u0E2D\u0E40\u0E15\u0E34\u0E21\u0E20\u0E32\u0E1E\u0E1B\u0E23\u0E34\u0E28\u0E19\u0E32",tr:"Bulmacay\u0131 doldurmak i\xE7in kayd\u0131rma \xE7ubu\u011Funu l\xFCtfen s\xFCr\xFCkleyin",vi:"Vui l\xF2ng k\xE9o m\u1EA3nh gh\xE9p v\xE0o \u0111\xFAng v\u1ECB tr\xED"}},{text:"\u8BF7\u62D6\u52A8\u6ED1\u5757\u8FD8\u539F\u5B8C\u6574\u56FE\u7247",key:"INPAINTING_TIP",value:{cn:"\u8BF7\u62D6\u52A8\u6ED1\u5757\u8FD8\u539F\u5B8C\u6574\u56FE\u7247",tw:"\u8ACB\u62D6\u66F3\u6ED1\u687F\u9084\u539F\u5B8C\u6574\u5716\u7247",en:"Drag slide to restore the complete picture",ar:"\u0627\u0633\u062D\u0628 \u0634\u0631\u064A\u0637 \u0627\u0644\u062A\u0645\u0631\u064A\u0631 \u0644\u0625\u0643\u0645\u0627\u0644 \u0627\u0644\u0644\u063A\u0632",de:"Ziehen Sie den Schieberegler, um das Puzzle zu l\xF6sen",es:"Arrastre el control deslizante para completar el rompecabezas",fr:"Faites glisser le curseur pour compl\xE9ter le puzzle",in:"Seret penggeser untuk menyelesaikan teka-teki",it:"Trascina la barra di scorrimento per completare il puzzle",ja:"\u30B9\u30E9\u30A4\u30C0\u3092\u30C9\u30E9\u30C3\u30B0\u3057\u3066\u30D1\u30BA\u30EB\u3092\u5B8C\u6210\u3055\u305B\u3066\u304F\u3060\u3055\u3044",ko:"\uC2AC\uB77C\uC774\uB354\uB97C \uB4DC\uB798\uADF8\uD558\uC5EC \uD37C\uC990\uC744 \uC644\uC131\uD569\uB2C8\uB2E4",pt:"Arraste a barra deslizante para completar o quebra-cabe\xE7a",ru:"\u041F\u0435\u0440\u0435\u0442\u0430\u0449\u0438\u0442\u0435 \u043F\u043E\u043B\u0437\u0443\u043D\u043E\u043A, \u0447\u0442\u043E\u0431\u044B \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044C \u0433\u043E\u043B\u043E\u0432\u043E\u043B\u043E\u043C\u043A\u0443",ms:"Seret gelangsar untuk melengkapkan teka-teki",th:"\u0E25\u0E32\u0E01\u0E41\u0E16\u0E1A\u0E40\u0E25\u0E37\u0E48\u0E2D\u0E19\u0E40\u0E1E\u0E37\u0E48\u0E2D\u0E43\u0E2B\u0E49\u0E20\u0E32\u0E1E\u0E2A\u0E21\u0E1A\u0E39\u0E23\u0E13\u0E4C",tr:"Bulmacay\u0131 tamamlamak i\xE7in kayd\u0131r\u0131c\u0131y\u0131 s\xFCr\xFCkleyin",vi:"K\xE9o thanh tr\u01B0\u1EE3t \u0111\u1EC3 ho\xE0n th\xE0nh h\xECnh gh\xE9p"}}];window.__ALIYUN_CAPTCHA_TEXTS=un;var an={},sn=function(t){var r=window.CAPTCHA_LANG||"cn";return un.forEach(function(t){an[t.text]=t.value,window.UP_LANG&&B()(window.UP_LANG).forEach(function(r){var e,i=b()(r,2),o=i[0],c=i[1];Gr()(e=n()(c)).call(e,t.key)&&(an[t.text][o]=c[t.key])})}),an[t][r]||t};function fn(t){var r=this;function e(){r.onFallback&&"function"==typeof r.onFallback?r.onFallback(t):function(t,r){pn.apply(this,arguments)}(r,t)}var n=Ar(r.button);n&&"2.0"===r.verifyType?n.onclick=e:e()}var ln="";function pn(){return(pn=k()(L().mark(function t(r,e){var n,i,o,c,u,a;return L().wrap(function(t){for(;;)switch(t.prev=t.next){case 0:if(n=r.SceneId,i=r.CertifyId,o=r.DeviceToken,c={sceneId:n,certifyId:i,deviceToken:o||yr(),failover:"T"},u=M()(e),ln!==u&&(c.err=e,ln=u),!r.captchaVerifyCallback||"function"!=typeof r.captchaVerifyCallback){t.next=3;break}return t.next=1,r.captchaVerifyCallback(M()(c),hn.bind(r));case 1:if(null!=(a=t.sent)){t.next=2;break}return t.abrupt("return");case 2:hn.call(r,a),t.next=4;break;case 3:r.isShowErrorTip&&U(sn("\u7F51\u7EDC\u4E0D\u7ED9\u529B\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5"));case 4:case"end":return t.stop()}},t)}))).apply(this,arguments)}function vn(t,r){r?t.success&&t.success(r):t.onBizResultCallback&&t.onBizResultCallback(!0)}function hn(t){var r=this,e=t.captchaResult,n=t.bizResult;if(!0===e){if(void 0===n)return void vn(r);!1===n?(!function(t,r){r?t.fail&&t.fail(r):t.onBizResultCallback&&t.onBizResultCallback(!1)}(r),r.reInitCaptcha(r)):!0===n&&vn(r)}else!1!==e&&void 0!==e||(r.isShowErrorTip&&U(sn("\u7F51\u7EDC\u4E0D\u7ED9\u529B\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5")),r.reInitCaptcha(r))}var dn=e(9624),yn=e.n(dn),gn=xn;function mn(){var t=["mJu2BgfgBfnM","mtCXmMTqqwvPqq","otGXmtj6twHczgC","C2DW","otq3nda2tgfLzgnL","otyZmJe0AgrLuxrJ","mta2otG5otnSCuLQC2C","mta1EKn1txvl","ntiZmJGXBLffALnr","zw1Izwq","Cg9WDxa","ndK1nZaWAvPtsLH4"];return(mn=function(){return t})()}function xn(t,r){var e=mn();return xn=function(r,n){var i=e[r-=153];if(void 0===xn.UCKBkb){xn.taTcEy=function(t){for(var r,e,n="",i="",o=0,c=0;e=t.charAt(c++);~e&&(r=o%4?64*r+e:e,o++%4)?n+=String.fromCharCode(255&r>>(-2*o&6)):0)e="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=".indexOf(e);for(var u=0,a=n.length;u<a;u++)i+="%"+("00"+n.charCodeAt(u).toString(16)).slice(-2);return decodeURIComponent(i)},t=arguments,xn.UCKBkb=!0}var o=r+e[0],c=t[o];return c?i=c:(i=xn.taTcEy(i),t[o]=i),i},xn(t,r)}!function(t){for(var r=153,e=162,n=164,i=158,o=156,c=161,u=159,a=157,s=163,f=xn,l=t();;)try{if(308404===parseInt(f(r))/1+parseInt(f(e))/2+parseInt(f(n))/3*(-parseInt(f(i))/4)+-parseInt(f(o))/5+parseInt(f(c))/6+-parseInt(f(u))/7*(-parseInt(f(a))/8)+-parseInt(f(s))/9)break;l.push(l.shift())}catch(t){l.push(l.shift())}}(mn);var wn=["cn","tw","en","ar","de","es","fr","in","it","ja","ko","pt","ru","ms","th","tr","vi"],bn=["cn",gn(160),"ga"],Sn=[gn(155),gn(154)];function Cn(t){var r=wn;[{key:"upLang",checkFunction:function(t){return"object"===_()(t)&&null!==t&&!Array.isArray(t)&&(null==t?void 0:t.constructor)===Object},errorType:"paramsError",extraAction:function(t){var e,i=n()(t);r=Zr()(new(yn())(N()(e=[]).call(e,Zr()(i),Zr()(r))))}},{key:"SceneId",checkFunction:function(t){return"string"==typeof t},errorType:"paramsError"},{key:"prefix",checkFunction:function(t){return"string"==typeof t},errorType:"paramsError"},{key:"element",checkFunction:function(t){return"string"==typeof t},errorType:"paramsError"},{key:"element",checkFunction:function(t){return Ar(t)instanceof Element},errorType:"elementError"},{key:"button",checkFunction:function(t){return"string"==typeof t},errorType:"paramsError"},{key:"button",checkFunction:function(t){return Ar(t)instanceof Element},errorType:"elementError"},{key:"immediate",checkFunction:function(t){return"boolean"==typeof t},errorType:"paramsError"},{key:"autoRefresh",checkFunction:function(t){return"boolean"==typeof t},errorType:"paramsError"},{key:"timeout",checkFunction:function(t){return"number"==typeof t&&t>=0},errorType:"paramsError"},{key:"rem",checkFunction:function(t){return"number"==typeof t&&t>0},errorType:"paramsError"},{key:"mode",checkFunction:function(t){return Gr()(Sn).call(Sn,t)},errorType:"modeError"},{key:"region",checkFunction:function(t){return"string"==typeof t&&Gr()(bn).call(bn,t)},errorType:"regionError"},{key:"language",checkFunction:function(t){return"string"==typeof t&&Gr()(r).call(r,t)},errorType:"languageError"},{key:"slideStyle",checkFunction:function(t){if("object"!==_()(t)||Array.isArray(t)||(null==t?void 0:t.constructor)!==Object)return!1;var r=n()(t),e=["width","height"];return!(!r.every(function(t){return Gr()(e).call(e,t)})||0===r.length)&&!(void 0!==t.width&&"number"!=typeof t.width||void 0!==t.height&&"number"!=typeof t.height)},errorType:"paramsError"},{key:"dualStack",checkFunction:function(t){return"boolean"==typeof t},errorType:"paramsError"},{key:"isShowErrorTip",checkFunction:function(t){return"boolean"==typeof t},errorType:"paramsError"},{key:"delayBeforeSuccess",checkFunction:function(t){return"boolean"==typeof t},errorType:"paramsError"},{key:"EncryptedSceneId",checkFunction:function(t){return"string"==typeof t},errorType:"paramsError"}].forEach(function(r){try{var e=r.key,n=r.checkFunction,i=r.errorType,o=null==t?void 0:t[e];if(o&&!n(o))vr(i,e);else{var c=r.extraAction;o&&c&&c(o)}}catch(t){}})}e(477);function An(t,r){var e=void 0!==g()&&x()(t)||t["@@iterator"];if(!e){if(Array.isArray(t)||(e=function(t,r){if(t){var e;if("string"==typeof t)return _n(t,r);var n=v()(e={}.toString.call(t)).call(e,8,-1);return"Object"===n&&t.constructor&&(n=t.constructor.name),"Map"===n||"Set"===n?d()(t):"Arguments"===n||/^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)?_n(t,r):void 0}}(t))||r&&t&&"number"==typeof t.length){e&&(t=e);var n=0,i=function(){};return{s:i,n:function(){return n>=t.length?{done:!0}:{done:!1,value:t[n++]}},e:function(t){throw t},f:i}}throw new TypeError("Invalid attempt to iterate non-iterable instance.\\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.")}var o,c=!0,u=!1;return{s:function(){e=e.call(t)},n:function(){var t=e.next();return c=t.done,t},e:function(t){u=!0,o=t},f:function(){try{c||null==e.return||e.return()}finally{if(u)throw o}}}}function _n(t,r){(null==r||r>t.length)&&(r=t.length);for(var e=0,n=Array(r);e<r;e++)n[e]=t[e];return n}function En(t,r){var e=n()(t);if(o()){var i=o()(t);r&&(i=u()(i).call(i,function(r){return s()(t,r).enumerable})),e.push.apply(e,i)}return e}function kn(t){for(var r=1;r<arguments.length;r++){var e=null!=arguments[r]?arguments[r]:{};r%2?En(Object(e),!0).forEach(function(r){C()(t,r,e[r])}):l()?Object.defineProperties(t,l()(e)):En(Object(e)).forEach(function(r){Object.defineProperty(t,r,s()(e,r))})}return t}var Tn=er.ERR;function Bn(){return(Bn=k()(L().mark(function t(){var r,e,n,i,o,c,u;return L().wrap(function(t){for(;;)switch(t.prev=t.next){case 0:r=B()(Mr),e={},n=An(r),t.prev=1,n.s();case 2:if((i=n.n()).done){t.next=5;break}return o=i.value,t.next=3,o[1]();case 3:c=t.sent,e[o[0]]=c;case 4:t.next=2;break;case 5:t.next=7;break;case 6:t.prev=6,u=t.catch(1),n.e(u);case 7:return t.prev=7,n.f(),t.finish(7);case 8:nr._extend({preCollectData:e});case 9:case"end":return t.stop()}},t,null,[[1,6,7,8]])}))).apply(this,arguments)}function Dn(t,r,e,n,i,o){return In.apply(this,arguments)}function In(){return In=k()(L().mark(function t(r,e,n,i,o,c){return L().wrap(function(t){for(;;)switch(t.prev=t.next){case 0:if(!1!==er.canInit){t.next=1;break}return t.abrupt("return");case 1:return er._extend({canInit:!1,dynamicJSLoaded:!1,imgPreLoaded:!1}),t.abrupt("return",new(I())(function(t){Oe(r,e,function(c,u){function a(){var r=window.AliyunCaptcha.prototype;r.config=e,r.deviceConfig=nr,n&&"function"==typeof n&&n(u),t(u);var i=new window.AliyunCaptcha;e.getInstance&&e.getInstance(i)}function s(){"1.0"===e.verifyType?e.success&&e.success(u.CertifyId):"3.0"===e.verifyType&&e.success&&e.success(window.btoa(M()({certifyId:u.CertifyId,sceneId:e.SceneId,isSign:!0})))}if(e._extend(kn({DeviceToken:r.DeviceToken||"",fallbackCb:fn,canInit:!0},u)),"success"===c){var f=u.CaptchaType,l=!("TRACELESS"===f||"SLIDING"===f||"CHECK_BOX"===f);l&&I().all([Hr(u.PuzzleImage),Hr(u.Image)]).then(function(t){var r=b()(t,2),n=r[0],i=r[1];n&&e._extend({PuzzleImage:n}),i&&e._extend({Image:i}),e._extend({imgPreLoaded:!0}),"function"==typeof window.AliyunCaptcha&&!0===e.dynamicJSLoaded&&a()});var p=Date.now();Pr("js",i,o,u.CaptchaJsPath,null,function(t){var r=Date.now();t?(xr("js",{t:r,s:!1,msg:Tn.DYNAMICJS_FAIL,rt:r-p}),Fe(),fn.call(e,{code:Tn.DYNAMICJS_FAIL,msg:"\u52A8\u6001JS\u52A0\u8F7D\u5931\u8D25"}),s(),er.onError&&er.onError({code:Tn.DYNAMICJS_FAIL,msg:"\u52A8\u6001JS\u52A0\u8F7D\u5931\u8D25"}),pr("networkError")):(e._extend({dynamicJSLoaded:!0}),xr("js",{t:r,s:!0,msg:"DYNAMICJS_LOADED",rt:r-p}),l&&!e.imgPreLoaded||a())},5e3),Pr("css",i,o,u.CaptchaCssPath,null,function(t){t&&pr("networkError")},3e3)}else if("fail"===c){Fe();var v=u.LimitFlow?Tn.LIMIT_FLOW:Tn.INIT_FAIL;fn.call(e,{code:v,msg:u.err}),s(),er.onError&&er.onError({code:v,msg:null==u?void 0:u.err}),t(u),pr("networkError")}},c)}).catch(function(t){er.onError&&er.onError({code:Tn.INIT_FAIL,msg:null==t?void 0:t.message}),er._extend({canInit:!0})}).finally(function(){return er._extend({canInit:!0})}));case 2:case"end":return t.stop()}},t)})),In.apply(this,arguments)}if(window.AliyunCaptchaConfig&&"object"===_()(window.AliyunCaptchaConfig)){var zn=document.getElementById("waf_nc_block"),Mn=window.AliyunCaptchaConfig;Cn(Mn);var On=Mn.region||"cn",Ln=zn?"1.0":Mn.verifyType||"2.0",Pn=br(Mn.secEndpointType,Ln,On),Nn=Mn.dev||!1,jn={prefix:Mn.prefix||"",region:On,appName:Rt.appName[Ln],appKey:Rt.appKey[Ln][On],endpoints:Pn,deviceCallback:function(t,r){"success"===t&&(er._extend({DeviceToken:r.DeviceToken}),nr._extend({DeviceToken:r.DeviceToken}))}};Nn&&(jn.endpoints=Yt.endpoints[On],jn.appKey=Yt.appKey[On],jn.dev=Nn),function(){Pe.apply(this,arguments)}(jn)}!function(t){if(function(){Bn.apply(this,arguments)}(),void 0===t)throw new Error("Aliyun captcha requires browser environment");!function(){if("function"==typeof t.CustomEvent)return!1;function e(t,e){e=e||{bubbles:!1,cancelable:!1,detail:void 0};var n=r.createEvent("CustomEvent");return n.initCustomEvent(t,e.bubbles,e.cancelable,e.detail),n}e.prototype=t.Event.prototype,t.CustomEvent=e}();var r=t.document;t.head=r.getElementsByTagName("head")[0],t.TIMEOUT=1e4,t.initAliyunCaptcha=function(){var r=k()(L().mark(function r(e,n){var i,o,c,u,a,s,f,l,p,v,h,d,y;return L().wrap(function(r){for(;;)switch(r.prev=r.next){case 0:return t.AliyunCaptchaConfig&&"object"===_()(t.AliyunCaptchaConfig)&&(e.region=t.AliyunCaptchaConfig.region||e.region,e.prefix=t.AliyunCaptchaConfig.prefix||e.prefix),e.isShowErrorTip=!1!==e.showErrorTip,delete e.showErrorTip,!1!==e.delayBeforeSuccess&&(e.delayBeforeSuccess=!0),Cn(e),i=Sr(e),er._extend({DeviceConfig:void 0,deviceConfig:void 0,DeviceToken:void 0,verifyType:i}),o=e.SceneId,t.CAPTCHA_LANG=e.language,t.UP_LANG=e.upLang,er._extend(e),c=er.https,u=er.cdnServers,a=er.cdnDevServers,s=er.isDev,f=er.region,l=void 0===f?"cn":f,p=u,v=Rt.appKey[i][l],h=br(e.secEndpointType,i,l),s&&(p=a,"cn"===l?(v="sh3c47a8ddhs03057ef9e8a295bc895c",h="1.0"===i?["https://pre-device.captcha-open.aliyuncs.com"]:["https://cloudauth-device-pre.aliyuncs.com","https://pre-cn-shanghai.device.saf.aliyuncs.com"]):"cn"!==l&&(h=["https://pre-ap-southeast-1.device.saf.aliyuncs.com"],"1.0"===i&&h.push("https://cloudauth-device-pre.ap-southeast-1.aliyuncs.com"))),d={deviceConfig:{sceneId:o,appName:Rt.appName[i],appKey:v,endpoints:h,dev:s},deviceCallback:function(t,r){"success"===t?er._extend({DeviceToken:r.DeviceToken}):er._extend({err:{code:Tn.DEVICE_INIT_FAIL,msg:"\u8BBE\u5907\u6307\u7EB9\u521D\u59CB\u5316/\u52A8\u6001JS\u52A0\u8F7D\u5931\u8D25"}})}},y=function(t){er._extend(kn({},t)),Dn({SceneId:o,DeviceToken:er.DeviceToken},er,n,c,p,d)},er._extend({reInitCaptcha:y}),r.next=1,Dn({SceneId:o},er,n,c,p,d);case 1:return r.abrupt("return",r.sent);case 2:case"end":return r.stop()}},r)}));return function(t,e){return r.apply(this,arguments)}}()}(window)}()}();`;
  }
});

// src/proxy/captcha.ts
var captcha_exports = {};
__export(captcha_exports, {
  RETRY_HEADERS: () => RETRY_HEADERS,
  detectCaptchaChallenge: () => detectCaptchaChallenge,
  getCaptchaToken: () => getCaptchaToken,
  invalidateCaptchaToken: () => invalidateCaptchaToken
});
function detectCaptchaChallenge(resp) {
  const v = resp.headers.get(CAPTCHA_HEADER);
  return v && v.trim().length > 0 ? v.trim() : null;
}
function invalidateCaptchaToken() {
  cachedToken = null;
}
async function fetchCaptchaConfig(appVersion) {
  if (cachedConfig.value && cachedConfig.expiresAt > Date.now()) return cachedConfig.value;
  try {
    const resp = await fetch(`${CONFIGS_API}?app_version=${encodeURIComponent(appVersion)}&platform=win32-x64`);
    const json = await resp.json();
    const cfg = json?.data?.configs?.captcha ?? null;
    cachedConfig = { value: cfg, expiresAt: Date.now() + 6e4 };
    return cfg;
  } catch {
    return null;
  }
}
async function getCaptchaToken(appVersion) {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return { verifyParam: cachedToken.verifyParam, region: cachedToken.region };
  const cfg = await fetchCaptchaConfig(appVersion);
  if (!cfg || !cfg.enabled || !cfg.prefix || !cfg.sceneId) throw new Error("Captcha config unavailable");
  const verifyParam = await solveInJsdomWithRetry(cfg);
  cachedToken = { verifyParam, region: cfg.region, expiresAt: Date.now() + TOKEN_TTL_MS };
  return { verifyParam, region: cfg.region };
}
async function solveInJsdomWithRetry(cfg) {
  let lastErr = null;
  for (let attempt = 1; attempt <= SOLVE_RETRIES; attempt++) {
    try {
      return await solveInJsdom(cfg);
    } catch (err) {
      lastErr = err;
      console.error(`[captcha] solve attempt ${attempt}/${SOLVE_RETRIES} failed: ${lastErr.message}`);
    }
  }
  throw new Error(`captcha solve failed after ${SOLVE_RETRIES} attempts: ${lastErr?.message ?? "unknown"}`);
}
async function solveInJsdom(cfg) {
  const vc = new import_jsdom.VirtualConsole();
  const sdkSafe = AliyunCaptcha_js_default.replace(/<\/script>/gi, "<\\/script>");
  const html = `<!DOCTYPE html><html><head></head><body><div id="captcha-element"></div><button id="captcha-button"></button><script>${sdkSafe}</script></body></html>`;
  const dom = new import_jsdom.JSDOM(html, {
    url: "https://zcode.z.ai/",
    runScripts: "dangerously",
    resources: new FeiLinBlockingLoader(),
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      applyPolyfills(window);
      window.AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix };
    }
  });
  const w = dom.window;
  try {
    await waitFor(() => typeof w.initAliyunCaptcha === "function", SDK_LOAD_TIMEOUT_MS);
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`captcha solve timeout after ${SOLVE_TIMEOUT_MS}ms`)),
        SOLVE_TIMEOUT_MS
      );
      w.initAliyunCaptcha({
        SceneId: cfg.sceneId,
        mode: "popup",
        region: cfg.region,
        prefix: cfg.prefix,
        language: "en",
        element: "#captcha-element",
        button: "#captcha-button",
        captchaLogoImg: "",
        showErrorTip: false,
        getInstance: (inst) => {
          const fn = inst.startTracelessVerification || inst.show;
          if (typeof fn !== "function") {
            clearTimeout(timeout);
            reject(new Error("Aliyun SDK instance has no startTracelessVerification or show method"));
            return;
          }
          try {
            fn.call(inst);
          } catch (err) {
            clearTimeout(timeout);
            reject(new Error(`Aliyun SDK startTracelessVerification threw: ${err.message}`));
          }
        },
        success: (param) => {
          clearTimeout(timeout);
          resolve(param);
        },
        fail: (err) => {
          clearTimeout(timeout);
          reject(new Error(`SDK fail: ${JSON.stringify(err)}`));
        },
        onError: (err) => {
          clearTimeout(timeout);
          reject(new Error(`SDK error: ${JSON.stringify(err)}`));
        }
      });
    });
  } finally {
    try {
      w.close();
    } catch {
    }
  }
}
function waitFor(cond, ms) {
  return new Promise((resolve, reject) => {
    const s = Date.now();
    const id = setInterval(() => {
      let ok = false;
      try {
        ok = cond();
      } catch {
      }
      if (ok) {
        clearInterval(id);
        resolve();
      } else if (Date.now() - s > ms) {
        clearInterval(id);
        reject(new Error("SDK load timeout"));
      }
    }, 80);
  });
}
function applyPolyfills(window) {
  window.matchMedia = () => ({ matches: false, media: "", onchange: null, addListener() {
  }, removeListener() {
  }, addEventListener() {
  }, removeEventListener() {
  }, dispatchEvent() {
    return false;
  } });
  let rafCount = 0;
  window.requestAnimationFrame = (cb) => {
    const id = ++rafCount;
    setTimeout(() => cb(Date.now()), 16);
    return id;
  };
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  const proto = window.HTMLCanvasElement.prototype;
  proto.getContext = function(type) {
    if (/webgl/i.test(type)) return { canvas: this, getParameter: (p) => {
      if (p === 37445) return "Intel Inc.";
      if (p === 37446) return "Intel Iris OpenGL Engine";
      return "Intel";
    }, getExtension: () => null, getSupportedExtensions: () => ["WEBGL_debug_renderer_info"], getContextAttributes: () => ({}), getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }) };
    return { canvas: this, fillRect() {
    }, clearRect() {
    }, getImageData: (x, y, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {
    }, createImageData: (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }), setTransform() {
    }, transform() {
    }, drawImage() {
    }, save() {
    }, restore() {
    }, beginPath() {
    }, moveTo() {
    }, lineTo() {
    }, bezierCurveTo() {
    }, quadraticCurveTo() {
    }, closePath() {
    }, clip() {
    }, stroke() {
    }, fill() {
    }, arc() {
    }, rect() {
    }, ellipse() {
    }, translate() {
    }, scale() {
    }, rotate() {
    }, fillText() {
    }, strokeText() {
    }, measureText: (t) => ({ width: ("" + t).length * 8 }), createLinearGradient: () => ({ addColorStop() {
    } }), createRadialGradient: () => ({ addColorStop() {
    } }), createPattern: () => ({}), isPointInPath: () => false, font: "10px sans-serif", textBaseline: "alphabetic", textAlign: "start", fillStyle: "#000", strokeStyle: "#000", globalAlpha: 1, lineWidth: 1, shadowBlur: 0, shadowColor: "" };
  };
  proto.toDataURL = () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  proto.toBlob = (cb) => cb && cb(null);
  window.Worker = class {
    postMessage() {
    }
    terminate() {
    }
    addEventListener() {
    }
    removeEventListener() {
    }
    onmessage = null;
    onerror = null;
  };
  window.OffscreenCanvas = class {
    width = 0;
    height = 0;
    constructor(w, h) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      return proto.getContext.call(this);
    }
  };
  try {
    Object.defineProperty(window.document, "hidden", { value: false, configurable: true });
    Object.defineProperty(window.document, "visibilityState", { value: "visible", configurable: true });
  } catch {
  }
  const nav = window.navigator;
  for (const [k, v] of Object.entries({ userAgent: FAKE_UA, platform: "Win32", language: "en-US", languages: ["en-US", "en"], vendor: "Google Inc.", webdriver: false, hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0, cookieEnabled: true, plugins: { length: 3, item: () => null, namedItem: () => null, refresh() {
  } }, mimeTypes: { length: 0, item: () => null, namedItem: () => null } })) {
    try {
      Object.defineProperty(nav, k, { value: v, configurable: true });
    } catch {
    }
  }
  window.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 };
  window.chrome = { runtime: {} };
  window.outerWidth = 1920;
  window.outerHeight = 1080;
  window.innerWidth = 1280;
  window.innerHeight = 720;
  window.devicePixelRatio = 1;
  try {
    window.localStorage = window.localStorage || { _data: {}, getItem(k) {
      return this._data[k] || null;
    }, setItem(k, v) {
      this._data[k] = String(v);
    }, removeItem(k) {
      delete this._data[k];
    }, clear() {
      this._data = {};
    }, key(i) {
      return Object.keys(this._data)[i] || null;
    }, get length() {
      return Object.keys(this._data).length;
    } };
  } catch {
  }
}
var import_jsdom, CAPTCHA_HEADER, REGION_HEADER, CONFIGS_API, TOKEN_TTL_MS, FAKE_UA, SOLVE_RETRIES, SOLVE_TIMEOUT_MS, SDK_LOAD_TIMEOUT_MS, cachedConfig, cachedToken, FeiLinBlockingLoader, RETRY_HEADERS;
var init_captcha = __esm({
  "src/proxy/captcha.ts"() {
    "use strict";
    import_jsdom = require("jsdom");
    init_AliyunCaptcha_js();
    CAPTCHA_HEADER = "x-aliyun-captcha-verify-param";
    REGION_HEADER = "x-aliyun-captcha-verify-region";
    CONFIGS_API = "https://zcode.z.ai/api/v1/client/configs";
    TOKEN_TTL_MS = 45e3;
    FAKE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    SOLVE_RETRIES = Number(process.env.ZCODE_CAPTCHA_RETRIES || 3);
    SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_TIMEOUT_MS || 4e4);
    SDK_LOAD_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_SDK_LOAD_MS || 2e4);
    cachedConfig = { value: null, expiresAt: 0 };
    cachedToken = null;
    FeiLinBlockingLoader = class extends import_jsdom.ResourceLoader {
      fetch(url, options) {
        if (/FeiLin/i.test(url)) {
          return Object.assign(
            Promise.resolve(Buffer.from("window.__feilin_blocked=true;")),
            { abort() {
            } }
          );
        }
        return super.fetch(url, options);
      }
    };
    RETRY_HEADERS = { PARAM: CAPTCHA_HEADER, REGION: REGION_HEADER };
  }
});

// src/index.ts
var index_exports = {};
__export(index_exports, {
  main: () => main,
  parseServeArgs: () => parseServeArgs
});
module.exports = __toCommonJS(index_exports);

// src/config/loader.ts
var import_node_fs = require("node:fs");
var import_yaml = __toESM(require_dist(), 1);
var ENV = {
  PORT: "ZCODE_PROXY_PORT",
  PROXY_API_KEY: "ZCODE_PROXY_API_KEY",
  PROVIDER: "ZCODE_PROVIDER",
  API_KEY: "ZCODE_API_KEY",
  APP_VERSION: "ZCODE_APP_VERSION",
  SOURCE_TITLE: "ZCODE_SOURCE_TITLE",
  REFERER_ORIGIN: "ZCODE_REFERER_ORIGIN"
};
var DEFAULTS = {
  PORT: 8080,
  HOST: "0.0.0.0",
  PROVIDER: "zai",
  PLAN: "coding-plan",
  DEFAULT_MODEL: "glm-4.6",
  LOG_LEVEL: "info",
  ZAI_ANTHROPIC_BASE: "https://api.z.ai/api/anthropic",
  ZAI_OPENAI_BASE: "https://api.z.ai/api/coding/paas/v4",
  BIGMODEL_ANTHROPIC_BASE: "https://open.bigmodel.cn/api/anthropic",
  BIGMODEL_OPENAI_BASE: "https://open.bigmodel.cn/api/coding/paas/v4",
  APP_VERSION: "3.3.3",
  SOURCE_TITLE: "cli",
  REFERER_ORIGIN: "https://zcode.z.ai",
  CLIENT_IDENTITY_MODE: "observe",
  CLIENT_IDENTITY_TTL_SECONDS: 900,
  CLIENT_IDENTITY_MAX_SESSIONS: 1024,
  RESPONSES_ENABLED: true,
  RESPONSES_STORE_MAX_ENTRIES: 1e3,
  RESPONSES_STORE_TTL_MS: 24 * 60 * 60 * 1e3,
  MCP_ENABLED: true,
  MCP_WEB_SEARCH: true,
  MCP_WEB_READER: false,
  MCP_ZREAD: false
};
var ASCII_PRINTABLE = /^[\x20-\x7e]+$/;
function loadConfig(path) {
  if (!(0, import_node_fs.existsSync)(path)) {
    throw new Error(`Config file not found: ${path}`);
  }
  const raw = (0, import_node_fs.readFileSync)(path, "utf-8");
  const parsed = (0, import_yaml.parse)(raw) ?? {};
  const port = resolvePort(process.env[ENV.PORT] ?? parsed?.server?.port);
  const host = typeof parsed?.server?.host === "string" ? parsed.server.host : DEFAULTS.HOST;
  const proxyApiKey = process.env[ENV.PROXY_API_KEY] ?? parsed?.auth?.proxyApiKey;
  const mode = parsed?.auth?.mode === "oauth" ? "oauth" : "apikey";
  const apiKey = process.env[ENV.API_KEY] ?? parsed?.auth?.apiKey;
  const oauthCredentialsPath = parsed?.auth?.oauthCredentialsPath;
  const provider = resolveProvider(process.env[ENV.PROVIDER] ?? parsed?.provider);
  const plan = resolvePlan(parsed?.plan);
  const zai = {
    anthropicBase: parsed?.providers?.zai?.anthropicBase ?? DEFAULTS.ZAI_ANTHROPIC_BASE,
    openaiBase: parsed?.providers?.zai?.openaiBase ?? DEFAULTS.ZAI_OPENAI_BASE,
    credential: parsed?.providers?.zai?.credential
  };
  const bigmodel = {
    anthropicBase: parsed?.providers?.bigmodel?.anthropicBase ?? DEFAULTS.BIGMODEL_ANTHROPIC_BASE,
    openaiBase: parsed?.providers?.bigmodel?.openaiBase ?? DEFAULTS.BIGMODEL_OPENAI_BASE,
    credential: parsed?.providers?.bigmodel?.credential
  };
  const defaultModel = typeof parsed?.defaultModel === "string" ? parsed.defaultModel : DEFAULTS.DEFAULT_MODEL;
  const models = Array.isArray(parsed?.models) ? parsed.models : [defaultModel];
  const logLevel = resolveLogLevel(parsed?.logging?.level);
  const identity = resolveIdentity({
    appVersionEnv: process.env[ENV.APP_VERSION],
    appVersionYaml: parsed?.identity?.appVersion,
    sourceTitleEnv: process.env[ENV.SOURCE_TITLE],
    sourceTitleYaml: parsed?.identity?.sourceTitle,
    refererEnv: process.env[ENV.REFERER_ORIGIN],
    refererYaml: parsed?.identity?.refererOrigin
  });
  const clientIdentity = resolveClientIdentity(parsed?.clientIdentity);
  const responses = resolveResponsesConfig(parsed?.responses);
  const mcp = resolveMcpConfig(parsed?.mcp);
  const config = {
    server: { port, host },
    auth: { proxyApiKey, mode, apiKey, oauthCredentialsPath },
    provider,
    plan,
    providers: { zai, bigmodel },
    defaultModel,
    models,
    identity,
    clientIdentity,
    responses,
    mcp,
    logging: { level: logLevel }
  };
  validate(config);
  return config;
}
function resolveClientIdentity(raw) {
  const obj = raw && typeof raw === "object" ? raw : {};
  const mode = resolveClientIdentityMode(obj.mode);
  const ttlSeconds = resolvePositiveInt(obj.ttlSeconds, DEFAULTS.CLIENT_IDENTITY_TTL_SECONDS, "clientIdentity.ttlSeconds");
  const maxSessions = resolvePositiveInt(obj.maxSessions, DEFAULTS.CLIENT_IDENTITY_MAX_SESSIONS, "clientIdentity.maxSessions");
  return { mode, ttlSeconds, maxSessions };
}
function resolveClientIdentityMode(raw) {
  if (raw === void 0 || raw === null) return DEFAULTS.CLIENT_IDENTITY_MODE;
  if (raw === "off" || raw === "observe" || raw === "enforce") return raw;
  throw new Error(`Invalid clientIdentity.mode "${String(raw)}": must be "off", "observe", or "enforce"`);
}
function resolveResponsesConfig(raw) {
  const obj = raw && typeof raw === "object" ? raw : {};
  const storeRaw = obj.store && typeof obj.store === "object" ? obj.store : {};
  return {
    enabled: resolveBool(obj.enabled, DEFAULTS.RESPONSES_ENABLED),
    storeMaxEntries: resolvePositiveInt(storeRaw.maxEntries, DEFAULTS.RESPONSES_STORE_MAX_ENTRIES, "responses.store.maxEntries"),
    storeTtlMs: resolvePositiveInt(storeRaw.ttlMs, DEFAULTS.RESPONSES_STORE_TTL_MS, "responses.store.ttlMs")
  };
}
function resolveMcpConfig(raw) {
  const obj = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: resolveBool(obj.enabled, DEFAULTS.MCP_ENABLED),
    webSearch: resolveBool(obj.webSearch ?? obj.web_search, DEFAULTS.MCP_WEB_SEARCH),
    webReader: resolveBool(obj.webReader ?? obj.web_reader, DEFAULTS.MCP_WEB_READER),
    zread: resolveBool(obj.zread, DEFAULTS.MCP_ZREAD)
  };
}
function resolveBool(raw, fallback) {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw === "true" || raw === "1";
  return fallback;
}
function resolvePositiveInt(raw, fallback, name) {
  if (raw === void 0 || raw === null) return fallback;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}
function resolvePort(raw) {
  if (raw === void 0 || raw === null) return DEFAULTS.PORT;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n)) {
    throw new Error("server.port must be a valid number");
  }
  return n;
}
function resolveProvider(raw) {
  const v = typeof raw === "string" ? raw : DEFAULTS.PROVIDER;
  if (v !== "zai" && v !== "bigmodel") {
    throw new Error(`Invalid provider "${v}": must be "zai" or "bigmodel"`);
  }
  return v;
}
function resolvePlan(raw) {
  if (raw === "start-plan") return "start-plan";
  return DEFAULTS.PLAN;
}
function resolveLogLevel(raw) {
  const levels = ["debug", "info", "warn", "error"];
  if (typeof raw === "string" && levels.includes(raw)) {
    return raw;
  }
  return DEFAULTS.LOG_LEVEL;
}
function resolveIdentity(inp) {
  const rawVersion = (inp.appVersionEnv ?? inp.appVersionYaml ?? DEFAULTS.APP_VERSION).trim();
  const appVersion = ASCII_PRINTABLE.test(rawVersion) ? rawVersion : DEFAULTS.APP_VERSION;
  const sourceTitle = (inp.sourceTitleEnv ?? inp.sourceTitleYaml ?? DEFAULTS.SOURCE_TITLE).trim() || DEFAULTS.SOURCE_TITLE;
  const refererOrigin = (inp.refererEnv ?? inp.refererYaml ?? DEFAULTS.REFERER_ORIGIN).trim() || DEFAULTS.REFERER_ORIGIN;
  return { appVersion, sourceTitle, refererOrigin };
}
function validate(config) {
  if (config.server.port < 1 || config.server.port > 65535) {
    throw new Error(`server.port ${config.server.port} is out of range (1-65535)`);
  }
  if (config.auth.mode === "apikey") {
    const hasGlobal = typeof config.auth.apiKey === "string" && config.auth.apiKey.length > 0;
    const hasProvider = typeof config.providers[config.provider].credential === "string";
    if (!hasGlobal && !hasProvider) {
      throw new Error(
        `auth.apiKey is required when auth.mode is "apikey" (or set providers.${config.provider}.credential)`
      );
    }
  }
  if (!config.models.includes(config.defaultModel)) {
    config.models.push(config.defaultModel);
  }
}

// src/config/template.ts
var EXAMPLE_CONFIG_YAML = `server:
  port: 8080
  host: "0.0.0.0"

auth:
  # "apikey"  = use a pre-obtained API key directly
  # "oauth"   = use OAuth login flow (run \`bun run src/index.ts auth login\` first)
  mode: apikey

  # For apikey mode:
  #   Z.AI:     "yourApiKey.yourSecretKey"
  #   Bigmodel: "yourApiKey"
  apiKey: "YOUR_API_KEY_HERE"

  # Key that clients must provide to use the proxy.
  # Set to null/omit to disable client auth.
  proxyApiKey: "your-proxy-secret"

  # For oauth mode (path to stored credentials from login flow):
  # oauthCredentialsPath: "~/.zcode-proxy/credentials.json"

# Which upstream provider to use: "zai" or "bigmodel"
provider: zai

# Which plan tier to use:
#   "coding-plan" (default) \u2014 direct upstream endpoints, permanent API key
#   "start-plan"            \u2014 routes through zcode.z.ai with JWT auth (requires \`auth login\`)
plan: coding-plan

providers:
  zai:
    anthropicBase: "https://api.z.ai/api/anthropic"
    openaiBase: "https://api.z.ai/api/coding/paas/v4"
  bigmodel:
    anthropicBase: "https://open.bigmodel.cn/api/anthropic"
    openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4"

defaultModel: glm-4.6

models:
  - glm-4.5-air
  - glm-4.6
  - glm-4.6v
  - glm-4.7
  - glm-5
  - glm-5-turbo
  - glm-5v-turbo
  - glm-5.1
  - glm-5.2

# Configurable identity headers injected on every upstream request to mimic the
# ZCode desktop client (User-Agent, X-ZCode-App-Version, X-Title,
# X-ZCode-Agent, HTTP-Referer). Runtime platform headers (X-Platform,
# X-Os-Category, X-Os-Version) are detected dynamically and are not configured
# here. All fields below are optional; env vars override YAML, which overrides
# defaults.
identity:
  # Mirrors process.env.ZCODE_APP_VERSION in the ZCode bundle.
  # Must be printable ASCII; non-conforming values fall back to the default.
  # Default: "3.3.3" (current ZCode release). Override to match your real client.
  appVersion: "3.3.3"
  # X-Title suffix \u2192 "Z Code@{sourceTitle}". Default "cli".
  sourceTitle: "cli"
  # HTTP-Referer URL. Default "https://zcode.z.ai".
  refererOrigin: "https://zcode.z.ai"

# Local client-session inference for cache-affinity experiments.
# "observe" (default) logs inferred sessions in debug mode but does not change
# upstream x-session-id. "enforce" reuses a stable x-session-id for inferred
# coding-plan sessions. "off" disables inference entirely.
clientIdentity:
  mode: observe
  ttlSeconds: 900
  maxSessions: 1024

logging:
  level: info
`;

// src/auth/apikey.ts
function createApiKeyCredential(provider, key) {
  if (!key || key.trim().length === 0) {
    throw new Error("API key must not be empty");
  }
  const trimmed = key.trim();
  const dotIdx = trimmed.indexOf(".");
  if (dotIdx > 0 && dotIdx < trimmed.length - 1) {
    const apiKey = trimmed.slice(0, dotIdx);
    const secret = trimmed.slice(dotIdx + 1);
    return { apiKey, secret, provider };
  }
  return { apiKey: trimmed, provider };
}

// src/auth/manager.ts
var AuthManager = class {
  mode;
  provider;
  cachedApiKeyCred = null;
  oauthCred = null;
  constructor(opts) {
    this.mode = opts.mode;
    this.provider = opts.provider;
    if (opts.mode === "apikey" && opts.apiKey) {
      this.cachedApiKeyCred = createApiKeyCredential(this.provider, opts.apiKey);
    }
  }
  /** Returns the current credential, refreshing if necessary. */
  async getCredential() {
    if (this.mode === "apikey") {
      if (this.cachedApiKeyCred) return this.cachedApiKeyCred;
      throw new Error("apikey mode configured but no credential was set");
    }
    if (this.oauthCred) {
      if (this.oauthCred.expiresAt && Date.now() >= this.oauthCred.expiresAt) {
        this.oauthCred = null;
        throw new Error("OAuth credential expired; re-authentication required (T9/T10 not yet implemented)");
      }
      return this.oauthCred;
    }
    throw new Error("OAuth credential not available \u2014 run login flow first (T9/T10 not yet implemented)");
  }
  /** Set the OAuth credential (used by T9/T10 OAuth flow). */
  setOAuthCredential(cred) {
    this.oauthCred = cred;
  }
  /** Current auth mode. */
  getMode() {
    return this.mode;
  }
};

// src/server/server.ts
var import_node_http = require("node:http");
var import_node_stream = require("node:stream");

// src/server/webui.txt
var webui_default = `<!doctype html>\r
<html lang="en">\r
  <head>\r
    <meta charset="utf-8" />\r
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />\r
    <meta name="color-scheme" content="light dark" />\r
    <title>zcode-proxy</title>\r
    <!-- Markdown + sanitize + code highlight. All optional: the UI degrades to\r
         escaped plaintext if the CDN is unreachable. -->\r
    <script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js" defer></script>\r
    <script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js" defer></script>\r
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js" defer></script>\r
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css" />\r
    <style>\r
      :root {\r
        --accent: #6366f1;\r
        --accent-strong: #4f46e5;\r
        --radius: 12px;\r
        --sidebar-w: 264px;\r
      }\r
      :root[data-theme="dark"] {\r
        --bg: #212121;\r
        --sidebar: #171717;\r
        --elevated: #2f2f2f;\r
        --elevated-hover: #383838;\r
        --text: #ececec;\r
        --muted: #9a9a9a;\r
        --border: #3a3a3a;\r
        --user-bubble: #2f2f2f;\r
        --danger: #ef4444;\r
      }\r
      :root[data-theme="light"] {\r
        --bg: #ffffff;\r
        --sidebar: #f7f7f8;\r
        --elevated: #f0f0f0;\r
        --elevated-hover: #e6e6e6;\r
        --text: #1a1a1a;\r
        --muted: #6e6e6e;\r
        --border: #e5e5e5;\r
        --user-bubble: #f0f0f0;\r
        --danger: #dc2626;\r
      }\r
      * { box-sizing: border-box; }\r
      html, body { height: 100%; margin: 0; }\r
      body {\r
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;\r
        background: var(--bg);\r
        color: var(--text);\r
        font-size: 15px;\r
        line-height: 1.6;\r
        -webkit-font-smoothing: antialiased;\r
        overflow: hidden;\r
      }\r
      button { font-family: inherit; cursor: pointer; }\r
      input, textarea, select { font-family: inherit; font-size: inherit; color: inherit; }\r
      ::-webkit-scrollbar { width: 10px; height: 10px; }\r
      ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 8px; }\r
      ::-webkit-scrollbar-thumb:hover { background: var(--muted); }\r
\r
      .app { display: flex; height: 100vh; width: 100vw; }\r
\r
      /* ---------- Sidebar ---------- */\r
      .sidebar {\r
        width: var(--sidebar-w);\r
        flex: 0 0 var(--sidebar-w);\r
        background: var(--sidebar);\r
        border-right: 1px solid var(--border);\r
        display: flex;\r
        flex-direction: column;\r
        transition: margin-left .2s ease;\r
      }\r
      .sidebar.collapsed { margin-left: calc(-1 * var(--sidebar-w)); }\r
      .sidebar-head { padding: 12px; display: flex; gap: 8px; }\r
      .btn-new {\r
        flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;\r
        padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius);\r
        background: transparent; color: var(--text); font-weight: 500;\r
      }\r
      .btn-new:hover { background: var(--elevated); }\r
      .conv-list { flex: 1; overflow-y: auto; padding: 4px 8px; }\r
      .conv {\r
        display: flex; align-items: center; gap: 8px; padding: 9px 10px; margin: 2px 0;\r
        border-radius: 8px; cursor: pointer; color: var(--text); position: relative;\r
        white-space: nowrap; overflow: hidden;\r
      }\r
      .conv .conv-title { flex: 1; overflow: hidden; text-overflow: ellipsis; }\r
      .conv:hover { background: var(--elevated); }\r
      .conv.active { background: var(--elevated); }\r
      .conv .conv-del {\r
        opacity: 0; border: none; background: transparent; color: var(--muted);\r
        padding: 2px 6px; border-radius: 6px; flex: 0 0 auto;\r
      }\r
      .conv:hover .conv-del, .conv.active .conv-del { opacity: 1; }\r
      .conv .conv-del:hover { color: var(--danger); background: var(--elevated-hover); }\r
      .sidebar-foot { padding: 10px 12px; border-top: 1px solid var(--border); display: flex; gap: 8px; }\r
      .icon-btn {\r
        border: 1px solid var(--border); background: transparent; color: var(--text);\r
        border-radius: var(--radius); padding: 8px 10px; display: inline-flex; align-items: center; gap: 6px;\r
      }\r
      .icon-btn:hover { background: var(--elevated); }\r
      .sidebar-foot .icon-btn { flex: 1; justify-content: center; }\r
\r
      /* ---------- Main ---------- */\r
      .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }\r
      .topbar {\r
        height: 52px; flex: 0 0 52px; display: flex; align-items: center; gap: 10px;\r
        padding: 0 14px; border-bottom: 1px solid var(--border);\r
      }\r
      .topbar .model-wrap { display: flex; align-items: center; gap: 6px; }\r
      .topbar select#model {\r
        background: var(--elevated); border: 1px solid var(--border); border-radius: 8px;\r
        padding: 7px 10px; color: var(--text); max-width: 220px;\r
      }\r
      .think-wrap { display: flex; align-items: center; gap: 6px; }\r
      .think-wrap select#reasoning-effort {\r
        background: var(--elevated); border: 1px solid var(--border); border-radius: 8px;\r
        padding: 7px 8px; color: var(--text); font-size: 13px;\r
      }\r
      .think-wrap select#reasoning-effort:disabled { opacity: .5; }\r
      .status-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: 0 0 9px; }\r
      .status-dot.ok { background: #22c55e; }\r
      .status-dot.err { background: var(--danger); }\r
      .topbar .spacer { flex: 1; }\r
      .messages { flex: 1; overflow-y: auto; padding: 20px 0 12px; scroll-behavior: smooth; }\r
      .msg-list { max-width: 768px; margin: 0 auto; padding: 0 18px; display: flex; flex-direction: column; gap: 22px; }\r
      .msg { display: flex; flex-direction: column; gap: 8px; }\r
      .msg .role { font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }\r
      .msg.user .bubble {\r
        background: var(--user-bubble); align-self: flex-end; max-width: 85%;\r
        padding: 10px 14px; border-radius: var(--radius); border-top-right-radius: 4px;\r
        white-space: pre-wrap; word-break: break-word;\r
      }\r
      .msg.assistant .content { color: var(--text); }\r
      .msg-images { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 6px; }\r
      .msg-images img { max-width: 200px; max-height: 200px; border-radius: 8px; border: 1px solid var(--border); }\r
      .think {\r
        border: 1px solid var(--border); border-radius: 10px; background: var(--elevated);\r
        margin-bottom: 8px; overflow: hidden;\r
      }\r
      .think summary {\r
        cursor: pointer; padding: 8px 12px; font-size: 13px; color: var(--muted);\r
        list-style: none; display: flex; align-items: center; gap: 6px; user-select: none;\r
      }\r
      .think summary::-webkit-details-marker { display: none; }\r
      .think summary::before { content: "\\25B6"; font-size: 9px; transition: transform .15s; }\r
      .think[open] summary::before { transform: rotate(90deg); }\r
      .think .think-body { padding: 0 12px 10px; font-size: 13px; color: var(--muted); white-space: pre-wrap; word-break: break-word; }\r
      .msg-meta { font-size: 12px; color: var(--muted); display: flex; gap: 10px; align-items: center; }\r
      .msg-meta .regen { border: none; background: transparent; color: var(--muted); padding: 2px 6px; border-radius: 6px; }\r
      .msg-meta .regen:hover { color: var(--text); background: var(--elevated); }\r
\r
      .empty { text-align: center; color: var(--muted); padding: 60px 20px; }\r
      .empty h1 { font-size: 22px; margin: 0 0 6px; color: var(--text); font-weight: 600; }\r
\r
      /* markdown rendering */\r
      .md p { margin: 0 0 12px; }\r
      .md p:last-child { margin-bottom: 0; }\r
      .md h1,.md h2,.md h3,.md h4 { margin: 18px 0 8px; line-height: 1.3; font-weight: 600; }\r
      .md h1 { font-size: 1.5em; } .md h2 { font-size: 1.3em; } .md h3 { font-size: 1.15em; }\r
      .md ul,.md ol { margin: 0 0 12px; padding-left: 24px; }\r
      .md li { margin: 3px 0; }\r
      .md a { color: var(--accent); }\r
      .md blockquote { border-left: 3px solid var(--border); margin: 0 0 12px; padding: 2px 14px; color: var(--muted); }\r
      .md code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: .9em; }\r
      .md :not(pre) > code { background: var(--elevated); padding: 1px 5px; border-radius: 5px; }\r
      .md pre { position: relative; margin: 0 0 12px; border-radius: 10px; overflow: hidden; border: 1px solid var(--border); }\r
      .md pre .code-head {\r
        display: flex; justify-content: space-between; align-items: center;\r
        padding: 6px 12px; font-size: 12px; color: #adbac7;\r
        background: #2d333b; border-bottom: 1px solid var(--border);\r
      }\r
      .md pre code { display: block; padding: 12px 14px; overflow-x: auto; background: #0d1117; }\r
      .md pre .copy-btn {\r
        border: none; background: transparent; color: #adbac7; font-size: 12px; padding: 2px 6px; border-radius: 5px;\r
      }\r
      .md pre .copy-btn:hover { background: rgba(255,255,255,.1); color: #fff; }\r
      .md pre .code-actions { display: flex; align-items: center; gap: 6px; }\r
      .md pre .html-preview {\r
        display: block; width: 100%; min-height: 200px; max-height: 80vh;\r
        border: 0; background: #fff; resize: vertical;\r
      }\r
      .md table { border-collapse: collapse; margin: 0 0 12px; display: block; overflow-x: auto; }\r
      .md th,.md td { border: 1px solid var(--border); padding: 6px 12px; text-align: left; }\r
      .md hr { border: none; border-top: 1px solid var(--border); margin: 16px 0; }\r
      .md img { max-width: 100%; border-radius: 8px; }\r
\r
      /* ---------- Composer ---------- */\r
      .composer-wrap { flex: 0 0 auto; padding: 10px 18px 18px; }\r
      .composer {\r
        max-width: 768px; margin: 0 auto; background: var(--elevated);\r
        border: 1px solid var(--border); border-radius: 22px; padding: 8px 8px 8px 14px;\r
        display: flex; align-items: flex-end; gap: 6px;\r
      }\r
      .composer textarea {\r
        flex: 1; background: transparent; border: none; outline: none; resize: none;\r
        max-height: 200px; padding: 8px 2px; line-height: 1.5; color: var(--text);\r
      }\r
      .composer .c-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }\r
      .composer .think-bar { display: flex; align-items: center; gap: 4px; padding-right: 2px; }\r
      .composer .pill {\r
        border: 1px solid var(--border); background: var(--elevated-hover); color: var(--text);\r
        border-radius: 14px; padding: 0 10px; font-size: 12px; height: 32px; white-space: nowrap;\r
      }\r
      .composer .pill.on { background: var(--accent); color: #fff; border-color: var(--accent); }\r
      .composer select#reasoning-effort {\r
        background: var(--elevated-hover); border: 1px solid var(--border); color: var(--text);\r
        border-radius: 14px; padding: 0 6px; font-size: 12px; height: 32px; max-width: 84px;\r
      }\r
      .composer select#reasoning-effort:disabled { opacity: .45; }\r
      .composer .c-btn {\r
        width: 36px; height: 36px; border-radius: 50%; border: none;\r
        background: var(--accent); color: #fff; display: inline-flex; align-items: center; justify-content: center;\r
      }\r
      .composer .c-btn:disabled { opacity: .5; }\r
      .composer .c-btn.send:hover:not(:disabled) { background: var(--accent-strong); }\r
      .composer .c-btn.stop { background: var(--danger); }\r
      .composer .c-btn.attach { background: var(--elevated-hover); color: var(--text); }\r
      .composer .c-btn.attach[hidden] { display: none; }\r
      .composer .c-btn.attach.active { background: var(--accent); color: #fff; }\r
      .attach-input { display: none; }\r
      .attach-preview { max-width: 768px; margin: 0 auto 8px; display: flex; flex-wrap: wrap; gap: 8px; }\r
      .attach-preview:empty { display: none; }\r
      .attach-preview .ap { position: relative; }\r
      .attach-preview img { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); }\r
      .attach-preview .ap-rm {\r
        position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%;\r
        background: var(--danger); color: #fff; border: none; font-size: 11px; line-height: 18px; padding: 0;\r
      }\r
      .composer-hint { max-width: 768px; margin: 6px auto 0; text-align: center; font-size: 12px; color: var(--muted); }\r
\r
      /* ---------- Settings modal ---------- */\r
      .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: none; z-index: 50; }\r
      .overlay.open { display: flex; align-items: center; justify-content: center; padding: 20px; }\r
      .modal {\r
        background: var(--bg); border: 1px solid var(--border); border-radius: 16px;\r
        width: 100%; max-width: 560px; max-height: 88vh; overflow-y: auto; padding: 22px;\r
      }\r
      .modal h2 { margin: 0 0 4px; font-size: 18px; }\r
      .modal .sub { color: var(--muted); font-size: 13px; margin: 0 0 18px; }\r
      .field { margin-bottom: 16px; }\r
      .field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 5px; }\r
      .field .hint { font-size: 12px; color: var(--muted); margin-top: 4px; }\r
      .field input[type=text], .field input[type=password], .field input[type=number],\r
      .field textarea, .field select {\r
        width: 100%; background: var(--elevated); border: 1px solid var(--border);\r
        border-radius: 8px; padding: 9px 11px; color: var(--text); outline: none;\r
      }\r
      .field input:focus, .field textarea:focus, .field select:focus { border-color: var(--accent); }\r
      .field textarea { resize: vertical; min-height: 70px; }\r
      .row { display: flex; gap: 12px; } .row .field { flex: 1; }\r
      .range-row { display: flex; align-items: center; gap: 12px; }\r
      .range-row input[type=range] { flex: 1; accent-color: var(--accent); }\r
      .range-row .val { width: 52px; text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; font-size: 13px; }\r
      .switch { display: inline-flex; align-items: center; gap: 8px; }\r
      .switch input { accent-color: var(--accent); width: 16px; height: 16px; }\r
      .modal-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }\r
      .btn { border: 1px solid var(--border); background: var(--elevated); color: var(--text); border-radius: 8px; padding: 9px 16px; }\r
      .btn:hover { background: var(--elevated-hover); }\r
      .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }\r
      .btn.primary:hover { background: var(--accent-strong); }\r
      .banner {\r
        background: rgba(239,68,68,.12); border: 1px solid var(--danger); color: var(--text);\r
        padding: 8px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 12px; display: none;\r
      }\r
      .mcp-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }\r
      .mcp-summary { color: var(--muted); font-size: 13px; }\r
      .mcp-srv { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; font-size: 13px; }\r
      .mcp-srv .mcp-srv-head { display: flex; align-items: center; gap: 8px; }\r
      .mcp-srv .mcp-label { font-weight: 600; }\r
      .mcp-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: 0 0 8px; }\r
      .mcp-dot.ok { background: #22c55e; } .mcp-dot.err { background: var(--danger); } .mcp-dot.busy { background: #eab308; }\r
      .mcp-srv .mcp-state { color: var(--muted); font-size: 12px; }\r
      .mcp-srv .mcp-err { color: var(--danger); font-size: 12px; margin-top: 4px; word-break: break-word; }\r
      .mcp-tools { margin-top: 6px; color: var(--muted); font-size: 12px; line-height: 1.5; }\r
      .mcp-tool-chip { display: inline-block; background: var(--elevated); border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px; margin: 2px 2px 0 0; }\r
      .msg.tool .tool-body {\r
        background: var(--elevated); border: 1px dashed var(--border); border-radius: 8px;\r
        padding: 8px 10px; font-size: 12px; color: var(--muted); white-space: pre-wrap; word-break: break-word;\r
      }\r
      .msg .toolcalls { font-size: 12px; color: var(--muted); margin-top: 4px; }\r
      .toast {\r
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);\r
        background: var(--elevated); border: 1px solid var(--border); color: var(--text);\r
        padding: 10px 16px; border-radius: 10px; font-size: 13px; opacity: 0;\r
        transition: opacity .2s; z-index: 100; pointer-events: none;\r
      }\r
      .toast.show { opacity: 1; }\r
\r
      @media (max-width: 720px) {\r
        .sidebar { position: fixed; inset: 0 auto 0 0; z-index: 40; box-shadow: 2px 0 12px rgba(0,0,0,.3); }\r
        .sidebar.collapsed { margin-left: calc(-1 * var(--sidebar-w)); }\r
        .topbar select#model { max-width: 140px; }\r
      }\r
    </style>\r
  </head>\r
  <body>\r
    <div class="app">\r
      <!-- Sidebar -->\r
      <aside class="sidebar" id="sidebar">\r
        <div class="sidebar-head">\r
          <button class="btn-new" id="btn-new" title="New chat">+ New chat</button>\r
        </div>\r
        <div class="conv-list" id="conv-list"></div>\r
        <div class="sidebar-foot">\r
          <button class="icon-btn" id="btn-settings" title="Settings">Settings</button>\r
          <button class="icon-btn" id="btn-theme" title="Switch theme">Dark mode</button>\r
        </div>\r
      </aside>\r
\r
      <!-- Main -->\r
      <main class="main">\r
        <div class="topbar">\r
          <button class="icon-btn" id="btn-menu" title="Toggle sidebar" style="flex:0 0 auto;width:38px;justify-content:center;">&#9776;</button>\r
          <span class="status-dot" id="status-dot" title="Connection status"></span>\r
          <div class="model-wrap">\r
            <select id="model" title="Model"></select>\r
          </div>\r
          <div class="spacer"></div>\r
        </div>\r
\r
        <div class="messages" id="messages">\r
          <div class="msg-list" id="msg-list"></div>\r
        </div>\r
\r
        <div class="composer-wrap">\r
          <div class="attach-preview" id="attach-preview"></div>\r
          <div class="composer">\r
            <textarea id="input" rows="1" placeholder="Message the model&#8230;  (Enter to send, Shift+Enter for newline)"></textarea>\r
            <div class="c-actions">\r
              <div class="think-bar">\r
                <button class="pill" id="btn-think" type="button" title="Toggle deep thinking">Think: on</button>\r
                <select id="reasoning-effort" title="Reasoning effort (GLM-5.2+)"></select>\r
              </div>\r
              <button class="c-btn attach" id="btn-attach" title="Attach image (vision models)" hidden>&#128206;</button>\r
              <button class="c-btn send" id="btn-send" title="Send">&#8593;</button>\r
            </div>\r
          </div>\r
          <div class="composer-hint" id="hint"></div>\r
          <input type="file" class="attach-input" id="attach-input" accept="image/*" multiple />\r
        </div>\r
      </main>\r
    </div>\r
\r
    <!-- Settings modal -->\r
    <div class="overlay" id="overlay">\r
      <div class="modal" role="dialog" aria-modal="true">\r
        <h2>Settings</h2>\r
        <p class="sub">Auto-saved to this browser. The proxy API key is sent on every request.</p>\r
        <div class="banner" id="banner"></div>\r
\r
        <div class="field">\r
          <label for="s-apikey">Proxy API key</label>\r
          <input type="password" id="s-apikey" autocomplete="off" placeholder="(leave blank if proxy has no key)" />\r
          <div class="hint">Sent as <code>Authorization: Bearer &lt;key&gt;</code>.</div>\r
        </div>\r
\r
        <div class="field">\r
          <label for="s-system">System prompt</label>\r
          <textarea id="s-system" placeholder="e.g. You are a concise senior engineer."></textarea>\r
        </div>\r
\r
        <div class="row">\r
          <div class="field">\r
            <label>Temperature</label>\r
            <div class="range-row">\r
              <input type="range" id="s-temp" min="0" max="1" step="0.01" />\r
              <span class="val" id="s-temp-val">1.00</span>\r
            </div>\r
          </div>\r
          <div class="field">\r
            <label>Top-p</label>\r
            <div class="range-row">\r
              <input type="range" id="s-topp" min="0.01" max="1" step="0.01" />\r
              <span class="val" id="s-topp-val">0.95</span>\r
            </div>\r
          </div>\r
        </div>\r
\r
        <div class="row">\r
          <div class="field">\r
            <label for="s-maxtok">Max output tokens</label>\r
            <input type="number" id="s-maxtok" min="1" max="131072" step="1" />\r
          </div>\r
          <div class="field">\r
            <label>Sampling</label>\r
            <div class="switch" style="margin-top:10px;">\r
              <input type="checkbox" id="s-dosample" />\r
              <span>do_sample (disable for deterministic output)</span>\r
            </div>\r
          </div>\r
        </div>\r
\r
        <div class="field">\r
          <label>MCP tool calling</label>\r
          <div class="switch" style="margin-bottom:8px;">\r
            <input type="checkbox" id="s-mcpenable" />\r
            <span>Enable tools (when off, no tools are sent even if servers are connected)</span>\r
          </div>\r
          <label for="s-mcp" style="margin-top:6px;">MCP servers (one per line)</label>\r
          <textarea id="s-mcp" placeholder="https://mcp.example.com/mcp&#10;https://mcp.github.com/mcp,ghp_xxx&#10;http://localhost:3001/mcp"></textarea>\r
          <div class="hint">Format: <code>URL</code> or <code>URL,key</code> (comma-separated). Key sent as <code>Authorization: Bearer</code>. If a server needs the key in the URL, embed it there directly. Caution: keys are stored in plaintext in localStorage.</div>\r
        </div>\r
\r
        <div class="field">\r
          <label for="s-cors">CORS proxy (optional)</label>\r
          <input type="text" id="s-cors" placeholder="https://corsproxy.io/?url=   (leave blank for no CORS)" />\r
          <div class="hint">Needed when servers block browser CORS.</div>\r
        </div>\r
\r
        <div class="field">\r
          <label>MCP connection</label>\r
          <div class="mcp-bar">\r
            <button class="btn" id="btn-mcp-connect" type="button">Connect all</button>\r
            <button class="btn" id="btn-mcp-disconnect" type="button">Disconnect</button>\r
            <span class="mcp-summary" id="mcp-summary"></span>\r
          </div>\r
          <div id="mcp-status"></div>\r
        </div>\r
\r
        <div class="field">\r
          <label>Input</label>\r
          <div class="switch">\r
            <input type="checkbox" id="s-enter" />\r
            <span>Enter to send (Shift+Enter = newline)</span>\r
          </div>\r
        </div>\r
\r
        <div class="modal-foot">\r
          <button class="btn" id="btn-clear-all" title="Delete all conversations and reset settings">Reset all</button>\r
          <button class="btn primary" id="btn-close-settings">Done</button>\r
        </div>\r
      </div>\r
    </div>\r
\r
    <div class="toast" id="toast"></div>\r
\r
    <script>\r
    (function () {\r
      "use strict";\r
      var STORE = "zcode_webui_state_v1";\r
      // Known model catalog (used as a fallback when /v1/models is unreachable,\r
      // e.g. before the proxy key has been entered).\r
      var KNOWN_MODELS = [\r
        "glm-4.5-air", "glm-4.6", "glm-4.6v", "glm-4.7", "glm-5",\r
        "glm-5-turbo", "glm-5v-turbo", "glm-5.1", "glm-5.2"\r
      ];\r
\r
      var DEFAULT_SETTINGS = {\r
        apiKey: "",\r
        model: "glm-4.6",\r
        systemPrompt: "",\r
        temperature: 1.0,\r
        topP: 0.95,\r
        maxTokens: 4096,\r
        doSample: true,\r
        thinkingEnabled: true,\r
        reasoningEffort: "max",\r
        mcpEnabled: true,          // master toggle: only send tools when on\r
        mcpServers: [],            // [{url, authKey}] \u2014 "URL" or "URL,key" per line\r
        mcpCorsProxy: "",          // optional prefix (or {url} template) for browser CORS bypass\r
        theme: "system",\r
        enterToSend: true\r
      };\r
\r
      // ---- state ----\r
      var state = loadState();\r
      var pendingImages = [];      // {name, dataUrl} attached to next user msg\r
      var abortCtrl = null;        // current stream controller\r
      var busy = false;            // generating?\r
      var systemThemeDark = matchMedia("(prefers-color-scheme: dark)").matches;\r
\r
      // ---- dom ----\r
      var $ = function (id) { return document.getElementById(id); };\r
      var msgList = $("msg-list"), messages = $("messages");\r
      var inputEl = $("input"), sendBtn = $("btn-send"), attachBtn = $("btn-attach");\r
      var modelSel = $("model"), effortSel = $("reasoning-effort"), btnThink = $("btn-think");\r
      var convListEl = $("conv-list"), statusDot = $("status-dot");\r
      var sidebar = $("sidebar"), overlay = $("overlay"), toastEl = $("toast");\r
      var hintEl = $("hint");\r
\r
      // =========================================================\r
      // persistence\r
      // =========================================================\r
      function loadState() {\r
        try {\r
          var raw = localStorage.getItem(STORE);\r
          if (raw) {\r
            var s = JSON.parse(raw);\r
            s.settings = Object.assign({}, DEFAULT_SETTINGS, s.settings || {});\r
            s.conversations = Array.isArray(s.conversations) ? s.conversations : [];\r
            s.activeId = s.activeId || (s.conversations[0] && s.conversations[0].id) || null;\r
            return s;\r
          }\r
        } catch (e) { console.warn("load state failed", e); }\r
        return { settings: Object.assign({}, DEFAULT_SETTINGS), conversations: [], activeId: null };\r
      }\r
      function saveState() {\r
        try { localStorage.setItem(STORE, JSON.stringify(state)); }\r
        catch (e) { toast("Storage full \\u2014 older sessions not saved."); }\r
      }\r
      function activeConv() {\r
        return state.conversations.find(function (c) { return c.id === state.activeId; }) || null;\r
      }\r
      function newConv() {\r
        var c = { id: rid(), title: "New chat", messages: [], model: state.settings.model, createdAt: Date.now() };\r
        state.conversations.unshift(c);\r
        state.activeId = c.id;\r
        saveState();\r
        renderSidebar(); renderMessages(); inputEl.focus();\r
      }\r
      function rid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }\r
\r
      // =========================================================\r
      // rendering\r
      // =========================================================\r
      function renderSidebar() {\r
        convListEl.innerHTML = "";\r
        state.conversations.forEach(function (c) {\r
          var row = document.createElement("div");\r
          row.className = "conv" + (c.id === state.activeId ? " active" : "");\r
          var title = document.createElement("span");\r
          title.className = "conv-title"; title.textContent = c.title || "New chat";\r
          var del = document.createElement("button");\r
          del.className = "conv-del"; del.innerHTML = "\\u2715"; del.title = "Delete";\r
          del.onclick = function (e) { e.stopPropagation(); deleteConv(c.id); };\r
          row.onclick = function () { state.activeId = c.id; saveState(); renderSidebar(); renderMessages(); };\r
          row.appendChild(title); row.appendChild(del);\r
          convListEl.appendChild(row);\r
        });\r
      }\r
      function deleteConv(id) {\r
        var i = state.conversations.findIndex(function (c) { return c.id === id; });\r
        if (i < 0) return;\r
        state.conversations.splice(i, 1);\r
        if (state.activeId === id) state.activeId = state.conversations[0] ? state.conversations[0].id : null;\r
        saveState(); renderSidebar(); renderMessages();\r
      }\r
\r
      function renderMessages() {\r
        msgList.innerHTML = "";\r
        var c = activeConv();\r
        if (!c || c.messages.length === 0) { emptyState(); return; }\r
        c.messages.forEach(function (m, idx) {\r
          msgList.appendChild(buildMsg(m, idx === c.messages.length - 1));\r
        });\r
        scrollBottom(true);\r
      }\r
      function emptyState() {\r
        var d = document.createElement("div");\r
        d.className = "empty";\r
        d.innerHTML = "<h1>zcode-proxy</h1><p>Chat with GLM models through your proxy. Pick a model above and start typing.</p>";\r
        msgList.appendChild(d);\r
      }\r
\r
      function buildMsg(m, isLast) {\r
        var wrap = document.createElement("div");\r
        wrap.className = "msg " + m.role;\r
        var role = document.createElement("div"); role.className = "role";\r
        role.textContent = m.role === "user" ? "You" : "Assistant";\r
        wrap.appendChild(role);\r
\r
        if (m.images && m.images.length) {\r
          var imgWrap = document.createElement("div"); imgWrap.className = "msg-images";\r
          m.images.forEach(function (src) {\r
            var im = document.createElement("img"); im.src = src; imgWrap.appendChild(im);\r
          });\r
          wrap.appendChild(imgWrap);\r
        }\r
\r
        if (m.role === "tool") {\r
          var tbody = document.createElement("div"); tbody.className = "tool-body";\r
          tbody.textContent = "\u{1F527} tool result\\n" + (m.content || "");\r
          wrap.appendChild(tbody);\r
          return wrap;\r
        }\r
\r
        if (m.role === "user") {\r
          var bubble = document.createElement("div"); bubble.className = "bubble";\r
          bubble.textContent = m.content || ""; wrap.appendChild(bubble);\r
        } else {\r
          var body = document.createElement("div"); body.className = "content md";\r
          if (m.reasoning) {\r
            var t = document.createElement("details"); t.className = "think"; t.open = true;\r
            var sum = document.createElement("summary"); sum.textContent = "Thinking\\u2026";\r
            var tb = document.createElement("div"); tb.className = "think-body"; tb.textContent = m.reasoning;\r
            t.appendChild(sum); t.appendChild(tb);\r
            body.appendChild(t);\r
          }\r
          body.innerHTML = renderMarkdown(m.content || "");\r
          enhanceCode(body);\r
          if (m.toolCalls && m.toolCalls.length) {\r
            var tc = document.createElement("div"); tc.className = "toolcalls";\r
            tc.textContent = "\u{1F527} called: " + m.toolCalls.map(function (x) { return x.name; }).join(", ");\r
            body.appendChild(tc);\r
          }\r
          wrap.appendChild(body);\r
          wrap.appendChild(meta(m, isLast));\r
        }\r
        return wrap;\r
      }\r
      function meta(m, isLast) {\r
        var d = document.createElement("div"); d.className = "msg-meta";\r
        if (m.model) { var s = document.createElement("span"); s.textContent = m.model; d.appendChild(s); }\r
        if (m.truncated) { var t = document.createElement("span"); t.textContent = "\\u00b7 truncated (max tokens)"; d.appendChild(t); }\r
        if (m.role === "assistant" && isLast && !busy) {\r
          var b = document.createElement("button"); b.className = "regen"; b.textContent = "\\u21bb Regenerate";\r
          b.onclick = regenerate; d.appendChild(b);\r
        }\r
        return d;\r
      }\r
\r
      // =========================================================\r
      // markdown\r
      // =========================================================\r
      function renderMarkdown(text) {\r
        if (typeof marked === "undefined") return escapeHtml(text);\r
        try {\r
          marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });\r
          var html = marked.parse(text);\r
          if (typeof DOMPurify !== "undefined") html = DOMPurify.sanitize(html);\r
          return html;\r
        } catch (e) { return escapeHtml(text); }\r
      }\r
      function escapeHtml(s) {\r
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");\r
      }\r
      // Tiny script appended to rendered HTML so the sandboxed iframe can tell\r
      // its parent how tall the content is (auto-height). Split "<script" so the\r
      // host parser never sees a real end-tag inside this string.\r
      var RESIZE_SCRIPT = '<' + 'script>(function(){function r(){try{parent.postMessage({__zcpPreview:true,h:document.documentElement.scrollHeight},"*")}catch(e){}}window.addEventListener("load",r);setTimeout(r,60);setTimeout(r,400);setTimeout(r,1200);})();<' + '/script>';\r
      var previewListenerAdded = false;\r
      function ensurePreviewListener() {\r
        if (previewListenerAdded) return;\r
        previewListenerAdded = true;\r
        window.addEventListener("message", function (ev) {\r
          var d = ev.data;\r
          if (!d || d.__zcpPreview !== true || typeof d.h !== "number") return;\r
          var frames = document.querySelectorAll("iframe.html-preview");\r
          for (var i = 0; i < frames.length; i++) {\r
            if (frames[i].contentWindow === ev.source) {\r
              var h = Math.max(120, Math.min(2000, d.h | 0));\r
              frames[i].style.height = h + "px";\r
              break;\r
            }\r
          }\r
        });\r
      }\r
      function toggleHtmlPreview(pre, code, btn, label, raw) {\r
        var frame = pre.querySelector("iframe.html-preview");\r
        if (!frame) {\r
          ensurePreviewListener();\r
          frame = document.createElement("iframe");\r
          frame.className = "html-preview";\r
          // allow-scripts (no allow-same-origin): JS runs but the iframe is a\r
          // null origin that cannot touch the parent page's DOM/storage.\r
          frame.setAttribute("sandbox", "allow-scripts");\r
          frame.setAttribute("srcdoc", raw + RESIZE_SCRIPT);\r
          pre.appendChild(frame);\r
        }\r
        var showPreview = btn.textContent === "preview";\r
        code.style.display = showPreview ? "none" : "";\r
        frame.style.display = showPreview ? "" : "none";\r
        btn.textContent = showPreview ? "code" : "preview";\r
        label.textContent = showPreview ? "preview" : "html";\r
      }\r
      function enhanceCode(root) {\r
        var pres = root.querySelectorAll("pre > code:not([data-hl])");\r
        pres.forEach(function (code) {\r
          var pre = code.parentElement;\r
          var raw = code.textContent;\r
          var lang = (code.className.match(/language-([\\w+-]+)/) || [])[1] || "";\r
          var head = document.createElement("div"); head.className = "code-head";\r
          var label = document.createElement("span"); label.textContent = lang || "code";\r
          var actions = document.createElement("span"); actions.className = "code-actions";\r
          var cp = document.createElement("button"); cp.className = "copy-btn"; cp.textContent = "copy";\r
          cp.onclick = function () {\r
            navigator.clipboard.writeText(raw).then(function () {\r
              cp.textContent = "copied"; setTimeout(function () { cp.textContent = "copy"; }, 1200);\r
            });\r
          };\r
          // In-page render toggle for HTML blocks (sandboxed iframe preview).\r
          if (/^html$/i.test(lang)) {\r
            var pv = document.createElement("button"); pv.className = "copy-btn"; pv.textContent = "preview";\r
            pv.title = "Render this HTML live (sandboxed)";\r
            pv.onclick = function () { toggleHtmlPreview(pre, code, pv, label, raw); };\r
            actions.appendChild(pv);\r
          }\r
          actions.appendChild(cp);\r
          head.appendChild(label); head.appendChild(actions);\r
          pre.insertBefore(head, code);\r
          code.setAttribute("data-hl", "1");\r
          if (typeof hljs !== "undefined") { try { hljs.highlightElement(code); } catch (e) {} }\r
        });\r
        root.querySelectorAll("a[href]").forEach(function (a) {\r
          a.target = "_blank"; a.rel = "noopener noreferrer";\r
        });\r
      }\r
\r
      // =========================================================\r
      // theme\r
      // =========================================================\r
      function applyTheme() {\r
        var t = state.settings.theme;\r
        var dark = t === "dark" || (t === "system" && systemThemeDark);\r
        document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");\r
        var b = $("btn-theme");\r
        if (b) {\r
          // Label shows the mode you'll switch TO.\r
          b.textContent = dark ? "Light mode" : "Dark mode";\r
          b.title = "Switch to " + (dark ? "light" : "dark") + " theme";\r
        }\r
      }\r
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function (e) {\r
        systemThemeDark = e.matches; if (state.settings.theme === "system") applyTheme();\r
      });\r
\r
      // =========================================================\r
      // models\r
      // =========================================================\r
      function populateModels(list) {\r
        modelSel.innerHTML = "";\r
        (list.length ? list : KNOWN_MODELS).forEach(function (id) {\r
          var o = document.createElement("option"); o.value = id; o.textContent = id;\r
          modelSel.appendChild(o);\r
        });\r
        if (state.settings.model && Array.from(modelSel.options).some(function (o) { return o.value === state.settings.model; })) {\r
          modelSel.value = state.settings.model;\r
        }\r
        syncAttachVisibility();\r
        if (typeof populateEffort === "function") { populateEffort(); syncThinkButton(); }\r
      }\r
      function fetchModels() {\r
        var headers = {};\r
        if (state.settings.apiKey) headers["authorization"] = "Bearer " + state.settings.apiKey;\r
        fetch("/v1/models", { method: "GET", headers: headers })\r
          .then(function (r) {\r
            if (!r.ok) throw new Error("HTTP " + r.status);\r
            return r.json();\r
          })\r
          .then(function (j) {\r
            var ids = (j.data || []).map(function (m) { return m.id; });\r
            populateModels(ids); setStatus("ok");\r
          })\r
          .catch(function () {\r
            populateModels(KNOWN_MODELS);\r
            setStatus(state.settings.apiKey ? "err" : "idle");\r
          });\r
      }\r
      function setStatus(s) {\r
        statusDot.className = "status-dot" + (s === "ok" ? " ok" : s === "err" ? " err" : "");\r
        statusDot.title = s === "ok" ? "Connected" : s === "err" ? "Request failed (check key / proxy)" : "Set proxy API key in settings";\r
      }\r
      function isVisionModel(id) { return /v/i.test(id || ""); }\r
      function syncAttachVisibility() { attachBtn.hidden = !isVisionModel(modelSel.value); }\r
\r
      // =========================================================\r
      // request building\r
      // =========================================================\r
      function buildRequestMessages(conv) {\r
        var msgs = [];\r
        if (state.settings.systemPrompt && state.settings.systemPrompt.trim()) {\r
          msgs.push({ role: "system", content: state.settings.systemPrompt.trim() });\r
        }\r
        conv.messages.forEach(function (m) {\r
          if (m.role === "user" && m.images && m.images.length) {\r
            var parts = m.images.map(function (src) {\r
              return { type: "image_url", image_url: { url: src } };\r
            });\r
            parts.push({ type: "text", text: m.content || "" });\r
            msgs.push({ role: "user", content: parts });\r
          } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length) {\r
            msgs.push({\r
              role: "assistant",\r
              content: m.content || "",\r
              tool_calls: m.toolCalls.map(function (tc) {\r
                return { id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments || "{}" } };\r
              }),\r
            });\r
          } else if (m.role === "tool") {\r
            msgs.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content || "" });\r
          } else {\r
            msgs.push({ role: m.role, content: m.content || "" });\r
          }\r
        });\r
        return msgs;\r
      }\r
      function buildBody(conv) {\r
        var model = conv.model || state.settings.model;\r
        var body = {\r
          model: model,\r
          messages: buildRequestMessages(conv),\r
          stream: true,\r
          temperature: Number(state.settings.temperature),\r
          top_p: Number(state.settings.topP),\r
          max_tokens: Number(state.settings.maxTokens),\r
          do_sample: !!state.settings.doSample\r
        };\r
        if (state.settings.thinkingEnabled) {\r
          body.thinking = { type: "enabled" };\r
          if (isReasoningModel(model)) body.reasoning_effort = state.settings.reasoningEffort;\r
        } else {\r
          body.thinking = { type: "disabled" };\r
        }\r
        var fnTools = gatherMcpTools();\r
        if (fnTools.length) { body.tools = fnTools; body.tool_choice = "auto"; }\r
        return body;\r
      }\r
      function isReasoningModel(id) {\r
        // reasoning_effort is only honored by GLM-5.2 and above per BigModel docs.\r
        return /glm-5\\.[2-9]|glm-[6-9]/i.test(id || "");\r
      }\r
      // =========================================================\r
      // MCP \u2014 client-managed (browser-direct, optional CORS proxy).\r
      // The webui connects to each server, lists its tools, injects them as\r
      // function tools, and auto-executes tool calls the model returns.\r
      // =========================================================\r
      var mcpState = {};          // url -> {sessionId, tools[], connected, error, status}\r
      var mcpToolMap = {};        // tool name -> {url, name}\r
      var mcpRpcId = 0;\r
      function nextRpcId() { return ++mcpRpcId; }\r
\r
      function applyCorsProxy(url) {\r
        var cp = (state.settings.mcpCorsProxy || "").trim();\r
        if (!cp) return url;\r
        if (cp.indexOf("{url}") >= 0) return cp.replace("{url}", encodeURIComponent(url));\r
        return cp + encodeURIComponent(url);\r
      }\r
      // POST one JSON-RPC message. Resolves {status, contentType, sessionId, body}.\r
      // Auth: sent only as Authorization: Bearer (KoboldAI parity). If a server\r
      // needs the key in the URL, embed it directly in the server URL line.\r
      function mcpFetch(server, rpc) {\r
        var st = mcpState[server.url] || (mcpState[server.url] = {});\r
        var headers = { "content-type": "application/json", "accept": "application/json, text/event-stream" };\r
        if (st.sessionId) headers["mcp-session-id"] = st.sessionId;\r
        if (server.authKey) headers["authorization"] = "Bearer " + server.authKey;\r
        return fetch(applyCorsProxy(server.url), {\r
          method: "POST", headers: headers, body: JSON.stringify(rpc),\r
        }).then(function (r) {\r
          return r.text().then(function (t) {\r
            return {\r
              ok: r.ok, status: r.status,\r
              contentType: r.headers.get("content-type") || "",\r
              sessionId: r.headers.get("mcp-session-id") || "",\r
              body: t,\r
            };\r
          });\r
        });\r
      }\r
      // streamable-http servers may answer with SSE (data: lines) or plain JSON.\r
      function parseMcpResponse(resp) {\r
        var body = resp.body || "";\r
        var looksSSE = resp.contentType.indexOf("text/event-stream") >= 0 || body.indexOf("data:") === 0;\r
        if (looksSSE) {\r
          var parsed = null;\r
          body.split("\\n").forEach(function (ln) {\r
            if (ln.indexOf("data:") === 0) {\r
              var d = ln.slice(5).trim();\r
              if (d) { try { parsed = JSON.parse(d); } catch (e) {} }\r
            }\r
          });\r
          return parsed;\r
        }\r
        try { return JSON.parse(body); } catch (e) { return null; }\r
      }\r
      function mcpCall(server, method, params) {\r
        var rpc = { jsonrpc: "2.0", id: nextRpcId(), method: method };\r
        if (params) rpc.params = params;\r
        return mcpFetch(server, rpc).then(function (resp) {\r
          var st = mcpState[server.url];\r
          if (resp.sessionId && st && !st.sessionId) st.sessionId = resp.sessionId;\r
          var json = parseMcpResponse(resp);\r
          if (!json) throw new Error("MCP " + method + " on " + server.url + " returned no JSON (HTTP " + resp.status + ")");\r
          if (json.error) throw new Error("MCP error" + (json.error.code != null ? " (" + json.error.code + ")" : "") + ": " + (json.error.message || JSON.stringify(json.error)));\r
          return json;\r
        });\r
      }\r
      // initialize + tools/list for one server. Resolves to tools[].\r
      function mcpConnect(server) {\r
        return mcpCall(server, "initialize", {\r
          protocolVersion: "2024-11-05", capabilities: {},\r
          clientInfo: { name: "zcode-proxy-webui", version: "1.0" },\r
        }).then(function () {\r
          // required notification before tools/list on stateful servers\r
          return mcpFetch(server, { jsonrpc: "2.0", method: "notifications/initialized" });\r
        }).then(function () {\r
          return mcpCall(server, "tools/list", {});\r
        }).then(function (j) {\r
          return (j.result && j.result.tools) || [];\r
        });\r
      }\r
      // Build function-tool entries from every connected server + refresh the\r
      // tool name -> {url, name} routing map. No tools when MCP is disabled.\r
      function gatherMcpTools() {\r
        var out = []; mcpToolMap = {};\r
        if (!state.settings.mcpEnabled) return out;\r
        state.settings.mcpServers.forEach(function (s) {\r
          var st = mcpState[s.url];\r
          if (st && st.connected && st.tools) {\r
            st.tools.forEach(function (t) {\r
              if (mcpToolMap[t.name]) return; // dedupe across servers (first wins)\r
              mcpToolMap[t.name] = { url: s.url, name: t.name };\r
              out.push({\r
                type: "function",\r
                function: {\r
                  name: t.name,\r
                  description: (t.description || t.name).slice(0, 1024),\r
                  parameters: t.inputSchema || { type: "object", properties: {} },\r
                },\r
              });\r
            });\r
          }\r
        });\r
        return out;\r
      }\r
      // Execute one model tool_call against its MCP server. Resolves to text.\r
      function execMcpTool(tc) {\r
        var map = mcpToolMap[tc.name];\r
        if (!map) return Promise.reject(new Error("Unknown tool: " + tc.name));\r
        var server = state.settings.mcpServers.find(function (s) { return s.url === map.url; });\r
        if (!server) return Promise.reject(new Error("MCP server not configured: " + map.url));\r
        var args = {};\r
        try { args = JSON.parse(tc.arguments || "{}"); } catch (e) { args = {}; }\r
        return mcpCall(server, "tools/call", { name: map.name, arguments: args }).then(function (j) {\r
          var res = j.result;\r
          if (!res) return "(no result)";\r
          if (Array.isArray(res.content)) {\r
            return res.content.map(function (c) { return c.type === "text" ? c.text : JSON.stringify(c); }).join("\\n");\r
          }\r
          return JSON.stringify(res);\r
        });\r
      }\r
\r
      // Parse the MCP textarea (KoboldAI format: "URL" or "URL,key" per line).\r
      function parseServersFromTextarea() {\r
        return $("s-mcp").value.split("\\n").map(function (ln) {\r
          var line = ln.trim();\r
          if (!line) return null;\r
          var parts = line.split(",");\r
          var url = (parts[0] || "").trim();\r
          var key = (parts[1] || "").trim();\r
          if (!url) return null;\r
          return { url: url, authKey: key };\r
        }).filter(function (s) { return s.url; });\r
      }\r
      function connectAllMcp() {\r
        var servers = parseServersFromTextarea();\r
        state.settings.mcpServers = servers;\r
        state.settings.mcpCorsProxy = $("s-cors").value.trim();\r
        state.settings.mcpEnabled = $("s-mcpenable").checked;\r
        saveState();\r
        mcpState = {};              // fresh sessions each connect\r
        renderMcpStatus(servers);\r
        var chain = Promise.resolve();\r
        servers.forEach(function (s) {\r
          chain = chain.then(function () {\r
            var st = mcpState[s.url] = { connected: false, tools: [], sessionId: "", error: "", status: "connecting" };\r
            renderMcpStatus(servers);\r
            return mcpConnect(s).then(function (tools) {\r
              st.connected = true; st.tools = tools || []; st.error = ""; st.status = "ok";\r
            }, function (err) {\r
              st.connected = false; st.tools = []; st.error = String((err && err.message) || err); st.status = "error";\r
            }).then(function () { renderMcpStatus(servers); });\r
          });\r
        });\r
        chain.then(updateMcpSummary, updateMcpSummary);\r
      }\r
      function disconnectMcp() {\r
        mcpState = {};\r
        renderMcpStatus(state.settings.mcpServers);\r
        updateMcpSummary();\r
      }\r
      function renderMcpStatus(servers) {\r
        var box = $("mcp-status"); if (!box) return;\r
        box.innerHTML = "";\r
        (servers || state.settings.mcpServers || []).forEach(function (s) {\r
          var st = mcpState[s.url] || { connected: false, tools: [], status: "", error: "" };\r
          var row = document.createElement("div"); row.className = "mcp-srv";\r
          var head = document.createElement("div"); head.className = "mcp-srv-head";\r
          var dot = document.createElement("span");\r
          dot.className = "mcp-dot " + (st.status === "ok" ? "ok" : st.status === "error" ? "err" : st.status === "connecting" ? "busy" : "");\r
          var urlEl = document.createElement("span"); urlEl.className = "mcp-label"; urlEl.textContent = s.url; urlEl.title = s.url;\r
          var info = document.createElement("span"); info.className = "mcp-state";\r
          if (st.status === "connecting") info.textContent = "connecting\\u2026";\r
          else if (st.status === "ok") info.textContent = "connected \\u00b7 " + (st.tools ? st.tools.length : 0) + " tools";\r
          else if (st.status === "error") info.textContent = "failed";\r
          else info.textContent = "not connected";\r
          head.appendChild(dot); head.appendChild(urlEl); head.appendChild(info);\r
          row.appendChild(head);\r
          if (st.error) { var e = document.createElement("div"); e.className = "mcp-err"; e.textContent = st.error; row.appendChild(e); }\r
          if (st.tools && st.tools.length) {\r
            var tw = document.createElement("div"); tw.className = "mcp-tools";\r
            st.tools.forEach(function (t) {\r
              var c = document.createElement("span"); c.className = "mcp-tool-chip";\r
              c.textContent = t.name; c.title = t.description || "";\r
              tw.appendChild(c);\r
            });\r
            row.appendChild(tw);\r
          }\r
          box.appendChild(row);\r
        });\r
      }\r
      function updateMcpSummary() {\r
        var el = $("mcp-summary"); if (!el) return;\r
        var servers = state.settings.mcpServers || [];\r
        var connected = 0, tools = 0;\r
        servers.forEach(function (s) {\r
          var st = mcpState[s.url];\r
          if (st && st.connected) { connected++; tools += (st.tools ? st.tools.length : 0); }\r
        });\r
        el.textContent = connected + "/" + servers.length + " servers \\u00b7 " + tools + " tools";\r
      }\r
\r
      // =========================================================\r
      // send / stream\r
      // =========================================================\r
      function send() {\r
        if (busy) return;\r
        var text = inputEl.value.trim();\r
        if (!text && pendingImages.length === 0) return;\r
        // Block image input for non-vision models with a clear message.\r
        if (pendingImages.length && !isVisionModel(state.settings.model)) {\r
          toast("This model does not support image input. Select a vision model (name contains 'v', e.g. glm-4.6v).");\r
          return;\r
        }\r
        var c = activeConv(); if (!c) { newConv(); c = activeConv(); }\r
        var images = pendingImages.map(function (p) { return p.dataUrl; });\r
        c.messages.push({ role: "user", content: text, images: images.length ? images : undefined });\r
        if (c.messages.filter(function (m) { return m.role === "user"; }).length === 1 && text) {\r
          c.title = text.slice(0, 40);\r
        }\r
        inputEl.value = ""; autoGrow(); pendingImages = []; renderAttachPreview(); renderSidebar();\r
        renderMessages();\r
        runCompletion(c);\r
      }\r
\r
      function regenerate() {\r
        if (busy) return;\r
        var c = activeConv(); if (!c) return;\r
        while (c.messages.length && c.messages[c.messages.length - 1].role === "assistant") c.messages.pop();\r
        renderMessages();\r
        runCompletion(c);\r
      }\r
\r
      function runCompletion(conv) {\r
        setBusy(true);\r
        runToolLoop(conv, 0);\r
      }\r
\r
      // One assistant turn per call; recurses while the model requests tools.\r
      function runToolLoop(conv, depth) {\r
        if (depth > 8) {\r
          toast("Stopped after 8 tool rounds.");\r
          finalizeLoop();\r
          return;\r
        }\r
        var assistant = { role: "assistant", content: "", reasoning: "", model: conv.model || state.settings.model, truncated: false };\r
        conv.messages.push(assistant);\r
        renderMessages();\r
\r
        streamOnce(conv, assistant).then(function (toolCalls) {\r
          if (toolCalls && toolCalls.length) {\r
            assistant.toolCalls = toolCalls;\r
            saveState(); renderMessages();\r
            // Auto-execute every tool call against its MCP server, sequentially.\r
            var seq = Promise.resolve();\r
            toolCalls.forEach(function (tc) {\r
              seq = seq.then(function () {\r
                return execMcpTool(tc).then(function (result) {\r
                  conv.messages.push({ role: "tool", toolCallId: tc.id, content: result });\r
                }, function (err) {\r
                  conv.messages.push({ role: "tool", toolCallId: tc.id, content: "Error: " + String((err && err.message) || err) });\r
                });\r
              });\r
            });\r
            seq.then(function () {\r
              saveState(); renderMessages(); scrollBottom(true);\r
              runToolLoop(conv, depth + 1);   // feed results back to the model\r
            });\r
          } else {\r
            finalizeLoop();\r
          }\r
        });\r
\r
        function finalizeLoop() {\r
          setBusy(false);\r
          abortCtrl = null;\r
          saveState();\r
          renderSidebar();\r
        }\r
      }\r
\r
      // Stream one completion. Resolves to an array of accumulated tool calls\r
      // (empty/null when the model just replied with text).\r
      function streamOnce(conv, assistant) {\r
        return new Promise(function (resolve) {\r
          abortCtrl = new AbortController();\r
          var toolAccum = {};     // index -> {id, name, arguments}\r
          var finished = false;\r
\r
          fetch("/v1/chat/completions", {\r
            method: "POST",\r
            headers: {\r
              "content-type": "application/json",\r
              "authorization": state.settings.apiKey ? "Bearer " + state.settings.apiKey : "",\r
            },\r
            body: JSON.stringify(buildBody(conv)),\r
            signal: abortCtrl.signal,\r
          }).then(function (r) {\r
            if (!r.ok || !r.body) {\r
              return r.text().then(function (t) {\r
                assistant.content = "**Request failed (" + r.status + ").**\\n\\n\`\`\`\\n" + (t || r.statusText).slice(0, 800) + "\\n\`\`\`";\r
                updateStreamingDom(assistant, true);\r
                resolve(null);\r
                throw new Error("__stop__");\r
              });\r
            }\r
            var reader = r.body.getReader();\r
            var dec = new TextDecoder();\r
            var buf = "";\r
            var lastRender = 0;\r
            function pump() {\r
              return reader.read().then(function (chunk) {\r
                if (chunk.done) { return; }\r
                buf += dec.decode(chunk.value, { stream: true });\r
                var lines = buf.split("\\n");\r
                buf = lines.pop();\r
                for (var i = 0; i < lines.length; i++) {\r
                  var line = lines[i].trim();\r
                  if (!line || line.indexOf("data:") !== 0) continue;\r
                  var data = line.slice(5).trim();\r
                  if (data === "[DONE]") { finished = true; break; }\r
                  var json; try { json = JSON.parse(data); } catch (e) { continue; }\r
                  var choice = json.choices && json.choices[0];\r
                  if (!choice) continue;\r
                  var d = choice.delta || {};\r
                  if (d.reasoning_content) assistant.reasoning += d.reasoning_content;\r
                  if (d.content) assistant.content += d.content;\r
                  if (d.tool_calls) {\r
                    d.tool_calls.forEach(function (tc) {\r
                      var idx = tc.index || 0;\r
                      var slot = toolAccum[idx] = toolAccum[idx] || { id: "", name: "", arguments: "" };\r
                      if (tc.id) slot.id = tc.id;\r
                      if (tc.function) {\r
                        if (tc.function.name) slot.name = tc.function.name;\r
                        if (tc.function.arguments) slot.arguments += tc.function.arguments;\r
                      }\r
                    });\r
                  }\r
                  if (choice.finish_reason === "length") assistant.truncated = true;\r
                }\r
                var now = Date.now();\r
                if (now - lastRender > 33) { lastRender = now; updateStreamingDom(assistant, false); }\r
                if (finished) { return; }\r
                return pump();\r
              });\r
            }\r
            return pump().then(function () {\r
              updateStreamingDom(assistant, true);\r
              var tcs = Object.keys(toolAccum).map(function (k) { return toolAccum[k]; }).filter(function (t) { return t.id && t.name; });\r
              if (!assistant.content && !assistant.reasoning && !tcs.length) {\r
                assistant.content = "_(empty response)_"; updateStreamingDom(assistant, true);\r
              }\r
              resolve(tcs.length ? tcs : null);\r
            });\r
          }).catch(function (e) {\r
            if (e && e.message === "__stop__") return;\r
            if (e && e.name === "AbortError") {\r
              assistant.content += "\\n\\n_\\u2026stopped._"; updateStreamingDom(assistant, true);\r
            } else {\r
              assistant.content = "**Error:** " + escapeHtml(String((e && e.message) || e));\r
              updateStreamingDom(assistant, true);\r
            }\r
            resolve(null);\r
          });\r
        });\r
      }\r
\r
      function updateStreamingDom(assistant, done) {\r
        var last = msgList.lastChild;\r
        if (!last || !last.classList || !last.classList.contains("msg")) { renderMessages(); last = msgList.lastChild; }\r
        if (!last) return;\r
        var body = last.querySelector(".content");\r
        if (!body) return;\r
        var think = body.querySelector(".think");\r
        if (assistant.reasoning) {\r
          if (!think) {\r
            think = document.createElement("details"); think.className = "think"; think.open = true;\r
            var sum = document.createElement("summary");\r
            var tb = document.createElement("div"); tb.className = "think-body";\r
            think.appendChild(sum); think.appendChild(tb);\r
            body.insertBefore(think, body.firstChild);\r
          }\r
          think.querySelector(".think-body").textContent = assistant.reasoning;\r
          think.querySelector("summary").textContent = done ? "Thought process" : "Thinking\\u2026";\r
          if (done) think.open = false;\r
        }\r
        if (assistant.content) {\r
          body.innerHTML = renderMarkdown(assistant.content);\r
          enhanceCode(body);\r
          if (think) body.insertBefore(think, body.firstChild); // keep thinking on top\r
        }\r
        if (done) {\r
          var oldMeta = last.querySelector(".msg-meta"); if (oldMeta) oldMeta.remove();\r
          last.appendChild(meta(assistant, true));\r
        }\r
        scrollBottom();\r
      }\r
\r
      function setBusy(b) {\r
        busy = b;\r
        sendBtn.className = "c-btn " + (b ? "stop" : "send");\r
        sendBtn.innerHTML = b ? "\\u25a0" : "\\u2191";\r
        sendBtn.title = b ? "Stop" : "Send";\r
        hintEl.textContent = b ? "Generating \\u2014 press Stop to interrupt." : "";\r
      }\r
      function stop() { if (abortCtrl) { try { abortCtrl.abort(); } catch (e) {} } }\r
\r
      // =========================================================\r
      // autoscroll\r
      // =========================================================\r
      function nearBottom() {\r
        return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120;\r
      }\r
      function scrollBottom(force) {\r
        if (force || nearBottom()) messages.scrollTop = messages.scrollHeight;\r
      }\r
\r
      // =========================================================\r
      // composer helpers\r
      // =========================================================\r
      function autoGrow() {\r
        inputEl.style.height = "auto";\r
        inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";\r
      }\r
      function renderAttachPreview() {\r
        var box = $("attach-preview"); box.innerHTML = "";\r
        pendingImages.forEach(function (p, i) {\r
          var w = document.createElement("div"); w.className = "ap";\r
          var img = document.createElement("img"); img.src = p.dataUrl;\r
          var rm = document.createElement("button"); rm.className = "ap-rm"; rm.innerHTML = "\\u2715";\r
          rm.onclick = function () { pendingImages.splice(i, 1); renderAttachPreview(); };\r
          w.appendChild(img); w.appendChild(rm); box.appendChild(w);\r
        });\r
      }\r
      function readImages(files) {\r
        Array.from(files).forEach(function (f) {\r
          if (!/image\\//.test(f.type)) return;\r
          var r = new FileReader();\r
          r.onload = function () { pendingImages.push({ name: f.name, dataUrl: r.result }); renderAttachPreview(); };\r
          r.readAsDataURL(f);\r
        });\r
      }\r
\r
      // =========================================================\r
      // settings modal\r
      // =========================================================\r
      function openSettings() { syncSettingsForm(); renderMcpStatus(state.settings.mcpServers); updateMcpSummary(); overlay.classList.add("open"); }\r
      function closeSettings() { overlay.classList.remove("open"); }\r
      function syncSettingsForm() {\r
        var s = state.settings;\r
        $("s-apikey").value = s.apiKey;\r
        $("s-system").value = s.systemPrompt;\r
        $("s-temp").value = s.temperature; $("s-temp-val").textContent = Number(s.temperature).toFixed(2);\r
        $("s-topp").value = s.topP; $("s-topp-val").textContent = Number(s.topP).toFixed(2);\r
        $("s-maxtok").value = s.maxTokens;\r
        $("s-dosample").checked = s.doSample;\r
        $("s-mcpenable").checked = s.mcpEnabled !== false;\r
        $("s-mcp").value = (s.mcpServers || []).map(function (m) {\r
          return m.authKey ? (m.url + "," + m.authKey) : m.url;\r
        }).join("\\n");\r
        $("s-cors").value = s.mcpCorsProxy || "";\r
        $("s-enter").checked = s.enterToSend;\r
        $("banner").style.display = s.apiKey ? "none" : "block";\r
        $("banner").textContent = "No proxy API key set. If your proxy requires one, requests will return 401.";\r
      }\r
      function readSettingsForm() {\r
        var s = state.settings;\r
        s.apiKey = $("s-apikey").value.trim();\r
        s.systemPrompt = $("s-system").value;\r
        s.temperature = parseFloat($("s-temp").value);\r
        s.topP = parseFloat($("s-topp").value);\r
        s.maxTokens = parseInt($("s-maxtok").value, 10) || 4096;\r
        s.doSample = $("s-dosample").checked;\r
        s.mcpEnabled = $("s-mcpenable").checked;\r
        s.mcpServers = $("s-mcp").value.split("\\n").map(function (ln) {\r
          var parts = ln.trim().split(",");\r
          var url = (parts[0] || "").trim();\r
          if (!url) return null;\r
          return { url: url, authKey: (parts[1] || "").trim() };\r
        }).filter(Boolean);\r
        s.mcpCorsProxy = $("s-cors").value.trim();\r
        s.enterToSend = $("s-enter").checked;\r
        saveState();\r
      }\r
\r
      // =========================================================\r
      // toast\r
      // =========================================================\r
      var toastTimer;\r
      function toast(msg) {\r
        toastEl.textContent = msg; toastEl.classList.add("show");\r
        clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2600);\r
      }\r
\r
      // =========================================================\r
      // wiring\r
      // =========================================================\r
      $("btn-new").onclick = newConv;\r
      $("btn-settings").onclick = openSettings;\r
      $("btn-close-settings").onclick = function () { readSettingsForm(); closeSettings(); fetchModels(); populateEffort(); syncThinkButton(); };\r
      $("btn-clear-all").onclick = function () {\r
        if (!confirm("Delete ALL conversations and reset settings? This cannot be undone.")) return;\r
        localStorage.removeItem(STORE);\r
        state = loadState(); saveState(); applyTheme(); renderSidebar(); renderMessages();\r
        syncSettingsForm(); populateModels(KNOWN_MODELS); toast("Reset complete.");\r
      };\r
      $("btn-theme").onclick = function () {\r
        var cur = document.documentElement.getAttribute("data-theme");\r
        state.settings.theme = cur === "dark" ? "light" : "dark";\r
        saveState(); applyTheme();\r
      };\r
      $("btn-menu").onclick = function () { sidebar.classList.toggle("collapsed"); };\r
      $("btn-mcp-connect").onclick = connectAllMcp;\r
      $("btn-mcp-disconnect").onclick = disconnectMcp;\r
      overlay.onclick = function (e) { if (e.target === overlay) closeSettings(); };\r
\r
      $("s-temp").addEventListener("input", function () { $("s-temp-val").textContent = parseFloat($("s-temp").value).toFixed(2); });\r
      $("s-topp").addEventListener("input", function () { $("s-topp-val").textContent = parseFloat($("s-topp").value).toFixed(2); });\r
      $("s-apikey").addEventListener("input", function () {\r
        $("banner").style.display = $("s-apikey").value.trim() ? "none" : "block";\r
      });\r
\r
      modelSel.onchange = function () {\r
        state.settings.model = modelSel.value;\r
        var c = activeConv(); if (c) c.model = modelSel.value;\r
        // If images were queued for a vision model and the user switched to a\r
        // non-vision one, drop them and explain.\r
        if (pendingImages.length && !isVisionModel(modelSel.value)) {\r
          pendingImages = []; renderAttachPreview();\r
          toast("Switched to a non-vision model \\u2014 attached images were removed.");\r
        }\r
        saveState(); syncAttachVisibility(); populateEffort();\r
      };\r
      // GLM-5.2 only has two distinct reasoning-effort levels (low/medium map\r
      // to high, xhigh maps to max), so expose just high and max. Other models\r
      // get a disabled placeholder (reasoning_effort is GLM-5.2+ only).\r
      function populateEffort() {\r
        var model = modelSel.value;\r
        effortSel.innerHTML = "";\r
        if (isReasoningModel(model)) {\r
          ["max", "high"].forEach(function (v) {\r
            var o = document.createElement("option");\r
            o.value = v; o.textContent = v;\r
            effortSel.appendChild(o);\r
          });\r
          var cur = state.settings.reasoningEffort;\r
          effortSel.value = (cur === "high") ? "high" : "max";\r
          effortSel.disabled = !state.settings.thinkingEnabled;\r
        } else {\r
          var o = document.createElement("option");\r
          o.value = ""; o.textContent = "n/a";\r
          effortSel.appendChild(o);\r
          effortSel.disabled = true;\r
        }\r
      }\r
      function syncThinkButton() {\r
        var on = state.settings.thinkingEnabled;\r
        btnThink.classList.toggle("on", on);\r
        btnThink.textContent = on ? "Think: on" : "Think: off";\r
        btnThink.title = on ? "Deep thinking on \\u2014 click to turn off" : "Deep thinking off \\u2014 click to turn on";\r
        // Repopulate so the effort dropdown's disabled state tracks the toggle\r
        // (populateEffort sets disabled = !thinkingEnabled for reasoning models).\r
        populateEffort();\r
      }\r
      effortSel.onchange = function () {\r
        state.settings.reasoningEffort = effortSel.value || "max";\r
        saveState();\r
      };\r
      btnThink.onclick = function () {\r
        state.settings.thinkingEnabled = !state.settings.thinkingEnabled;\r
        saveState(); syncThinkButton();\r
      };\r
\r
      attachBtn.onclick = function () { $("attach-input").click(); };\r
      $("attach-input").onchange = function (e) { readImages(e.target.files); e.target.value = ""; };\r
      // drag & drop onto composer\r
      var composer = document.querySelector(".composer");\r
      ["dragover", "dragenter"].forEach(function (ev) {\r
        composer.addEventListener(ev, function (e) { e.preventDefault(); composer.style.borderColor = "var(--accent)"; });\r
      });\r
      ["dragleave", "drop"].forEach(function (ev) {\r
        composer.addEventListener(ev, function (e) { e.preventDefault(); composer.style.borderColor = ""; });\r
      });\r
      composer.addEventListener("drop", function (e) {\r
        if (!isVisionModel(modelSel.value)) { toast("Select a vision model (name contains 'v') to attach images."); return; }\r
        if (e.dataTransfer && e.dataTransfer.files) readImages(e.dataTransfer.files);\r
      });\r
\r
      inputEl.addEventListener("input", autoGrow);\r
      inputEl.addEventListener("keydown", function (e) {\r
        if (e.key === "Enter" && !e.shiftKey && state.settings.enterToSend && !e.isComposing) { e.preventDefault(); send(); }\r
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }\r
      });\r
      sendBtn.onclick = function () { if (busy) stop(); else send(); };\r
\r
      // =========================================================\r
      // boot\r
      // =========================================================\r
      applyTheme();\r
      populateModels(KNOWN_MODELS);\r
      renderSidebar(); renderMessages();\r
      populateEffort(); syncThinkButton();\r
      fetchModels();\r
      autoGrow();\r
      inputEl.focus();\r
      if (!state.conversations.length) newConv();\r
    })();\r
    </script>\r
  </body>\r
</html>\r
`;

// src/provider/providers.ts
var ZAI_PROVIDER = {
  id: "zai",
  displayName: "Z.AI",
  anthropicBaseURL: "https://api.z.ai/api/anthropic",
  openaiBaseURL: "https://api.z.ai/api/coding/paas/v4",
  bizHost: "https://api.z.ai"
};
var BIGMODEL_PROVIDER = {
  id: "bigmodel",
  displayName: "BigModel / \u667A\u8C31",
  anthropicBaseURL: "https://open.bigmodel.cn/api/anthropic",
  openaiBaseURL: "https://open.bigmodel.cn/api/coding/paas/v4",
  bizHost: "https://open.bigmodel.cn"
};
var PROVIDERS = {
  zai: ZAI_PROVIDER,
  bigmodel: BIGMODEL_PROVIDER
};
function getProvider(id) {
  const def = PROVIDERS[id];
  if (!def) {
    throw new Error(`Unknown provider: "${id}"`);
  }
  return def;
}

// src/auth/types.ts
function credentialString(cred) {
  if (cred.secret) {
    return `${cred.apiKey}.${cred.secret}`;
  }
  return cred.apiKey;
}

// src/proxy/identity.ts
var import_node_os = __toESM(require("node:os"), 1);
var ASCII_PRINTABLE2 = /^[\x20-\x7e]+$/;
function resolveAppVersion(raw) {
  if (typeof raw !== "string") return void 0;
  const v = raw.trim();
  return v.length > 0 && ASCII_PRINTABLE2.test(v) ? v : void 0;
}
function normalizePrintableHeaderValue(raw) {
  if (typeof raw !== "string") return void 0;
  const v = raw.trim();
  return v.length > 0 && ASCII_PRINTABLE2.test(v) ? v : void 0;
}
function normalizeOsCategory(platform) {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
function resolveClientLanguage() {
  const override = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE);
  if (override) return override;
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || void 0;
  } catch {
    return void 0;
  }
}
function resolveClientTimezone() {
  const override = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE);
  if (override) return override;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || void 0;
  } catch {
    return void 0;
  }
}
function buildIdentityHeaders(id) {
  const n = resolveAppVersion(id.appVersion);
  const platform = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_PLATFORM ?? process.platform);
  const arch = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_ARCH ?? import_node_os.default.arch());
  const release = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_RELEASE ?? import_node_os.default.release());
  const platformForCategory = process.env.ZCODE_IDENTITY_PLATFORM ?? process.platform;
  const releaseChannel = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_RELEASE_CHANNEL);
  const clientLanguage = resolveClientLanguage();
  const clientTimezone = resolveClientTimezone();
  const deviceMid = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_DEVICE_MID);
  const headers = {
    "HTTP-Referer": id.refererOrigin,
    "User-Agent": `ZCode/${n ?? "unknown"}`,
    ...n ? { "X-ZCode-App-Version": n } : {},
    "X-Title": `Z Code@${id.sourceTitle}`,
    "X-ZCode-Agent": "glm",
    ...platform && arch ? { "X-Platform": `${platform}-${arch}` } : {},
    ...releaseChannel ? { "X-Release-Channel": releaseChannel } : {},
    ...clientLanguage ? { "X-Client-Language": clientLanguage } : {},
    ...clientTimezone ? { "X-Client-Timezone": clientTimezone } : {},
    ...platform ? { "X-Os-Category": normalizeOsCategory(platformForCategory) } : {},
    ...release ? { "X-Os-Version": release } : {},
    ...deviceMid ? { "X-Device-Mid": deviceMid } : {}
  };
  return headers;
}

// src/proxy/trace-headers.ts
var QUERY_PREFIX = "query_";
var SESSION_PREFIXES = ["sess_", "subagent_agent_"];
function buildZcodeTraceHeaders(ctx = {}) {
  const queryId = ctx.queryId ? stripHeaderInternalPrefixes(ctx.queryId, [QUERY_PREFIX]) : void 0;
  const sessionId = ctx.sessionId ? stripHeaderInternalPrefixes(ctx.sessionId, SESSION_PREFIXES) : void 0;
  return {
    "x-request-id": ctx.requestId ?? crypto.randomUUID(),
    "x-zcode-trace-id": ctx.traceId ?? crypto.randomUUID(),
    ...queryId ? { "x-query-id": queryId } : {},
    ...sessionId ? { "x-session-id": sessionId } : {}
  };
}
function stripHeaderInternalPrefixes(value, prefixes) {
  let out = value;
  for (const prefix of prefixes) {
    if (out.startsWith(prefix) && out.length > prefix.length) out = out.slice(prefix.length);
  }
  return out || value;
}

// src/proxy/client-session.ts
var import_node_crypto = __toESM(require("node:crypto"), 1);
function createClientSessionResolver(now = () => Date.now()) {
  const nodes = /* @__PURE__ */ new Map();
  const sessions = /* @__PURE__ */ new Map();
  function remember(nodeHash, session, config) {
    const stored = { ...session, nodeHash, lastSeenAt: now() };
    nodes.set(nodeHash, stored);
    sessions.set(stored.sessionId, stored);
    prune(config);
  }
  function prune(config) {
    const cutoff = now() - config.ttlSeconds * 1e3;
    for (const [hash, node] of nodes.entries()) {
      if (node.lastSeenAt < cutoff) nodes.delete(hash);
    }
    for (const [id, node] of sessions.entries()) {
      if (node.lastSeenAt < cutoff) sessions.delete(id);
    }
    while (sessions.size > config.maxSessions) {
      let oldestId = "";
      let oldestAt = Infinity;
      for (const [id, node] of sessions.entries()) {
        if (node.lastSeenAt < oldestAt) {
          oldestAt = node.lastSeenAt;
          oldestId = id;
        }
      }
      if (!oldestId) break;
      sessions.delete(oldestId);
      for (const [hash, node] of nodes.entries()) {
        if (node.sessionId === oldestId) nodes.delete(hash);
      }
    }
  }
  function action(config) {
    return config.mode;
  }
  return {
    resolve(req, body, format, model, config) {
      if (config.mode === "off") return { source: "none", action: "off", confidence: 0 };
      prune(config);
      const explicitTrace = requestTraceContext(req, body);
      if (explicitTrace.sessionId) return explicitResult(explicitTrace, config);
      const canonical = canonicalize(body, format, model);
      if (!canonical) {
        if (hasTraceContext(explicitTrace)) return explicitResult(explicitTrace, config);
        return { source: "none", action: action(config), confidence: 0 };
      }
      const nodeHash = hashJson(canonical.identity);
      const existing = nodes.get(nodeHash);
      if (existing) {
        remember(nodeHash, existing, config);
        return withTraceContext(result("lineage", action(config), existing, 0.95), explicitTrace);
      }
      const parent = findLinearParent(canonical, nodes);
      if (parent) {
        remember(nodeHash, parent, config);
        return withTraceContext(result("lineage", action(config), parent, 0.9), explicitTrace);
      }
      const fresh = newSession();
      remember(nodeHash, fresh, config);
      return withTraceContext(result("lineage", action(config), fresh, 0.75), explicitTrace);
    }
  };
}
var defaultClientSessionResolver = createClientSessionResolver();
function result(source, action, node, confidence) {
  return {
    source,
    action,
    confidence,
    sessionId: node.sessionId,
    upstreamSessionId: node.upstreamSessionId
  };
}
function requestTraceContext(req, body) {
  const bodyTrace = bodyMetadataTrace(body);
  return {
    requestId: firstHeader(req.headers, ["x-request-id"]) ?? bodyTrace.requestId,
    traceId: firstHeader(req.headers, ["x-zcode-trace-id"]) ?? bodyTrace.traceId,
    queryId: firstHeader(req.headers, ["x-query-id"]) ?? bodyTrace.queryId,
    sessionId: firstHeader(req.headers, ["x-opencode-session", "x-claude-code-session-id", "x-session-id", "x-parent-session-id", "helicone-session-id"]) ?? bodyTrace.sessionId
  };
}
function explicitResult(trace, config) {
  return {
    source: "explicit",
    action: config.mode,
    confidence: 1,
    ...trace.requestId ? { requestId: trace.requestId } : {},
    ...trace.traceId ? { traceId: trace.traceId } : {},
    ...trace.queryId ? { queryId: trace.queryId } : {},
    ...trace.sessionId ? { sessionId: trace.sessionId, upstreamSessionId: trace.sessionId } : {}
  };
}
function withTraceContext(session, trace) {
  if (!trace.requestId && !trace.traceId && !trace.queryId) return session;
  return {
    ...session,
    ...trace.requestId ? { requestId: trace.requestId } : {},
    ...trace.traceId ? { traceId: trace.traceId } : {},
    ...trace.queryId ? { queryId: trace.queryId } : {}
  };
}
function hasTraceContext(trace) {
  return Boolean(trace.requestId || trace.traceId || trace.queryId || trace.sessionId);
}
function firstHeader(headers, names) {
  for (const name of names) {
    const value = headers.get(name);
    if (value && value.trim()) return value.trim();
  }
  return null;
}
function bodyMetadataTrace(body) {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    const metadata = parsed?.metadata;
    if (!metadata || typeof metadata !== "object") return {};
    return {
      requestId: stringProperty(metadata, ["requestId", "request_id"]),
      traceId: stringProperty(metadata, ["traceId", "trace_id"]),
      queryId: stringProperty(metadata, ["queryId", "query_id"]),
      sessionId: stringProperty(metadata, ["sessionId", "session_id", "conversationId", "conversation_id"])
    };
  } catch {
    return {};
  }
}
function stringProperty(obj, names) {
  for (const name of names) {
    const value = obj[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return void 0;
}
function canonicalize(body, format, fallbackModel) {
  if (!body) return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const model = typeof parsed.model === "string" ? parsed.model : fallbackModel;
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  if (messages.length === 0) return null;
  const identity = {
    format,
    model,
    system: parsed.system,
    developer: messages.filter((m) => m?.role === "developer"),
    tools: parsed.tools,
    tool_choice: parsed.tool_choice,
    messages
  };
  return { model, identity, messages };
}
function findLinearParent(canonical, nodes) {
  if (canonical.messages.length < 3) return null;
  const prefix = {
    ...canonical.identity,
    messages: canonical.messages.slice(0, -2)
  };
  if (prefix.messages.length === 0) return null;
  return nodes.get(hashJson(prefix)) ?? null;
}
function newSession() {
  const upstreamSessionId = crypto.randomUUID();
  return {
    nodeHash: "",
    sessionId: `ses_${upstreamSessionId.replace(/-/g, "").slice(0, 12)}`,
    upstreamSessionId,
    lastSeenAt: Date.now()
  };
}
function hashJson(value) {
  return hashString(stableStringify(value));
}
function hashString(value) {
  return import_node_crypto.default.createHash("sha256").update(value, "utf-8").digest("hex");
}
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// src/proxy/session-context.ts
function resolveSessionContext(input) {
  if (input.config.clientIdentity.mode === "off") return void 0;
  const resolver = input.resolver ?? defaultClientSessionResolver;
  return resolver.resolve(input.clientReq, input.body, input.upstreamFormat, input.model, input.config.clientIdentity);
}
function shouldUseExactTraceHeaders(plan, session) {
  return plan === "start-plan" || hasExplicitTraceHeaders(session) || shouldForwardSessionId(session);
}
function shouldForwardSessionId(session) {
  return session?.source === "explicit" || session?.action === "enforce";
}
function sessionIdForHeader(session) {
  if (!session || !shouldForwardSessionId(session)) return void 0;
  return session.upstreamSessionId ?? session.sessionId;
}
function hasExplicitTraceHeaders(session) {
  return Boolean(session?.requestId || session?.traceId || session?.queryId);
}

// src/proxy/upstream.ts
var ANTHROPIC_VERSION = "2023-06-01";
var STARTPLAN_OPENAI_BASE = "https://zcode.z.ai/api/v1/zcode-plan";
var STRIP_HEADERS = /* @__PURE__ */ new Set([
  "host",
  "authorization",
  "x-api-key",
  "anthropic-version",
  "content-length",
  "connection",
  "proxy-authorization",
  "proxy-authenticate",
  "transfer-encoding",
  "x-request-id",
  "x-zcode-trace-id",
  "x-query-id",
  "x-session-id"
]);
function buildUpstreamURL(format, provider, plan = "coding-plan") {
  if (plan === "start-plan") {
    return `${STARTPLAN_OPENAI_BASE}/chat/completions`;
  }
  if (format === "anthropic") {
    return `${provider.anthropicBaseURL}/v1/messages`;
  }
  return `${provider.openaiBaseURL}/chat/completions`;
}
function buildAuthHeaders(format, cred, identity, plan = "coding-plan", clientSession) {
  const credStr = plan === "start-plan" && cred.jwt ? cred.jwt : credentialString(cred);
  const base = {
    ...buildIdentityHeaders(identity),
    ...buildTraceHeaders(plan, clientSession)
  };
  if (format === "anthropic") {
    if (plan === "start-plan" && cred.jwt) {
      base["authorization"] = `Bearer ${cred.jwt}`;
    } else {
      base["x-api-key"] = credStr;
    }
    base["anthropic-version"] = ANTHROPIC_VERSION;
  } else {
    base["authorization"] = `Bearer ${credStr}`;
  }
  return base;
}
function buildTraceHeaders(plan, clientSession) {
  if (shouldUseExactTraceHeaders(plan, clientSession)) {
    return buildZcodeTraceHeaders({
      requestId: clientSession?.requestId,
      traceId: clientSession?.traceId,
      queryId: clientSession?.queryId,
      sessionId: sessionIdForHeader(clientSession)
    });
  }
  const headers = {
    "x-request-id": crypto.randomUUID(),
    "x-zcode-trace-id": crypto.randomUUID()
  };
  if (plan !== "start-plan") {
    headers["x-query-id"] = crypto.randomUUID();
    headers["x-session-id"] = crypto.randomUUID();
  }
  return headers;
}
function collectPassthroughHeaders(req) {
  const result2 = {};
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase();
    if (STRIP_HEADERS.has(lower)) continue;
    if (lower === "anthropic-beta") {
      result2[lower] = value;
    }
  }
  return result2;
}
function buildUpstreamHeaderPairs(clientReq, format, cred, identity, plan = "coding-plan", extraHeaders, clientSession) {
  const clientAcceptEncoding = clientReq.headers.get("accept-encoding") ?? "gzip";
  return [
    ["content-type", "application/json"],
    ["accept-encoding", clientAcceptEncoding],
    ...Object.entries(collectPassthroughHeaders(clientReq)),
    ...Object.entries(buildAuthHeaders(format, cred, identity, plan, clientSession)),
    ...Object.entries(extraHeaders ?? {})
  ];
}
function buildUpstreamRequest(clientReq, format, provider, cred, body, identity, plan = "coding-plan", extraHeaders, clientSession) {
  const url = buildUpstreamURL(format, provider, plan);
  const headerPairs = buildUpstreamHeaderPairs(clientReq, format, cred, identity, plan, extraHeaders, clientSession);
  const init = {
    method: "POST",
    headers: Object.fromEntries(headerPairs)
  };
  if (body !== void 0) {
    init.body = body;
  }
  return new Request(url, init);
}

// src/proxy/ordered-transport.ts
var import_node_net = require("node:net");
var import_node_tls = require("node:tls");
var CRLF = "\r\n";
var HEADER_END = new Uint8Array([13, 10, 13, 10]);
var HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
async function sendOrderedUpstreamRequest(req) {
  const url = new URL(req.url);
  const bodyBytes = bodyToBytes(req.body);
  const requestHead = buildRequestHead(url, req.method ?? "POST", req.headers, bodyBytes.byteLength);
  const socket = await openSocket(url);
  return await new Promise((resolve, reject) => {
    let headerBuffer = new Uint8Array(0);
    let responseStarted = false;
    let bodyController = null;
    let chunkedDecoder = null;
    let remainingContentLength = null;
    const bodyStream = new ReadableStream({
      start(controller) {
        bodyController = controller;
      },
      cancel() {
        socket.destroy();
      }
    });
    function fail(err) {
      if (responseStarted) bodyController?.error(err);
      else reject(err);
      socket.destroy();
    }
    function finish() {
      if (chunkedDecoder && !chunkedDecoder.done) return;
      try {
        bodyController?.close();
      } catch {
      }
    }
    function pushBody(bytes) {
      if (!bodyController || bytes.byteLength === 0) return;
      if (chunkedDecoder) {
        chunkedDecoder.push(bytes, bodyController);
        if (chunkedDecoder.done) finish();
        return;
      }
      if (remainingContentLength !== null) {
        const next = bytes.slice(0, remainingContentLength);
        remainingContentLength -= next.byteLength;
        if (next.byteLength > 0) bodyController.enqueue(next);
        if (remainingContentLength === 0) finish();
        return;
      }
      bodyController.enqueue(bytes);
    }
    socket.on("data", (chunk) => {
      try {
        const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        if (!responseStarted) {
          headerBuffer = concatBytes(headerBuffer, bytes);
          const headerEnd = indexOfBytes(headerBuffer, HEADER_END);
          if (headerEnd < 0) return;
          const headerBytes = headerBuffer.slice(0, headerEnd);
          const rest = headerBuffer.slice(headerEnd + HEADER_END.byteLength);
          const parsed = parseResponseHeaders(headerBytes);
          responseStarted = true;
          const transferEncoding = parsed.headers.get("transfer-encoding")?.toLowerCase() ?? "";
          if (transferEncoding.split(",").map((s) => s.trim()).includes("chunked")) {
            parsed.headers.delete("transfer-encoding");
            chunkedDecoder = new ChunkedDecoder();
          } else {
            const contentLength = parsed.headers.get("content-length");
            remainingContentLength = contentLength ? Number.parseInt(contentLength, 10) : null;
            if (!Number.isFinite(remainingContentLength)) remainingContentLength = null;
          }
          let responseBody = bodyStream;
          if (req.decompress && parsed.headers.get("content-encoding")?.toLowerCase() === "gzip") {
            parsed.headers.delete("content-encoding");
            parsed.headers.delete("content-length");
            const gzip = new DecompressionStream("gzip");
            responseBody = bodyStream.pipeThrough(gzip);
          }
          resolve(new Response(responseBody, {
            status: parsed.status,
            statusText: parsed.statusText,
            headers: parsed.headers
          }));
          pushBody(rest);
          return;
        }
        pushBody(bytes);
      } catch (err) {
        fail(err);
      }
    });
    socket.once("error", fail);
    socket.once("end", () => {
      if (!responseStarted) {
        reject(new Error("upstream closed before sending response headers"));
        return;
      }
      finish();
    });
    socket.write(requestHead);
    if (bodyBytes.byteLength > 0) socket.write(bodyBytes);
  });
}
function openSocket(url) {
  const isHttps = url.protocol === "https:";
  if (!isHttps && url.protocol !== "http:") {
    return Promise.reject(new Error(`Unsupported upstream protocol: ${url.protocol}`));
  }
  const port = Number(url.port || (isHttps ? 443 : 80));
  return new Promise((resolve, reject) => {
    const onConnect = () => {
      socket.off("error", reject);
      resolve(socket);
    };
    const socket = isHttps ? (0, import_node_tls.connect)({ host: url.hostname, port, servername: url.hostname }, onConnect) : (0, import_node_net.connect)({ host: url.hostname, port }, onConnect);
    socket.once("error", reject);
  });
}
function buildRequestHead(url, method, headers, contentLength) {
  const path = `${url.pathname || "/"}${url.search}`;
  const lines = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${url.host}`,
    ...headers.map(headerLine),
    `Content-Length: ${contentLength}`,
    "Connection: close",
    "",
    ""
  ];
  return lines.join(CRLF);
}
function headerLine([name, value]) {
  if (!HEADER_NAME.test(name)) throw new Error(`Invalid upstream header name: ${name}`);
  if (/[\r\n]/.test(value)) throw new Error(`Invalid upstream header value for ${name}`);
  return `${name}: ${value}`;
}
function bodyToBytes(body) {
  if (body === void 0) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body);
  return body;
}
function parseResponseHeaders(bytes) {
  const text = new TextDecoder("latin1").decode(bytes);
  const lines = text.split(CRLF);
  const statusLine = lines.shift() ?? "";
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
  if (!match) throw new Error(`Invalid upstream status line: ${statusLine}`);
  const headers = new Headers();
  for (const line of lines) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    headers.append(line.slice(0, idx), line.slice(idx + 1).trimStart());
  }
  return { status: Number(match[1]), statusText: match[2] ?? "", headers };
}
var ChunkedDecoder = class {
  buffer = new Uint8Array(0);
  expectedSize = null;
  done = false;
  push(bytes, controller) {
    if (this.done) return;
    this.buffer = concatBytes(this.buffer, bytes);
    while (!this.done) {
      if (this.expectedSize === null) {
        const lineEnd = indexOfCrlf(this.buffer);
        if (lineEnd < 0) return;
        const line = new TextDecoder("latin1").decode(this.buffer.slice(0, lineEnd));
        const sizeHex = line.split(";", 1)[0].trim();
        const size = Number.parseInt(sizeHex, 16);
        if (!Number.isFinite(size)) throw new Error(`Invalid chunk size: ${line}`);
        this.buffer = this.buffer.slice(lineEnd + 2);
        this.expectedSize = size;
        if (size === 0) {
          this.done = true;
          return;
        }
      }
      if (this.buffer.byteLength < this.expectedSize + 2) return;
      const chunk = this.buffer.slice(0, this.expectedSize);
      controller.enqueue(chunk);
      this.buffer = this.buffer.slice(this.expectedSize + 2);
      this.expectedSize = null;
    }
  }
};
function concatBytes(a, b) {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  if (a.byteLength > 0) out.set(a, 0);
  if (b.byteLength > 0) out.set(b, a.byteLength);
  return out;
}
function indexOfBytes(haystack, needle) {
  outer: for (let i = 0; i <= haystack.byteLength - needle.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
function indexOfCrlf(bytes) {
  for (let i = 0; i < bytes.byteLength - 1; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
  }
  return -1;
}

// src/proxy/zcode_system.json
var zcode_system_default = [
  {
    type: "text",
    text: "You are ZCode, an interactive coding agent",
    cache_control: {
      type: "ephemeral"
    }
  },
  {
    type: "text",
    text: "\nYou are an interactive ZCode agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n\n# Harness\n- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.\n- Tools run behind a user-selected permission mode; a denied call means the user declined it \u2014 adjust, don't retry verbatim.\n- `<system-reminder>` tags in messages and tool results are injected by the harness, not the user. Hooks may intercept tool calls; treat hook output as user feedback.\n- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.\n- Reference code as `file_path:line_number` \u2014 it's clickable.",
    cache_control: {
      type: "ephemeral"
    }
  },
  {
    type: "text",
    text: "# Environment\nYou have been invoked in the following environment:\n- Primary working directory: unknown\n- Is a git repository: no\n- Platform: unknown\n- Shell: unknown\n- OS Version: unknown",
    cache_control: {
      type: "ephemeral"
    }
  }
];

// src/proxy/system-prompt.ts
var ZCODE_SYSTEM_BLOCKS = zcode_system_default;
function buildStartPlanSystem(existingSystem, currentModel) {
  const official = ZCODE_SYSTEM_BLOCKS.map((b) => structuredClone(b));
  if (currentModel && currentModel.trim().length > 0) {
    official.push({
      type: "text",
      text: `- You are powered by the model named ${currentModel}.`,
      cache_control: { type: "ephemeral" }
    });
  }
  const userBlocks = normalizeUserSystem(existingSystem);
  return [...official, ...userBlocks];
}
function normalizeUserSystem(system) {
  if (system == null) return [];
  if (typeof system === "string") {
    const text = system.trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(system)) return [];
  const out = [];
  for (const item of system) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ type: "text", text: item });
    } else if (item && typeof item === "object") {
      const b = item;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        out.push({
          type: "text",
          text: b.text,
          ...typeof b.cache_control === "object" && b.cache_control !== null ? { cache_control: b.cache_control } : {}
        });
      }
    }
  }
  return out;
}

// src/proxy/body-transformer.ts
function transformRequestBody(body, ctx) {
  if (body === void 0 || body.length === 0) return body;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null) return body;
  let modified = false;
  if (ctx.format === "openai") {
    if (ctx.startPlan) {
      modified = applyStartPlanOpenAISystem(parsed) || modified;
    }
    modified = applyStreamOptionsIncludeUsage(parsed) || modified;
  }
  if (ctx.format === "anthropic") {
    const obj = parsed;
    if (ctx.startPlan) {
      modified = applyStartPlanSystem(obj) || modified;
    }
    modified = applyAnthropicCacheControl(obj) || modified;
    if (ctx.userId) {
      modified = applyAnthropicUserId(obj, ctx.userId) || modified;
    }
  }
  return modified ? JSON.stringify(parsed) : body;
}
function applyStreamOptionsIncludeUsage(body) {
  if (body.stream !== true) return false;
  const existing = body.stream_options;
  if (isPlainObject(existing) && existing.include_usage === true) {
    return false;
  }
  const merged = isPlainObject(existing) ? { ...existing } : {};
  merged.include_usage = true;
  body.stream_options = merged;
  return true;
}
function isPlainObject(v) {
  return typeof v === "object" && v !== null;
}
function applyAnthropicCacheControl(body) {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== "object" || msg === null) continue;
    if (msg.role === "system") continue;
    if (typeof msg.content === "string") {
      msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
      return true;
    }
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const lastBlock = msg.content[msg.content.length - 1];
      if (typeof lastBlock === "object" && lastBlock !== null && !lastBlock.cache_control) {
        lastBlock.cache_control = { type: "ephemeral" };
        return true;
      }
    }
    return false;
  }
  return false;
}
function applyAnthropicUserId(body, userId) {
  const existing = body.metadata;
  if (isPlainObject(existing) && existing.user_id === userId) {
    return false;
  }
  body.metadata = {
    ...isPlainObject(existing) ? existing : {},
    user_id: userId
  };
  return true;
}
function applyStartPlanSystem(body) {
  const model = typeof body.model === "string" ? body.model : void 0;
  body.system = buildStartPlanSystem(body.system, model);
  return true;
}
function applyStartPlanOpenAISystem(body) {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  const model = typeof body.model === "string" ? body.model : void 0;
  const official = buildStartPlanSystem(void 0, model).map((block) => ({
    role: "system",
    content: typeof block === "object" && block !== null && "text" in block ? String(block.text) : ""
  }));
  body.messages = [...official, ...messages];
  return true;
}

// src/proxy/handler.ts
var import_node_zlib = require("node:zlib");

// src/provider/models.ts
var MODELS = [
  { id: "glm-4.5-air", name: "GLM 4.5 Air", contextWindow: 2e5, maxOutputTokens: 128e3, reasoning: true },
  { id: "glm-4.6", name: "GLM 4.6", contextWindow: 2e5, maxOutputTokens: 128e3, reasoning: true },
  { id: "glm-4.6v", name: "GLM 4.6V", contextWindow: 2e5, maxOutputTokens: 128e3 },
  { id: "glm-4.7", name: "GLM 4.7", contextWindow: 2e5, maxOutputTokens: 128e3, reasoning: true },
  { id: "glm-5", name: "GLM 5", contextWindow: 2e5, maxOutputTokens: 128e3, reasoning: true },
  { id: "glm-5-turbo", name: "GLM 5 Turbo", contextWindow: 2e5, maxOutputTokens: 128e3, reasoning: true },
  { id: "glm-5v-turbo", name: "GLM 5V Turbo", contextWindow: 2e5, maxOutputTokens: 128e3 },
  { id: "glm-5.1", name: "GLM 5.1", contextWindow: 2e5, maxOutputTokens: 128e3, reasoning: true },
  { id: "glm-5.2", name: "GLM 5.2", contextWindow: 1e6, maxOutputTokens: 128e3, reasoning: true }
];

// src/translator/openai-to-anthropic.ts
var DEFAULT_MAX_TOKENS = 4096;
function translateRequestOpenAIToAnthropic(req) {
  const systemMessages = req.messages.filter((m) => m.role === "system");
  const nonSystemMessages = req.messages.filter((m) => m.role !== "system");
  const system = systemMessages.length > 0 ? systemMessages.map((m) => extractText(m)).join("\n\n") : void 0;
  const anthropicMessages = translateMessagesWithToolCoalescing(nonSystemMessages);
  const result2 = {
    model: req.model,
    messages: anthropicMessages,
    max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS
  };
  if (system) result2.system = system;
  if (req.temperature !== void 0) result2.temperature = req.temperature;
  if (req.top_p !== void 0) result2.top_p = req.top_p;
  if (req.stream !== void 0) result2.stream = req.stream;
  if (req.stop) result2.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  const thinking = translateThinking(req);
  if (thinking) result2.thinking = thinking;
  if (req.tools?.length && req.tool_choice !== "none") {
    result2.tools = req.tools.map(translateToolOpenAIToAnthropic);
  }
  if (req.tool_choice !== void 0 && req.tool_choice !== "none") {
    const translated = translateToolChoice(req.tool_choice);
    if (translated) result2.tool_choice = translated;
  }
  return result2;
}
function translateThinking(req) {
  const explicit = req.thinking;
  if (explicit && typeof explicit === "object") {
    if (explicit.type === "disabled") return { type: "disabled" };
    if (explicit.type === "enabled" || explicit.type === "adaptive") {
      const budget = explicit.budget_tokens ?? explicit.budgetTokens;
      return {
        type: explicit.type,
        ...typeof budget === "number" && Number.isFinite(budget) && budget > 0 ? { budget_tokens: Math.floor(budget) } : {},
        ...explicit.type === "adaptive" && typeof explicit.display === "boolean" ? { display: explicit.display } : {}
      };
    }
  }
  if (req.reasoning_effort === "none") return { type: "disabled" };
  if (isReasoningModel(req.model)) return { type: "enabled" };
  return void 0;
}
function isReasoningModel(model) {
  return MODELS.some((m) => m.id === model && m.reasoning === true);
}
function translateToolChoice(choice) {
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (typeof choice === "object" && choice.type === "function") {
    return { type: "tool", name: choice.function.name };
  }
  return void 0;
}
function translateMessagesWithToolCoalescing(messages) {
  const out = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === "tool" && m.tool_call_id) {
      const results = [];
      while (i < messages.length) {
        const tool = messages[i];
        const toolCallId = tool.tool_call_id;
        if (tool.role !== "tool" || !toolCallId) break;
        results.push({
          type: "tool_result",
          tool_use_id: toolCallId,
          content: toolResultContent(tool)
        });
        i++;
      }
      out.push({ role: "user", content: results });
      continue;
    }
    out.push(translateMessageOpenAIToAnthropic(m));
    i++;
  }
  return out;
}
function translateMessageOpenAIToAnthropic(msg) {
  if (msg.role === "assistant" && msg.tool_calls?.length) {
    const blocks = [];
    const text = extractText(msg);
    if (text.length > 0) blocks.push({ type: "text", text });
    for (const tc of msg.tool_calls) {
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: parseToolArguments(tc.function.arguments)
      });
    }
    return { role: "assistant", content: blocks };
  }
  return {
    role: msg.role === "assistant" ? "assistant" : "user",
    content: translateContentOpenAIToAnthropic(msg)
  };
}
function parseToolArguments(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function toolResultContent(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  if (msg.content.every((c) => c.type === "text")) {
    const joined = msg.content.map((c) => c.text ?? "").join("");
    return joined;
  }
  return msg.content.map((c) => {
    if (c.type === "text") return { type: "text", text: c.text ?? "" };
    if (c.type === "image_url" && c.image_url) {
      const parsed = parseDataUrl(c.image_url.url);
      if (parsed) {
        return {
          type: "image",
          source: { type: "base64", media_type: parsed.mediaType, data: parsed.data }
        };
      }
      return { type: "text", text: c.image_url.url };
    }
    return { type: "text", text: "" };
  });
}
function parseDataUrl(url) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!m) return void 0;
  return { mediaType: m[1], data: m[2] };
}
function translateResponseAnthropicToOpenAI(resp, model) {
  const textBlocks = resp.content.filter((b) => b.type === "text");
  const toolUseBlocks = resp.content.filter((b) => b.type === "tool_use");
  const thinkingBlocks = resp.content.filter((b) => b.type === "thinking");
  const content = textBlocks.map((b) => b.text).join("") || null;
  const reasoningContent = thinkingBlocks.map((b) => b.thinking ?? "").join("") || void 0;
  const toolCalls = toolUseBlocks.length > 0 ? toolUseBlocks.map((b, i) => ({
    id: b.id,
    type: "function",
    function: {
      name: b.name,
      arguments: JSON.stringify(b.input ?? {})
    }
  })) : void 0;
  const finishReason = mapStopReasonToFinishReason(resp.stop_reason);
  return {
    id: resp.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1e3),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content,
        ...reasoningContent ? { reasoning_content: reasoningContent } : {},
        ...toolCalls ? { tool_calls: toolCalls } : {}
      },
      finish_reason: finishReason
    }],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0)
    }
  };
}
function extractText(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  }
  return "";
}
function translateContentOpenAIToAnthropic(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (msg.content === null) return "";
  if (Array.isArray(msg.content)) {
    return msg.content.map((c) => {
      if (c.type === "text") return { type: "text", text: c.text ?? "" };
      return { type: "text", text: "" };
    });
  }
  return "";
}
function translateToolOpenAIToAnthropic(tool) {
  return {
    name: tool.function.name,
    ...tool.function.description ? { description: tool.function.description } : {},
    ...tool.function.parameters ? { input_schema: tool.function.parameters } : {}
  };
}
function mapStopReasonToFinishReason(stopReason) {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return null;
  }
}

// src/translator/anthropic-to-openai.ts
function translateRequestAnthropicToOpenAI(req) {
  const messages = [];
  if (req.system) {
    const systemText = typeof req.system === "string" ? req.system : req.system.map((s) => s.text).join("\n");
    messages.push({ role: "system", content: systemText });
  }
  for (const m of req.messages) {
    messages.push(...translateMessageAnthropicToOpenAI(m));
  }
  const result2 = {
    model: req.model,
    messages,
    ...req.temperature !== void 0 ? { temperature: req.temperature } : {},
    ...req.top_p !== void 0 ? { top_p: req.top_p } : {},
    ...req.stream !== void 0 ? { stream: req.stream } : {},
    ...req.max_tokens !== void 0 ? { max_tokens: req.max_tokens } : {}
  };
  if (req.stop_sequences?.length) {
    result2.stop = req.stop_sequences.length === 1 ? req.stop_sequences[0] : req.stop_sequences;
  }
  if (req.thinking) {
    result2.thinking = req.thinking;
  }
  if (req.tools?.length) {
    result2.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        ...t.description ? { description: t.description } : {},
        ...t.input_schema ? { parameters: t.input_schema } : {}
      }
    }));
  }
  if (req.tool_choice) {
    const translated = mapToolChoiceAnthropicToOpenAI(req.tool_choice);
    if (translated !== void 0) result2.tool_choice = translated;
  }
  return result2;
}
function mapToolChoiceAnthropicToOpenAI(choice) {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: choice.name } };
    default:
      return void 0;
  }
}
function translateResponseOpenAIToAnthropic(resp) {
  const choice = resp.choices?.[0];
  const content = [];
  if (choice?.message?.reasoning_content) {
    content.push({ type: "thinking", thinking: choice.message.reasoning_content });
  }
  if (choice?.message?.content) {
    const textContent = typeof choice.message.content === "string" ? choice.message.content : Array.isArray(choice.message.content) ? choice.message.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("") : "";
    if (textContent) content.push({ type: "text", text: textContent });
  }
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input
      });
    }
  }
  const stopReason = mapFinishReasonToStopReason(choice?.finish_reason);
  return {
    id: resp.id,
    type: "message",
    role: "assistant",
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    model: resp.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: openaiUsageToAnthropic(resp.usage)
  };
}
function translateMessageAnthropicToOpenAI(m) {
  if (typeof m.content === "string") {
    return [{ role: m.role, content: m.content }];
  }
  const result2 = [];
  const contentParts = [];
  const toolCalls = [];
  const reasoningParts = [];
  for (const block of m.content) {
    switch (block.type) {
      case "text": {
        contentParts.push({ type: "text", text: block.text });
        break;
      }
      case "image": {
        if (block.source.type === "base64") {
          contentParts.push({
            type: "image_url",
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` }
          });
        }
        break;
      }
      case "tool_use": {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
        });
        break;
      }
      case "tool_result": {
        result2.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: toolResultContentToOpenAI(block.content, block.is_error === true)
        });
        break;
      }
      case "thinking": {
        if (block.thinking.length > 0) reasoningParts.push(block.thinking);
        break;
      }
      default:
        break;
    }
  }
  const hasReasoning = m.role === "assistant" && reasoningParts.length > 0;
  if (contentParts.length > 0 || toolCalls.length > 0 || hasReasoning) {
    const content = contentParts.length === 0 ? null : contentParts.length === 1 && contentParts[0].type === "text" ? contentParts[0].text ?? "" : contentParts;
    result2.push({
      role: m.role,
      content,
      ...hasReasoning ? { reasoning_content: reasoningParts.join("\n") } : {},
      ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
    });
  }
  if (result2.length === 0) {
    result2.push({ role: m.role, content: null });
  }
  return result2;
}
function toolResultContentToOpenAI(content, isError) {
  const body = flattenToolResultContent(content);
  return isError && body.length > 0 ? `[tool_error] ${body}` : body;
}
function flattenToolResultContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts = content.filter((b) => b.type === "text").map((b) => b.text);
  if (texts.length > 0) return texts.join("");
  return JSON.stringify(content);
}
function mapFinishReasonToStopReason(finishReason) {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    default:
      return null;
  }
}
function openaiUsageToAnthropic(usage) {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
  const inputTokens = Math.max(0, promptTokens - cacheRead - cacheCreation);
  const result2 = {
    input_tokens: inputTokens,
    output_tokens: usage?.completion_tokens ?? 0
  };
  if (cacheRead > 0) result2.cache_read_input_tokens = cacheRead;
  if (cacheCreation > 0) result2.cache_creation_input_tokens = cacheCreation;
  return result2;
}

// src/translator/sse-translator.ts
function parseSSEChunk(raw) {
  const results = [];
  const blocks = raw.split("\n\n");
  for (const block of blocks) {
    const lines = block.trim().split("\n").filter(Boolean);
    if (lines.length === 0) continue;
    let eventType = "";
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        dataStr = line.slice(6);
      }
    }
    if (dataStr) {
      try {
        results.push({ event: eventType, data: JSON.parse(dataStr) });
      } catch {
      }
    }
  }
  return results;
}
function initState(model) {
  return {
    messageId: "",
    model,
    roleSent: false,
    inputTokens: 0,
    outputTokens: 0,
    toolCallIndex: 0,
    blockIndexToToolCallIndex: /* @__PURE__ */ new Map(),
    finishReasonSent: false
  };
}
function makeChunk(state, delta, finishReason = null, usage) {
  const chunk = {
    id: state.messageId || "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1e3),
    model: state.model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason
    }]
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}

`;
}
function anthropicSseToOpenaiSse(upstream, model = "glm-4.6") {
  const state = initState(model);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      let errored = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const parsed = parseSSEChunk(block);
            for (const p of parsed) {
              const output = translateEvent(state, p);
              if (output) {
                controller.enqueue(encoder.encode(output));
              }
            }
          }
        }
        if (buffer.trim()) {
          const parsed = parseSSEChunk(buffer);
          for (const p of parsed) {
            const output = translateEvent(state, p);
            if (output) controller.enqueue(encoder.encode(output));
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        errored = true;
        try {
          controller.error(err);
        } catch {
        }
      } finally {
        if (!errored) {
          try {
            controller.close();
          } catch {
          }
        }
        reader.releaseLock();
      }
    }
  });
}
function translateEvent(state, sse) {
  const data = sse.data;
  switch (data.type) {
    case "message_start": {
      const msg = data.message;
      state.messageId = msg?.id ?? "msg_stream";
      state.model = msg?.model ?? state.model;
      state.inputTokens = msg?.usage?.input_tokens ?? 0;
      if (!state.roleSent) {
        state.roleSent = true;
        return makeChunk(state, { role: "assistant" });
      }
      return null;
    }
    case "content_block_start": {
      if (data.type !== "content_block_start") return null;
      const block = data.content_block;
      const blockIdx = data.index;
      if (block.type === "tool_use") {
        const myIndex = state.toolCallIndex++;
        state.blockIndexToToolCallIndex.set(blockIdx, myIndex);
        return makeChunk(state, {
          tool_calls: [{
            index: myIndex,
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: "" }
          }]
        });
      }
      return null;
    }
    case "content_block_delta": {
      if (data.type !== "content_block_delta") return null;
      const delta = data.delta;
      const blockIdx = data.index;
      if (delta.type === "text_delta") {
        return makeChunk(state, { content: delta.text });
      }
      if (delta.type === "thinking_delta") {
        return makeChunk(state, { reasoning_content: delta.thinking });
      }
      if (delta.type === "signature_delta") {
        return null;
      }
      if (delta.type === "input_json_delta") {
        const myIndex = state.blockIndexToToolCallIndex.get(blockIdx);
        if (myIndex === void 0) return null;
        return makeChunk(state, {
          tool_calls: [{
            index: myIndex,
            function: { arguments: delta.partial_json ?? "" }
          }]
        });
      }
      return null;
    }
    case "message_delta": {
      const dataAny = data;
      const delta = dataAny.delta;
      if (dataAny?.usage?.output_tokens !== void 0) {
        state.outputTokens = dataAny.usage.output_tokens;
      }
      if (delta?.stop_reason) {
        const finishReason = mapStopReason(delta.stop_reason);
        state.finishReasonSent = true;
        return makeChunk(state, {}, finishReason, {
          prompt_tokens: state.inputTokens,
          completion_tokens: state.outputTokens,
          total_tokens: state.inputTokens + state.outputTokens
        });
      }
      return null;
    }
    case "message_stop": {
      if (state.finishReasonSent) return null;
      return makeChunk(state, {}, "stop", {
        prompt_tokens: state.inputTokens,
        completion_tokens: state.outputTokens,
        total_tokens: state.inputTokens + state.outputTokens
      });
    }
    case "ping":
    case "content_block_stop":
      return null;
    default:
      return null;
  }
}
function mapStopReason(stopReason) {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}
function openaiSseToAnthropicSse(upstream, model = "glm-4.6") {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let messageStarted = false;
  let blockIndex = 0;
  let activeBlock = null;
  const toolBlocks = /* @__PURE__ */ new Map();
  const openToolBlockIndices = [];
  let outputTokens = 0;
  let latestUsage;
  let pendingStopReason = null;
  let contentClosed = false;
  let messageDeltaSent = false;
  let messageStopped = false;
  const messageId = `msg_${Date.now()}`;
  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      let errored = false;
      const enqueueAnthropicEvent = (eventType, data) => {
        controller.enqueue(encoder.encode(formatAnthropicSSE(eventType, data)));
      };
      const closeActiveBlock = () => {
        if (!activeBlock) return;
        enqueueAnthropicEvent("content_block_stop", {
          type: "content_block_stop",
          index: activeBlock.index
        });
        activeBlock = null;
      };
      const closeToolBlocks = () => {
        for (const idx of openToolBlockIndices) {
          enqueueAnthropicEvent("content_block_stop", {
            type: "content_block_stop",
            index: idx
          });
        }
        openToolBlockIndices.length = 0;
      };
      const ensureActiveBlock = (type) => {
        if (activeBlock?.type === type) return activeBlock.index;
        closeActiveBlock();
        const index = blockIndex++;
        activeBlock = { type, index };
        enqueueAnthropicEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "", signature: "" }
        });
        return index;
      };
      const handleToolCalls = (toolCalls) => {
        closeActiveBlock();
        for (const tc of toolCalls) {
          const idx = tc.index ?? 0;
          let state = toolBlocks.get(idx);
          if (!state) {
            state = { index: blockIndex++, id: "", name: "", started: false, pendingArgs: "" };
            toolBlocks.set(idx, state);
          }
          if (tc.id) state.id = tc.id;
          if (tc.function?.name) state.name = tc.function.name;
          if (!state.started && state.id && state.name) {
            state.started = true;
            enqueueAnthropicEvent("content_block_start", {
              type: "content_block_start",
              index: state.index,
              content_block: { type: "tool_use", id: state.id, name: state.name, input: {} }
            });
            openToolBlockIndices.push(state.index);
            if (state.pendingArgs.length > 0) {
              enqueueAnthropicEvent("content_block_delta", {
                type: "content_block_delta",
                index: state.index,
                delta: { type: "input_json_delta", partial_json: state.pendingArgs }
              });
              state.pendingArgs = "";
            }
          }
          const argsDelta = tc.function?.arguments;
          if (argsDelta) {
            if (state.started) {
              enqueueAnthropicEvent("content_block_delta", {
                type: "content_block_delta",
                index: state.index,
                delta: { type: "input_json_delta", partial_json: argsDelta }
              });
            } else {
              state.pendingArgs += argsDelta;
            }
          }
        }
      };
      const startPendingToolBlocks = () => {
        const lateStarts = [];
        for (const [openaiIdx, state] of toolBlocks) {
          if (state.started) continue;
          if (!state.pendingArgs && !state.id && !state.name) continue;
          state.started = true;
          lateStarts.push({
            index: state.index,
            id: state.id || `tool_call_${openaiIdx}`,
            name: state.name || "unknown_tool",
            args: state.pendingArgs
          });
          state.pendingArgs = "";
          openToolBlockIndices.push(state.index);
        }
        lateStarts.sort((a, b) => a.index - b.index);
        for (const ls of lateStarts) {
          enqueueAnthropicEvent("content_block_start", {
            type: "content_block_start",
            index: ls.index,
            content_block: { type: "tool_use", id: ls.id, name: ls.name, input: {} }
          });
          if (ls.args.length > 0) {
            enqueueAnthropicEvent("content_block_delta", {
              type: "content_block_delta",
              index: ls.index,
              delta: { type: "input_json_delta", partial_json: ls.args }
            });
          }
        }
      };
      const closeContent = () => {
        if (contentClosed) return;
        contentClosed = true;
        closeActiveBlock();
        startPendingToolBlocks();
        closeToolBlocks();
      };
      const finalizeStream = () => {
        closeContent();
        if (!messageDeltaSent) {
          messageDeltaSent = true;
          const usage = openaiUsageToAnthropic(latestUsage);
          if (!latestUsage) usage.output_tokens = outputTokens;
          enqueueAnthropicEvent("message_delta", {
            type: "message_delta",
            delta: {
              stop_reason: pendingStopReason ?? "end_turn",
              stop_sequence: null
            },
            usage
          });
        }
        if (!messageStopped) {
          messageStopped = true;
          enqueueAnthropicEvent("message_stop", { type: "message_stop" });
        }
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") {
              finalizeStream();
              continue;
            }
            try {
              const chunk = JSON.parse(dataStr);
              const choice = chunk.choices?.[0];
              if (chunk.usage) {
                latestUsage = chunk.usage;
                outputTokens = chunk.usage.completion_tokens ?? outputTokens;
              }
              if (!messageStarted) {
                messageStarted = true;
                const startUsage = openaiUsageToAnthropic(chunk.usage);
                enqueueAnthropicEvent("message_start", {
                  type: "message_start",
                  message: {
                    id: chunk.id ?? messageId,
                    type: "message",
                    role: "assistant",
                    content: [],
                    model: chunk.model || model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: startUsage
                  }
                });
              }
              if (choice?.delta?.content) {
                const index = ensureActiveBlock("text");
                enqueueAnthropicEvent("content_block_delta", {
                  type: "content_block_delta",
                  index,
                  delta: { type: "text_delta", text: choice.delta.content }
                });
              }
              if (choice?.delta?.reasoning_content) {
                const index = ensureActiveBlock("thinking");
                enqueueAnthropicEvent("content_block_delta", {
                  type: "content_block_delta",
                  index,
                  delta: { type: "thinking_delta", thinking: choice.delta.reasoning_content }
                });
              }
              if (choice?.delta?.tool_calls?.length) {
                handleToolCalls(choice.delta.tool_calls);
              }
              if (choice?.finish_reason) {
                pendingStopReason = mapFinishReason(choice.finish_reason);
                closeContent();
              }
            } catch {
            }
          }
        }
        finalizeStream();
      } catch (err) {
        errored = true;
        try {
          controller.error(err);
        } catch {
        }
      } finally {
        if (!errored) {
          try {
            controller.close();
          } catch {
          }
        }
        reader.releaseLock();
      }
    }
  });
}
function formatAnthropicSSE(eventType, data) {
  return `event: ${eventType}
data: ${JSON.stringify(data)}

`;
}
function mapFinishReason(finishReason) {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}

// src/proxy/dump.ts
var import_node_fs2 = require("node:fs");
var DUMP_PATH = process.env.ZCODE_DUMP_UPSTREAM;
var SENSITIVE_HEADERS = /* @__PURE__ */ new Set([
  "authorization",
  "x-api-key",
  "proxy-authorization",
  "proxy-api-key",
  "x-zcode-captcha-verify-param",
  "x-zcode-captcha-verify-region",
  "cookie"
]);
function maskHeaderValue(key, value) {
  if (!SENSITIVE_HEADERS.has(key.toLowerCase())) return value;
  if (value.length <= 12) return "<redacted>";
  return `${value.slice(0, 8)}\u2026${value.slice(-4)} (len=${value.length})`;
}
function dumpHeaders(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    out[k] = maskHeaderValue(k, v);
  }
  return out;
}
function dumpBody(body) {
  if (body === void 0 || body === null) return void 0;
  if (body.length === 0) return "";
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
function dumpPhase(reqId, phase, data) {
  if (!DUMP_PATH) return;
  try {
    const line = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      reqId,
      phase,
      ...data
    };
    (0, import_node_fs2.appendFileSync)(DUMP_PATH, JSON.stringify(line) + "\n", "utf-8");
  } catch {
  }
}
function dumpEnabled() {
  return !!DUMP_PATH;
}

// src/proxy/handler.ts
var captchaModule = null;
async function loadCaptcha() {
  if (!captchaModule) captchaModule = await Promise.resolve().then(() => (init_captcha(), captcha_exports));
  return captchaModule;
}
async function proxyRequest(clientReq, format, opts) {
  const { config, auth } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hasCustomFetchImpl = opts.fetchImpl !== void 0;
  const debug = opts.debug === true;
  const started = Date.now();
  const reqId = nextReqId();
  const body = await readBody(clientReq);
  const meta = peekBody(body);
  if (dumpEnabled()) {
    dumpPhase(reqId, "client_in", {
      method: clientReq.method,
      url: clientReq.url,
      headers: dumpHeaders(clientReq.headers),
      body: dumpBody(body)
    });
  }
  const staticProvider = getProvider(config.provider);
  const provider = {
    ...staticProvider,
    anthropicBaseURL: config.providers[config.provider].anthropicBase,
    openaiBaseURL: config.providers[config.provider].openaiBase
  };
  let cred;
  try {
    cred = await auth.getCredential();
  } catch (err) {
    if (debug) debugError(reqId, "credential_unavailable", err.message);
    printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0);
    return errorResponse(503, "credential_unavailable", err.message);
  }
  const startPlan = config.plan === "start-plan";
  const translateAnthropicToOpenAI = format === "anthropic";
  const translateOpenAIToAnthropic = false;
  const upstreamFormat = "openai";
  const clientSession = resolveSessionContext({ clientReq, body, upstreamFormat, model: meta.model, config });
  if (debug && clientSession) {
    const shortSession = clientSession.sessionId ? clientSession.sessionId.slice(0, 10) : "-";
    debugLine(reqId, `clientIdentity source=${clientSession.source} action=${clientSession.action} confidence=${clientSession.confidence.toFixed(2)} session=${shortSession}`);
  }
  let upstreamBody = body;
  if (translateOpenAIToAnthropic) {
    const translated = translateOpenAIBody(body);
    if (translated instanceof Response) return translated;
    upstreamBody = translated;
    if (debug) debugLine(reqId, `translated OpenAI\u2192Anthropic (bytes=${upstreamBody?.length ?? 0})`);
  } else if (translateAnthropicToOpenAI) {
    const translated = translateAnthropicBody(body);
    if (translated instanceof Response) return translated;
    upstreamBody = translated;
    if (debug) debugLine(reqId, `translated Anthropic\u2192OpenAI (bytes=${upstreamBody?.length ?? 0})`);
  }
  const transformedBody = transformRequestBody(upstreamBody, { format: upstreamFormat, userId: startPlan ? void 0 : cred.userId, startPlan });
  if (debug && transformedBody !== upstreamBody) {
    debugLine(reqId, `body transformed (upstreamFormat=${upstreamFormat}, startPlan=${startPlan}, bytes=${transformedBody?.length ?? 0})`);
  }
  let captchaHeaders;
  if (startPlan) {
    try {
      const captcha2 = await loadCaptcha();
      const token = await captcha2.getCaptchaToken(config.identity.appVersion);
      captchaHeaders = { [captcha2.RETRY_HEADERS.PARAM]: token.verifyParam, [captcha2.RETRY_HEADERS.REGION]: token.region };
    } catch {
    }
  }
  const useOrderedTransport = shouldUseOrderedTransport(config, clientSession, hasCustomFetchImpl);
  let upstreamHeaderPairs = buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, config.identity, config.plan, captchaHeaders, clientSession);
  let upstreamReq = buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, config.plan, captchaHeaders, clientSession);
  if (debug) {
    debugLine(reqId, `\u2192 POST ${upstreamReq.url}`);
    debugLine(reqId, `  ${formatHeaderPairs(upstreamReq.headers)}`);
    if (transformedBody) debugLine(reqId, `  body preview: ${previewBody(transformedBody)}`);
  }
  if (dumpEnabled()) {
    dumpPhase(reqId, "upstream_out", {
      method: upstreamReq.method,
      url: upstreamReq.url,
      headers: dumpHeaders(upstreamReq.headers),
      body: dumpBody(transformedBody),
      upstreamFormat,
      translateMode: translateOpenAIToAnthropic || translateAnthropicToOpenAI,
      useOrderedTransport,
      startPlan
    });
  }
  let upstreamResp;
  try {
    upstreamResp = await sendUpstreamRequest(upstreamReq, upstreamHeaderPairs, transformedBody, translateOpenAIToAnthropic || translateAnthropicToOpenAI, useOrderedTransport, fetchImpl, clientReq.signal);
  } catch (err) {
    if (debug) debugError(reqId, "upstream_unreachable", err.message);
    printRow(reqId, format, meta, 502, started, Date.now(), 0, 0, 0);
    return errorResponse(502, "upstream_unreachable", err.message);
  }
  const headersAt = Date.now();
  if (debug) {
    debugLine(reqId, `\u2190 ${upstreamResp.status} ${upstreamResp.statusText}`);
    debugLine(reqId, `  ${formatResponseHeaders(upstreamResp.headers)}`);
  }
  if (dumpEnabled()) {
    dumpPhase(reqId, "upstream_in", {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: dumpHeaders(upstreamResp.headers),
      isSSE: upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false,
      ttfbMs: headersAt - started
    });
  }
  if (upstreamResp.status === 401 && startPlan) {
    if (debug) debugError(reqId, "start_plan_jwt_invalid", "JWT rejected upstream");
    printRow(reqId, format, meta, 401, started, headersAt, 0, 0, 0);
    return errorResponse(401, "start_plan_jwt_invalid", "Start-plan JWT was rejected. Re-run: zcode-proxy auth login");
  }
  const captcha = startPlan ? await loadCaptcha() : null;
  const captchaChallenge = captcha ? captcha.detectCaptchaChallenge(upstreamResp) : null;
  if (captchaChallenge && captcha) {
    if (debug) debugLine(reqId, "captcha challenge \u2014 re-solving and retrying once");
    try {
      upstreamResp.body?.cancel();
    } catch {
    }
    console.log(`${reqId} captcha challenge, re-solving...`);
    captcha.invalidateCaptchaToken();
    try {
      const fresh = await captcha.getCaptchaToken(config.identity.appVersion);
      console.log(`${reqId} captcha re-solved (token ${fresh.verifyParam.length} chars), retrying...`);
      const retryHeaders = {
        [captcha.RETRY_HEADERS.PARAM]: fresh.verifyParam,
        [captcha.RETRY_HEADERS.REGION]: fresh.region
      };
      upstreamHeaderPairs = buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, config.identity, config.plan, retryHeaders, clientSession);
      upstreamReq = buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, config.plan, retryHeaders, clientSession);
      upstreamResp = await sendUpstreamRequest(upstreamReq, upstreamHeaderPairs, transformedBody, translateOpenAIToAnthropic || translateAnthropicToOpenAI, useOrderedTransport, fetchImpl).catch((err) => {
        if (debug) debugError(reqId, "upstream_unreachable", err.message);
        printRow(reqId, format, meta, 502, started, Date.now(), 0, 0, 0);
        return errorResponse(502, "upstream_unreachable", err.message);
      });
      if (debug) debugLine(reqId, `\u2190 retry ${upstreamResp.status} ${upstreamResp.statusText}`);
    } catch (err) {
      if (debug) debugError(reqId, "captcha_solver_failed", err.message);
      printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0);
      return errorResponse(503, "captcha_solver_failed", err.message);
    }
  }
  const isSSE = upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false;
  if (translateOpenAIToAnthropic) {
    if (!upstreamResp.ok) {
      const errBody = await upstreamResp.text().catch(() => "");
      printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
      return errorResponse(502, "translation_failed", `upstream returned ${upstreamResp.status}: ${errBody.slice(0, 200)}`);
    }
    if (isSSE && upstreamResp.body) {
      const translated = anthropicSseToOpenaiSse(upstreamResp.body, meta.model);
      const [clientBody, statsBody] = translated.tee();
      observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, null);
      return translatedSseResponse(clientBody);
    }
    return await translatedBatchResponse(clientReq, upstreamResp, meta.model, reqId, format, meta, started, headersAt);
  }
  if (translateAnthropicToOpenAI) {
    if (!upstreamResp.ok) {
      const errBody = await upstreamResp.text().catch(() => "");
      printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
      return errorResponse(502, "translation_failed", `upstream returned ${upstreamResp.status}: ${errBody.slice(0, 200)}`);
    }
    if (isSSE && upstreamResp.body) {
      const translated = openaiSseToAnthropicSse(upstreamResp.body, meta.model);
      const [clientBody, statsBody] = translated.tee();
      observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, null);
      return translatedSseResponse(clientBody);
    }
    return await translatedOpenAIToAnthropicBatchResponse(clientReq, upstreamResp, reqId, format, meta, started, headersAt);
  }
  if (isSSE && upstreamResp.body) {
    const [clientBody, statsBody] = upstreamResp.body.tee();
    observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, upstreamResp.headers.get("content-encoding"));
    return passthroughResponse(upstreamResp, clientAcceptsGzip(clientReq), clientBody);
  }
  printRow(reqId, format, meta, upstreamResp.status, started, headersAt, 0, 0, 0);
  return passthroughResponse(upstreamResp, clientAcceptsGzip(clientReq));
}
function shouldUseOrderedTransport(config, clientSession, hasCustomFetchImpl) {
  if (hasCustomFetchImpl) return false;
  return clientSession?.action === "enforce" || clientSession?.source === "explicit";
}
async function sendUpstreamRequest(upstreamReq, headerPairs, body, translateMode, useOrderedTransport, fetchImpl, abortSignal) {
  if (useOrderedTransport) {
    return sendOrderedUpstreamRequest({
      url: upstreamReq.url,
      method: upstreamReq.method,
      headers: headerPairs,
      body,
      decompress: translateMode
    });
  }
  const fetchOpts = translateMode ? {} : { decompress: false };
  if (abortSignal) fetchOpts.signal = abortSignal;
  return fetchImpl(upstreamReq, fetchOpts);
}
async function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return void 0;
  const text = await req.text();
  if (text.length === 0) return void 0;
  return text;
}
function passthroughResponse(upstream, clientAcceptsGzip2, body) {
  const headers = new Headers();
  const forwardHeaders = [
    "content-type",
    "content-encoding",
    "cache-control",
    "x-request-id",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset"
  ];
  for (const h of forwardHeaders) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  const upstreamEncoding = headers.get("content-encoding")?.toLowerCase() ?? "";
  const source = body ?? upstream.body;
  if (upstreamEncoding.includes("gzip") && !clientAcceptsGzip2 && source) {
    const gunzip = new DecompressionStream("gzip");
    const decompressed = source.pipeThrough(gunzip);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(decompressed, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    });
  }
  return new Response(source, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
}
function errorResponse(status, type, message) {
  const body = JSON.stringify({
    error: { type, message }
  });
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" }
  });
}
function translateOpenAIBody(body) {
  if (body === void 0 || body.length === 0) {
    return errorResponse(400, "translation_failed", "OpenAI request body is empty; cannot translate.");
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return errorResponse(400, "translation_failed", `OpenAI request body is not valid JSON: ${err.message}`);
  }
  try {
    const translated = translateRequestOpenAIToAnthropic(parsed);
    return JSON.stringify(translated);
  } catch (err) {
    return errorResponse(400, "translation_failed", `OpenAI\u2192Anthropic translation failed: ${err.message}`);
  }
}
function clientAcceptsGzip(req) {
  const ae = req.headers.get("accept-encoding");
  if (!ae) return false;
  return /\bgzip\b(?!\s*;\s*q=0(?:\.0+)?\s*(?:,|$))/i.test(ae);
}
async function translatedBatchResponse(clientReq, upstream, model, reqId, format, meta, started, headersAt) {
  const raw = await upstream.text();
  let parsedAnthropic;
  try {
    parsedAnthropic = JSON.parse(raw);
  } catch (err) {
    printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
    return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${err.message}`);
  }
  if (!isAnthropicMessagesResponse(parsedAnthropic)) {
    printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
    return errorResponse(502, "translation_failed", `upstream returned invalid Anthropic message: ${raw.slice(0, 200)}`);
  }
  const openaiResp = translateResponseAnthropicToOpenAI(parsedAnthropic, model);
  const json = JSON.stringify(openaiResp);
  const payload = new TextEncoder().encode(json);
  const respHeaders = new Headers();
  respHeaders.set("content-type", "application/json");
  for (const h of forwardedUpstreamHeaders()) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }
  if (clientAcceptsGzip(clientReq)) {
    respHeaders.set("content-encoding", "gzip");
    printRow(reqId, format, meta, upstream.status, started, headersAt, openaiResp.usage?.completion_tokens ?? 0, 0, 0);
    return new Response((0, import_node_zlib.gzipSync)(payload), {
      status: upstream.status,
      headers: respHeaders
    });
  }
  printRow(reqId, format, meta, upstream.status, started, headersAt, openaiResp.usage?.completion_tokens ?? 0, 0, 0);
  return new Response(payload, {
    status: upstream.status,
    headers: respHeaders
  });
}
async function translatedOpenAIToAnthropicBatchResponse(clientReq, upstream, reqId, format, meta, started, headersAt) {
  const raw = await upstream.text();
  let parsedOpenAI;
  try {
    parsedOpenAI = JSON.parse(raw);
  } catch (err) {
    printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
    return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${err.message}`);
  }
  const anthropicResp = translateResponseOpenAIToAnthropic(parsedOpenAI);
  const json = JSON.stringify(anthropicResp);
  const payload = new TextEncoder().encode(json);
  const respHeaders = new Headers();
  respHeaders.set("content-type", "application/json");
  for (const h of forwardedUpstreamHeaders()) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }
  if (clientAcceptsGzip(clientReq)) {
    respHeaders.set("content-encoding", "gzip");
    printRow(reqId, format, meta, upstream.status, started, headersAt, anthropicResp.usage.output_tokens, 0, 0);
    return new Response((0, import_node_zlib.gzipSync)(payload), {
      status: upstream.status,
      headers: respHeaders
    });
  }
  printRow(reqId, format, meta, upstream.status, started, headersAt, anthropicResp.usage.output_tokens, 0, 0);
  return new Response(payload, {
    status: upstream.status,
    headers: respHeaders
  });
}
function translateAnthropicBody(body) {
  if (body === void 0 || body.length === 0) {
    return errorResponse(400, "translation_failed", "Anthropic request body is empty; cannot translate.");
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return errorResponse(400, "translation_failed", `Anthropic request body is not valid JSON: ${err.message}`);
  }
  try {
    const translated = translateRequestAnthropicToOpenAI(parsed);
    return JSON.stringify(translated);
  } catch (err) {
    return errorResponse(400, "translation_failed", `Anthropic\u2192OpenAI translation failed: ${err.message}`);
  }
}
function isAnthropicMessagesResponse(value) {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value;
  return candidate.type === "message" && candidate.role === "assistant" && Array.isArray(candidate.content);
}
function forwardedUpstreamHeaders() {
  return [
    "x-request-id",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset"
  ];
}
function translatedSseResponse(body) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    }
  });
}
function peekBody(body) {
  if (!body) return { model: "-", stream: false };
  try {
    const p = JSON.parse(body);
    return {
      model: typeof p.model === "string" ? p.model : "-",
      stream: p.stream === true
    };
  } catch {
    return { model: "-", stream: false };
  }
}
var reqCounter = 0;
var headerPrinted = false;
function localTime(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
function nextReqId() {
  return `#${String(++reqCounter).padStart(3, "0")}`;
}
var DEBUG_BODY_PREVIEW = 200;
var SENSITIVE_HEADERS2 = /* @__PURE__ */ new Set(["authorization", "x-api-key", "cookie", "set-cookie", "proxy-authorization"]);
function debugLine(reqId, msg) {
  console.log(`${reqId} debug: ${msg}`);
}
function debugError(reqId, kind, msg) {
  console.log(`${reqId} debug: ERROR ${kind}: ${msg}`);
}
function redactHeaderVal(key, val) {
  const k = key.toLowerCase();
  if (!SENSITIVE_HEADERS2.has(k)) return val;
  if (k === "authorization") {
    const sp = val.indexOf(" ");
    return sp > 0 ? `${val.slice(0, sp)} <redacted>` : "<redacted>";
  }
  if (val.length <= 10) return "<redacted>";
  return `${val.slice(0, 6)}...${val.slice(-4)}`;
}
function formatHeaderPairs(headers) {
  const pairs = [];
  for (const [k, v] of headers.entries()) {
    pairs.push(`${k}=${redactHeaderVal(k, v)}`);
  }
  return pairs.join(" ");
}
function formatResponseHeaders(headers) {
  const interesting = [
    "content-type",
    "content-encoding",
    "content-length",
    "x-request-id",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-tokens-remaining"
  ];
  const pairs = [];
  for (const h of interesting) {
    const v = headers.get(h);
    if (v) pairs.push(`${h}=${v}`);
  }
  return pairs.length > 0 ? pairs.join(" ") : "(no notable headers)";
}
function previewBody(body) {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= DEBUG_BODY_PREVIEW) return flat;
  return `${flat.slice(0, DEBUG_BODY_PREVIEW)}\u2026(${flat.length} bytes total)`;
}
var COMPACT_LOG = process.env.ZCODE_LOG_FORMAT === "compact";
function printHeader() {
  if (headerPrinted) return;
  headerPrinted = true;
  if (COMPACT_LOG) return;
  console.log(
    "| #    | Time       | Fmt | Model       | Mode   | Stat |    TTFB |   Tok |  tok/s |   Total |"
  );
  console.log(
    "|------|------------|-----|-------------|--------|------|---------|-------|--------|---------|"
  );
}
function printRow(reqId, format, meta, status, started, headersAt, tokens, avgTps, streamEndAt) {
  printHeader();
  const tag = format === "anthropic" ? "ANT" : "OAI";
  const mode = meta.stream ? "stream" : "batch";
  if (COMPACT_LOG) {
    const ttfbMs = headersAt - started;
    const totalMs = streamEndAt > started ? streamEndAt - started : ttfbMs;
    const ttfbStr = fmtMs(ttfbMs);
    const tokStr = tokens > 0 ? `${tokens}tok` : "";
    const tpsStr = avgTps > 0 ? `${avgTps.toFixed(0)}t/s` : "";
    const parts = [reqId, tag, meta.model, String(status), mode];
    if (meta.stream && streamEndAt > started) {
      parts.push(`${ttfbStr}\u2192${fmtMs(totalMs)}`);
    } else {
      parts.push(ttfbStr);
    }
    if (tokStr) parts.push(tokStr);
    if (tpsStr) parts.push(tpsStr);
    console.log(parts.join(" "));
    return;
  }
  const ts = localTime(started);
  const ttfb = `${headersAt - started}ms`;
  const total = streamEndAt > started ? `${streamEndAt - started}ms` : "-";
  const tok = tokens > 0 ? String(tokens) : "-";
  const tps = avgTps > 0 ? avgTps.toFixed(1) : "-";
  console.log(
    `| ${reqId.padEnd(4)} | ${ts.padEnd(10)} | ${tag} | ${meta.model.padEnd(11)} | ${mode.padEnd(6)} | ${String(status).padStart(4)} | ${ttfb.padStart(7)} | ${tok.padStart(5)} | ${tps.padStart(6)} | ${total.padStart(7)} |`
  );
}
function fmtMs(ms) {
  if (ms < 1e3) return `${ms}ms`;
  if (ms < 6e4) return `${(ms / 1e3).toFixed(1)}s`;
  return `${Math.floor(ms / 6e4)}m${Math.floor(ms % 6e4 / 1e3)}s`;
}
function observeStream(reqId, format, meta, status, requestSentAt, body, contentEncoding) {
  const compressed = contentEncoding !== null;
  const dumpOn = dumpEnabled();
  let tokens = 0;
  let sseBuffer = "";
  let firstChunkAt = 0;
  let totalBytes = 0;
  let firstBytesSample = "";
  function parseSse(text) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        if (j.usage?.completion_tokens) {
          tokens = j.usage.completion_tokens;
          continue;
        }
        if (j.usage?.output_tokens) {
          tokens = j.usage.output_tokens;
          continue;
        }
        const oai = j.choices?.[0]?.delta?.content;
        if (typeof oai === "string" && oai.length > 0) {
          tokens++;
          continue;
        }
        if (j.type === "content_block_delta" && j.delta?.type === "text_delta") {
          const t = j.delta?.text;
          if (typeof t === "string" && t.length > 0) tokens++;
        }
      } catch {
      }
    }
  }
  (async () => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstChunkAt === 0) firstChunkAt = Date.now();
        if (dumpOn && value) {
          totalBytes += value.byteLength;
          if (firstBytesSample.length < 4096) {
            firstBytesSample += decoder.decode(value.slice(0, 4096 - firstBytesSample.length), { stream: true });
          }
        }
        if (!compressed) {
          sseBuffer += decoder.decode(value, { stream: true });
          const idx = sseBuffer.lastIndexOf("\n");
          if (idx >= 0) {
            parseSse(sseBuffer.slice(0, idx));
            sseBuffer = sseBuffer.slice(idx + 1);
          }
        }
      }
      if (!compressed && sseBuffer) parseSse(sseBuffer);
    } catch {
    }
    const endAt = Date.now();
    const ttfbMs = (firstChunkAt > 0 ? firstChunkAt : endAt) - requestSentAt;
    const totalMs = endAt - requestSentAt;
    const avgTps = tokens > 0 && totalMs > 0 ? tokens / (totalMs / 1e3) : 0;
    printRow(reqId, format, meta, status, requestSentAt, requestSentAt + ttfbMs, tokens, avgTps, endAt);
    if (dumpOn) {
      dumpPhase(reqId, "upstream_stream_summary", {
        status,
        contentEncoding,
        compressed,
        totalBytes,
        tokensObserved: tokens,
        ttfbMs,
        totalMs,
        firstBytesSample: firstBytesSample.length > 0 ? firstBytesSample.slice(0, 4096) : "(empty stream)"
      });
    }
  })().catch(() => {
  });
}

// src/server/routes-openai.ts
async function handleChatCompletions(req, opts) {
  return proxyRequest(req, "openai", opts);
}
function handleListModels() {
  const list = {
    object: "list",
    data: MODELS.map((m) => ({
      id: m.id,
      object: "model",
      owned_by: "zcode-proxy"
    }))
  };
  return new Response(JSON.stringify(list), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

// src/server/routes-anthropic.ts
async function handleMessages(req, opts) {
  return proxyRequest(req, "anthropic", opts);
}

// src/translator/responses-types.ts
function generateResponsesId(prefix = "resp_") {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}${hex}`;
}
function generateItemId() {
  return generateResponsesId("item_");
}
function generateCallId() {
  return generateResponsesId("call_");
}
function isHostedTool(t) {
  return t.type === "file_search" || t.type === "code_interpreter" || t.type === "computer_use_preview" || t.type === "image_generation" || t.type === "mcp";
}
function isWebSearchTool(t) {
  return t.type === "web_search" || t.type === "web_search_preview";
}

// src/translator/responses-to-chat.ts
var CUSTOM_TOOL_SCHEMA = {
  type: "object",
  properties: { input: { type: "string" } },
  required: ["input"],
  additionalProperties: false
};
var TOOL_SEARCH_PROXY_SCHEMA = {
  type: "object",
  properties: { query: { type: "string" }, limit: { type: "number" } },
  additionalProperties: false
};
function responsesToChatCompletions(req) {
  const messages = [];
  if (typeof req.instructions === "string" && req.instructions.trim().length > 0) {
    messages.push({ role: "system", content: req.instructions });
  }
  const inputItems = normaliseInput(req.input);
  const built = buildMessagesFromItems(inputItems);
  messages.push(...built);
  const customToolNames = /* @__PURE__ */ new Set();
  const namespaceMap = /* @__PURE__ */ new Map();
  const convertibleToolNames = /* @__PURE__ */ new Set();
  let hasWebSearch = false;
  let hasToolSearch = false;
  const tools = [];
  if (Array.isArray(req.tools)) {
    for (const tool of req.tools) {
      collectTools(tool, "", tools, customToolNames, namespaceMap, convertibleToolNames, (ref) => {
        if (ref === "web_search") hasWebSearch = true;
        if (ref === "tool_search") hasToolSearch = true;
      });
    }
  }
  const chatRequest = {
    model: req.model,
    messages,
    ...req.max_output_tokens !== void 0 ? { max_tokens: req.max_output_tokens } : {},
    ...req.temperature !== void 0 ? { temperature: req.temperature } : {},
    ...req.top_p !== void 0 ? { top_p: req.top_p } : {},
    ...req.stream !== void 0 ? { stream: req.stream } : {},
    ...req.user !== void 0 ? { user: req.user } : {}
  };
  if (tools.length > 0) chatRequest.tools = tools;
  if (tools.length > 0 && req.tool_choice !== void 0) {
    const mapped = mapToolChoice(req.tool_choice, convertibleToolNames, hasToolSearch);
    if (mapped !== void 0) chatRequest.tool_choice = mapped;
  }
  if (tools.length > 0 && req.parallel_tool_calls !== void 0) {
    chatRequest.parallel_tool_calls = req.parallel_tool_calls;
  }
  if (req.reasoning?.effort) {
    chatRequest.reasoning_effort = req.reasoning.effort;
  }
  return {
    chatRequest,
    customToolNames,
    namespaceMap,
    hasWebSearch,
    hasToolSearch,
    convertibleToolNames
  };
}
function normaliseInput(input) {
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: input }];
  }
  if (!Array.isArray(input)) return [];
  return input.filter((x) => x !== null && typeof x === "object");
}
function buildMessagesFromItems(items) {
  const out = [];
  let pendingReasoning = "";
  for (const item of items) {
    const type = item.type ?? "";
    switch (type) {
      case "message": {
        const role = item.role;
        const chatRole = role === "assistant" ? "assistant" : role === "developer" || role === "system" ? "system" : "user";
        const content = contentPartsToChat(item.content, chatRole);
        out.push({ role: chatRole, content });
        if (chatRole !== "assistant") pendingReasoning = "";
        continue;
      }
      case "reasoning": {
        const text = extractReasoningText(item);
        if (text) pendingReasoning = text;
        continue;
      }
      case "function_call": {
        const fc = item;
        const args = (fc.arguments ?? "").trim().length === 0 ? "{}" : fc.arguments;
        const toolCall = {
          id: fc.call_id,
          type: "function",
          function: { name: fc.name, arguments: args }
        };
        mergeToolCallIntoAssistant(out, toolCall, pendingReasoning);
        pendingReasoning = "";
        continue;
      }
      case "custom_tool_call": {
        const ct = item;
        const argObj = JSON.stringify({ input: ct.input ?? "" });
        const toolCall = {
          id: ct.call_id,
          type: "function",
          function: { name: ct.name, arguments: argObj }
        };
        mergeToolCallIntoAssistant(out, toolCall, pendingReasoning);
        pendingReasoning = "";
        continue;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const fco = item;
        out.push({
          role: "tool",
          tool_call_id: fco.call_id,
          content: fco.output ?? ""
        });
        pendingReasoning = "";
        continue;
      }
      case "tool_search_call": {
        const tsc = item;
        const argStr = typeof tsc.arguments === "string" ? tsc.arguments : JSON.stringify(tsc.arguments ?? {});
        const toolCall = {
          id: tsc.call_id ?? "",
          type: "function",
          function: { name: "tool_search", arguments: argStr }
        };
        mergeToolCallIntoAssistant(out, toolCall, pendingReasoning);
        pendingReasoning = "";
        continue;
      }
      case "tool_search_output": {
        const tso = item;
        out.push({
          role: "tool",
          tool_call_id: tso.call_id ?? "",
          content: typeof tso.output === "string" ? tso.output : JSON.stringify(tso.output ?? {})
        });
        pendingReasoning = "";
        continue;
      }
      case "additional_tools":
        continue;
      default:
        if (type !== "") pendingReasoning = "";
        continue;
    }
  }
  return out;
}
function mergeToolCallIntoAssistant(out, toolCall, reasoning) {
  const last = out[out.length - 1];
  if (last && last.role === "assistant" && Array.isArray(last.tool_calls)) {
    last.tool_calls.push(toolCall);
    if (!last.reasoning_content && reasoning) last.reasoning_content = reasoning;
  } else {
    out.push({
      role: "assistant",
      content: null,
      tool_calls: [toolCall],
      ...reasoning ? { reasoning_content: reasoning } : {}
    });
  }
}
function extractReasoningText(item) {
  const r = item;
  const parts = Array.isArray(r.summary) && r.summary.length > 0 ? r.summary : r.content;
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => typeof p.text === "string" ? p.text : "").filter((t) => t.length > 0).join("\n");
}
function contentPartsToChat(content, role) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const textParts = [];
  const chatParts = [];
  let hasImage = false;
  for (const part of content) {
    if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
      if (part.text.length === 0) continue;
      textParts.push(part.text);
      chatParts.push({ type: "text", text: part.text });
    } else if (part.type === "input_image" || part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (!url) continue;
      hasImage = true;
      chatParts.push({ type: "image_url", image_url: { url } });
    }
  }
  if (!hasImage) return textParts.join("\n");
  if (role !== "user") return textParts.join("\n");
  return chatParts;
}
function collectTools(tool, namespacePrefix, out, customToolNames, namespaceMap, convertibleToolNames, signal) {
  const type = tool.type ?? "";
  if (type === "function") {
    const name = tool.name;
    const flatName = namespacePrefix ? `${namespacePrefix}__${name}` : name;
    if (convertibleToolNames.has(flatName)) {
      throw new ToolTranslationError(`duplicate tool name after flattening: "${flatName}"`);
    }
    const t = tool;
    out.push({
      type: "function",
      function: {
        name: flatName,
        ...t.description ? { description: t.description } : {},
        ...t.parameters ? { parameters: t.parameters } : {}
      }
    });
    convertibleToolNames.add(flatName);
    if (namespacePrefix) namespaceMap.set(flatName, { namespace: namespacePrefix, name });
    return;
  }
  if (type === "custom") {
    const name = tool.name;
    const flatName = namespacePrefix ? `${namespacePrefix}__${name}` : name;
    if (convertibleToolNames.has(flatName)) {
      throw new ToolTranslationError(`duplicate tool name after flattening: "${flatName}"`);
    }
    const t = tool;
    out.push({
      type: "function",
      function: {
        name: flatName,
        ...t.description ? { description: t.description } : {},
        parameters: CUSTOM_TOOL_SCHEMA
      }
    });
    convertibleToolNames.add(flatName);
    customToolNames.add(flatName);
    if (namespacePrefix) namespaceMap.set(flatName, { namespace: namespacePrefix, name });
    return;
  }
  if (type === "namespace") {
    const ns = tool.name;
    const children = tool.tools ?? tool.children ?? [];
    const childPrefix = namespacePrefix ? `${namespacePrefix}__${ns}` : ns;
    for (const child of children) {
      collectTools(child, childPrefix, out, customToolNames, namespaceMap, convertibleToolNames, signal);
    }
    return;
  }
  if (type === "tool_search") {
    signal("tool_search");
    if (convertibleToolNames.has("tool_search")) return;
    out.push({
      type: "function",
      function: {
        name: "tool_search",
        description: "Search the available tool registry.",
        parameters: TOOL_SEARCH_PROXY_SCHEMA
      }
    });
    convertibleToolNames.add("tool_search");
    return;
  }
  if (isWebSearchTool(tool)) {
    signal("web_search");
    return;
  }
  if (isHostedTool(tool)) {
    return;
  }
  const maybeName = tool.name;
  const maybeParams = tool.parameters;
  if (typeof maybeName === "string" && maybeParams && typeof maybeParams === "object") {
    const flatName = namespacePrefix ? `${namespacePrefix}__${maybeName}` : maybeName;
    if (!convertibleToolNames.has(flatName)) {
      out.push({ type: "function", function: { name: flatName, parameters: maybeParams } });
      convertibleToolNames.add(flatName);
    }
  }
}
function mapToolChoice(raw, convertible, hasToolSearch) {
  if (raw === void 0 || raw === null) return void 0;
  if (typeof raw === "string") {
    return raw;
  }
  if (typeof raw !== "object") return void 0;
  const obj = raw;
  const type = obj.type ?? "";
  if (type === "web_search" || type === "web_search_preview") return void 0;
  if (type === "file_search" || type === "code_interpreter" || type === "computer_use_preview" || type === "image_generation" || type === "mcp") {
    return void 0;
  }
  if (type === "tool_search") {
    return hasToolSearch ? { type: "function", function: { name: "tool_search" } } : void 0;
  }
  if (type === "custom" || type === "function") {
    const name = obj.name ?? obj.function?.name;
    if (typeof name !== "string" || name.length === 0) return void 0;
    if (!convertible.has(name)) return void 0;
    return { type: "function", function: { name } };
  }
  return void 0;
}
var ToolTranslationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolTranslationError";
  }
};

// src/translator/chat-to-responses.ts
function chatCompletionsToResponses(resp, model, opts = {}) {
  const id = opts.responseId ?? generateResponsesId();
  const choice = resp.choices?.[0];
  const output = [];
  if (choice) {
    const items = chatChoiceToOutputItems(choice, opts.meta);
    output.push(...items);
  }
  if (output.length === 0) {
    output.push(emptyMessageOutput());
  }
  const status = choice?.finish_reason === "length" ? "incomplete" : "completed";
  const incomplete = status === "incomplete" ? { reason: "max_output_tokens" } : void 0;
  return {
    id,
    object: "response",
    created_at: Date.now(),
    model: model || resp.model || "",
    status,
    output,
    ...incomplete ? { incomplete_details: incomplete } : {},
    ...resp.usage ? { usage: chatUsageToResponsesUsage(resp.usage) } : {},
    ...opts.instructions ? { instructions: opts.instructions } : {},
    ...opts.previousResponseId ? { previous_response_id: opts.previousResponseId } : {}
  };
}
function chatChoiceToOutputItems(choice, meta) {
  const items = [];
  const msg = choice.message;
  if (msg?.reasoning_content) {
    items.push({
      type: "reasoning",
      id: generateItemId(),
      summary: [{ type: "summary_text", text: msg.reasoning_content }],
      status: "completed"
    });
  }
  const text = extractAssistantText(msg);
  const toolCalls = msg?.tool_calls ?? [];
  const customNames = meta?.customToolNames ?? /* @__PURE__ */ new Set();
  const nsMap = meta?.namespaceMap ?? /* @__PURE__ */ new Map();
  const hasToolSearch = meta?.hasToolSearch === true;
  if (text.length > 0 || toolCalls.length === 0) {
    items.push({
      type: "message",
      id: generateItemId(),
      role: "assistant",
      content: [{ type: "output_text", text }],
      status: "completed"
    });
  }
  for (const tc of toolCalls) {
    const flatName = tc.function.name;
    const args = tc.function.arguments && tc.function.arguments.trim().length > 0 ? tc.function.arguments : "{}";
    if (customNames.has(flatName)) {
      const inputStr = extractCustomToolInput(args);
      items.push({
        type: "custom_tool_call",
        id: generateItemId(),
        call_id: tc.id || generateCallId(),
        name: flatName,
        input: inputStr,
        status: "completed"
      });
      continue;
    }
    if (flatName === "tool_search" && hasToolSearch) {
      let argsObj = {};
      try {
        argsObj = JSON.parse(args);
      } catch {
        argsObj = {};
      }
      items.push({
        type: "tool_search_call",
        id: generateItemId(),
        call_id: tc.id || generateCallId(),
        arguments: argsObj,
        execution: "client",
        status: "completed"
      });
      continue;
    }
    const ns = nsMap.get(flatName);
    if (ns) {
      items.push({
        type: "function_call",
        id: generateItemId(),
        call_id: tc.id || generateCallId(),
        name: ns.name,
        namespace: ns.namespace,
        arguments: args,
        status: "completed"
      });
      continue;
    }
    items.push({
      type: "function_call",
      id: generateItemId(),
      call_id: tc.id || generateCallId(),
      name: flatName,
      arguments: args,
      status: "completed"
    });
  }
  return items;
}
function emptyMessageOutput() {
  return {
    type: "message",
    id: generateItemId(),
    role: "assistant",
    content: [{ type: "output_text", text: "" }],
    status: "completed"
  };
}
function extractAssistantText(msg) {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
  }
  return "";
}
function extractCustomToolInput(rawArgs) {
  try {
    const obj = JSON.parse(rawArgs);
    if (typeof obj.input === "string") return obj.input;
  } catch {
  }
  return rawArgs;
}
function chatUsageToResponsesUsage(u) {
  return {
    input_tokens: u.prompt_tokens ?? 0,
    output_tokens: u.completion_tokens ?? 0,
    total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
    ...u.prompt_tokens_details?.cached_tokens ? { input_tokens_details: { cached_tokens: u.prompt_tokens_details.cached_tokens } } : {},
    ...u.output_tokens_details?.reasoning_tokens ? { output_tokens_details: { reasoning_tokens: u.output_tokens_details.reasoning_tokens } } : {}
  };
}
function newResponsesStreamState(model, opts = {}) {
  return {
    responseId: opts.responseId ?? generateResponsesId(),
    model,
    createdAt: Date.now(),
    sequenceNumber: 0,
    createdSent: false,
    completedSent: false,
    nextOutputIndex: 0,
    reasoningItemId: void 0,
    reasoningIndex: -1,
    reasoningOpen: false,
    reasoningDone: false,
    reasoningText: "",
    messageItemId: void 0,
    messageIndex: -1,
    textPartOpen: false,
    text: "",
    toolCalls: /* @__PURE__ */ new Map(),
    finishReason: void 0,
    usage: void 0,
    meta: opts.meta
  };
}
function chatChunkToResponsesEvents(chunk, state) {
  const events = [];
  events.push(...ensureCreated(state));
  if (chunk.model && !state.model) state.model = chunk.model;
  if (chunk.usage) state.usage = chatUsageToResponsesUsage(chunk.usage);
  for (const choice of chunk.choices ?? []) {
    events.push(...handleChoice(choice, state));
  }
  return events;
}
function handleChoice(choice, state) {
  const events = [];
  const delta = choice.delta;
  if (delta.reasoning_content && delta.reasoning_content.length > 0) {
    events.push(...ensureReasoningItem(state));
    state.reasoningText += delta.reasoning_content;
    events.push(seq(state, {
      type: "response.reasoning_summary_text.delta",
      output_index: state.reasoningIndex,
      summary_index: 0,
      delta: delta.reasoning_content,
      item_id: state.reasoningItemId
    }));
  }
  if (typeof delta.content === "string" && delta.content.length > 0) {
    events.push(...closeReasoningItem(state));
    events.push(...ensureMessageItem(state));
    events.push(...ensureTextPart(state));
    state.text += delta.content;
    events.push(seq(state, {
      type: "response.output_text.delta",
      output_index: state.messageIndex,
      content_index: 0,
      delta: delta.content,
      item_id: state.messageItemId
    }));
  }
  for (const tc of delta.tool_calls ?? []) {
    const idx = tc.index ?? 0;
    let entry = state.toolCalls.get(idx);
    if (!entry) {
      events.push(...closeReasoningItem(state));
      const itemId = generateItemId();
      const outputIndex = allocIndex(state);
      const callId = tc.id || generateCallId();
      const name = tc.function?.name ?? "";
      entry = { id: callId, name, args: "", itemId, outputIndex };
      state.toolCalls.set(idx, entry);
      const initialArgs = tc.function?.arguments ?? "";
      entry.args += initialArgs;
      events.push(seq(state, {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: toolCallAddedItem(entry, state.meta)
      }));
      if (initialArgs.length > 0) {
        events.push(seq(state, toolArgsDeltaEvent(entry, initialArgs, state)));
      }
    } else {
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name = tc.function.name;
      const argDelta = tc.function?.arguments ?? "";
      if (argDelta.length > 0) {
        entry.args += argDelta;
        events.push(seq(state, toolArgsDeltaEvent(entry, argDelta, state)));
      }
    }
  }
  if (choice.finish_reason) {
    state.finishReason = choice.finish_reason;
  }
  return events;
}
function toolCallAddedItem(entry, meta) {
  const customNames = meta?.customToolNames ?? /* @__PURE__ */ new Set();
  const nsMap = meta?.namespaceMap ?? /* @__PURE__ */ new Map();
  const hasToolSearch = meta?.hasToolSearch === true;
  if (customNames.has(entry.name)) {
    return {
      type: "custom_tool_call",
      id: entry.itemId,
      call_id: entry.id,
      name: entry.name,
      input: "",
      // final value emitted at output_item.done
      status: "in_progress"
    };
  }
  if (entry.name === "tool_search" && hasToolSearch) {
    return {
      type: "tool_search_call",
      id: entry.itemId,
      call_id: entry.id,
      execution: "client",
      status: "in_progress"
    };
  }
  const ns = nsMap.get(entry.name);
  if (ns) {
    return {
      type: "function_call",
      id: entry.itemId,
      call_id: entry.id,
      name: ns.name,
      namespace: ns.namespace,
      status: "in_progress"
    };
  }
  return {
    type: "function_call",
    id: entry.itemId,
    call_id: entry.id,
    name: entry.name,
    status: "in_progress"
  };
}
function toolArgsDeltaEvent(entry, delta, state) {
  const customNames = state.meta?.customToolNames ?? /* @__PURE__ */ new Set();
  const isCustom = customNames.has(entry.name);
  const base = {
    output_index: entry.outputIndex,
    delta,
    item_id: entry.itemId,
    call_id: entry.id,
    name: entry.name
  };
  return seq(state, isCustom ? { type: "response.custom_tool_call_input.delta", ...base } : { type: "response.function_call_arguments.delta", ...base });
}
function finalizeResponsesStream(state) {
  if (state.completedSent) return [];
  const events = [];
  events.push(...ensureCreated(state));
  events.push(...closeReasoningItem(state));
  events.push(...synthesizeReasoningFallbackMessage(state));
  events.push(...closeMessageItem(state));
  events.push(...closeToolItems(state));
  const status = state.finishReason === "length" ? "incomplete" : "completed";
  const incomplete = status === "incomplete" ? { reason: "max_output_tokens" } : void 0;
  state.completedSent = true;
  events.push(seq(state, {
    type: status === "incomplete" ? "response.incomplete" : "response.completed",
    response: {
      id: state.responseId,
      object: "response",
      created_at: state.createdAt,
      model: state.model,
      status,
      output: buildFinalOutput(state),
      ...incomplete ? { incomplete_details: incomplete } : {},
      ...state.usage ? { usage: state.usage } : {}
    }
  }));
  return events;
}
function ensureCreated(state) {
  if (state.createdSent) return [];
  state.createdSent = true;
  return [seq(state, {
    type: "response.created",
    response: {
      id: state.responseId,
      object: "response",
      created_at: state.createdAt,
      model: state.model,
      status: "in_progress",
      output: []
    }
  })];
}
function ensureReasoningItem(state) {
  if (state.reasoningOpen || state.reasoningDone) return [];
  state.reasoningOpen = true;
  state.reasoningItemId = generateItemId();
  state.reasoningIndex = allocIndex(state);
  return [
    seq(state, {
      type: "response.output_item.added",
      output_index: state.reasoningIndex,
      item: { type: "reasoning", id: state.reasoningItemId, status: "in_progress" }
    }),
    seq(state, {
      type: "response.reasoning_summary_part.added",
      output_index: state.reasoningIndex,
      summary_index: 0,
      item_id: state.reasoningItemId,
      part: { type: "summary_text" }
    })
  ];
}
function closeReasoningItem(state) {
  if (!state.reasoningOpen) return [];
  state.reasoningOpen = false;
  state.reasoningDone = true;
  const text = state.reasoningText;
  return [
    seq(state, {
      type: "response.reasoning_summary_text.done",
      output_index: state.reasoningIndex,
      summary_index: 0,
      text,
      item_id: state.reasoningItemId
    }),
    seq(state, {
      type: "response.reasoning_summary_part.done",
      output_index: state.reasoningIndex,
      summary_index: 0,
      item_id: state.reasoningItemId,
      part: { type: "summary_text", text }
    }),
    seq(state, {
      type: "response.output_item.done",
      output_index: state.reasoningIndex,
      item: {
        type: "reasoning",
        id: state.reasoningItemId,
        status: "completed",
        summary: [{ type: "summary_text", text }]
      }
    })
  ];
}
function synthesizeReasoningFallbackMessage(state) {
  if (state.messageItemId || state.text.length > 0 || state.reasoningText.length === 0 || state.toolCalls.size > 0) {
    return [];
  }
  const text = state.reasoningText;
  if (text.trim().length === 0) return [];
  const events = [];
  events.push(...ensureMessageItem(state));
  events.push(...ensureTextPart(state));
  state.text = text;
  events.push(seq(state, {
    type: "response.output_text.delta",
    output_index: state.messageIndex,
    content_index: 0,
    delta: text,
    item_id: state.messageItemId
  }));
  return events;
}
function ensureMessageItem(state) {
  if (state.messageItemId) return [];
  state.messageItemId = generateItemId();
  state.messageIndex = allocIndex(state);
  return [seq(state, {
    type: "response.output_item.added",
    output_index: state.messageIndex,
    item: {
      type: "message",
      id: state.messageItemId,
      role: "assistant",
      status: "in_progress",
      content: [{ type: "output_text" }]
    }
  })];
}
function ensureTextPart(state) {
  if (state.textPartOpen) return [];
  state.textPartOpen = true;
  return [seq(state, {
    type: "response.content_part.added",
    output_index: state.messageIndex,
    content_index: 0,
    item_id: state.messageItemId,
    part: { type: "output_text", text: "" }
  })];
}
function closeMessageItem(state) {
  if (!state.messageItemId) return [];
  const events = [];
  if (state.textPartOpen) {
    events.push(seq(state, {
      type: "response.output_text.done",
      output_index: state.messageIndex,
      content_index: 0,
      text: state.text,
      item_id: state.messageItemId
    }));
    events.push(seq(state, {
      type: "response.content_part.done",
      output_index: state.messageIndex,
      content_index: 0,
      item_id: state.messageItemId,
      part: { type: "output_text", text: state.text }
    }));
  }
  events.push(seq(state, {
    type: "response.output_item.done",
    output_index: state.messageIndex,
    item: {
      type: "message",
      id: state.messageItemId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: state.text }]
    }
  }));
  return events;
}
function closeToolItems(state) {
  const events = [];
  const sortedKeys = [...state.toolCalls.keys()].sort((a, b) => a - b);
  for (const idx of sortedKeys) {
    const entry = state.toolCalls.get(idx);
    const customNames = state.meta?.customToolNames ?? /* @__PURE__ */ new Set();
    const nsMap = state.meta?.namespaceMap ?? /* @__PURE__ */ new Map();
    const hasToolSearch = state.meta?.hasToolSearch === true;
    const isCustom = customNames.has(entry.name);
    const isToolSearch = entry.name === "tool_search" && hasToolSearch;
    const ns = nsMap.get(entry.name);
    const finalArgs = entry.args.trim().length === 0 ? "{}" : entry.args;
    if (isCustom) {
      const inputStr = extractCustomToolInput(finalArgs);
      events.push(seq(state, {
        type: "response.custom_tool_call_input.done",
        output_index: entry.outputIndex,
        input: inputStr,
        item_id: entry.itemId,
        call_id: entry.id,
        name: entry.name
      }));
      events.push(seq(state, {
        type: "response.output_item.done",
        output_index: entry.outputIndex,
        item: {
          type: "custom_tool_call",
          id: entry.itemId,
          call_id: entry.id,
          name: entry.name,
          input: inputStr,
          status: "completed"
        }
      }));
    } else if (isToolSearch) {
      let argsObj = {};
      try {
        argsObj = JSON.parse(finalArgs);
      } catch {
        argsObj = {};
      }
      events.push(seq(state, {
        type: "response.function_call_arguments.done",
        output_index: entry.outputIndex,
        arguments: finalArgs,
        item_id: entry.itemId,
        call_id: entry.id,
        name: entry.name
      }));
      events.push(seq(state, {
        type: "response.output_item.done",
        output_index: entry.outputIndex,
        item: {
          type: "tool_search_call",
          id: entry.itemId,
          call_id: entry.id,
          arguments: argsObj,
          execution: "client",
          status: "completed"
        }
      }));
    } else {
      events.push(seq(state, {
        type: "response.function_call_arguments.done",
        output_index: entry.outputIndex,
        arguments: finalArgs,
        item_id: entry.itemId,
        call_id: entry.id,
        name: entry.name
      }));
      events.push(seq(state, {
        type: "response.output_item.done",
        output_index: entry.outputIndex,
        item: ns ? {
          type: "function_call",
          id: entry.itemId,
          call_id: entry.id,
          name: ns.name,
          namespace: ns.namespace,
          arguments: finalArgs,
          status: "completed"
        } : {
          type: "function_call",
          id: entry.itemId,
          call_id: entry.id,
          name: entry.name,
          arguments: finalArgs,
          status: "completed"
        }
      }));
    }
  }
  return events;
}
function buildFinalOutput(state) {
  const out = [];
  if (state.reasoningDone && state.reasoningText.length > 0) {
    out.push({
      type: "reasoning",
      id: state.reasoningItemId,
      summary: [{ type: "summary_text", text: state.reasoningText }],
      status: "completed"
    });
  }
  if (state.messageItemId || state.toolCalls.size === 0) {
    out.push({
      type: "message",
      id: state.messageItemId ?? generateItemId(),
      role: "assistant",
      content: [{ type: "output_text", text: state.text }],
      status: "completed"
    });
  }
  const sortedKeys = [...state.toolCalls.keys()].sort((a, b) => a - b);
  for (const idx of sortedKeys) {
    const entry = state.toolCalls.get(idx);
    const customNames = state.meta?.customToolNames ?? /* @__PURE__ */ new Set();
    const nsMap = state.meta?.namespaceMap ?? /* @__PURE__ */ new Map();
    const hasToolSearch = state.meta?.hasToolSearch === true;
    const isCustom = customNames.has(entry.name);
    const isToolSearch = entry.name === "tool_search" && hasToolSearch;
    const ns = nsMap.get(entry.name);
    const finalArgs = entry.args.trim().length === 0 ? "{}" : entry.args;
    if (isCustom) {
      out.push({
        type: "custom_tool_call",
        id: entry.itemId,
        call_id: entry.id,
        name: entry.name,
        input: extractCustomToolInput(finalArgs),
        status: "completed"
      });
    } else if (isToolSearch) {
      let argsObj = {};
      try {
        argsObj = JSON.parse(finalArgs);
      } catch {
        argsObj = {};
      }
      out.push({
        type: "tool_search_call",
        id: entry.itemId,
        call_id: entry.id,
        arguments: argsObj,
        execution: "client",
        status: "completed"
      });
    } else if (ns) {
      out.push({
        type: "function_call",
        id: entry.itemId,
        call_id: entry.id,
        name: ns.name,
        namespace: ns.namespace,
        arguments: finalArgs,
        status: "completed"
      });
    } else {
      out.push({
        type: "function_call",
        id: entry.itemId,
        call_id: entry.id,
        name: entry.name,
        arguments: finalArgs,
        status: "completed"
      });
    }
  }
  return out;
}
function allocIndex(state) {
  return state.nextOutputIndex++;
}
function seq(state, evt) {
  const n = state.sequenceNumber++;
  return { ...evt, sequence_number: n };
}
function responsesEventToSse(evt) {
  return `event: ${evt.type}
data: ${JSON.stringify(evt)}

`;
}

// src/proxy/responses-handler.ts
async function handleResponses(clientReq, opts) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const debug = opts.debug === true;
  const start = Date.now();
  let rawBody;
  try {
    rawBody = await clientReq.text();
  } catch (err) {
    return errorResponse(400, "invalid_request", `could not read request body: ${err.message}`);
  }
  let req;
  try {
    req = JSON.parse(rawBody);
  } catch (err) {
    return errorResponse(400, "invalid_request", `request body is not valid JSON: ${err.message}`);
  }
  if (typeof req.input !== "string" && !Array.isArray(req.input)) {
    return errorResponse(400, "invalid_request", "`input` must be a string or an array");
  }
  if (typeof req.model !== "string" || req.model.length === 0) {
    return errorResponse(400, "invalid_request", "`model` is required");
  }
  const stream = req.stream === true;
  let historyItems = [];
  let prevId;
  if (typeof req.previous_response_id === "string" && req.previous_response_id.length > 0) {
    if (!opts.responseStore) {
      return errorResponse(404, "response_store_disabled", "`previous_response_id` was supplied but the response store is not configured");
    }
    const prev = opts.responseStore.get(req.previous_response_id);
    if (!prev) {
      return errorResponse(404, "response_not_found", `previous_response_id ${req.previous_response_id} not found (response store is in-memory; entries are lost on restart and after the TTL)`);
    }
    prevId = req.previous_response_id;
    historyItems = [...prev.input, ...outputItemsAsInputItems(prev.output)];
  }
  const input = typeof req.input === "string" ? [...historyItems, { type: "message", role: "user", content: req.input }] : [...historyItems, ...req.input];
  const reqWithHistory = {
    ...req,
    input
  };
  let translated;
  try {
    translated = responsesToChatCompletions(reqWithHistory);
  } catch (err) {
    if (err instanceof ToolTranslationError) {
      return errorResponse(400, "tool_translation_error", err.message);
    }
    throw err;
  }
  const { chatRequest, customToolNames, namespaceMap, hasToolSearch } = translated;
  let cred;
  try {
    cred = await opts.auth.getCredential();
  } catch (err) {
    return errorResponse(503, "credential_unavailable", err.message);
  }
  const providerDef = resolveProviderDef(opts.config);
  const startPlan = opts.config.plan === "start-plan";
  const chatBodyStr = JSON.stringify(chatRequest);
  const transformedBody = transformRequestBody(chatBodyStr, {
    format: "openai",
    userId: startPlan ? void 0 : cred.userId,
    startPlan
  });
  const upstreamHeaders = buildUpstreamHeaderPairs(clientReq, "openai", cred, opts.config.identity, opts.config.plan, void 0, void 0);
  const upstreamReq = buildUpstreamRequest(clientReq, "openai", providerDef, cred, transformedBody, opts.config.identity, opts.config.plan, void 0, void 0);
  if (debug) console.log(`[responses] \u2192 POST ${upstreamReq.url}`);
  let upstreamResp;
  try {
    upstreamResp = await fetchImpl(upstreamReq, { method: "POST", headers: Object.fromEntries(upstreamHeaders), body: transformedBody ?? void 0, signal: clientReq.signal });
  } catch (err) {
    return errorResponse(502, "upstream_unreachable", err.message);
  }
  if (!upstreamResp.ok) {
    const errText = await upstreamResp.text().catch(() => "");
    return errorResponse(upstreamResp.status, "upstream_error", errText.slice(0, 500) || `upstream returned ${upstreamResp.status}`);
  }
  const responseId = generateResponsesId();
  const meta = { customToolNames, namespaceMap, hasToolSearch };
  if (stream) {
    return streamResponse(upstreamResp, { responseId, model: req.model, meta, request: req, input, options: opts });
  }
  const rawChatResp = await upstreamResp.text();
  let chatRespJson;
  try {
    chatRespJson = JSON.parse(rawChatResp);
  } catch (err) {
    return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${err.message}`);
  }
  const responsesResp = chatCompletionsToResponses(chatRespJson, req.model, {
    responseId,
    meta,
    ...typeof req.instructions === "string" ? { instructions: req.instructions } : {},
    ...prevId ? { previousResponseId: prevId } : {}
  });
  if (req.store !== false && opts.responseStore) {
    const stored = buildStoredResponse(responsesResp, input, req.instructions);
    opts.responseStore.set(stored);
  }
  if (debug) console.log(`[responses] \u2190 ${responsesResp.status} (${Date.now() - start}ms)`);
  return new Response(JSON.stringify(responsesResp), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
function streamResponse(upstreamResp, context) {
  if (!upstreamResp.body) {
    return errorResponse(502, "translation_failed", "upstream returned no body for stream");
  }
  const state = newResponsesStreamState(context.model, { meta: context.meta, responseId: context.responseId });
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (evt) => controller.enqueue(encoder.encode(responsesEventToSse(evt)));
      try {
        const reader = upstreamResp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let errored = false;
        for (; ; ) {
          if (errored) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            const dataLine = extractSseData(frame);
            if (!dataLine || dataLine === "[DONE]") continue;
            try {
              const chunk = JSON.parse(dataLine);
              for (const evt of chatChunkToResponsesEvents(chunk, state)) send(evt);
            } catch (err) {
              errored = true;
              controller.error(err);
              return;
            }
          }
        }
        const finalEvents = finalizeResponsesStream(state);
        for (const evt of finalEvents) send(evt);
        const finalEvent = finalEvents.find((evt) => evt.type === "response.completed" || evt.type === "response.incomplete");
        if (finalEvent && context.request.store !== false && context.options.responseStore) {
          context.options.responseStore.set(buildStoredResponse(finalEvent.response, context.input, context.request.instructions));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      context.options.debug === true && console.log(`[responses] stream cancelled: ${String(reason)}`);
      try {
        upstreamResp.body?.cancel();
      } catch {
      }
    }
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    }
  });
}
function extractSseData(frame) {
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) return line.slice(5).replace(/^\s/, "");
  }
  return null;
}
function resolveProviderDef(config) {
  const base = getProvider(config.provider);
  const endpoints = config.providers[config.provider];
  return {
    ...base,
    anthropicBaseURL: endpoints.anthropicBase,
    openaiBaseURL: endpoints.openaiBase
  };
}
function outputItemsAsInputItems(outputs) {
  return outputs;
}
function buildStoredResponse(resp, input, instructions) {
  return {
    id: resp.id,
    model: resp.model,
    status: resp.status === "completed" || resp.status === "incomplete" || resp.status === "failed" ? resp.status : "completed",
    input,
    output: resp.output,
    usage: resp.usage,
    instructions,
    createdAt: Date.now(),
    lastAccessedAt: Date.now()
  };
}

// src/server/routes-responses.ts
async function handleResponsesRoute(req, opts) {
  return handleResponses(req, opts);
}

// src/server/server.ts
function createFetchHandler(opts) {
  const { config, auth } = opts;
  const proxyOpts = { config, auth, fetchImpl: opts.fetchImpl, debug: opts.debug === true };
  const responsesOpts = {
    config,
    auth,
    fetchImpl: opts.fetchImpl,
    debug: opts.debug === true,
    ...opts.responseStore ? { responseStore: opts.responseStore } : {}
  };
  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    if (method === "OPTIONS") {
      return corsResponse();
    }
    if (method === "GET" && (path === "/webui" || path.startsWith("/webui/"))) {
      return new Response(webui_default, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }
      });
    }
    if (config.auth.proxyApiKey) {
      const authHeader = req.headers.get("authorization") ?? req.headers.get("x-api-key");
      if (!authHeader || !checkProxyKey(authHeader, config.auth.proxyApiKey)) {
        return errorResponse(401, "authentication_error", "Invalid or missing proxy API key");
      }
    }
    if (path === "/v1/chat/completions" && method === "POST") {
      return handleChatCompletions(req, proxyOpts);
    }
    if (config.responses.enabled && path === "/v1/responses" && method === "POST") {
      return handleResponsesRoute(req, responsesOpts);
    }
    if (path === "/v1/models" && method === "GET") {
      return handleListModels();
    }
    if (path === "/v1/messages" && method === "POST") {
      return handleMessages(req, proxyOpts);
    }
    if (path === "/health" || path === "/") {
      return new Response(JSON.stringify({ status: "ok", provider: config.provider }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return errorResponse(404, "not_found_error", `No route for ${method} ${path}`);
  };
}
function startServer(opts) {
  const handler = createFetchHandler(opts);
  const { port: requestedPort, host } = opts.config.server;
  const server = (0, import_node_http.createServer)(async (req, res) => {
    const abortController = new AbortController();
    const onClientClose = () => {
      if (!res.writableEnded) abortController.abort();
    };
    res.on("close", onClientClose);
    try {
      const webReq = nodeReqToWebRequest(req, abortController.signal);
      const resp = await handler(webReq).then((r) => addCorsHeaders(r));
      await writeWebResponseToNodeResp(resp, res, abortController.signal);
    } catch (err) {
      if (abortController.signal.aborted) return;
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "internal_error", message: err.message } }));
      } else {
        try {
          res.end();
        } catch {
        }
      }
    }
  });
  server.requestTimeout = 6e5;
  server.keepAliveTimeout = 12e4;
  server.headersTimeout = 6e5;
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(requestedPort, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : requestedPort;
      resolve({
        hostname: host,
        port: actualPort,
        stop: (exit) => {
          server.close();
          if (exit) process.exit(0);
        },
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}
function nodeReqToWebRequest(req, signal) {
  const headers = new Headers();
  for (const [key, val] of Object.entries(req.headers)) {
    if (val == null) continue;
    if (Array.isArray(val)) {
      for (const v of val) headers.append(key, v);
    } else {
      headers.set(key, val);
    }
  }
  const host = headers.get("host") ?? "localhost";
  const url = `http://${host}${req.url ?? "/"}`;
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers, signal });
  }
  const bodyStream = import_node_stream.Readable.toWeb(req);
  const init = {
    method,
    headers,
    body: bodyStream,
    duplex: "half",
    signal
  };
  return new Request(url, init);
}
async function writeWebResponseToNodeResp(resp, res, abortSignal) {
  const headers = {};
  resp.headers.forEach((value, key) => {
    const existing = headers[key];
    if (existing === void 0) {
      headers[key] = value;
    } else if (typeof existing === "string") {
      headers[key] = [existing, value];
    } else {
      existing.push(value);
    }
  });
  res.writeHead(resp.status, resp.statusText, headers);
  if (resp.body == null) {
    res.end();
    return;
  }
  const reader = resp.body.getReader();
  const onAbort = () => {
    reader.cancel().catch(() => {
    });
  };
  abortSignal?.addEventListener("abort", onAbort);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once("drain", () => resolve()));
      }
    }
    res.end();
  } catch (err) {
    if (abortSignal?.aborted) {
      try {
        res.end();
      } catch {
      }
    } else {
      try {
        res.destroy(err);
      } catch {
      }
    }
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
  }
}
function checkProxyKey(authHeader, expected) {
  const trimmed = authHeader.trim();
  if (trimmed.startsWith("Bearer ")) {
    return trimmed.slice(7).trim() === expected;
  }
  return trimmed === expected;
}
function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}
function addCorsHeaders(resp) {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders())) {
    headers.set(k, v);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers
  });
}
function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
    "access-control-max-age": "86400"
  };
}

// src/android/control.ts
var import_node_http3 = require("node:http");

// src/auth/oauth.ts
var import_node_http2 = require("node:http");
var import_node_crypto2 = require("node:crypto");
var ZCODE_TOKEN_ENDPOINT = "https://zcode.z.ai/api/v1/oauth/token";
var BIGMODEL_HOST = "https://bigmodel.cn";
var BIGMODEL_APP_ID = "zcode";
var AuthCodeOAuthClient = class {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }
  config;
  fetchImpl;
  server = null;
  callbackResult = null;
  callbackWaiters = [];
  /** Build the provider authorize URL with the localhost redirect + state. */
  buildAuthorizeUrl(callbackUrl, state) {
    const params = this.config.authorizeParamStyle === "oauth2" ? new URLSearchParams({
      redirect_uri: callbackUrl,
      response_type: "code",
      client_id: this.config.appId,
      state
    }) : new URLSearchParams({
      appId: this.config.appId,
      redirect: callbackUrl,
      state
    });
    return `${this.config.authorizeUrl}?${params.toString()}`;
  }
  /**
   * Start the localhost callback server and return the authorize URL.
   * Call `waitForCallback()` (or `authorize()`) afterwards, then `close()`.
   *
   * The bind port is `0` (OS-assigned random) unless the env var
   * `ZCODE_OAUTH_CALLBACK_PORT` is set, in which case that exact port is used.
   * The Android entry sets the env var so the WebView redirect URL is
   * predictable across launches.
   */
  start() {
    const state = (0, import_node_crypto2.randomBytes)(32).toString("hex");
    const requestedPort = Number(process.env.ZCODE_OAUTH_CALLBACK_PORT ?? 0) || 0;
    return new Promise((resolve, reject) => {
      this.server = (0, import_node_http2.createServer)((req, res) => {
        this.handleCallback(req, res, state);
      });
      this.server.on("error", reject);
      this.server.listen(requestedPort, "127.0.0.1", () => {
        const addr = this.server.address();
        if (!addr || typeof addr !== "object") {
          reject(new Error("Failed to bind localhost callback server"));
          return;
        }
        const callbackUrl = `http://127.0.0.1:${addr.port}${this.config.callbackPath}`;
        const authorizeUrl = this.buildAuthorizeUrl(callbackUrl, state);
        resolve({ authorizeUrl, callbackUrl, state });
      });
    });
  }
  handleCallback(req, res, expectedState) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== this.config.callbackPath) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("authCode") ?? url.searchParams.get("code") ?? "";
    if (state !== expectedState || !code) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Authorization failed: state mismatch or missing code.");
      if (!this.callbackResult) {
        this.callbackResult = { code: "", error: "OAuth callback state mismatch or missing code." };
        this.callbackWaiters.forEach((fn) => fn(this.callbackResult));
      }
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Authorization successful! You may close this window and return to the CLI.");
    if (!this.callbackResult) {
      this.callbackResult = { code, error: null };
      this.callbackWaiters.forEach((fn) => fn(this.callbackResult));
    }
  }
  /** Wait for the OAuth callback redirect. Resolves with the auth code. */
  waitForCallback(timeoutMs = 3e5) {
    if (this.callbackResult?.code) {
      return Promise.resolve(this.callbackResult.code);
    }
    if (this.callbackResult?.error) {
      return Promise.reject(new Error(this.callbackResult.error));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Authorization timed out. Please retry login."));
      }, timeoutMs);
      this.callbackWaiters.push((result2) => {
        clearTimeout(timer);
        if (result2.error) {
          reject(new Error(result2.error));
        } else {
          resolve(result2.code);
        }
      });
    });
  }
  /**
   * Exchange the auth code at the shared zcode.z.ai token endpoint.
   * The ZCode server holds the app secret and performs the real provider exchange.
   * Returns `{ accessToken, userId, jwt }`.
   */
  async exchangeCode(authCode, redirectUri, state) {
    const resp = await this.fetchImpl(this.config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: this.config.provider,
        code: authCode,
        redirect_uri: redirectUri,
        state
      })
    });
    const raw = safeJsonParse(await resp.text());
    if (!resp.ok || raw && typeof raw.code === "number" && raw.code !== 0) {
      const label = this.config.provider;
      throw new Error(
        `${label} token exchange failed: status=${resp.status} msg=${raw?.msg ?? "(none)"}`
      );
    }
    const providerToken = raw?.data?.[this.config.accessTokenField];
    const accessToken = providerToken?.access_token?.trim() ?? "";
    if (!accessToken) {
      throw new Error(`${this.config.provider} token response missing data.${this.config.accessTokenField}.access_token`);
    }
    const userId = raw?.data?.user?.user_id;
    const jwt = raw?.data?.token?.trim() ?? void 0;
    return { accessToken, userId: typeof userId === "string" ? userId : void 0, jwt };
  }
  /** Run the full flow: start server, surface authorize URL, exchange code. */
  async authorize(onAuthorizeUrl, timeoutMs = 3e5) {
    const { authorizeUrl, callbackUrl, state } = await this.start();
    onAuthorizeUrl?.(authorizeUrl);
    try {
      const authCode = await this.waitForCallback(timeoutMs);
      const { accessToken, userId, jwt } = await this.exchangeCode(authCode, callbackUrl, state);
      return { accessToken, provider: this.config.provider, userId, jwt };
    } finally {
      await this.close();
    }
  }
  async close() {
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(() => resolve());
      });
      this.server = null;
    }
  }
};
var ZAI_AUTH_CODE_CONFIG = {
  provider: "zai",
  authorizeUrl: "https://chat.z.ai/api/oauth/authorize",
  appId: "client_P8X5CMWmlaRO9gyO-KSqtg",
  tokenUrl: ZCODE_TOKEN_ENDPOINT,
  callbackPath: "/oauth/callback/zai",
  accessTokenField: "zai",
  authorizeParamStyle: "oauth2"
};
var BIGMODEL_AUTH_CODE_CONFIG = {
  provider: "bigmodel",
  authorizeUrl: `${BIGMODEL_HOST}/login`,
  appId: BIGMODEL_APP_ID,
  tokenUrl: ZCODE_TOKEN_ENDPOINT,
  callbackPath: "/oauth/callback/bigmodel",
  accessTokenField: "bigmodel",
  authorizeParamStyle: "zcode"
};
var ZaiOAuthClient = class extends AuthCodeOAuthClient {
  constructor(fetchImpl = fetch) {
    super(ZAI_AUTH_CODE_CONFIG, fetchImpl);
  }
};
var BigmodelOAuthClient = class extends AuthCodeOAuthClient {
  constructor(fetchImpl = fetch, host = BIGMODEL_HOST, appId = BIGMODEL_APP_ID) {
    super(
      { ...BIGMODEL_AUTH_CODE_CONFIG, authorizeUrl: `${host}/login`, appId },
      fetchImpl
    );
  }
};
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// src/auth/resolver.ts
var ZAI_API_KEY_NAME = "zcode-api-key";
var DEFAULT_ORG_MARKER = "\u9ED8\u8BA4\u673A\u6784";
var DEFAULT_PROJECT_MARKER = "\u9ED8\u8BA4\u9879\u76EE";
async function requestBizApi(fetchImpl, url, authorization, init) {
  const resp = await fetchImpl(url, {
    ...init,
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      ...init?.headers ?? {}
    }
  });
  if (!resp.ok) {
    throw new Error(`Biz API ${url} failed: ${resp.status}`);
  }
  const body = await resp.json();
  const code = body.code ?? body.status;
  if (code != null && code !== 0 && code !== 200 && code !== "0" && code !== "200") {
    throw new Error(body.msg ?? `Biz API error ${code}`);
  }
  return body.data ?? body;
}
var KeyResolver = class {
  constructor(fetchImpl = fetch) {
    this.fetchImpl = fetchImpl;
  }
  fetchImpl;
  async resolveZaiBizToken(accessToken) {
    const resp = await this.fetchImpl("https://api.z.ai/api/auth/z/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: accessToken })
    });
    if (!resp.ok) {
      throw new Error(`z/login failed: ${resp.status}`);
    }
    const data = await resp.json();
    return data.access_token ?? data.accessToken ?? data.data?.access_token;
  }
  async resolveCustomerInfo(host, authorization) {
    const data = await requestBizApi(
      this.fetchImpl,
      `${host}/api/biz/customer/getCustomerInfo`,
      authorization,
      { method: "GET" }
    );
    const orgs = data.organizations ?? data.orgs ?? [];
    if (!Array.isArray(orgs) || orgs.length === 0) {
      throw new Error("No organizations found");
    }
    const org = orgs.find(
      (o) => (o.organizationName ?? o.name ?? "").includes(DEFAULT_ORG_MARKER)
    ) ?? orgs[0];
    const orgId = org.organizationId ?? org.id ?? org.orgId;
    const projects = org.projects ?? [];
    if (!Array.isArray(projects) || projects.length === 0) {
      throw new Error("No projects found in default organization");
    }
    const project = projects.find(
      (p) => (p.projectName ?? p.name ?? "").includes(DEFAULT_PROJECT_MARKER)
    ) ?? projects[0];
    const projectId = project.projectId ?? project.id;
    return { orgId, projectId };
  }
  async findOrCreateApiKey(host, authorization, orgId, projectId) {
    const listUrl = `${host}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys`;
    let existing = [];
    try {
      existing = await requestBizApi(this.fetchImpl, listUrl, authorization, { method: "GET" }) ?? [];
    } catch {
    }
    if (Array.isArray(existing)) {
      const found = existing.find((k) => k.name === ZAI_API_KEY_NAME);
      if (found?.apiKey) {
        return { apiKey: found.apiKey };
      }
    }
    const created = await requestBizApi(this.fetchImpl, listUrl, authorization, {
      method: "POST",
      body: JSON.stringify({ name: ZAI_API_KEY_NAME })
    });
    return { apiKey: created.apiKey };
  }
  async getSecretKey(host, authorization, orgId, projectId, apiKey) {
    const url = `${host}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys/copy/${encodeURIComponent(apiKey)}`;
    const data = await requestBizApi(this.fetchImpl, url, authorization, { method: "GET" });
    return data.secretKey ?? data.secret_key ?? "";
  }
  async resolveCodingPlanCredential(accessToken, provider, userId) {
    if (provider === "zai") {
      const bizToken = await this.resolveZaiBizToken(accessToken);
      const host2 = "https://api.z.ai";
      const authorization2 = `Bearer ${bizToken}`;
      const { orgId: orgId2, projectId: projectId2 } = await this.resolveCustomerInfo(host2, authorization2);
      const { apiKey: apiKey2 } = await this.findOrCreateApiKey(host2, authorization2, orgId2, projectId2);
      let secret;
      try {
        secret = await this.getSecretKey(host2, authorization2, orgId2, projectId2, apiKey2);
      } catch {
      }
      return { apiKey: apiKey2, secret: secret || void 0, provider: "zai", userId };
    }
    const host = "https://bigmodel.cn";
    const authorization = accessToken;
    const { orgId, projectId } = await this.resolveCustomerInfo(host, authorization);
    const { apiKey } = await this.findOrCreateApiKey(host, authorization, orgId, projectId);
    let fullKey = apiKey;
    try {
      const secret = await this.getSecretKey(host, authorization, orgId, projectId, apiKey);
      if (secret) fullKey = `${apiKey}.${secret}`;
    } catch {
    }
    return { apiKey: fullKey, provider: "bigmodel", userId };
  }
};

// src/auth/store.ts
var import_node_fs3 = require("node:fs");
var import_node_path = require("node:path");
var import_node_os2 = require("node:os");
var STORE_DIR = (0, import_node_path.join)((0, import_node_os2.homedir)(), ".zcode-proxy");
var STORE_FILE = (0, import_node_path.join)(STORE_DIR, "credentials.json");
var ENV_SECRET = "ZCODE_PROXY_CREDENTIAL_SECRET";
function getEncryptionKey() {
  const hash = new Uint8Array(new ArrayBuffer(32));
  const encoder = new TextEncoder();
  const seed = process.env[ENV_SECRET] ?? `${(0, import_node_os2.homedir)()}-${process.platform}-${process.arch}`;
  const seedBytes = encoder.encode(seed);
  for (let i = 0; i < seedBytes.length; i++) {
    hash[i % 32] ^= seedBytes[i];
  }
  return hash;
}
async function encrypt(plaintext) {
  const key = await crypto.subtle.importKey(
    "raw",
    getEncryptionKey(),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext)
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return Buffer.from(combined).toString("base64");
}
async function decrypt(ciphertext) {
  const key = await crypto.subtle.importKey(
    "raw",
    getEncryptionKey(),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
  const combined = Buffer.from(ciphertext, "base64");
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );
  return new TextDecoder().decode(decrypted);
}
async function saveCredential(cred) {
  (0, import_node_fs3.mkdirSync)((0, import_node_path.dirname)(STORE_FILE), { recursive: true });
  const json = JSON.stringify(cred);
  const encrypted = await encrypt(json);
  (0, import_node_fs3.writeFileSync)(STORE_FILE, JSON.stringify({ encrypted }), { mode: 384 });
}
async function loadCredential() {
  if (!(0, import_node_fs3.existsSync)(STORE_FILE)) return null;
  const raw = (0, import_node_fs3.readFileSync)(STORE_FILE, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed.encrypted) return null;
  try {
    const json = await decrypt(parsed.encrypted);
    return JSON.parse(json);
  } catch (e) {
    console.warn(`Ignoring corrupted or stale credentials at ${STORE_FILE}: ${e.message}`);
    return null;
  }
}
function clearCredential() {
  if ((0, import_node_fs3.existsSync)(STORE_FILE)) {
    (0, import_node_fs3.unlinkSync)(STORE_FILE);
  }
}
function getStorePath() {
  return STORE_FILE;
}

// src/android/control.ts
var LogBuffer = class {
  lines = [];
  capacity;
  nextSeq = 0;
  constructor(capacity = 500) {
    this.capacity = capacity;
  }
  push(line) {
    this.lines.push(line);
    this.nextSeq++;
    if (this.lines.length > this.capacity) {
      this.lines.splice(0, this.lines.length - this.capacity);
    }
  }
  /**
   * Returns lines whose logical sequence number is `>= since`, plus the
   * next-since cursor (use as the next `since` value for incremental polling).
   */
  since(since) {
    const baseSeq = Math.max(0, this.nextSeq - this.lines.length);
    const wantStart = Math.max(since, baseSeq);
    const offset = wantStart - baseSeq;
    if (offset >= this.lines.length) {
      return { nextSince: this.nextSeq, lines: [] };
    }
    return { nextSince: this.nextSeq, lines: this.lines.slice(offset) };
  }
  /** Returns all lines currently in the buffer. */
  snapshot() {
    return this.lines;
  }
  /** Monotonic cursor; safe to expose externally. */
  get cursor() {
    return this.nextSeq;
  }
};
function startControlListener(opts) {
  const logBuffer = opts.logBuffer ?? new LogBuffer();
  const server = (0, import_node_http3.createServer)(async (req, res) => {
    try {
      const result2 = await handleControlRequest(req, opts.state, {
        onStartProxy: opts.onStartProxy,
        onStopProxy: opts.onStopProxy,
        onSetConfig: opts.onSetConfig,
        onShutdown: opts.onShutdown,
        logBuffer
      });
      writeJson(res, result2.status, result2.body);
    } catch (err) {
      writeJson(res, 500, { ok: false, error: `internal_error: ${err.message}` });
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve({
      close: () => new Promise((r) => server.close(() => r()))
    }));
  });
}
async function handleControlRequest(req, state, ctx) {
  if (!isLoopback(req.socket.remoteAddress)) {
    return { status: 403, body: { ok: false, error: "forbidden: non-loopback remote address" } };
  }
  const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method !== "POST" || parsed.pathname !== "/control") {
    return { status: 404, body: { ok: false, error: `not_found: ${req.method} ${parsed.pathname}` } };
  }
  const body = await readBody2(req);
  let cmd;
  try {
    cmd = JSON.parse(body);
  } catch {
    return { status: 400, body: { ok: false, error: "invalid_json" } };
  }
  const result2 = await dispatch(cmd, state, ctx);
  return { status: 200, body: result2 };
}
async function dispatch(cmd, state, ctx) {
  switch (cmd.cmd) {
    case "status": {
      const cred = await loadCredential().catch(() => null);
      return {
        ok: true,
        state: "running",
        provider: state.provider,
        plan: state.plan,
        proxyPort: state.proxyPort,
        loggedIn: cred != null
      };
    }
    case "startOAuth": {
      const client = cmd.provider === "bigmodel" ? new BigmodelOAuthClient() : new ZaiOAuthClient();
      const started = await client.start();
      const callbackUrlObj = new URL(started.callbackUrl);
      const callbackPort = callbackUrlObj.port ? Number(callbackUrlObj.port) : 80;
      state.activeOauth = {
        client,
        callbackUrl: started.callbackUrl,
        state: started.state
      };
      client.waitForCallback().then(async (code) => {
        try {
          const { accessToken, userId, jwt } = await client.exchangeCode(code, started.callbackUrl, started.state);
          const resolver = new KeyResolver();
          const cred = await resolver.resolveCodingPlanCredential(accessToken, cmd.provider, userId);
          if (jwt) cred.jwt = jwt;
          await saveCredential(cred);
          console.log(`OAuth completed for ${cmd.provider} via browser callback`);
        } catch (err) {
          console.error(`OAuth auto-complete failed: ${err.message}`);
        } finally {
          await client.close().catch(() => {
          });
          if (state.activeOauth?.state === started.state) state.activeOauth = void 0;
        }
      }).catch(() => {
      });
      return {
        ok: true,
        event: "oauthUrl",
        authorizeUrl: started.authorizeUrl,
        callbackPort
      };
    }
    case "deliverOAuthCode": {
      const active = state.activeOauth;
      if (!active || active.state !== cmd.state) {
        return { ok: false, error: "no_matching_oauth_flow" };
      }
      try {
        const { accessToken, userId, jwt } = await active.client.exchangeCode(
          cmd.code,
          active.callbackUrl,
          cmd.state
        );
        const resolver = new KeyResolver();
        const cred = await resolver.resolveCodingPlanCredential(accessToken, cmd.provider, userId);
        if (jwt) cred.jwt = jwt;
        await saveCredential(cred);
        state.activeOauth = void 0;
        await active.client.close().catch(() => {
        });
        return { ok: true, event: "loginOk", provider: cmd.provider };
      } catch (err) {
        state.activeOauth = void 0;
        await active.client.close().catch(() => {
        });
        return { ok: false, error: `oauth_exchange_failed: ${err.message}` };
      }
    }
    case "logout": {
      await clearCredential();
      return { ok: true, event: "loggedOut" };
    }
    case "setConfig": {
      if (!ctx.onSetConfig) return { ok: false, error: "config_update_unavailable" };
      const result2 = await ctx.onSetConfig({ provider: cmd.provider, plan: cmd.plan });
      if (!result2.ok) return result2;
      state.provider = result2.provider;
      state.plan = result2.plan;
      return { ok: true, event: "configUpdated", provider: result2.provider, plan: result2.plan };
    }
    case "startProxy": {
      if (!ctx.onStartProxy) return { ok: false, error: "proxy_lifecycle_unavailable" };
      const result2 = await ctx.onStartProxy();
      if (!result2.ok) return result2;
      state.proxyPort = result2.port;
      return { ok: true, event: "proxyStarted", port: result2.port };
    }
    case "stopProxy": {
      if (!ctx.onStopProxy) return { ok: false, error: "proxy_lifecycle_unavailable" };
      const result2 = await ctx.onStopProxy();
      if (!result2.ok) return result2;
      state.proxyPort = 0;
      return { ok: true, event: "proxyStopped" };
    }
    case "getLogs": {
      const since = typeof cmd.since === "number" ? cmd.since : 0;
      const { nextSince, lines } = ctx.logBuffer.since(since);
      return { ok: true, event: "logs", nextSince, lines: [...lines] };
    }
    case "shutdown": {
      if (ctx.onShutdown) await ctx.onShutdown();
      return { ok: true, event: "shuttingDown" };
    }
    default:
      return { ok: false, error: `unknown_cmd: ${cmd.cmd}` };
  }
}
function isLoopback(addr) {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
function writeJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json)
  });
  res.end(json);
}
function readBody2(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// src/responses/store.ts
var DEFAULT_MAX_ENTRIES = 1e3;
var DEFAULT_TTL_MS = 24 * 60 * 60 * 1e3;
var ResponseStore = class {
  maxEntries;
  ttlMs;
  map = /* @__PURE__ */ new Map();
  constructor(opts = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }
  /** Store a response. Overwrites on duplicate id. Evicts LRU entries on overflow. */
  set(entry) {
    const now = Date.now();
    entry.createdAt = now;
    entry.lastAccessedAt = now;
    if (this.map.has(entry.id)) this.map.delete(entry.id);
    this.map.set(entry.id, entry);
    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === void 0) break;
      this.map.delete(oldestKey);
    }
  }
  /**
   * Fetch a stored response. Returns `undefined` when missing or stale.
   * Refreshes LRU position on hit.
   */
  get(id) {
    const entry = this.map.get(id);
    if (!entry) return void 0;
    const now = Date.now();
    if (now - entry.createdAt > this.ttlMs) {
      this.map.delete(id);
      return void 0;
    }
    entry.lastAccessedAt = now;
    this.map.delete(id);
    this.map.set(id, entry);
    return entry;
  }
  delete(id) {
    return this.map.delete(id);
  }
  clear() {
    this.map.clear();
  }
  size() {
    return this.map.size;
  }
};

// src/index.ts
var import_yaml2 = __toESM(require_dist(), 1);
var import_node_child_process = require("node:child_process");
var import_node_fs4 = require("node:fs");
var import_node_path2 = require("node:path");
var import_node_os3 = require("node:os");
var VERSION = "2.6.0";
if (require.main === module) main();
function parseServeArgs(args) {
  const debug = args.includes("debug");
  const configPath = args.find((a) => a !== "debug");
  return { configPath, debug };
}
function main() {
  try {
    runCli();
  } catch (err) {
    process.stderr.write(`zcode-proxy: uncaught error: ${err.stack ?? String(err)}
`);
    process.exit(1);
  }
}
function runCli() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "serve";
  if (cmd === "auth") {
    authCommand(args.slice(1));
  } else if (cmd === "android") {
    runAndroid();
  } else if (cmd === "serve" || cmd.endsWith(".yaml") || cmd.endsWith(".yml")) {
    const serveArgs = cmd === "serve" ? parseServeArgs(args.slice(1)) : parseServeArgs(args);
    serve(serveArgs.configPath, serveArgs.debug);
  } else if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(`zcode-proxy ${VERSION}`);
  } else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
  } else {
    console.error(`Unknown command: ${cmd}
`);
    printHelp();
    process.exit(1);
  }
}
function printHelp() {
  console.log(`zcode-proxy ${VERSION}

Usage:
  zcode-proxy serve [config.yaml]   Start the proxy server (default)
  zcode-proxy serve debug [config.yaml]
                                    Start with verbose per-request diagnostics
  zcode-proxy android               Android entry: proxy + localhost control listener
  zcode-proxy auth login <provider> Login via OAuth (provider: zai | bigmodel)
  zcode-proxy auth login <provider> --import
                                    Import API key from ~/.zcode/v2/config.json
  zcode-proxy auth logout           Clear stored credentials
  zcode-proxy auth status           Show current authentication state
  zcode-proxy version               Show version
  zcode-proxy help                  Show this help

Examples:
  zcode-proxy                       Start server with default config.yaml
  zcode-proxy serve debug           Start with extra debug logging
  zcode-proxy auth login bigmodel   OAuth login for Bigmodel
  zcode-proxy auth login bigmodel --import
                                    Import existing key from ZCode config
  zcode-proxy auth status           Check if logged in
`);
}
async function serve(configPath, debug) {
  const path = configPath ?? process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (!(0, import_node_fs4.existsSync)(path)) {
    (0, import_node_fs4.writeFileSync)(path, EXAMPLE_CONFIG_YAML, "utf-8");
    console.log(`Created ${path} from bundled template.`);
    console.log(`Edit auth.apiKey, or run: zcode-proxy auth login <zai|bigmodel>
`);
  }
  const config = loadConfig(path);
  const auth = new AuthManager({
    mode: config.auth.mode,
    provider: config.provider,
    apiKey: config.auth.apiKey ?? config.providers[config.provider].credential
  });
  if (config.auth.mode === "oauth") {
    const cred = await loadCredential();
    if (!cred) {
      console.error("Not logged in. Run: zcode-proxy auth login " + config.provider);
      process.exit(1);
    }
    auth.setOAuthCredential(cred);
  }
  if (debug) printDebugBanner(config, path);
  const server = await startServer(buildServerOptions(config, auth, debug));
  const url = `http://${server.hostname}:${server.port}`;
  console.log(`zcode-proxy listening on ${url}`);
  console.log(`  provider: ${config.provider}`);
  console.log(`  plan: ${config.plan}`);
  console.log(`  auth mode: ${config.auth.mode}`);
  console.log(`  models: ${config.models.length} available`);
  if (config.responses.enabled) console.log(`  /v1/responses: ON`);
  if (debug) console.log(`  debug: ON`);
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    server.stop(true);
  });
  process.on("SIGTERM", () => {
    server.stop(true);
  });
}
function buildServerOptions(config, auth, debug) {
  const opts = { config, auth, debug };
  if (config.responses.enabled) {
    opts.responseStore = new ResponseStore({ maxEntries: config.responses.storeMaxEntries, ttlMs: config.responses.storeTtlMs });
  }
  return opts;
}
async function runAndroid() {
  const path = process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (!(0, import_node_fs4.existsSync)(path)) {
    (0, import_node_fs4.writeFileSync)(path, EXAMPLE_CONFIG_YAML, "utf-8");
  }
  const config = loadConfig(path);
  const logBuffer = new LogBuffer();
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...args) => {
    logBuffer.push(args.join(" "));
    origLog(...args);
  };
  console.error = (...args) => {
    logBuffer.push("[error] " + args.join(" "));
    origErr(...args);
  };
  console.warn = (...args) => {
    logBuffer.push("[warn] " + args.join(" "));
    origWarn(...args);
  };
  let auth = new AuthManager({
    mode: config.auth.mode,
    provider: config.provider,
    apiKey: config.auth.apiKey ?? config.providers[config.provider].credential
  });
  const serverRef = { current: null };
  async function startProxy() {
    if (serverRef.current) return { ok: false, error: "already_running" };
    if (config.auth.mode === "oauth") {
      const cred = await loadCredential().catch(() => null);
      if (!cred) return { ok: false, error: "not_logged_in" };
      auth.setOAuthCredential(cred);
    }
    try {
      const s = await startServer(buildServerOptions(config, auth, false));
      serverRef.current = s;
      console.log(`zcode-proxy listening on http://${s.hostname}:${s.port}`);
      return { ok: true, port: s.port };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  async function stopProxy() {
    const s = serverRef.current;
    if (!s) return { ok: false, error: "not_running" };
    try {
      s.stop(false);
      serverRef.current = null;
      console.log("zcode-proxy stopped");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  async function setConfig(changes) {
    if (serverRef.current) return { ok: false, error: "stop_proxy_first" };
    if (changes.provider) config.provider = changes.provider;
    if (changes.plan) config.plan = changes.plan;
    auth = new AuthManager({
      mode: config.auth.mode,
      provider: config.provider,
      apiKey: config.auth.apiKey ?? config.providers[config.provider].credential
    });
    updateConfigYaml(path, { provider: config.provider, plan: config.plan });
    console.log(`config updated: provider=${config.provider} plan=${config.plan}`);
    return { ok: true, provider: config.provider, plan: config.plan };
  }
  console.log("control listener ready; proxy stopped \u2014 use startProxy command to start");
  const controlPort = Number(process.env.ZCODE_CONTROL_PORT ?? 0) || 0;
  const controlState = {
    provider: config.provider,
    plan: config.plan,
    proxyPort: serverRef.current?.port ?? 0
  };
  const controlListener = await startControlListener({
    port: controlPort,
    state: controlState,
    logBuffer,
    onStartProxy: startProxy,
    onStopProxy: stopProxy,
    onSetConfig: setConfig,
    onShutdown: async () => {
      serverRef.current?.stop(true);
    }
  });
  console.log(`control listener: 127.0.0.1:${controlPort}`);
  console.log(`provider: ${config.provider}`);
  console.log(`plan: ${config.plan}`);
  process.on("SIGINT", () => {
    void controlListener.close().then(() => serverRef.current?.stop(true));
  });
  process.on("SIGTERM", () => {
    void controlListener.close().then(() => serverRef.current?.stop(true));
  });
}
function updateConfigYaml(path, fields) {
  const raw = (0, import_node_fs4.readFileSync)(path, "utf-8");
  const parsed = (0, import_yaml2.parse)(raw) ?? {};
  parsed.provider = fields.provider;
  parsed.plan = fields.plan;
  (0, import_node_fs4.writeFileSync)(path, (0, import_yaml2.stringify)(parsed), "utf-8");
}
function printDebugBanner(config, path) {
  const cred = config.providers[config.provider].credential ?? config.auth.apiKey;
  const credShape = cred ? `${cred.slice(0, 6)}...${cred.slice(-4)} (${cred.length} chars)` : "(none \u2014 oauth)";
  const active = config.providers[config.provider];
  console.log("=== zcode-proxy DEBUG MODE ===");
  console.log(`  config file: ${path}`);
  console.log(`  server: ${config.server.host}:${config.server.port}`);
  console.log(`  proxy api key: ${config.auth.proxyApiKey ? "required" : "open (no client auth)"}`);
  console.log(`  provider: ${config.provider}`);
  console.log(`  plan: ${config.plan}`);
  console.log(`  identity: appVersion=${config.identity.appVersion} sourceTitle=${config.identity.sourceTitle} referer=${config.identity.refererOrigin}`);
  console.log(`  client identity: mode=${config.clientIdentity.mode} ttl=${config.clientIdentity.ttlSeconds}s max=${config.clientIdentity.maxSessions}`);
  console.log(`  anthropic base: ${active.anthropicBase}`);
  console.log(`  openai base:    ${active.openaiBase}`);
  console.log(`  credential: ${credShape}`);
  console.log(`  models (${config.models.length}): ${config.models.join(", ")}`);
  console.log(`  log level: ${config.logging.level}`);
  console.log("===============================");
}
function authCommand(args) {
  const sub = args[0];
  if (sub === "login") {
    authLogin(args.slice(1));
  } else if (sub === "logout") {
    authLogout();
  } else if (sub === "status") {
    authStatus();
  } else {
    console.error("Usage: zcode-proxy auth <login|logout|status>");
    process.exit(1);
  }
}
async function authLogin(args) {
  const provider = args[0];
  const importMode = args.includes("--import");
  if (!provider || provider !== "zai" && provider !== "bigmodel") {
    console.error("Usage: zcode-proxy auth login <zai|bigmodel> [--import]");
    process.exit(1);
  }
  console.log(`Logging in: ${provider}${importMode ? " (import)" : " (OAuth)"}
`);
  let cred;
  if (importMode) {
    cred = importFromZCodeConfig(provider);
  } else {
    const { accessToken, userId, jwt } = await runOAuth(provider);
    console.log("\nResolving API key...");
    const resolver = new KeyResolver();
    cred = await resolver.resolveCodingPlanCredential(accessToken, provider, userId);
    if (jwt) cred.jwt = jwt;
  }
  await saveCredential(cred);
  console.log(`
Logged in as ${provider}.`);
  console.log(`  API Key: ${cred.apiKey.substring(0, 12)}...`);
  if (cred.userId) console.log(`  User ID: ${cred.userId}`);
  console.log(`  Stored:  ${getStorePath()}`);
}
function authLogout() {
  if (!(0, import_node_fs4.existsSync)(getStorePath())) {
    console.log("Not logged in.");
    return;
  }
  clearCredential();
  console.log("Logged out. Credentials removed.");
}
async function authStatus() {
  const cred = await loadCredential();
  if (!cred) {
    console.log("Not logged in.");
    console.log("Run: zcode-proxy auth login <zai|bigmodel>");
    return;
  }
  console.log(`Logged in: ${cred.provider}`);
  console.log(`  API Key: ${cred.apiKey.substring(0, 12)}...`);
  console.log(`  Store:   ${getStorePath()}`);
}
async function runOAuth(provider) {
  if (provider === "bigmodel") {
    const oauth2 = new BigmodelOAuthClient();
    const result3 = await oauth2.authorize((url) => {
      console.log("Open this URL to authorize:\n");
      console.log(`  ${url}
`);
      console.log("Waiting for authorization... (expires in 300s)\n");
      openBrowser(url);
    });
    return { accessToken: result3.accessToken, userId: result3.userId, jwt: result3.jwt };
  }
  const oauth = new ZaiOAuthClient();
  const result2 = await oauth.authorize((url) => {
    console.log("Open this URL to authorize:\n");
    console.log(`  ${url}
`);
    console.log("Waiting for authorization... (expires in 300s)\n");
    openBrowser(url);
  });
  return { accessToken: result2.accessToken, userId: result2.userId, jwt: result2.jwt };
}
function importFromZCodeConfig(provider) {
  const configPath = (0, import_node_path2.join)((0, import_node_os3.homedir)(), ".zcode", "v2", "config.json");
  let raw;
  try {
    raw = (0, import_node_fs4.readFileSync)(configPath, "utf-8");
  } catch {
    console.error(`Cannot read ${configPath}.`);
    console.error("Make sure ZCode is installed and you've logged in at least once.");
    process.exit(1);
  }
  const config = JSON.parse(raw);
  const providerKey = `builtin:${provider}-coding-plan`;
  const entry = config.provider?.[providerKey];
  const apiKey = entry?.options?.apiKey?.trim();
  if (!apiKey) {
    console.error(`No API key for ${providerKey} in ZCode config.`);
    process.exit(1);
  }
  const startPlanKey = `builtin:${provider}-start-plan`;
  const jwt = config.provider?.[startPlanKey]?.options?.apiKey?.trim() || void 0;
  console.log(`Imported from ${configPath}`);
  if (jwt) console.log(`  Start-plan JWT: ${jwt.slice(0, 12)}...`);
  return { apiKey, provider, jwt };
}
function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      (0, import_node_child_process.spawn)("cmd.exe", ["/c", `start "" "${url}"`], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: true
      }).unref();
    } else if (process.platform === "darwin") {
      (0, import_node_child_process.spawn)("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      (0, import_node_child_process.spawn)("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  main,
  parseServeArgs
});

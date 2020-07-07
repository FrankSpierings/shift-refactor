import { default as codegen, FormattedCodeGen } from '@jsoverson/shift-codegen';
import DEBUG from 'debug';
import deepEqual from 'fast-deep-equal';
import {
  BindingIdentifier,
  Expression,
  FunctionDeclaration,
  IdentifierExpression,
  Node,
  Statement
} from 'shift-ast';
import { parseScript } from 'shift-parser';
import shiftScope, { Declaration, Reference, Scope, ScopeLookup, Variable } from 'shift-scope';
import traverser from 'shift-traverser';
import { default as isValid } from 'shift-validator';
import { query } from './query';
import { RefactorPlugin } from './refactor-plugin';
import { RefactorError, Replacer, SelectorOrNode, SimpleIdentifier, SimpleIdentifierOwner } from './types';
import {
  buildParentMap,
  copy,
  extractExpression,
  extractStatement,
  findNodes,
  isArray,
  isFunction,
  isShiftNode,
  isStatement,
  isString,
  identityLogger
} from './util';
import { waterfallMap } from './waterfall';
import { RefactorSessionChainable } from './refactor-session-chainable';

/**
 * Parse JavaScript source with shift-parser
 *
 * @param src - JavaScript source
 * @returns Shift AST
 *
 * @public
 */
export const parse = parseScript;

const debug = DEBUG('shift-refactor');

export interface RefactorConfig {
  autoCleanup?: boolean;
  parentSession?: RefactorSession;
}

/**
 * The main Shift Refactor class
 * @public
 */
export class RefactorSession {
  nodes: Node[];
  _root?: Node;
  globalSession: RefactorSession;
  autoCleanup = true;

  private dirty = false;

  scopeMap: WeakMap<Variable, Scope> = new WeakMap();
  scopeOwnerMap: WeakMap<Node, Scope> = new WeakMap();
  parentMap: WeakMap<Node, Node> = new WeakMap();
  variables: Set<Variable> = new Set();

  private replacements = new WeakMap();
  private deletions = new WeakSet();
  private insertions = new WeakMap();

  private lookupTable: ScopeLookup | undefined;

  constructor(sourceOrNodes: string | Node | Node[], config: RefactorConfig = {}) {
    let nodes: Node[], tree: Node;
    if (config.parentSession) {
      this.globalSession = config.parentSession.globalSession;
      if (isString(sourceOrNodes)) throw new Error('Can not initialize child RefactorSession with a new AST');
      if (isArray(sourceOrNodes)) {
        //@ts-ignore : as any[] cast tracker https://github.com/microsoft/TypeScript/issues/36390
        nodes = (sourceOrNodes as any[]).filter((x: string | Node): x is Node => typeof x !== 'string');
      } else {
        nodes = [sourceOrNodes];
      }
    } else {
      if (isString(sourceOrNodes)) {
        try {
          tree = parseScript(sourceOrNodes);
          this._root = tree;
        } catch (e) {
          throw new RefactorError(`Could not parse passed source: ${e}`);
        }
        nodes = [tree];
      } else {
        if (isArray(sourceOrNodes)) throw new RefactorError('Must initialize root session with a JavaScript source program (JS source or single Node)');
        nodes = [sourceOrNodes];
        this._root = sourceOrNodes;
      }
      this.globalSession = this;
    }
    this.nodes = nodes;

    if (config.autoCleanup) this.autoCleanup = config.autoCleanup;

    this.rebuildParentMap();

    this.getLookupTable();
  }

  get root(): Node {
    if (this._root) {
      return this._root;
    } else {
      if (this === this.globalSession && !this._root) throw new Error('why');
      return this.globalSession.root;
    }
  }

  get length(): number {
    return this.nodes.length;
  }

  $(querySessionOrNodes: SelectorOrNode | RefactorSession) {
    return this.subSession(querySessionOrNodes);
  }

  subSession(querySessionOrNodes: SelectorOrNode | RefactorSession) {
    const nodes = querySessionOrNodes instanceof RefactorSession ? querySessionOrNodes.nodes : findNodes(this.nodes, querySessionOrNodes);
    const subSession = new RefactorSession(nodes, { parentSession: this });
    return subSession;
  }

  use<T extends RefactorPlugin>(Plugin: new (session: RefactorSession) => T) {
    const plugin = new Plugin(this);
    plugin.register();
  }

  private rebuildParentMap() {
    this.parentMap = buildParentMap(this.nodes);
  }

  rename(selectorOrNode: SelectorOrNode, newName: string) {
    const lookupTable = this.getLookupTable();

    const nodes = findNodes(this.nodes, selectorOrNode);

    nodes.forEach((node: Node) => {
      if (node.type === 'VariableDeclarator') node = node.binding;
      const lookup = lookupTable.variableMap.get(node);
      if (!lookup) return;
      this.renameInPlace(lookup[0], newName);
    });

    return this;
  }

  renameInPlace(lookup: Variable, newName: string) {
    if (!lookup || !newName) return;
    lookup.declarations.forEach(decl => ((decl.node as BindingIdentifier).name = newName));
    lookup.references.forEach(ref => ((ref.node as IdentifierExpression).name = newName));
  }

  delete(selectorOrNode: SelectorOrNode = this.nodes) {
    const nodes = findNodes(this.nodes, selectorOrNode);
    if (nodes.length > 0) {
      nodes.forEach((node: Node) => this._queueDeletion(node));
    }
    return this.conditionalCleanup();
  }

  replace(selectorOrNode: SelectorOrNode, replacer: Replacer) {
    const nodes = findNodes(this.nodes, selectorOrNode);

    const replacementScript = typeof replacer === 'string' ? parseScript(replacer) : null;

    const replaced = nodes.map((node: Node) => {
      let replacement = null;
      if (isFunction(replacer)) {
        const rv = replacer(node);
        if (rv && typeof rv.then === 'function') {
          throw new RefactorError(`Promise returned from replacer function, use .replaceAsync() instead.`);
        }
        if (isShiftNode(rv)) {
          replacement = rv;
        } else if (isString(rv)) {
          const returnedTree = parseScript(rv);
          if (isStatement(node)) {
            replacement = extractStatement(returnedTree);
          } else {
            replacement = extractExpression(returnedTree);
          }
        } else {
          throw new RefactorError(`Invalid return type from replacement function: ${rv}`);
        }
      } else if (isShiftNode(replacer)) {
        replacement = copy(replacer);
      } else if (replacementScript) {
        if (isStatement(node)) {
          replacement = copy(replacementScript.statements[0]);
        } else {
          if (replacementScript.statements[0].type === 'ExpressionStatement') {
            replacement = copy(replacementScript.statements[0].expression);
          }
        }
      }
      if (node && replacement !== node) {
        this._queueReplacement(node, replacement);
        return true;
      } else {
        return false;
      }
    });

    this.conditionalCleanup();
    return replaced.filter((wasReplaced: any) => wasReplaced).length;
  }

  async replaceAsync(selectorOrNode: SelectorOrNode, replacer: (node: Node) => Promise<Node | string>): Promise<number> {
    const nodes = findNodes(this.nodes, selectorOrNode);

    if (!isFunction(replacer)) {
      throw new RefactorError(`Invalid replacer type for replaceAsync. Pass a function or use .replace() instead.`);
    }

    const promiseResults = await waterfallMap(nodes, async (node: Node, i: number) => {
      let replacement = null;
      const rv = await replacer(node);
      if (isShiftNode(rv)) {
        replacement = rv;
      } else if (isString(rv)) {
        const returnedTree = parseScript(rv);
        if (isStatement(node)) {
          replacement = extractStatement(returnedTree);
        } else {
          replacement = extractExpression(returnedTree);
        }
      } else {
        throw new RefactorError(`Invalid return type from replacement function: ${rv}`);
      }

      if (node && replacement !== node) {
        this._queueReplacement(node, replacement);
        return true;
      } else {
        return false;
      }
    });

    this.conditionalCleanup();

    return promiseResults.filter(result => result).length;
  }

  replaceRecursive(selectorOrNode: SelectorOrNode, replacer: Replacer) {
    const nodesReplaced = this.replace(selectorOrNode, replacer);
    this.cleanup();
    if (nodesReplaced > 0) this.replaceRecursive(selectorOrNode, replacer);
    return this;
  }

  first(): Node {
    return this.nodes[0];
  }

  private insert(selectorOrNode: SelectorOrNode, replacer: Replacer, after = false): ReturnType<typeof RefactorSession.prototype.conditionalCleanup> {
    if (this !== this.globalSession) {
      return this.globalSession.insert(selectorOrNode, replacer, after);
    }
    const nodes = findNodes(this.nodes, selectorOrNode);

    let insertion: Node | null = null;
    let getInsertion = (program: Replacer, node: Node) => {
      if (isFunction(program)) {
        const result = program(node);
        if (isShiftNode(result)) return result;
        return parseScript(result).statements[0];
      } else {
        if (insertion) return copy(insertion);
        if (isShiftNode(program)) return copy(program);
        return (insertion = parseScript(program).statements[0]);
      }
    };

    nodes.forEach((node: Node) => {
      if (!isStatement(node)) throw new RefactorError('Can only insert before or after Statements or Declarations');
      this.isDirty(true);
      const toInsert = getInsertion(replacer, node);
      if (!isStatement(toInsert)) throw new RefactorError('Will not insert anything but a Statement or Declaration');
      this.insertions.set(node, {
        after,
        statement: getInsertion(replacer, node),
      });
    });

    return this.conditionalCleanup();
  }

  findParents(selectorOrNode: SelectorOrNode): Node[] {
    const nodes = findNodes(this.nodes, selectorOrNode);
    return nodes.map(identityLogger).map(node => this.globalSession.parentMap.get(node)).map(identityLogger).filter((node): node is Node => !!node);
  }

  prepend(selectorOrNode: SelectorOrNode, replacer: Replacer) {
    return this.globalSession.insert(selectorOrNode, replacer, false);
  }

  append(selectorOrNode: SelectorOrNode, replacer: Replacer) {
    return this.globalSession.insert(selectorOrNode, replacer, true);
  }

  _queueDeletion(node: Node): void {
    if (this !== this.globalSession) {
      return this.globalSession._queueDeletion(node);
    }
    this.isDirty(true);
    this.deletions.add(node);
  }

  _queueReplacement(from: Node, to: Node): void {
    if (this !== this.globalSession) {
      return this.globalSession._queueReplacement(from, to);
    }
    this.isDirty(true);
    this.replacements.set(from, to);
  }

  getLookupTable(): ScopeLookup {
    if (this.lookupTable) return this.lookupTable;
    const globalScope = shiftScope(this.root);
    this.lookupTable = new ScopeLookup(globalScope);
    this._rebuildScopeMap();
    return this.lookupTable;
  }

  _rebuildScopeMap() {
    const lookupTable = this.getLookupTable();
    this.scopeMap = new WeakMap();
    this.variables = new Set();
    const recurse = (scope: Scope) => {
      this.scopeOwnerMap.set(scope.astNode, scope);
      scope.variableList.forEach((variable: Variable) => {
        this.variables.add(variable);
        this.scopeMap.set(variable, scope);
      });
      scope.children.forEach(recurse);
    };
    recurse(lookupTable.scope);
  }

  isDirty(dirty?: boolean) {
    if (dirty !== undefined) this.dirty = dirty;
    return this.dirty;
  }

  validate() {
    return isValid(this.nodes);
  }

  conditionalCleanup() {
    if (this.autoCleanup) this.cleanup();
    return this;
  }

  cleanup(): RefactorSession {
    if (this !== this.globalSession) {
      return this.globalSession.cleanup();
    }
    if (!this.isDirty()) return this;
    const _this = this;
    const result = this.nodes.map(node => traverser.replace(node, {
      leave: function (node: Node, parent: Node) {
        if (node.type === 'VariableDeclarationStatement') {
          if (node.declaration.declarators.length === 0) return this.remove();
        }
        if (_this.replacements.has(node)) {
          const newNode = _this.replacements.get(node);
          _this.replacements.delete(node);
          return newNode;
        }
        if (_this.insertions.has(node)) {
          if (isStatement(node)) {
            const insertion = _this.insertions.get(node);
            if ('statements' in parent) {
              let statementIndex = parent.statements.indexOf(node);
              if (insertion.after) statementIndex++;
              parent.statements.splice(statementIndex, 0, insertion.statement);
              _this.insertions.delete(node);
            } else {
              debug(`Tried to insert ${node.type} but I lost track of my parent block :-(`);
            }
          } else {
            debug(`Tried to insert a non-Statement (${node.type}). Skipping.`);
          }
        }
        if (_this.deletions.has(node)) {
          _this.replacements.delete(node);
          this.remove();
        }
      },
    }));
    this.lookupTable = undefined;
    this.rebuildParentMap();
    this.isDirty(false);
    this.nodes = result;
    return this;
  }

  query(selector: string | string[]) {
    return query(this.nodes, selector);
  }

  // alias for query because I refuse to name findOne()->queryOne() and I need the symmetry.
  find(selectorOrNode: string) {
    return this.query(selectorOrNode);
  }

  queryFrom(astNodes: Node | Node[], selectorOrNode: string) {
    return isArray(astNodes)
      ? astNodes.map(node => query(node, selectorOrNode)).flat()
      : query(astNodes, selectorOrNode);
  }

  findMatchingExpression(sampleSrc: string): Expression[] {
    const tree = parseScript(sampleSrc);
    if (tree.statements[0] && tree.statements[0].type === 'ExpressionStatement') {
      const sampleExpression = tree.statements[0].expression;
      const potentialMatches = this.query(sampleExpression.type);
      const matches = potentialMatches.filter((realNode: Node) => deepEqual(sampleExpression, realNode));
      return matches as Expression[];
    }
    return [];
  }

  findMatchingStatement(sampleSrc: string): Statement[] {
    const tree = parseScript(sampleSrc);
    if (tree.statements[0]) {
      const sampleStatement = tree.statements[0];
      const potentialMatches = this.query(sampleStatement.type);
      const matches = potentialMatches.filter((realNode: Node) => deepEqual(sampleStatement, realNode));
      return matches as Statement[];
    }
    return [];
  }

  findOne(selectorOrNode: string) {
    const nodes = this.query(selectorOrNode);
    if (nodes.length !== 1)
      throw new Error(`findOne('${selectorOrNode}') found ${nodes.length} nodes. If this is intentional, use .find()`);
    return nodes[0];
  }

  findReferences(node: SimpleIdentifier | SimpleIdentifierOwner): Reference[] {
    const lookup = this.lookupVariable(node);
    return lookup.references;
  }

  findDeclarations(node: SimpleIdentifier | SimpleIdentifierOwner): Declaration[] {
    const lookup = this.lookupVariable(node);
    return lookup.declarations;
  }

  closest(originSelector: SelectorOrNode, closestSelector: string): Node[] {
    const nodes = findNodes(this.nodes, originSelector);

    const recurse = (node: Node, selector: string): Node[] => {
      const parent = this.findParents(node)[0];
      if (!parent) return [];
      const matches = query(parent, selector);
      if (matches.length > 0) return matches;
      else return recurse(parent, selector);
    };

    return nodes.flatMap((node: Node) => recurse(node, closestSelector));
  }

  lookupScope(variableLookup: Variable | Variable[] | SimpleIdentifierOwner | SimpleIdentifierOwner[] | SimpleIdentifier | SimpleIdentifier[]) {
    if (isArray(variableLookup)) variableLookup = variableLookup[0];

    if (isShiftNode(variableLookup)) variableLookup = this.lookupVariable(variableLookup);

    return this.scopeMap.get(variableLookup);
  }

  getInnerScope(node: FunctionDeclaration) {
    return this.scopeOwnerMap.get(node);
  }

  lookupVariable(node: SimpleIdentifierOwner | SimpleIdentifierOwner[] | SimpleIdentifier | SimpleIdentifier[]) {
    const lookupTable = this.getLookupTable();
    if (isArray(node)) node = node[0];

    let lookup: Variable[];
    switch (node.type) {
      case 'AssignmentExpression':
      case 'VariableDeclarator':
        lookup = lookupTable.variableMap.get(node.binding);
        break;
      case 'AssignmentTargetIdentifier':
      case 'IdentifierExpression':
      case 'BindingIdentifier':
        lookup = lookupTable.variableMap.get(node);
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
      case 'FunctionDeclaration':
      case 'FunctionExpression':
        lookup = lookupTable.variableMap.get(node.name);
        break;
    }

    if (!lookup)
      throw new Error('Could not find reference to passed identifier. Ensure you are passing a valid Identifier node.');
    if (lookup.length > 1)
      throw new Error('When does this happen? Submit an issue with this case so I can handle it better.');
    return lookup[0];
  }

  lookupVariableByName(name: string) {
    const lookupTable = this.getLookupTable();
    const varSet = new Set();

    // @ts-ignore: Poking where I shouldn't
    for (let [lookup] of lookupTable.variableMap._.values()) {
      if (name === lookup.name) varSet.add(lookup);
    }
    return Array.from(varSet) as Variable[];
  }

  generate(ast?: Node) {
    if (this.isDirty())
      throw new RefactorError(
        'refactor .print() called with a dirty AST. This is almost always a bug. Call .cleanup() before printing.',
      );
    return codegen(ast || this.first(), new FormattedCodeGen());
  }
}

export class GlobalSession extends RefactorSession {
  type = 'GlobalSession';

}
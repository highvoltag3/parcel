// @flow

import type {
  Asset,
  BundleGraph,
  NamedBundle,
  PluginOptions,
} from '@parcel/types';
import type {
  ArrayExpression,
  ExpressionStatement,
  File,
  Identifier,
  Statement,
  StringLiteral,
  VariableDeclaration,
} from '@babel/types';

import babelGenerate from '@babel/generator';
import invariant from 'assert';
import path from 'path';
import fs from 'fs';
import {parse} from '@babel/parser';
import {isEntry, needsPrelude} from './utils';
import SourceMap from '@parcel/source-map';
import * as t from '@babel/types';
import template from '@babel/template';

const PRELUDE_PATH = path.join(__dirname, 'prelude.js');
const PRELUDE = parse(
  fs.readFileSync(path.join(__dirname, 'prelude.js'), 'utf8'),
  {sourceFilename: PRELUDE_PATH},
);

const PARCEL_REQUIRE_NAME_DECL = template.statement<
  {|NAME: StringLiteral|},
  VariableDeclaration,
>(`var parcelRequireName = NAME;`);

const REGISTER_TEMPLATE = template.statements<
  {|
    REFERENCED_IDS: ArrayExpression,
    STATEMENTS: Array<Statement>,
    PARCEL_REQUIRE: Identifier,
  |},
  ExpressionStatement,
>(`
function $parcel$bundleWrapper() {
  if ($parcel$bundleWrapper._executed) return;
  STATEMENTS;
  $parcel$bundleWrapper._executed = true;
}
var $parcel$referencedAssets = REFERENCED_IDS;
for (var $parcel$i = 0; $parcel$i < $parcel$referencedAssets.length; $parcel$i++) {
  PARCEL_REQUIRE.registerBundle($parcel$referencedAssets[$parcel$i], $parcel$bundleWrapper);
}`);
const WRAPPER_TEMPLATE = template.statement<
  {|STATEMENTS: Array<Statement>|},
  ExpressionStatement,
>('(function () { STATEMENTS; })()');

export function generate({
  bundleGraph,
  bundle,
  ast,
  hoistedCalls,
  referencedAssets,
  parcelRequireName,
  options,
}: {|
  bundleGraph: BundleGraph<NamedBundle>,
  bundle: NamedBundle,
  ast: File,
  hoistedCalls: Array<Statement>,
  options: PluginOptions,
  referencedAssets: Set<Asset>,
  parcelRequireName: string,
|}): {|contents: string, map: ?SourceMap|} {
  let interpreter;
  let mainEntry = bundle.getMainEntry();
  if (mainEntry && !bundle.target.env.isBrowser()) {
    let _interpreter = mainEntry.meta.interpreter;
    invariant(_interpreter == null || typeof _interpreter === 'string');
    interpreter = _interpreter;
  }

  let isAsync = !isEntry(bundle, bundleGraph);

  // Wrap async bundles in a closure and register with parcelRequire so they are executed
  // at the right time (after other bundle dependencies are loaded).
  let statements = ast.program.body;
  if (bundle.env.outputFormat === 'global') {
    // Wrap async bundles in a closure and register with parcelRequire so they are executed
    // at the right time (after other bundle dependencies are loaded).
    if (isAsync) {
      statements = REGISTER_TEMPLATE({
        STATEMENTS: statements,
        REFERENCED_IDS: t.arrayExpression(
          [mainEntry, ...referencedAssets]
            .filter(Boolean)
            .map(asset => t.stringLiteral(bundleGraph.getAssetPublicId(asset))),
        ),
        PARCEL_REQUIRE: t.identifier(parcelRequireName),
      });
    }

    if (needsPrelude(bundle, bundleGraph)) {
      statements.unshift(
        PARCEL_REQUIRE_NAME_DECL({NAME: t.stringLiteral(parcelRequireName)}),
        ...PRELUDE.program.body,
      );
    }

    statements.unshift(
      // importScripts calls that potentially declare parcelRequire
      ...hoistedCalls,
    );

    statements = [WRAPPER_TEMPLATE({STATEMENTS: statements})];
  }

  ast = t.file(
    t.program(
      statements,
      [],
      bundle.env.outputFormat === 'esmodule' ? 'module' : 'script',
      interpreter ? t.interpreterDirective(interpreter) : null,
    ),
  );

  let {code, rawMappings} = babelGenerate(ast, {
    sourceMaps: !!bundle.env.sourceMap,
    minified: bundle.env.minify,
    comments: true, // retain /*@__PURE__*/ comments for terser
  });

  let map = null;
  if (bundle.env.sourceMap && rawMappings != null) {
    map = new SourceMap(options.projectRoot);
    map.addIndexedMappings(rawMappings);
  }

  return {
    contents: code,
    map,
  };
}
